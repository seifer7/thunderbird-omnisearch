'use strict';
// Orchestrator: drives the search engine (which lives in a Web Worker so its
// heavy JSON + index work never touches the UI thread), applies live updates via
// the messenger.* APIs, and answers search/command messages from the UI page.
// Depends on the globals OmniIndexer, OmniEvents (loaded first; see manifest).
// The worker owns OmniEngine/OmniStore/MiniSearch.
(function () {
  let loaded = false;
  let loadPromise = null;
  let building = false;
  let buildProgress = 0;
  let buildTotal = 0;
  let headerOnly = 0;
  let eligibleTotal = 0;
  let updatedAt;
  // Cached document count reported by the worker (we can't read engine.size
  // synchronously across the worker boundary).
  let engineCount = 0;
  // Last index-save error reported by the worker (null = saved OK). Surfaced in
  // status so the Settings page can warn that the index won't survive a restart.
  let saveError = null;
  // Whether a background eligible-count pass is running.
  let eligibleCountRunning = false;
  // Abort handle + generation id for interrupting stale eligible-count runs.
  let eligibleCountAbort = null;
  let eligibleCountRunId = 0;

  // Walk the folder tree (metadata only — no body reads, no index mutations) and
  // update eligibleTotal. Safe to call at any time, including during a build.
  // When an index start date is configured, headers must be iterated to get an
  // accurate count (getFolderInfo returns a raw total that ignores the date cut-off).
  async function countEligibleInBackground() {
    eligibleCountRunId++;
    const runId = eligibleCountRunId;
    if (eligibleCountAbort) eligibleCountAbort.abort();
    const abort = new AbortController();
    eligibleCountAbort = abort;
    eligibleCountRunning = true;
    // Recount restarted: clear the previous value immediately so the UI never
    // shows a stale eligible total while the new settings are being recomputed.
    eligibleTotal = 0;
    try {
      const folders = await OmniIndexer.flattenFolders();
      const startDateMs = await OmniIndexer.getIndexStartDate();
      if (abort.signal.aborted || runId !== eligibleCountRunId) return;
      if (startDateMs > 0) {
        eligibleTotal = await OmniIndexer.countEligibleHeaders(folders, startDateMs, abort.signal);
      } else {
        eligibleTotal = await OmniIndexer.totalMessageCount(folders, abort.signal);
      }
    } catch (e) {
      if (!abort.signal.aborted && runId === eligibleCountRunId) {
        console.error('[OmniSearch] eligible count failed:', e);
      }
    } finally {
      if (runId === eligibleCountRunId) {
        eligibleCountRunning = false;
        if (eligibleCountAbort === abort) eligibleCountAbort = null;
      }
    }
  }

  // ---- Worker RPC ----
  // Shared request/response envelope for our workers: post {reqId, ...payload},
  // resolve when the worker echoes {reqId, ok, result|error} back.
  function rpcWorker(url) {
    const w = new Worker(url);
    const pending = new Map();
    let nextReqId = 1;
    w.onmessage = (e) => {
      const { reqId, ok, result, error } = e.data;
      const resolver = pending.get(reqId);
      if (!resolver) return;
      pending.delete(reqId);
      if (ok) resolver.resolve(result);
      else resolver.reject(new Error(error));
    };
    w.onerror = (e) => console.error('[OmniSearch] worker error:', e.message || e);
    return function post(payload) {
      const reqId = nextReqId++;
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        w.postMessage({ reqId, ...payload });
      });
    };
  }

  // The engine (index + persistence) lives in one worker.
  const enginePost = rpcWorker('lib/engine.worker.js');
  function call(cmd, payload) {
    return enginePost({ cmd, ...payload });
  }

  // Pool of extractor workers for the CPU-heavy text extraction during a rebuild
  // — sized to the machine, so HTML stripping runs across cores. Calls are
  // round-robined; each worker queues its own requests.
  const EXTRACT_WORKERS = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const extractPosts = Array.from({ length: EXTRACT_WORKERS }, () => rpcWorker('lib/extract.worker.js'));
  let extractRR = 0;
  const extractor = {
    run(mode, headerMeta, full, indexEncrypted, maxBody) {
      const post = extractPosts[extractRR++ % extractPosts.length];
      return post({ mode, headerMeta, full, indexEncrypted, maxBody });
    },
  };

  // Async stand-in for the old in-process SearchEngine. fullBuild/events talk to
  // this; each method updates the cached count from the worker's reply.
  const engineProxy = {
    async search(query, limit) {
      return (await call('search', { query, limit })).results;
    },
    async addAll(docs) {
      engineCount = (await call('addAll', { docs })).count;
    },
    async upsert(doc) {
      engineCount = (await call('upsert', { doc })).count;
    },
    async remove(ids) {
      engineCount = (await call('remove', { ids })).count;
    },
    async knownIds() {
      return (await call('knownIds')).ids;
    },
    async reset() {
      engineCount = (await call('reset')).count;
    },
    async clear() {
      // Purge RAM + persisted (IndexedDB) index. Refresh every cached field the
      // status() report reads so the UI immediately shows the empty state.
      const r = await call('clear');
      engineCount = r.count;
      headerOnly = r.headerOnly;
      eligibleTotal = r.eligibleTotal || 0;
      updatedAt = r.updatedAt;
      saveError = r.saveError || null;
    },
    async flush(meta) {
      const r = await call('flush', meta || {});
      engineCount = r.count;
      headerOnly = r.headerOnly;
      eligibleTotal = r.eligibleTotal || 0;
      saveError = r.saveError || null;
    },
  };

  function status() {
    if (building) {
      return { state: 'building', count: engineCount, total: buildTotal, headerOnly, progress: buildProgress, updatedAt };
    }
    // Not yet finished loading the persisted index. Report this explicitly (and
    // immediately — see handle('status')) so the popup keeps the "Loading…"
    // indicator up and knows precisely when the index becomes usable, instead of
    // the background going silent until the load completes.
    if (!loaded) {
      return { state: 'loading', count: engineCount, headerOnly, updatedAt };
    }
    return {
      state: engineCount > 0 ? 'ready' : 'empty',
      count: engineCount,
      headerOnly,
      eligibleTotal,
      updatedAt,
      saveError,
    };
  }

  // Lazy-load the persisted index on first use. Single-flight: concurrent
  // callers share one load promise, so an early search can't kick off a second
  // deserialize that races the startup one.
  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          // The worker reads IndexedDB and deserializes off the UI thread.
          const r = await call('load');
          engineCount = r.count;
          headerOnly = r.headerOnly || 0;
          eligibleTotal = r.eligibleTotal || 0;
          updatedAt = r.updatedAt;
          saveError = r.saveError || null;
        } catch (e) {
          console.error('[OmniSearch] index load failed:', e);
        } finally {
          loaded = true;
        }
      })();
    }
    return loadPromise;
  }

  const controller = {
    get engine() {
      return engineProxy;
    },
    // Live-update handlers await this before mutating: it guarantees the worker
    // has finished loading the persisted index before any incremental update is
    // sent, so updates can't be applied to an empty index that's about to load.
    ensureLoaded,
  };

  // Full rebuild from scratch. Persistence happens once at the end (flush).
  async function rebuild() {
    if (building) return;
    await ensureLoaded();
    building = true;
    buildProgress = 0;
    headerOnly = 0;
    let builtCount = 0;
    await engineProxy.reset();
    try {
      const result = await OmniIndexer.fullBuild(engineProxy, extractor, (fraction, _count, ho, total) => {
        buildProgress = fraction;
        headerOnly = ho;
        buildTotal = total || 0;
      });
      headerOnly = result.headerOnly;
      builtCount = result.count;
    } finally {
      building = false;
    }
    // Use the actually-indexed count as eligibleTotal: it reflects any date filter
    // applied during the build, unlike buildTotal which comes from getFolderInfo.
    eligibleTotal = builtCount || buildTotal;
    await engineProxy.flush({ headerOnly, eligibleTotal });
  }

  // Open a single message by its numeric id, with a tab fallback.
  async function tryOpen(id) {
    if (!Number.isFinite(id)) return false;
    try {
      await messenger.messageDisplay.open({ messageId: id, location: 'tab' });
      return true;
    } catch (e) {
      try {
        const [tab] = await messenger.mailTabs.query({ active: true, currentWindow: true });
        if (!tab) return false;
        await messenger.mailTabs.setSelectedMessages(tab.id, [id]);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // Open a result. The stored numeric id can become stale (message moved) or be
  // reused by Thunderbird for a completely different message after the original
  // was deleted. Either case produces wrong-message opens if we trust the numeric
  // id blindly. When a stable RFC Message-ID is available, we verify the stored
  // numeric id still refers to the correct message before using it; if the check
  // fails we fall back to a fresh headerMessageId query.
  async function openMessage(msg) {
    const numId = Number(msg.id);
    if (Number.isFinite(numId)) {
      if (msg.headerMessageId) {
        // Verify the stored numeric id still refers to this specific message.
        // messenger.messages.get() returns null for missing/invalid ids rather
        // than throwing, but we guard with try/catch for robustness.
        try {
          const header = await messenger.messages.get(numId);
          if (header && header.headerMessageId === msg.headerMessageId) {
            if (await tryOpen(numId)) return;
          }
          // headerMessageId mismatch: id was reused for a different message, or
          // the message was moved and got a new id — fall through to re-resolve.
        } catch (e) {
          // Stale id; fall through to the headerMessageId path.
        }
      } else {
        // No headerMessageId to verify against; use the numeric id directly.
        if (await tryOpen(numId)) return;
      }
    }
    if (msg.headerMessageId) {
      try {
        const q = await messenger.messages.query({ headerMessageId: msg.headerMessageId });
        const list = (q && q.messages) || [];
        // If multiple copies exist (e.g. different accounts or Gmail labels),
        // prefer the one whose accountId matches what was indexed.
        const match = msg.accountId
          ? list.find((m) => m.folder && m.folder.accountId === msg.accountId) || list[0]
          : list[0];
        if (match && (await tryOpen(match.id))) return;
      } catch (e) {
        console.error('[OmniSearch] could not re-resolve message:', e);
      }
    }
    console.error('[OmniSearch] could not open message', msg.id, msg.headerMessageId);
  }

  // ---- UI message handling ----
  async function handle(msg) {
    switch (msg.type) {
      case 'search':
        await ensureLoaded();
        return { type: 'results', results: await engineProxy.search(msg.query, msg.limit || 100) };
      case 'status':
        // Reply immediately (don't await the load): status() reports 'loading'
        // until the index is ready, so the popup keeps getting replies during a
        // slow cold load rather than the background going silent for seconds.
        void ensureLoaded();
        return { type: 'status', status: status() };
      case 'rebuild':
        await ensureLoaded();
        void rebuild();
        return { type: 'status', status: status() };
      case 'clear':
        // Let any in-flight cold load settle first, then purge RAM + disk, so a
        // load racing the clear can't repopulate the index right after.
        await ensureLoaded();
        await engineProxy.clear();
        return { type: 'status', status: status() };
      case 'countEligible':
        // Recount eligible messages in the background (metadata only, no body
        // reads). Does not affect an ongoing build; returns the updated status.
        void countEligibleInBackground();
        return { type: 'status', status: status() };
      case 'reconcile':
        await ensureLoaded();
        const reconResult = await OmniEvents.reconcile(controller);
        eligibleTotal = reconResult.eligibleTotal || 0;
        await engineProxy.flush({ headerOnly, eligibleTotal });
        return { type: 'status', status: status() };
      case 'open':
        await openMessage(msg);
        return { type: 'ok' };
      default:
        return { type: 'ok' };
    }
  }

  // The toolbar button opens the search UI as a native popup panel
  // (action.default_popup). The keyboard shortcut is bound in the manifest via
  // the reserved "_execute_action" command, which opens that same popup
  // natively — so no JS is needed to open it.

  // ---- Keep the index warm (optional) ----
  // The index lives in the worker, which dies when the event page suspends —
  // causing a cold reload on the next popup. When the user enables keepWarm, a
  // short repeating alarm keeps the page (and worker) alive so reopening is
  // instant. Best-effort: trades a little memory/battery for no cold start.
  const KEEPALIVE_ALARM = 'omnisearch-keepwarm';
  async function keepWarmEnabled() {
    try {
      const r = await messenger.storage.local.get('settings');
      return !!(r.settings && r.settings.keepWarm);
    } catch (e) {
      return false;
    }
  }
  async function applyKeepWarm() {
    try {
      await messenger.alarms.clear(KEEPALIVE_ALARM);
      if (await keepWarmEnabled()) {
        messenger.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
      }
    } catch (e) {
      console.error('[OmniSearch] keepWarm setup failed:', e);
    }
  }

  // ---- Search UI mode (toolbar popup vs Spotlight-style window) ----
  // 'spotlight' (default): clear the action popup so a click / the Alt+S command
  // fires action.onClicked, which opens ui/search.html as a centered standalone
  // window (reuses the exact same page).
  // 'popup': the toolbar button opens ui/search.html anchored to it.
  // One setting drives both button and shortcut.
  const SPOTLIGHT_W = 720;
  // Start collapsed (about the height of the search field); the page grows the
  // window downward to fit results as they appear (see fitModalWindow in
  // ui/search.js). It does NOT reposition while growing — to avoid a jerky
  // moving window — so we anchor the top up-front for the expanded height
  // (SPOTLIGHT_EXPANDED_H): the collapsed field opens high, then results fill
  // downward to land roughly vertically centered.
  const SPOTLIGHT_H = 140; // must track MODAL_MIN_H (the resize floor) in ui/search.js
  const SPOTLIGHT_EXPANDED_H = 560; // must track the height cap in fitModalWindow
  let spotlightWindowId = null;
  async function searchUIMode() {
    try {
      const r = await messenger.storage.local.get('settings');
      const uiMode = r.settings && r.settings.searchUI;
      if (uiMode === 'popup') return 'popup';
      if (uiMode === 'tab') return 'tab';
      // Spotlight is the default.
      return 'spotlight';
    } catch (e) {
      return 'spotlight';
    }
  }
  async function applySearchUI() {
    try {
      const mode = await searchUIMode();
      // For spotlight and tab modes, clear the action popup so onClicked fires.
      await messenger.action.setPopup({ popup: mode === 'popup' ? 'ui/search.html' : '' });
    } catch (e) {
      console.error('[OmniSearch] search UI mode setup failed:', e);
    }
  }

  // Open a new search tab in the main Thunderbird window. Each click opens a
  // fresh tab so multiple independent search sessions can run side-by-side.
  async function openTab() {
    try {
      await messenger.tabs.create({ url: 'ui/search.html#tab' });
    } catch (e) {
      console.error('[OmniSearch] could not open search tab:', e);
    }
  }

  // Open (or focus) the centered search window. The top is anchored for the
  // expanded height so the field opens high and grows straight down to a roughly
  // centered results view — the window never moves once open.
  async function openSpotlight() {
    if (spotlightWindowId != null) {
      try {
        await messenger.windows.update(spotlightWindowId, { focused: true });
        return;
      } catch (e) {
        spotlightWindowId = null; // stale id — recreate below
      }
    }
    let pos = {};
    try {
      const ref = await messenger.windows.getLastFocused();
      if (ref && Number.isFinite(ref.left) && Number.isFinite(ref.width)) {
        pos = {
          left: Math.round(ref.left + (ref.width - SPOTLIGHT_W) / 2),
          top: Math.round(ref.top + Math.max(0, (ref.height - SPOTLIGHT_EXPANDED_H) / 2)),
        };
      }
    } catch (e) {
      /* no reference bounds — let the WM place it */
    }
    try {
      const win = await messenger.windows.create({
        type: 'popup',
        url: 'ui/search.html#modal',
        width: SPOTLIGHT_W,
        height: SPOTLIGHT_H,
        allowScriptsToClose: true,
        ...pos,
      });
      spotlightWindowId = win.id;
    } catch (e) {
      console.error('[OmniSearch] could not open Spotlight window:', e);
    }
  }

  // Register everything defensively: an unsupported API on a given Thunderbird
  // build must not abort the rest (which is what left the button dead before).
  function safe(label, fn) {
    try {
      fn();
    } catch (e) {
      console.error('[OmniSearch] failed to register ' + label + ':', e);
    }
  }

  safe('runtime.onMessage', () =>
    messenger.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      handle(msg).then(sendResponse);
      return true; // keep the channel open for the async response
    }),
  );

  safe('runtime.onInstalled', () =>
    messenger.runtime.onInstalled.addListener(async (details) => {
      if (details.reason === 'install') {
        await ensureLoaded();
        if (engineCount === 0) void rebuild();
      }
    }),
  );

  safe('registerEvents', () => OmniEvents.registerEvents(controller));

  // Warm the index when Thunderbird starts a session, so the first popup is fast.
  safe('runtime.onStartup', () =>
    messenger.runtime.onStartup.addListener(() => void ensureLoaded()),
  );
  // Keepalive alarm handler + (re)apply when the setting changes.
  safe('alarms.onAlarm', () =>
    messenger.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === KEEPALIVE_ALARM) void ensureLoaded();
    }),
  );
  // In Spotlight and Tab modes the popup is cleared, so clicking the button (and
  // the Alt+S _execute_action command, when no popup is set) fires onClicked.
  safe('action.onClicked', () =>
    messenger.action.onClicked.addListener(async () => {
      const mode = await searchUIMode();
      if (mode === 'tab') void openTab();
      else void openSpotlight();
    }),
  );
  safe('windows.onRemoved', () =>
    messenger.windows.onRemoved.addListener((id) => {
      if (id === spotlightWindowId) spotlightWindowId = null;
    }),
  );

  safe('storage.onChanged', () =>
    messenger.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        void applyKeepWarm();
        void applySearchUI();
        // Re-count eligible messages whenever account/folder/spam settings change
        // so the status line stays accurate without needing a rebuild.
        const prev = (changes.settings.oldValue && changes.settings.oldValue) || {};
        const next = (changes.settings.newValue && changes.settings.newValue) || {};
        if (
          JSON.stringify(prev.excludedAccounts) !== JSON.stringify(next.excludedAccounts) ||
          JSON.stringify(prev.excludedFolderIds) !== JSON.stringify(next.excludedFolderIds) ||
          JSON.stringify(prev.includedFolderIds) !== JSON.stringify(next.includedFolderIds) ||
          prev.folderIndexMode !== next.folderIndexMode ||
          prev.includeSpamTrash !== next.includeSpamTrash ||
          prev.indexStartDate !== next.indexStartDate
        ) {
          void countEligibleInBackground();
        }
      }
    }),
  );
  void applyKeepWarm();
  void applySearchUI();

  console.log('[OmniSearch] background loaded');
  // Load the persisted index, then immediately count eligible messages in the
  // background so eligibleTotal is populated before the options page is opened.
  void ensureLoaded().then(() => void countEligibleInBackground());
})();

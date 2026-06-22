'use strict';
// Orchestrator: owns the in-memory index, persists it, applies live updates,
// and answers search/command messages from the UI page. Depends on the globals
// OmniEngine, OmniIndexer, OmniEvents, OmniStore (loaded first; see manifest).
(function () {
  let engine = new OmniEngine();
  let loaded = false;
  let loadPromise = null;
  let building = false;
  let buildProgress = 0;
  let buildTotal = 0;
  let headerOnly = 0;
  let updatedAt;

  function status() {
    if (building) {
      return { state: 'building', count: engine.size, total: buildTotal, headerOnly, progress: buildProgress, updatedAt };
    }
    return {
      state: engine.size > 0 ? 'ready' : 'empty',
      count: engine.size,
      headerOnly,
      updatedAt,
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
          const json = await OmniStore.loadIndex();
          if (json) {
            engine = await OmniEngine.deserialize(json);
            const meta = await OmniStore.loadMeta();
            headerOnly = (meta && meta.headerOnly) || 0;
            updatedAt = meta && meta.updatedAt;
          }
        } catch (e) {
          console.error('[OmniSearch] index load failed:', e);
        } finally {
          loaded = true;
        }
      })();
    }
    return loadPromise;
  }

  // ---- Debounced persistence ----
  let persistTimer;
  async function persistNow() {
    updatedAt = Date.now();
    await OmniStore.saveIndex(engine.serialize(), { count: engine.size, headerOnly, updatedAt });
  }
  function persistSoon() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void persistNow(), 1500);
  }

  const controller = {
    get engine() {
      return engine;
    },
    persistSoon,
    // Live-update handlers await this before mutating: the index load is now
    // async (yields across event-loop turns), so an event firing mid-load must
    // not write into the empty engine that's about to be replaced.
    ensureLoaded,
  };

  // Full rebuild from scratch.
  async function rebuild() {
    if (building) return;
    await ensureLoaded();
    building = true;
    buildProgress = 0;
    headerOnly = 0;
    const fresh = new OmniEngine();
    engine = fresh;
    try {
      const result = await OmniIndexer.fullBuild(fresh, (fraction, _count, ho, total) => {
        buildProgress = fraction;
        headerOnly = ho;
        buildTotal = total || 0;
      });
      headerOnly = result.headerOnly;
    } finally {
      building = false;
    }
    await persistNow();
  }

  // Open a single message by its numeric id, with a tab fallback.
  async function tryOpen(id) {
    if (!Number.isFinite(id)) return false;
    try {
      await messenger.messageDisplay.open({ messageId: id, location: 'tab' });
      return true;
    } catch (e) {
      try {
        const tab = await messenger.mailTabs.getCurrent();
        await messenger.mailTabs.setSelectedMessages(tab.id, [id]);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // Open a result. The stored numeric id can be stale after a restart, so if it
  // fails we re-resolve the message by its stable RFC Message-ID and open that.
  async function openMessage(msg) {
    if (await tryOpen(Number(msg.id))) return;
    if (msg.headerMessageId) {
      try {
        const q = await messenger.messages.query({ headerMessageId: msg.headerMessageId });
        const list = (q && q.messages) || [];
        if (list.length && (await tryOpen(list[0].id))) return;
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
        return { type: 'results', results: engine.search(msg.query, msg.limit || 100) };
      case 'status':
        // Await the load so the very first status reply only arrives once the
        // index is ready — the popup shows its spinner until then, then clears
        // it for good.
        await ensureLoaded();
        return { type: 'status', status: status() };
      case 'rebuild':
        await ensureLoaded();
        void rebuild();
        return { type: 'status', status: status() };
      case 'reconcile':
        await ensureLoaded();
        await OmniEvents.reconcile(controller);
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
        if (engine.size === 0) void rebuild();
      }
    }),
  );

  safe('registerEvents', () => OmniEvents.registerEvents(controller));

  console.log('[OmniSearch] background loaded');
  void ensureLoaded();
})();

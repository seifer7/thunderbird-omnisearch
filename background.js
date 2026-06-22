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
    // Initial deserialize from IndexedDB still in progress — the UI shows a
    // loading indicator and disables search until this clears.
    if (!loaded && !building) {
      return { state: 'loading', count: 0, headerOnly: 0 };
    }
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
            engine = OmniEngine.deserialize(json);
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

  // ---- UI message handling ----
  async function handle(msg) {
    switch (msg.type) {
      case 'search':
        // Don't block on the initial load; tell the UI to show "loading" and
        // let it retry once the index is ready.
        if (!loaded) {
          ensureLoaded();
          return { type: 'loading' };
        }
        return { type: 'results', results: engine.search(msg.query, msg.limit || 100) };
      case 'status':
        ensureLoaded(); // kick off / continue loading; don't await
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
        try {
          await messenger.messageDisplay.open({ messageId: Number(msg.id), location: 'tab' });
        } catch (e) {
          try {
            const tab = await messenger.mailTabs.getCurrent();
            await messenger.mailTabs.setSelectedMessages(tab.id, [Number(msg.id)]);
          } catch (e2) {
            /* give up silently */
          }
        }
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

'use strict';
// Orchestrator: owns the in-memory index, persists it, applies live updates,
// and answers search/command messages from the UI page. Depends on the globals
// OmniEngine, OmniIndexer, OmniEvents, OmniStore (loaded first; see manifest).
(function () {
  let engine = new OmniEngine();
  let loaded = false;
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

  // Lazy-load the persisted index on first use (handles background wake-ups).
  async function ensureLoaded() {
    if (loaded) return;
    const json = await OmniStore.loadIndex();
    if (json) {
      engine = OmniEngine.deserialize(json);
      const meta = await OmniStore.loadMeta();
      headerOnly = (meta && meta.headerOnly) || 0;
      updatedAt = meta && meta.updatedAt;
    }
    loaded = true;
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
    await ensureLoaded();
    switch (msg.type) {
      case 'search':
        return { type: 'results', results: engine.search(msg.query, msg.limit || 100) };
      case 'status':
        return { type: 'status', status: status() };
      case 'rebuild':
        void rebuild();
        return { type: 'status', status: status() };
      case 'reconcile':
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

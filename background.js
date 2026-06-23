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
  let updatedAt;
  // Cached document count reported by the worker (we can't read engine.size
  // synchronously across the worker boundary).
  let engineCount = 0;

  // ---- Worker RPC ----
  // The engine runs in lib/engine.worker.js. Every call posts a request tagged
  // with a reqId and resolves when the worker echoes that id back.
  const worker = new Worker('lib/engine.worker.js');
  const pending = new Map();
  let nextReqId = 1;
  worker.onmessage = (e) => {
    const { reqId, ok, result, error } = e.data;
    const resolver = pending.get(reqId);
    if (!resolver) return;
    pending.delete(reqId);
    if (ok) resolver.resolve(result);
    else resolver.reject(new Error(error));
  };
  worker.onerror = (e) => console.error('[OmniSearch] worker error:', e.message || e);
  function call(cmd, payload) {
    const reqId = nextReqId++;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      worker.postMessage({ reqId, cmd, ...payload });
    });
  }

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
    async flush(meta) {
      const r = await call('flush', meta || {});
      engineCount = r.count;
      headerOnly = r.headerOnly;
    },
  };

  function status() {
    if (building) {
      return { state: 'building', count: engineCount, total: buildTotal, headerOnly, progress: buildProgress, updatedAt };
    }
    return {
      state: engineCount > 0 ? 'ready' : 'empty',
      count: engineCount,
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
          // The worker reads IndexedDB and deserializes off the UI thread.
          const r = await call('load');
          engineCount = r.count;
          headerOnly = r.headerOnly || 0;
          updatedAt = r.updatedAt;
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
    await engineProxy.reset();
    try {
      const result = await OmniIndexer.fullBuild(engineProxy, (fraction, _count, ho, total) => {
        buildProgress = fraction;
        headerOnly = ho;
        buildTotal = total || 0;
      });
      headerOnly = result.headerOnly;
    } finally {
      building = false;
    }
    await engineProxy.flush({ headerOnly });
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
        return { type: 'results', results: await engineProxy.search(msg.query, msg.limit || 100) };
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
        if (engineCount === 0) void rebuild();
      }
    }),
  );

  safe('registerEvents', () => OmniEvents.registerEvents(controller));

  console.log('[OmniSearch] background loaded');
  void ensureLoaded();
})();

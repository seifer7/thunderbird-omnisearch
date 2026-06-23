'use strict';
// Search-engine worker. Owns the MiniSearch index, all (de)serialization, and
// IndexedDB persistence — so the multi-second JSON.parse/stringify + index
// rebuild run OFF the UI thread and Thunderbird never freezes. The main thread
// (background.js) only does messenger.* work and talks to us via postMessage.
//
// importScripts resolves relative to this file (lib/), so the existing modules
// are reused unchanged: they attach OmniEngine / OmniStore / MiniSearch to the
// worker's globalThis, and both indexedDB and MiniSearch are available here.
importScripts('minisearch.js', 'engine.js', 'store.js');

let engine = new OmniEngine();
let headerOnly = 0;
let updatedAt;

// ---- Debounced persistence (mirrors the old background.js timing) ----
let persistTimer;
async function persistNow() {
  updatedAt = Date.now();
  await OmniStore.saveIndex(engine.serialize(), { count: engine.size, headerOnly, updatedAt });
}
function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persistNow(), 1500);
}

async function dispatch(cmd, msg) {
  switch (cmd) {
    case 'load': {
      const json = await OmniStore.loadIndex();
      if (json) {
        engine = await OmniEngine.deserialize(json);
        const meta = await OmniStore.loadMeta();
        headerOnly = (meta && meta.headerOnly) || 0;
        updatedAt = meta && meta.updatedAt;
      }
      return { count: engine.size, headerOnly, updatedAt };
    }
    case 'search':
      return { results: engine.search(msg.query, msg.limit || 100) };
    case 'reset':
      engine = new OmniEngine();
      headerOnly = 0;
      return { count: 0 };
    case 'addAll':
      // Bulk build path: no auto-persist; background calls 'flush' at the end.
      engine.addAll(msg.docs || []);
      return { count: engine.size };
    case 'upsert':
      engine.upsert(msg.doc);
      persistSoon();
      return { count: engine.size };
    case 'remove':
      for (const id of msg.ids || []) engine.remove(id);
      persistSoon();
      return { count: engine.size };
    case 'knownIds':
      return { ids: engine.knownIds() };
    case 'flush':
      if (typeof msg.headerOnly === 'number') headerOnly = msg.headerOnly;
      await persistNow();
      return { count: engine.size, headerOnly };
    default:
      return {};
  }
}

onmessage = async (e) => {
  const { reqId, cmd } = e.data;
  try {
    const result = await dispatch(cmd, e.data);
    postMessage({ reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};

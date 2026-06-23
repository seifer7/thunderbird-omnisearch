'use strict';
// IndexedDB persistence for the index. We store the index as a structured-clone
// OBJECT (engine.toData()), not a JSON string — IndexedDB clones large object
// graphs without JSON.stringify/parse (faster) and without V8's max-string-length
// ceiling. The `unlimitedStorage` permission lets it grow past localStorage's
// ~5 MB cap. Exposes globalThis.OmniStore.
(function () {
  const DB_NAME = 'omnisearch';
  const STORE = 'kv';
  const KEY_INDEX = 'serializedIndex';
  const KEY_META = 'meta';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, run) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE, mode);
          const request = run(transaction.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => db.close();
        }),
    );
  }

  async function saveIndex(data, meta) {
    await tx('readwrite', (s) => s.put(data, KEY_INDEX));
    await tx('readwrite', (s) => s.put(meta, KEY_META));
  }

  function loadIndex() {
    return tx('readonly', (s) => s.get(KEY_INDEX));
  }

  function loadMeta() {
    return tx('readonly', (s) => s.get(KEY_META));
  }

  async function clearIndex() {
    await tx('readwrite', (s) => s.delete(KEY_INDEX));
    await tx('readwrite', (s) => s.delete(KEY_META));
  }

  globalThis.OmniStore = { saveIndex, loadIndex, loadMeta, clearIndex };
})();

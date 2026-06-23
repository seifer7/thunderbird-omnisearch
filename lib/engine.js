'use strict';
// SearchEngine: the search-engine wrapper. The rest of the extension talks only
// to globalThis.OmniEngine, so swapping MiniSearch for FlexSearch/Orama later
// means editing this one file. Depends on globalThis.MiniSearch (lib/minisearch.js).
(function () {
  const MINISEARCH_OPTIONS = {
    idField: 'id',
    // Tokenised + indexed for full-text matching.
    fields: ['subject', 'from', 'to', 'body'],
    // Retained on the index for display (NOT the body — only a short preview,
    // to stay memory-lean; the full message is re-opened on click).
    storeFields: ['subject', 'from', 'to', 'date', 'folderName', 'preview', 'bodyAvailable', 'headerMessageId', 'encrypted'],
  };

  const SEARCH_OPTIONS = {
    // Boost matches in headers above the body, like OmniSearch boosts titles.
    boost: { subject: 3, from: 2, to: 1.5, body: 1 },
    // Typo tolerance (edit distance) + "as you type" prefix matching.
    fuzzy: 0.2,
    prefix: true,
    combineWith: 'AND',
  };

  class SearchEngine {
    constructor() {
      this.mini = new MiniSearch(MINISEARCH_OPTIONS);
      // MiniSearch has no public "enumerate all ids" API, so we track them
      // alongside the index to drive reconciliation.
      this.ids = new Set();
    }

    get size() {
      return this.mini.documentCount;
    }

    // Number of unique index terms — a proxy for index/memory size, for
    // diagnostics. Reaches into MiniSearch internals (the inverted index Map).
    get termCount() {
      return (this.mini && this.mini._index && this.mini._index.size) || 0;
    }

    has(id) {
      return this.ids.has(id);
    }

    knownIds() {
      return [...this.ids];
    }

    addAll(docs) {
      this.mini.addAll(docs);
      for (const doc of docs) this.ids.add(doc.id);
    }

    // Yields to the event loop between chunks (MiniSearch.addAllAsync), so the
    // worker can answer search messages mid-build — search stays available while
    // indexing. The index is consistent between chunks (single-threaded).
    async addAllAsync(docs) {
      await this.mini.addAllAsync(docs);
      for (const doc of docs) this.ids.add(doc.id);
    }

    upsert(doc) {
      if (this.ids.has(doc.id)) this.mini.replace(doc);
      else this.mini.add(doc);
      this.ids.add(doc.id);
    }

    remove(id) {
      if (this.ids.has(id)) {
        this.mini.discard(id);
        this.ids.delete(id);
      }
    }

    search(query, limit = 100) {
      const q = (query || '').trim();
      if (!q) return [];
      const hits = this.mini.search(q, SEARCH_OPTIONS);
      return hits.slice(0, limit).map((h) => ({
        id: String(h.id),
        headerMessageId: h.headerMessageId || '',
        encrypted: !!h.encrypted,
        score: h.score,
        subject: h.subject || '',
        from: h.from || '',
        to: h.to || '',
        date: h.date || 0,
        folderName: h.folderName || '',
        preview: h.preview || '',
        bodyAvailable: h.bodyAvailable !== false,
      }));
    }

    // A plain, structured-clone-safe snapshot of the index — stored in IndexedDB
    // as an object (NOT a JSON string). Avoids JSON.stringify/parse of a
    // multi-hundred-MB string on save/load (slow, and can exceed V8's max string
    // length on big mailboxes). mini.toJSON() already returns a plain object that
    // MiniSearch.loadJS consumes directly.
    toData() {
      return { v: 1, mini: this.mini.toJSON(), ids: [...this.ids] };
    }

    // Rebuild from a toData() snapshot. Runs only inside the engine worker (off
    // the UI thread), so the synchronous loader is fine. Back-compat: an older
    // build stored a JSON string, so parse that first if we get one.
    static deserialize(data) {
      if (typeof data === 'string') data = JSON.parse(data);
      const engine = new SearchEngine();
      engine.mini = MiniSearch.loadJS(data.mini, MINISEARCH_OPTIONS);
      engine.ids = new Set(data.ids || []);
      return engine;
    }
  }

  globalThis.OmniEngine = SearchEngine;
})();

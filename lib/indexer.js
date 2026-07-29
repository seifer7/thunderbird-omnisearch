'use strict';
// Reads mail through the Thunderbird WebExtension API and turns messages into
// index docs. This is the part that bypasses Gloda: we walk folders and read
// bodies ourselves. Exposes globalThis.OmniIndexer.
(function () {
  function hwc() {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  // Number of message-body reads (messenger.messages.getFull) kept in flight at
  // once. Indexing is I/O-bound on these backend round-trips, so we overlap many
  // — scaled past core count since they mostly wait on the backend, not the CPU.
  const READ_CONCURRENCY = clamp(hwc() * 4, 16, 64);
  // Flush docs to the engine worker in batches this large, to amortise the
  // postMessage round-trip without starving it.
  const FLUSH_BATCH = 200;

  // Account ids the user has excluded from the index (settings.excludedAccounts).
  // Absent/empty ⇒ every account is included (opt-out model, so new accounts are
  // indexed by default).
  async function getExcludedAccounts() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      return new Set(s.excludedAccounts || []);
    } catch (e) {
      return new Set();
    }
  }

  // Whether Junk (Spam) and Trash folders should be indexed. Default false —
  // they're excluded from search unless the user opts in.
  async function getIncludeSpamTrash() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      return !!s.includeSpamTrash;
    } catch (e) {
      return false;
    }
  }

  // Whether to index the decrypted bodies of OpenPGP/S-MIME encrypted messages.
  // Default false — encrypted mail is indexed by header only, so no decrypted
  // plaintext is written to the on-disk index.
  async function getIndexEncryptedBodies() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      return !!s.indexEncryptedBodies;
    } catch (e) {
      return false;
    }
  }

  // Folder-level filter settings.
  // mode 'all'      → index every folder except those in excludedFolderIds.
  // mode 'included' → index only folders explicitly listed in includedFolderIds.
  // Default: mode 'all', no exclusions.
  async function getFolderFilter() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      return {
        mode: s.folderIndexMode || 'all',
        includedFolderIds: new Set(s.includedFolderIds || []),
        excludedFolderIds: new Set(s.excludedFolderIds || []),
      };
    } catch (e) {
      return { mode: 'all', includedFolderIds: new Set(), excludedFolderIds: new Set() };
    }
  }

  // Max indexed body length (chars). Smaller = smaller index = faster/lighter
  // cold load. Configurable via settings.bodyIndexLimit; default matches
  // OmniExtract.DEFAULT_MAX_BODY.
  async function getMaxBody() {
    try {
      const r = await messenger.storage.local.get('settings');
      const v = r.settings && r.settings.bodyIndexLimit;
      return Number.isFinite(v) && v > 0 ? v : OmniExtract.DEFAULT_MAX_BODY;
    } catch (e) {
      return OmniExtract.DEFAULT_MAX_BODY;
    }
  }

  // Earliest message date (ms) to include in the index. Messages dated before
  // this timestamp are skipped at every indexing path. Returns 0 when no date
  // limit is configured (all mail is eligible).
  // The setting is stored as a 'YYYY-MM-DD' string; absent / empty → no filter.
  async function getIndexStartDate() {
    try {
      const r = await messenger.storage.local.get('settings');
      const s = r.settings || {};
      if (!s.indexStartDate) return 0;
      const t = new Date(s.indexStartDate).getTime();
      return Number.isFinite(t) ? t : 0;
    } catch (e) {
      return 0;
    }
  }

  // A folder is Junk/Trash if its type (older API) or specialUse (newer API)
  // marks it as such.
  function isSpamOrTrash(folder) {
    if (!folder) return false;
    const t = folder.type;
    const su = folder.specialUse || [];
    return t === 'junk' || t === 'trash' || su.indexOf('junk') !== -1 || su.indexOf('trash') !== -1;
  }

  // Recursively flatten the folders of every *included* account into a flat list,
  // skipping Junk/Trash (and their subfolders) unless the user opted them in, and
  // applying the folder-level include/exclude filter from settings.
  async function flattenFolders() {
    const excluded = await getExcludedAccounts();
    const includeSpamTrash = await getIncludeSpamTrash();
    const folderFilter = await getFolderFilter();
    const accounts = await messenger.accounts.list(true);
    const out = [];
    const walk = (folders) => {
      for (const f of folders || []) {
        if (!includeSpamTrash && isSpamOrTrash(f)) continue; // skip folder + subfolders
        if (folderFilter.mode === 'all') {
          // Exclude listed folders and all their descendants.
          if (folderFilter.excludedFolderIds.has(f.id)) continue;
          out.push(f);
          walk(f.subFolders);
        } else {
          // 'included' mode: only index folders explicitly selected.
          // Always recurse so a selected descendant of an unselected parent is found.
          if (folderFilter.includedFolderIds.has(f.id)) out.push(f);
          walk(f.subFolders);
        }
      }
    };
    for (const account of accounts) {
      if (excluded.has(account.id)) continue;
      walk(account.folders || (account.rootFolder && account.rootFolder.subFolders));
    }
    return out;
  }

  function toMillis(date) {
    if (date instanceof Date) return date.getTime();
    const t = new Date(date).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // The already-resolved header fields a doc needs (the rest — body/preview —
  // comes from extraction). RFC Message-ID is stable across restarts, unlike the
  // numeric id, so it's used to re-resolve a message when opening it.
  function headerMeta(header) {
    return {
      id: String(header.id),
      headerMessageId: header.headerMessageId || '',
      subject: header.subject || '',
      from: header.author || '',
      to: (header.recipients || []).join(', '),
      date: toMillis(header.date),
      folderName: (header.folder && header.folder.name) || '',
      accountId: (header.folder && header.folder.accountId) || '',
    };
  }

  // Build an index doc from a MessageHeader, reading its body via getFull. Text
  // extraction is delegated to OmniExtract (shared with the worker pool). Bodies
  // are read WITHOUT decrypting by default; encrypted mail is header-only unless
  // indexEncrypted is set, in which case the decrypt read happens here, on the
  // main thread — so decrypted plaintext is never sent to the extractor pool
  // unless the user opted in. Used for incremental (single-message) updates.
  async function headerToDoc(header, indexEncrypted) {
    const meta = headerMeta(header);
    const maxBody = await getMaxBody();
    let full;
    try {
      full = await messenger.messages.getFull(header.id, { decrypt: false });
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, false);
    }
    const r = OmniExtract.buildDoc(meta, full, indexEncrypted, maxBody);
    if (!r.needsDecrypt) return r.doc;
    try {
      const dec = await messenger.messages.getFull(header.id); // decrypt defaults to true
      return OmniExtract.buildDecryptedDoc(meta, dec, maxBody).doc;
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, true);
    }
  }

  // Iterate every message header in a folder, paging through the list.
  async function forEachHeader(folderId, fn) {
    let page = await messenger.messages.list(folderId);
    for (const header of page.messages) await fn(header);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      for (const header of page.messages) await fn(header);
    }
  }

  // Sum the real message count across folders, for an accurate progress total.
  // The MailFolder objects from accounts.list() don't carry a count, so we ask
  // folders.getFolderInfo() (falling back to any messageCount that is present).
  // Returns the raw total (may be 0); callers that use it as a denominator should
  // clamp themselves.
  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
  }

  async function totalMessageCount(folders, signal) {
    let total = 0;
    for (const f of folders) {
      throwIfAborted(signal);
      try {
        const info = await messenger.folders.getFolderInfo(f.id);
        throwIfAborted(signal);
        total += (info && info.totalMessageCount) || 0;
      } catch (e) {
        throwIfAborted(signal);
        total += f.messageCount || 0;
      }
    }
    return total;
  }

  // Stream every message header across all folders. Lightweight (list pages),
  // it just feeds the pipeline; the heavy getFull reads happen downstream.
  // Headers dated before startDateMs (when non-zero) are skipped here so every
  // downstream path (build, count, reconcile) applies the same filter.
  async function* allHeaders(folders, startDateMs) {
    for (const folder of folders) {
      let page = await messenger.messages.list(folder.id);
      for (const header of page.messages) {
        if (!startDateMs || toMillis(header.date) >= startDateMs) yield header;
      }
      while (page.id) {
        page = await messenger.messages.continueList(page.id);
        for (const header of page.messages) {
          if (!startDateMs || toMillis(header.date) >= startDateMs) yield header;
        }
      }
    }
  }

  // Count eligible headers across folders, applying the date filter. Used by
  // countEligibleInBackground when a start date is configured, because
  // getFolderInfo returns a raw total that ignores the date cut-off.
  async function countEligibleHeaders(folders, startDateMs, signal) {
    let count = 0;
    for (const folder of folders) {
      throwIfAborted(signal);
      let page = await messenger.messages.list(folder.id);
      throwIfAborted(signal);
      for (const h of page.messages) {
        if (!startDateMs || toMillis(h.date) >= startDateMs) count++;
      }
      while (page.id) {
        throwIfAborted(signal);
        page = await messenger.messages.continueList(page.id);
        throwIfAborted(signal);
        for (const h of page.messages) {
          if (!startDateMs || toMillis(h.date) >= startDateMs) count++;
        }
      }
    }
    return count;
  }

  // Read one message body and turn it into a doc, using the extractor worker
  // pool for the CPU-heavy text extraction (off the main thread, across cores).
  // The getFull I/O stays here because messenger.* is main-thread-only.
  async function readDoc(header, indexEncrypted, extractor, maxBody) {
    const meta = headerMeta(header);
    let full;
    try {
      full = await messenger.messages.getFull(header.id, { decrypt: false });
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, false);
    }
    const r = await extractor.run('plain', meta, full, indexEncrypted, maxBody);
    if (!r.needsDecrypt) return r.doc;
    try {
      const dec = await messenger.messages.getFull(header.id); // decrypt
      return (await extractor.run('decrypted', meta, dec, false, maxBody)).doc;
    } catch (e) {
      return OmniExtract.makeDoc(meta, '', false, true);
    }
  }

  // Full index rebuild as a producer/consumer pipeline: READ_CONCURRENCY workers
  // pull headers, read bodies (I/O) and extract text (pool, CPU) concurrently,
  // buffering finished docs and flushing them to the engine worker in batches —
  // so message I/O, multi-core extraction and index tokenisation all overlap
  // instead of running one batch at a time. A worker that triggers a flush awaits
  // the engine while the others keep reading, which also applies natural
  // backpressure when the engine falls behind. onProgress drives the UI bar.
  async function fullBuild(engine, extractor, onProgress) {
    const folders = await flattenFolders();
    const total = Math.max(await totalMessageCount(folders), 1);
    const indexEncrypted = await getIndexEncryptedBodies();
    const maxBody = await getMaxBody();
    const startDateMs = await getIndexStartDate();

    let count = 0;
    let headerOnly = 0;
    let buffer = [];

    const headers = allHeaders(folders, startDateMs);
    // Serialise pulls from the shared async iterator (concurrent .next() is
    // unsafe); the real concurrency is in the per-header getFull/extract work.
    let pullChain = Promise.resolve({ done: true });
    function nextHeader() {
      pullChain = pullChain.then(() => headers.next());
      return pullChain.then((r) => (r.done ? null : r.value));
    }

    async function flush(force) {
      if (buffer.length === 0 || (!force && buffer.length < FLUSH_BATCH)) return;
      const batch = buffer;
      buffer = [];
      await engine.addAll(batch);
      onProgress(Math.min(count / total, 0.99), count, headerOnly, total);
    }

    async function worker() {
      for (;;) {
        const header = await nextHeader();
        if (!header) break;
        const doc = await readDoc(header, indexEncrypted, extractor, maxBody);
        if (!doc.bodyAvailable) headerOnly++;
        count++;
        buffer.push(doc);
        await flush(false);
      }
    }

    await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
    await flush(true);
    onProgress(1, count, headerOnly, total);
    return { count, headerOnly };
  }

  // Collect the id of every message currently in every folder (for reconcile).
  // Applies the same date and folder filters as the build, so reconcile naturally
  // removes messages that fall outside the current index scope.
  async function collectAllMessageIds() {
    const ids = new Set();
    const folders = await flattenFolders();
    const startDateMs = await getIndexStartDate();
    for (const folder of folders) {
      await forEachHeader(folder.id, (header) => {
        if (!startDateMs || toMillis(header.date) >= startDateMs) {
          ids.add(String(header.id));
        }
      });
    }
    return ids;
  }

  globalThis.OmniIndexer = {
    flattenFolders,
    totalMessageCount,
    countEligibleHeaders,
    headerToDoc,
    fullBuild,
    collectAllMessageIds,
    getExcludedAccounts,
    getIncludeSpamTrash,
    getIndexEncryptedBodies,
    getFolderFilter,
    getIndexStartDate,
    isSpamOrTrash,
    toMillis,
  };
})();

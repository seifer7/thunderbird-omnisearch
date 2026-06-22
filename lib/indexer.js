'use strict';
// Reads mail through the Thunderbird WebExtension API and turns messages into
// index docs. This is the part that bypasses Gloda: we walk folders and read
// bodies ourselves. Exposes globalThis.OmniIndexer.
(function () {
  const PREVIEW_LEN = 200;
  // Read this many message bodies concurrently. Each body read is a backend
  // round-trip (disk read + parse); overlapping them is the main speedup.
  const CONCURRENCY = 20;
  // Cap indexed body length — bounds tokenisation cost for giant messages
  // without hurting search usefulness.
  const MAX_BODY = 20000;

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

  // Recursively flatten the folders of every *included* account into a flat list.
  async function flattenFolders() {
    const excluded = await getExcludedAccounts();
    const accounts = await messenger.accounts.list(true);
    const out = [];
    const walk = (folders) => {
      for (const f of folders || []) {
        out.push(f);
        walk(f.subFolders);
      }
    };
    for (const account of accounts) {
      if (excluded.has(account.id)) continue;
      walk(account.folders || (account.rootFolder && account.rootFolder.subFolders));
    }
    return out;
  }

  function stripHtml(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collectParts(part, plain, html) {
    if (!part) return;
    const ct = (part.contentType || '').toLowerCase();
    if (typeof part.body === 'string' && part.body.length) {
      if (ct.startsWith('text/plain')) plain.push(part.body);
      else if (ct.startsWith('text/html')) html.push(part.body);
    }
    for (const child of part.parts || []) collectParts(child, plain, html);
  }

  function cap(text) {
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  }

  // Read a message body. Returns the text and whether it was available — for
  // IMAP messages not yet synced offline, no body may be available, in which
  // case we still index the headers so the message is never silently missing.
  //
  // Prefers listInlineTextParts() (lighter: just the inline text, skipping the
  // full MIME tree + attachment decoding) and falls back to getFull().
  async function readBody(messageId) {
    if (messenger.messages.listInlineTextParts) {
      try {
        const parts = await messenger.messages.listInlineTextParts(messageId);
        const plain = [];
        const html = [];
        for (const p of parts || []) {
          const ct = (p.contentType || '').toLowerCase();
          const content = p.content != null ? p.content : p.body;
          if (typeof content !== 'string') continue;
          if (ct.startsWith('text/plain')) plain.push(content);
          else if (ct.startsWith('text/html')) html.push(content);
        }
        let text = plain.join('\n').trim();
        if (!text && html.length) text = stripHtml(html.join('\n'));
        if (text) return { text: cap(text), available: true };
        // empty result — fall through to getFull below
      } catch (e) {
        /* fall through to getFull */
      }
    }

    try {
      const full = await messenger.messages.getFull(messageId);
      const plain = [];
      const html = [];
      collectParts(full, plain, html);
      let text = plain.join('\n').trim();
      if (!text && html.length) text = stripHtml(html.join('\n'));
      return { text: cap(text), available: text.length > 0 };
    } catch (e) {
      return { text: '', available: false };
    }
  }

  function toMillis(date) {
    if (date instanceof Date) return date.getTime();
    const t = new Date(date).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Build an index doc from a MessageHeader, reading its body.
  async function headerToDoc(header) {
    const { text, available } = await readBody(header.id);
    const recipients = header.recipients || [];
    return {
      id: String(header.id),
      subject: header.subject || '',
      from: header.author || '',
      to: recipients.join(', '),
      body: text,
      preview: text.slice(0, PREVIEW_LEN),
      date: toMillis(header.date),
      folderName: (header.folder && header.folder.name) || '',
      bodyAvailable: available,
    };
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
  async function totalMessageCount(folders) {
    let total = 0;
    for (const f of folders) {
      try {
        const info = await messenger.folders.getFolderInfo(f.id);
        total += (info && info.totalMessageCount) || 0;
      } catch (e) {
        total += f.messageCount || 0;
      }
    }
    return Math.max(total, 1);
  }

  // Full index rebuild: walk every folder, read every message. Bodies are read
  // CONCURRENCY at a time (the speed lever). onProgress(fraction 0..1, count,
  // headerOnly) drives the UI progress bar.
  async function fullBuild(engine, onProgress) {
    const folders = await flattenFolders();
    const total = await totalMessageCount(folders);

    let count = 0;
    let headerOnly = 0;

    for (const folder of folders) {
      // Collect this folder's headers (lightweight), then build docs in
      // bounded concurrent chunks so backend body reads overlap.
      const headers = [];
      await forEachHeader(folder.id, (header) => {
        headers.push(header);
      });

      for (let i = 0; i < headers.length; i += CONCURRENCY) {
        const slice = headers.slice(i, i + CONCURRENCY);
        const docs = await Promise.all(slice.map((h) => headerToDoc(h)));
        for (const doc of docs) {
          if (!doc.bodyAvailable) headerOnly++;
          count++;
        }
        engine.addAll(docs);
        onProgress(Math.min(count / total, 0.99), count, headerOnly, total);
        // Yield so Thunderbird stays responsive.
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    onProgress(1, count, headerOnly, total);
    return { count, headerOnly };
  }

  // Collect the id of every message currently in every folder (for reconcile).
  async function collectAllMessageIds() {
    const ids = new Set();
    const folders = await flattenFolders();
    for (const folder of folders) {
      await forEachHeader(folder.id, (header) => {
        ids.add(String(header.id));
      });
    }
    return ids;
  }

  globalThis.OmniIndexer = { flattenFolders, headerToDoc, fullBuild, collectAllMessageIds, getExcludedAccounts };
})();

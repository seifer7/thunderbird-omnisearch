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

  // A folder is Junk/Trash if its type (older API) or specialUse (newer API)
  // marks it as such.
  function isSpamOrTrash(folder) {
    if (!folder) return false;
    const t = folder.type;
    const su = folder.specialUse || [];
    return t === 'junk' || t === 'trash' || su.indexOf('junk') !== -1 || su.indexOf('trash') !== -1;
  }

  // Recursively flatten the folders of every *included* account into a flat list,
  // skipping Junk/Trash (and their subfolders) unless the user opted them in.
  async function flattenFolders() {
    const excluded = await getExcludedAccounts();
    const includeSpamTrash = await getIncludeSpamTrash();
    const accounts = await messenger.accounts.list(true);
    const out = [];
    const walk = (folders) => {
      for (const f of folders || []) {
        if (!includeSpamTrash && isSpamOrTrash(f)) continue; // skip folder + subfolders
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

  // True if a (non-decrypted) MIME tree is an OpenPGP/S-MIME encrypted message,
  // or carries an inline-PGP armored block. Signed-but-not-encrypted mail is NOT
  // treated as encrypted (its content is plaintext).
  function isEncrypted(part) {
    if (!part) return false;
    const ct = (part.contentType || '').toLowerCase();
    if (ct.indexOf('multipart/encrypted') !== -1) return true; // PGP/MIME
    if (ct.indexOf('application/pgp-encrypted') !== -1) return true;
    if (ct.indexOf('pkcs7-mime') !== -1) return true; // S/MIME (application/[x-]pkcs7-mime)
    if (
      ct.startsWith('text/') &&
      typeof part.body === 'string' &&
      part.body.indexOf('-----BEGIN PGP MESSAGE-----') !== -1
    ) {
      return true;
    }
    for (const child of part.parts || []) if (isEncrypted(child)) return true;
    return false;
  }

  function extractText(full) {
    const plain = [];
    const html = [];
    collectParts(full, plain, html);
    let text = plain.join('\n').trim();
    if (!text && html.length) text = stripHtml(html.join('\n'));
    return text;
  }

  // Read the decrypted plaintext — only used when the user has opted to index
  // encrypted message bodies.
  async function readDecrypted(messageId) {
    try {
      const full = await messenger.messages.getFull(messageId); // decrypt defaults to true
      return extractText(full);
    } catch (e) {
      return '';
    }
  }

  // Read a message body for indexing. Crucially this reads WITHOUT decrypting
  // (decrypt:false), so the decrypted plaintext of OpenPGP/S-MIME mail is never
  // written to the on-disk index by default — encrypted messages are indexed by
  // header only. The user can opt in (indexEncrypted) to index their bodies.
  //
  // Returns { text, available, encrypted }. `available:false` for unreadable or
  // header-only-encrypted messages — headers are still indexed either way.
  async function readBody(messageId, indexEncrypted) {
    let full;
    try {
      full = await messenger.messages.getFull(messageId, { decrypt: false });
    } catch (e) {
      return { text: '', available: false, encrypted: false };
    }

    if (isEncrypted(full)) {
      if (!indexEncrypted) {
        // Header-only: do not decrypt, do not store any body-derived content.
        return { text: '', available: false, encrypted: true };
      }
      const text = await readDecrypted(messageId);
      return { text: cap(text), available: text.length > 0, encrypted: true };
    }

    const text = extractText(full);
    return { text: cap(text), available: text.length > 0, encrypted: false };
  }

  function toMillis(date) {
    if (date instanceof Date) return date.getTime();
    const t = new Date(date).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Build an index doc from a MessageHeader, reading its body. Encrypted bodies
  // are skipped unless indexEncrypted is true (see readBody).
  async function headerToDoc(header, indexEncrypted) {
    const { text, available, encrypted } = await readBody(header.id, indexEncrypted);
    const recipients = header.recipients || [];
    return {
      id: String(header.id),
      // RFC Message-ID — stable across restarts, unlike the numeric id. Used to
      // re-resolve the current message when opening (numeric ids can go stale).
      headerMessageId: header.headerMessageId || '',
      encrypted: !!encrypted,
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
    const indexEncrypted = await getIndexEncryptedBodies();

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
        const docs = await Promise.all(slice.map((h) => headerToDoc(h, indexEncrypted)));
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

  globalThis.OmniIndexer = {
    flattenFolders,
    headerToDoc,
    fullBuild,
    collectAllMessageIds,
    getExcludedAccounts,
    getIncludeSpamTrash,
    getIndexEncryptedBodies,
    isSpamOrTrash,
  };
})();

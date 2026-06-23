'use strict';
// Pure, messenger-free text extraction. Turns a MIME tree (from
// messenger.messages.getFull) into an index doc. Shared by the main-thread
// indexer (incremental updates) and the extractor worker pool (bulk rebuild),
// so the CPU-heavy HTML stripping can run off the main thread and across cores.
// Exposes globalThis.OmniExtract — works both as a background script and via
// importScripts() inside a worker.
(function () {
  const PREVIEW_LEN = 200;
  // Cap indexed body length — bounds tokenisation cost for giant messages
  // without hurting search usefulness.
  const MAX_BODY = 20000;

  function stripHtml(html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      // Drop quoted reply content: Gmail/Outlook/Apple Mail wrap the quoted
      // message in <blockquote>. Removing it stops long threads from indexing the
      // same text once per reply (the quoted text stays searchable via the
      // original message).
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
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

  // Remove quoted reply text from a plain-text body so a long thread doesn't
  // index the same content once per message. Drops '>'-quoted lines and truncates
  // at common attribution / "Original Message" markers (top-posting is the norm:
  // new text on top, quote below). If stripping would leave nothing (a quote-only
  // message, e.g. a bare forward), keep the original so we still index it.
  function stripQuoted(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*>/.test(line)) continue; // quoted line
      if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(line)) break;
      if (/^\s*On\b.+\bwrote:\s*$/i.test(line)) break; // English
      if (/^\s*Am\b.+\bschrieb\b.*:\s*$/i.test(line)) break; // German
      if (/^\s*Le\b.+\ba écrit\s*:\s*$/i.test(line)) break; // French
      if (/^\s*El\b.+\bescribió:\s*$/i.test(line)) break; // Spanish
      out.push(line);
    }
    const stripped = out.join('\n').trim();
    return stripped || text.trim();
  }

  function extractText(full) {
    const plain = [];
    const html = [];
    collectParts(full, plain, html);
    let text = plain.join('\n').trim();
    if (text) return stripQuoted(text);
    // HTML-only body: quoted <blockquote> content is already dropped in stripHtml.
    if (html.length) return stripHtml(html.join('\n'));
    return '';
  }

  // headerMeta carries the already-resolved header fields (built on the main
  // thread, since they come off the MessageHeader object): id, headerMessageId,
  // subject, from, to, date (ms), folderName.
  function makeDoc(headerMeta, text, available, encrypted) {
    return {
      id: headerMeta.id,
      headerMessageId: headerMeta.headerMessageId || '',
      encrypted: !!encrypted,
      subject: headerMeta.subject || '',
      from: headerMeta.from || '',
      to: headerMeta.to || '',
      body: text,
      preview: text.slice(0, PREVIEW_LEN),
      date: headerMeta.date || 0,
      folderName: headerMeta.folderName || '',
      bodyAvailable: available,
    };
  }

  // Build a doc from a NON-decrypted MIME tree. Returns { doc } normally, or
  // { needsDecrypt: true } when the message is encrypted and the caller opted to
  // index encrypted bodies — the decrypt read must happen on the main thread.
  function buildDoc(headerMeta, full, indexEncrypted) {
    if (isEncrypted(full)) {
      if (!indexEncrypted) return { doc: makeDoc(headerMeta, '', false, true) };
      return { needsDecrypt: true };
    }
    const text = cap(extractText(full));
    return { doc: makeDoc(headerMeta, text, text.length > 0, false) };
  }

  // Build a doc from an already-decrypted MIME tree (encrypted message, opted in).
  function buildDecryptedDoc(headerMeta, full) {
    const text = cap(extractText(full));
    return { doc: makeDoc(headerMeta, text, text.length > 0, true) };
  }

  globalThis.OmniExtract = {
    PREVIEW_LEN,
    MAX_BODY,
    isEncrypted,
    extractText,
    makeDoc,
    buildDoc,
    buildDecryptedDoc,
  };
})();

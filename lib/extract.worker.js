'use strict';
// Extractor pool worker. Pure CPU: turns a fetched MIME tree into an index doc
// (HTML stripping + text extraction), off the main thread and across cores. The
// main thread does the messenger.messages.getFull I/O and posts the result here.
importScripts('extract.js');

onmessage = (e) => {
  const { reqId, mode, headerMeta, full, indexEncrypted } = e.data;
  try {
    const result =
      mode === 'decrypted'
        ? OmniExtract.buildDecryptedDoc(headerMeta, full)
        : OmniExtract.buildDoc(headerMeta, full, indexEncrypted);
    postMessage({ reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};

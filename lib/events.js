'use strict';
// Keeps the index correct as mail changes — the thing Gloda fails to do
// reliably. Subscribes to message events and applies incremental updates, plus
// reconcile() which re-walks folders to self-heal drift. Exposes globalThis.OmniEvents.
//
// A "controller" is { engine, persistSoon() } supplied by background.js.
(function () {
  async function upsertHeader(ctrl, header, opts) {
    const folder = header.folder;
    // Don't index messages from accounts the user excluded, or from Junk/Trash
    // unless they opted those in.
    if (folder) {
      if (opts.excluded && opts.excluded.has(folder.accountId)) return;
      if (!opts.includeSpamTrash && OmniIndexer.isSpamOrTrash(folder)) return;
    }
    const doc = await OmniIndexer.headerToDoc(header, opts.indexEncrypted);
    ctrl.engine.upsert(doc);
  }

  function headersOf(list) {
    return (list && list.messages) || [];
  }

  async function indexOpts() {
    return {
      excluded: await OmniIndexer.getExcludedAccounts(),
      includeSpamTrash: await OmniIndexer.getIncludeSpamTrash(),
      indexEncrypted: await OmniIndexer.getIndexEncryptedBodies(),
    };
  }

  // Wire up live incremental updates. Each listener is registered independently
  // so a single unsupported event API can't abort the others.
  function on(event, handler) {
    try {
      event.addListener(handler);
    } catch (e) {
      console.error('[OmniSearch] event listener registration failed:', e);
    }
  }

  function registerEvents(ctrl) {
    const m = messenger.messages;

    // Each handler awaits ctrl.ensureLoaded() first: the index loads
    // asynchronously now, so an event firing mid-load must wait for the real
    // engine rather than mutate the empty placeholder that's about to be swapped.
    on(m.onNewMailReceived, async (_folder, messageList) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      for (const header of headersOf(messageList)) await upsertHeader(ctrl, header, opts);
      ctrl.persistSoon();
    });

    on(m.onUpdated, async (message) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      await upsertHeader(ctrl, message, opts);
      ctrl.persistSoon();
    });

    on(m.onDeleted, async (messageList) => {
      await ctrl.ensureLoaded();
      // Removal is always safe regardless of inclusion settings.
      for (const header of headersOf(messageList)) ctrl.engine.remove(String(header.id));
      ctrl.persistSoon();
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      // A message moved INTO Junk/Trash is dropped (upsertHeader skips it); one
      // moved out gets (re)indexed. Either way remove the originals first.
      for (const header of headersOf(originalMessages)) ctrl.engine.remove(String(header.id));
      for (const header of headersOf(movedMessages)) await upsertHeader(ctrl, header, opts);
      ctrl.persistSoon();
    });

    on(m.onCopied, async (_originalMessages, copiedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      for (const header of headersOf(copiedMessages)) await upsertHeader(ctrl, header, opts);
      ctrl.persistSoon();
    });
  }

  // Self-heal: compare the live set of message ids against the index, removing
  // stale entries and indexing anything missing. Guarantees a message can never
  // stay permanently hidden because an event was dropped.
  async function reconcile(ctrl) {
    const live = await OmniIndexer.collectAllMessageIds();
    const opts = await indexOpts();
    let added = 0;
    let removed = 0;

    for (const id of live) {
      if (!ctrl.engine.has(id)) {
        try {
          const header = await messenger.messages.get(Number(id));
          await upsertHeader(ctrl, header, opts);
          added++;
        } catch (e) {
          /* message vanished mid-reconcile; skip */
        }
      }
    }

    for (const id of ctrl.engine.knownIds()) {
      if (!live.has(id)) {
        ctrl.engine.remove(id);
        removed++;
      }
    }

    ctrl.persistSoon();
    return { added, removed };
  }

  globalThis.OmniEvents = { registerEvents, reconcile };
})();

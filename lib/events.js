'use strict';
// Keeps the index correct as mail changes — the thing Gloda fails to do
// reliably. Subscribes to message events and applies incremental updates, plus
// reconcile() which re-walks folders to self-heal drift. Exposes globalThis.OmniEvents.
//
// A "controller" is { engine, ensureLoaded() } supplied by background.js, where
// engine is the async worker proxy (persistence is handled inside the worker).
(function () {
  async function upsertHeader(ctrl, header, opts) {
    const folder = header.folder;
    // Don't index messages from accounts the user excluded, or from Junk/Trash
    // unless they opted those in, or from folders outside the folder filter.
    if (folder) {
      if (opts.excluded && opts.excluded.has(folder.accountId)) return;
      if (!opts.includeSpamTrash && OmniIndexer.isSpamOrTrash(folder)) return;
      if (opts.folderFilter) {
        const ff = opts.folderFilter;
        if (ff.mode === 'included' && !ff.includedFolderIds.has(folder.id)) return;
        if (ff.mode === 'all' && ff.excludedFolderIds.has(folder.id)) return;
      }
    }
    // Skip messages dated before the configured index start date.
    if (opts.indexStartDate && OmniIndexer.toMillis(header.date) < opts.indexStartDate) return;
    const doc = await OmniIndexer.headerToDoc(header, opts.indexEncrypted);
    await ctrl.engine.upsert(doc);
  }

  function headersOf(list) {
    return (list && list.messages) || [];
  }

  function idsOf(list) {
    return headersOf(list).map((h) => String(h.id));
  }

  async function indexOpts() {
    return {
      excluded: await OmniIndexer.getExcludedAccounts(),
      includeSpamTrash: await OmniIndexer.getIncludeSpamTrash(),
      indexEncrypted: await OmniIndexer.getIndexEncryptedBodies(),
      folderFilter: await OmniIndexer.getFolderFilter(),
      indexStartDate: await OmniIndexer.getIndexStartDate(),
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
    });

    on(m.onUpdated, async (message) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      await upsertHeader(ctrl, message, opts);
    });

    on(m.onDeleted, async (messageList) => {
      await ctrl.ensureLoaded();
      // Removal is always safe regardless of inclusion settings.
      await ctrl.engine.remove(idsOf(messageList));
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      // A message moved INTO Junk/Trash is dropped (upsertHeader skips it); one
      // moved out gets (re)indexed. Either way remove the originals first.
      await ctrl.engine.remove(idsOf(originalMessages));
      for (const header of headersOf(movedMessages)) await upsertHeader(ctrl, header, opts);
    });

    on(m.onCopied, async (_originalMessages, copiedMessages) => {
      await ctrl.ensureLoaded();
      const opts = await indexOpts();
      for (const header of headersOf(copiedMessages)) await upsertHeader(ctrl, header, opts);
    });
  }

  // Self-heal: compare the live set of message ids against the index, removing
  // stale entries and indexing anything missing. Guarantees a message can never
  // stay permanently hidden because an event was dropped.
  async function reconcile(ctrl) {
    await ctrl.ensureLoaded();
    const live = await OmniIndexer.collectAllMessageIds();
    const opts = await indexOpts();
    // Pull the indexed id set once, then diff locally — cheaper than a worker
    // round-trip per message.
    const known = new Set(await ctrl.engine.knownIds());
    let added = 0;

    for (const id of live) {
      if (!known.has(id)) {
        try {
          const header = await messenger.messages.get(Number(id));
          await upsertHeader(ctrl, header, opts);
          added++;
        } catch (e) {
          /* message vanished mid-reconcile; skip */
        }
      }
    }

    const removedIds = [...known].filter((id) => !live.has(id));
    if (removedIds.length) await ctrl.engine.remove(removedIds);

    return { added, removed: removedIds.length, eligibleTotal: live.size };
  }

  globalThis.OmniEvents = { registerEvents, reconcile };
})();

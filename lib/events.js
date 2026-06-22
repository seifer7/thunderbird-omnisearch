'use strict';
// Keeps the index correct as mail changes — the thing Gloda fails to do
// reliably. Subscribes to message events and applies incremental updates, plus
// reconcile() which re-walks folders to self-heal drift. Exposes globalThis.OmniEvents.
//
// A "controller" is { engine, persistSoon() } supplied by background.js.
(function () {
  async function upsertHeader(ctrl, header) {
    const doc = await OmniIndexer.headerToDoc(header);
    ctrl.engine.upsert(doc);
  }

  function headersOf(list) {
    return (list && list.messages) || [];
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

    on(m.onNewMailReceived, async (_folder, messageList) => {
      for (const header of headersOf(messageList)) await upsertHeader(ctrl, header);
      ctrl.persistSoon();
    });

    on(m.onUpdated, async (message) => {
      await upsertHeader(ctrl, message);
      ctrl.persistSoon();
    });

    on(m.onDeleted, (messageList) => {
      for (const header of headersOf(messageList)) ctrl.engine.remove(String(header.id));
      ctrl.persistSoon();
    });

    on(m.onMoved, async (originalMessages, movedMessages) => {
      for (const header of headersOf(originalMessages)) ctrl.engine.remove(String(header.id));
      for (const header of headersOf(movedMessages)) await upsertHeader(ctrl, header);
      ctrl.persistSoon();
    });

    on(m.onCopied, async (_originalMessages, copiedMessages) => {
      for (const header of headersOf(copiedMessages)) await upsertHeader(ctrl, header);
      ctrl.persistSoon();
    });
  }

  // Self-heal: compare the live set of message ids against the index, removing
  // stale entries and indexing anything missing. Guarantees a message can never
  // stay permanently hidden because an event was dropped.
  async function reconcile(ctrl) {
    const live = await OmniIndexer.collectAllMessageIds();
    let added = 0;
    let removed = 0;

    for (const id of live) {
      if (!ctrl.engine.has(id)) {
        try {
          const header = await messenger.messages.get(Number(id));
          await upsertHeader(ctrl, header);
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

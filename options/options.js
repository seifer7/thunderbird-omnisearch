'use strict';
// Loads/saves OmniSearch settings, and hosts the index controls (Rebuild /
// Verify & repair) which talk to the background script over runtime messages.
(function () {
  const KEY = 'settings';
  const keepOpen = document.getElementById('keepOpen');
  const statusEl = document.getElementById('status');
  const progressEl = document.getElementById('progress');
  const rebuildBtn = document.getElementById('rebuild');
  const reconcileBtn = document.getElementById('reconcile');

  function send(msg) {
    return messenger.runtime.sendMessage(msg);
  }

  // ---- Settings ----
  async function getSettings() {
    const result = await messenger.storage.local.get(KEY);
    return result[KEY] || {};
  }

  async function loadSettings() {
    const settings = await getSettings();
    keepOpen.checked = !!settings.keepOpenAfterResult;
  }

  keepOpen.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.keepOpenAfterResult = keepOpen.checked;
    await messenger.storage.local.set({ [KEY]: settings });
  });

  // ---- Index status + controls ----
  function renderStatus(s) {
    const building = s.state === 'building';
    progressEl.hidden = !building;
    rebuildBtn.disabled = building;
    reconcileBtn.disabled = building;

    if (building) {
      progressEl.value = s.progress || 0;
      const pct = Math.round((s.progress || 0) * 100);
      if (s.total) {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} / ${s.total.toLocaleString()} messages (${pct}%)`;
      } else {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} messages so far`;
      }
      return;
    }

    if (s.state === 'empty') {
      statusEl.textContent = 'No index yet — click Rebuild to index your mail.';
      return;
    }
    const parts = [`${s.count.toLocaleString()} messages indexed`];
    if (s.headerOnly > 0) {
      parts.push(`${s.headerOnly.toLocaleString()} header-only (body not downloaded — enable full offline sync to index them)`);
    }
    if (s.updatedAt) parts.push(`updated ${new Date(s.updatedAt).toLocaleString()}`);
    statusEl.textContent = parts.join(' · ');
  }

  async function refreshStatus() {
    const reply = await send({ type: 'status' });
    if (reply && reply.type === 'status') renderStatus(reply.status);
  }

  rebuildBtn.addEventListener('click', async () => {
    await send({ type: 'rebuild' });
    void refreshStatus();
  });

  reconcileBtn.addEventListener('click', async () => {
    reconcileBtn.disabled = true;
    statusEl.textContent = 'Verifying against your folders…';
    await send({ type: 'reconcile' });
    void refreshStatus();
  });

  // Poll so progress advances live during a build.
  setInterval(() => void refreshStatus(), 1000);

  loadSettings();
  refreshStatus();
})();

'use strict';
// The search page. Sends queries/commands to the background script (which owns
// the index) and renders ranked results.
(function () {
  const $ = (id) => document.getElementById(id);
  const queryInput = $('q');
  const clearBtn = $('clear');
  const resultsEl = $('results');
  const statusEl = $('status');
  const progressEl = $('progress');
  const emptyEl = $('empty');

  function send(msg) {
    return messenger.runtime.sendMessage(msg);
  }

  async function getSettings() {
    try {
      const result = await messenger.storage.local.get('settings');
      return result.settings || {};
    } catch (e) {
      return {};
    }
  }

  function fmtDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function escape(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  }

  function renderStatus(s) {
    if (s.state === 'building') {
      progressEl.hidden = false;
      progressEl.value = s.progress || 0;
      const pct = Math.round((s.progress || 0) * 100);
      if (s.total) {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} / ${s.total.toLocaleString()} messages (${pct}%)`;
      } else {
        statusEl.textContent = `Indexing… ${s.count.toLocaleString()} messages so far`;
      }
    } else {
      progressEl.hidden = true;
      if (s.state === 'empty') {
        statusEl.textContent = 'No index yet — click Rebuild to index your mail.';
      } else {
        const parts = [`${s.count.toLocaleString()} messages indexed`];
        if (s.headerOnly > 0) {
          parts.push(`${s.headerOnly.toLocaleString()} header-only (body not downloaded — enable full offline sync to index them)`);
        }
        if (s.updatedAt) parts.push(`updated ${new Date(s.updatedAt).toLocaleTimeString()}`);
        statusEl.textContent = parts.join(' · ');
      }
    }
  }

  function renderResults(results, query) {
    resultsEl.innerHTML = '';
    emptyEl.textContent = '';
    if (!query.trim()) return;
    if (results.length === 0) {
      emptyEl.textContent = 'No matches.';
      return;
    }
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'result';
      const badge = r.bodyAvailable ? '' : '<span class="badge" title="Indexed by header only">header-only</span>';
      li.innerHTML = `
        <div class="row">
          <span class="subject">${escape(r.subject || '(no subject)')}${badge}</span>
          <span class="date">${fmtDate(r.date)}</span>
        </div>
        <div class="meta">${escape(r.from)} → ${escape(r.to)} · <span class="folder">${escape(r.folderName)}</span></div>
        <div class="preview">${escape(r.preview)}</div>`;
      li.addEventListener('click', async () => {
        await send({ type: 'open', id: r.id });
        // Close the popup once the message opens, unless the user opted to keep
        // it open in settings.
        const settings = await getSettings();
        if (!settings.keepOpenAfterResult) window.close();
      });
      resultsEl.appendChild(li);
    }
  }

  let searchSeq = 0;
  async function runSearch() {
    const query = queryInput.value;
    const seq = ++searchSeq;
    const reply = await send({ type: 'search', query });
    if (seq !== searchSeq) return; // a newer keystroke superseded this one
    if (reply && reply.type === 'results') renderResults(reply.results, query);
  }

  async function refreshStatus() {
    const reply = await send({ type: 'status' });
    if (reply && reply.type === 'status') renderStatus(reply.status);
  }

  function syncClearButton() {
    clearBtn.hidden = queryInput.value.length === 0;
  }

  let debounce;
  queryInput.addEventListener('input', () => {
    syncClearButton();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void runSearch(), 120);
  });

  clearBtn.addEventListener('click', () => {
    queryInput.value = '';
    syncClearButton();
    resultsEl.innerHTML = '';
    emptyEl.textContent = '';
    queryInput.focus();
  });

  // Esc clears the field (when it has text) before the popup would close.
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && queryInput.value) {
      e.stopPropagation();
      e.preventDefault();
      clearBtn.click();
    }
  });

  // Index controls (Rebuild / Verify & repair) now live in the settings page.
  $('settings').addEventListener('click', () => {
    messenger.runtime.openOptionsPage();
  });

  setInterval(() => void refreshStatus(), 1000);
  void refreshStatus();
})();

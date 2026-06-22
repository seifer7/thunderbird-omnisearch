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
  const loadingEl = $('loading');

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

  // The spinner shows from popup-open until the FIRST status reply arrives. The
  // background only answers status once the index has finished loading, so that
  // first reply is our definitive "ready" signal — we then clear the spinner and
  // enable the field, permanently for this popup session.
  let ready = false;
  function markReady() {
    if (ready) return;
    ready = true;
    loadingEl.hidden = true;
    queryInput.disabled = false;
    queryInput.focus();
    if (queryInput.value.trim()) void runSearch();
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
      li.tabIndex = 0; // focusable for keyboard navigation
      let badge = '';
      if (r.encrypted) badge = '<span class="badge" title="Encrypted message — indexed by subject/sender only">encrypted</span>';
      else if (!r.bodyAvailable) badge = '<span class="badge" title="Indexed by header only">header-only</span>';
      li.innerHTML = `
        <div class="row">
          <span class="subject">${escape(r.subject || '(no subject)')}${badge}</span>
          <span class="date">${fmtDate(r.date)}</span>
        </div>
        <div class="meta">${escape(r.from)} → ${escape(r.to)} · <span class="folder">${escape(r.folderName)}</span></div>
        <div class="preview">${escape(r.preview)}</div>`;
      li.addEventListener('click', async () => {
        await send({ type: 'open', id: r.id, headerMessageId: r.headerMessageId });
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
    let reply;
    try {
      reply = await send({ type: 'search', query });
    } catch (e) {
      statusEl.textContent = 'Search backend not responding — reload the add-on (Remove + Load again). ' + (e && e.message ? e.message : '');
      return;
    }
    if (seq !== searchSeq) return; // a newer keystroke superseded this one
    if (reply && reply.type === 'results') renderResults(reply.results, query);
    else emptyEl.textContent = 'No response from the index.';
  }

  async function refreshStatus() {
    try {
      const reply = await send({ type: 'status' });
      if (reply && reply.type === 'status') {
        markReady(); // first reply means the index has loaded — clear the spinner
        renderStatus(reply.status);
      }
    } catch (e) {
      statusEl.textContent = 'Background not responding — reload the add-on (Remove + Load again).';
    }
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
      return;
    }
    // Tab (or Down) from the search field jumps to the first result.
    if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown') {
      const items = resultsEl.querySelectorAll('li.result');
      if (items.length) {
        e.preventDefault();
        items[0].focus();
      }
    }
  });

  // Within the results: Tab/Down move down, Shift+Tab/Up move up (Up at the top
  // returns to the search field), Enter opens the focused result.
  resultsEl.addEventListener('keydown', (e) => {
    const items = [...resultsEl.querySelectorAll('li.result')];
    const current = items.indexOf(document.activeElement);
    if (current === -1) return;

    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (current < items.length - 1) items[current + 1].focus();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (current > 0) items[current - 1].focus();
      else queryInput.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[current].click();
    }
  });

  // Index controls (Rebuild / Verify & repair) now live in the settings page.
  $('settings').addEventListener('click', () => {
    messenger.runtime.openOptionsPage();
  });

  // Show the spinner and disable the field until the first status reply (which
  // the background only sends once the index has loaded).
  loadingEl.hidden = false;
  queryInput.disabled = true;
  // Safety net: never leave the field stuck if the background somehow never
  // answers — re-enable after a few seconds so the user can still try.
  setTimeout(markReady, 8000);
  setInterval(() => void refreshStatus(), 500);
  void refreshStatus();
})();

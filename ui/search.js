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

  let ready = false;
  function setReady(isReady) {
    if (ready === isReady) return;
    ready = isReady;
    queryInput.disabled = !isReady;
    if (isReady) {
      queryInput.focus();
      if (queryInput.value.trim()) void runSearch();
    }
  }

  function renderStatus(s) {
    if (s.state === 'loading') {
      // Index still deserializing from disk — block search until it's ready.
      setReady(false);
      progressEl.hidden = false;
      progressEl.removeAttribute('value'); // indeterminate bar
      statusEl.textContent = 'Loading index…';
      return;
    }
    setReady(true);
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
      li.tabIndex = 0; // focusable for keyboard navigation
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
    let reply;
    try {
      reply = await send({ type: 'search', query });
    } catch (e) {
      statusEl.textContent = 'Search backend not responding — reload the add-on (Remove + Load again). ' + (e && e.message ? e.message : '');
      return;
    }
    if (seq !== searchSeq) return; // a newer keystroke superseded this one
    if (reply && reply.type === 'results') renderResults(reply.results, query);
    else if (reply && reply.type === 'loading') {
      // Index not ready yet — show the loading state; the status poll re-enables
      // search and re-runs the query once it's loaded.
      setReady(false);
      progressEl.hidden = false;
      progressEl.removeAttribute('value');
      statusEl.textContent = 'Loading index…';
    } else emptyEl.textContent = 'No response from the index.';
  }

  async function refreshStatus() {
    try {
      const reply = await send({ type: 'status' });
      if (reply && reply.type === 'status') renderStatus(reply.status);
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

  // Start disabled until the first status confirms the index is ready, so a
  // click right after Thunderbird launch can't search a half-loaded index.
  queryInput.disabled = true;
  setInterval(() => void refreshStatus(), 500);
  void refreshStatus();
})();

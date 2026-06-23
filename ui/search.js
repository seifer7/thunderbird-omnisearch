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

  // The field is usable immediately (type-ahead): you can start typing while the
  // index loads/builds. The "Loading…" indicator stays up until the index is
  // genuinely ready — meaning it has finished loading AND any (re)build is done
  // AND the first results for a typed query are actually on screen. That last
  // part is what closes the visible gap: we never hide the indicator before
  // search output appears. See refreshStatus() for the readiness logic.
  let ready = false;
  // Safety net only: unstick the indicator if the background never answers at
  // all (it normally replies 'loading' within ~500ms, so this won't fire during
  // a slow cold load). Does not block the readiness-driven auto-search.
  function forceReady() {
    if (ready) return;
    ready = true;
    loadingEl.hidden = true;
  }

  function renderStatus(s) {
    if (s.state === 'loading') {
      // The #loading banner already says "Loading your mail index…"; keep the
      // status line clear so we don't flash a misleading "0 messages indexed".
      progressEl.hidden = true;
      statusEl.textContent = '';
      return;
    }
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
    // Before the index is ready we don't search — the query just sits in the
    // field. refreshStatus() runs it the instant the index becomes ready, so a
    // word typed during load/indexing searches automatically (no competing
    // in-flight request while loading).
    if (!ready) return;
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

  let gotReply = false;
  let searchedUpdatedAt = null;
  async function refreshStatus() {
    try {
      const reply = await send({ type: 'status' });
      if (!reply || reply.type !== 'status') return;
      gotReply = true;
      const s = reply.status;
      renderStatus(s);

      // 'loading' (cold load) and 'building' (rebuild) both mean the index isn't
      // usable yet — keep the indicator up and don't search.
      const usable = s.state === 'ready' || s.state === 'empty';
      if (!usable) return;

      ready = true;
      // Auto-run the typed query the first time the index is usable, and again
      // whenever its contents change (updatedAt advances after a (re)build or new
      // mail). This shows results automatically no matter how long the load took,
      // without relying on a timer or on having observed the 'building' phase.
      const u = s.updatedAt || 0;
      if (queryInput.value.trim() && u !== searchedUpdatedAt) {
        searchedUpdatedAt = u;
        await runSearch(); // keep the indicator up until results are on screen
      }
      loadingEl.hidden = true;
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

  // Show the (non-blocking) loading hint until the first status reply. The field
  // stays enabled and focused the whole time so the user can type immediately.
  loadingEl.hidden = false;
  queryInput.focus();
  // Safety net: only force-clear the hint if the background never answers at
  // all. If it's replying (e.g. "building" during a long rebuild) we leave the
  // indicator up until the index is genuinely ready.
  setTimeout(() => {
    if (!gotReply) forceReady();
  }, 8000);
  setInterval(() => void refreshStatus(), 500);
  void refreshStatus();
})();

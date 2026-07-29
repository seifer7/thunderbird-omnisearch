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
  const sortEl = $('sort');
  const filterToggleBtn = $('filter-toggle');
  const filterPanelEl = $('filter-panel');
  const contentLayoutEl = $('content-layout');
  const fpLeftBtn = $('fp-left');
  const fpRightBtn = $('fp-right');
  const fpResetBtn = $('fp-reset');
  const fpDateFromEl = $('fp-date-from');
  const fpDateToEl = $('fp-date-to');
  const fpSubjectEl = $('fp-subject');
  const fpFromEl = $('fp-from');
  const fpToEl = $('fp-to');
  const fpAccountsEl = $('fp-accounts');
  const fpFoldersEl = $('fp-folders');

  const MILLIS_PER_DAY = 86400000;   // milliseconds in one day
  const FILTER_DEBOUNCE_MS = 120;    // debounce delay for text filter inputs

  // Launched as the centered standalone window (background opens
  // ui/search.html#modal) rather than the toolbar-anchored popup. Enables
  // Escape-to-close and self-resizing so the window grows from just the search
  // field to fit results. The <html> also carries class "modal" for layout.
  const isModal = location.hash === '#modal';
  // Launched as a content tab in the main Thunderbird window. Each tab has its
  // own independent query/results/sort state. The <html> carries class "tab".
  const isTab = location.hash === '#tab';
  let modalWinId = null;
  // The window's opening height. Must track SPOTLIGHT_H in background.js. The
  // window never shrinks below this, so the empty/loading state never triggers a
  // resize — it only grows to fit real results. We use a fixed constant rather
  // than reading window.outerHeight at init because on GNOME/Wayland the
  // compositor may not have applied the requested open height yet when this runs;
  // a 0/stale read there would collapse the floor and let the empty state resize
  // on open — the flicker. See window-positioning notes.
  const MODAL_MIN_H = 140;
  let modalMinHeight = 0;

  // Resize the window to fit its content (header + results), capped, so it grows
  // as results appear and shrinks back (no lower than the opening size) when the
  // query is cleared. Driven by a ResizeObserver on the body; updating the window
  // height doesn't change body height (natural/content-sized), so no feedback loop.
  function fitModalWindow() {
    if (!isModal || modalWinId == null) return;
    const maxContent = Math.min(560, Math.round((screen.availHeight || 900) * 0.7));
    const content = Math.min(document.body.scrollHeight, maxContent);
    const chrome = Math.max(0, window.outerHeight - window.innerHeight);
    // Grow to fit content (header on open, then results), floored so the window
    // never shrinks below its opening size. The loading hint is the field
    // placeholder (not a height-changing banner), so the empty/loading state
    // doesn't grow-then-shrink — that was the original flicker.
    const target = Math.max(modalMinHeight, content + chrome + 2);
    if (Math.abs(target - window.outerHeight) <= 4) return; // ignore sub-pixel churn
    // Only change height — the window grows straight down from its anchored
    // position (set in background.js for the expanded height). We never move the
    // top, so there's no jerky repositioning as results appear.
    messenger.windows.update(modalWinId, { height: target }).catch(() => {});
  }

  // Show the "not ready yet" hint, worded for what's actually happening:
  // "Indexing…" while a (re)build runs, "Loading…" while the index loads from
  // disk. In the toolbar popup this is the #loading banner; in the centered
  // window we use the field's placeholder instead so the hint never changes the
  // window's height (which would cause an open-time grow-then-shrink flicker).
  const basePlaceholder = queryInput.placeholder;
  const loadingTextEl = loadingEl.querySelector('span:last-of-type');
  function showLoadingHint(show, building) {
    const msg = building ? 'Indexing your mail…' : 'Loading your mail index…';
    if (isModal) {
      queryInput.placeholder = show ? msg : basePlaceholder;
    } else {
      loadingEl.hidden = !show;
      if (show && loadingTextEl) loadingTextEl.textContent = msg;
    }
  }

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

  // ---- Account name lookup ----
  // Map of accountId → display name. Populated once on load; used by the dynamic
  // Accounts multiselect in the filter panel. Falls back to the raw ID if the
  // account is not found (e.g. since removed).
  const accountNames = new Map();
  async function loadAccountNames() {
    try {
      const accounts = await messenger.accounts.list();
      for (const a of accounts) {
        accountNames.set(a.id, a.type ? `${a.name} (${a.type})` : a.name);
      }
    } catch (e) {
      // Silent fail — raw IDs will display as fallback.
    }
  }
  void loadAccountNames();

  // ---- Filter state ----
  // All filter values. Empty string / empty Set = inactive (pass everything).
  const filters = {
    dateFrom: '', // 'YYYY-MM-DD' string
    dateTo: '',   // 'YYYY-MM-DD' string
    subject: '',
    from: '',
    to: '',
    accounts: new Set(), // selected accountIds; empty = all
    folders: new Set(),  // selected folder names; empty = all
  };

  function hasActiveFilters() {
    return !!(
      filters.dateFrom || filters.dateTo ||
      filters.subject || filters.from || filters.to ||
      filters.accounts.size > 0 || filters.folders.size > 0
    );
  }

  // Apply all active filters to an array of results. Does not mutate the input.
  function applyFilters(results) {
    if (!hasActiveFilters()) return results;
    return results.filter((r) => {
      // Date from (start of that day, local time)
      if (filters.dateFrom) {
        if ((r.date || 0) < new Date(filters.dateFrom).getTime()) return false;
      }
      // Date to (end of that day, local time)
      if (filters.dateTo) {
        if ((r.date || 0) > new Date(filters.dateTo).getTime() + MILLIS_PER_DAY - 1) return false;
      }
      // Subject substring
      if (filters.subject && !(r.subject || '').toLowerCase().includes(filters.subject.toLowerCase())) return false;
      // From substring
      if (filters.from && !(r.from || '').toLowerCase().includes(filters.from.toLowerCase())) return false;
      // To substring
      if (filters.to && !(r.to || '').toLowerCase().includes(filters.to.toLowerCase())) return false;
      // Account multiselect (empty set = all)
      if (filters.accounts.size > 0 && !filters.accounts.has(r.accountId || '')) return false;
      // Folder multiselect (empty set = all)
      if (filters.folders.size > 0) {
        const rFolders = (r.folders && r.folders.length ? r.folders : [r.folderName]).filter(Boolean);
        if (!rFolders.some((f) => filters.folders.has(f))) return false;
      }
      return true;
    });
  }

  // ---- Filter panel toggle ----
  // 'right' (default) or 'left'. Remembered within the session.
  let filterPanelSide = 'right';

  function setFilterPanelVisible(visible, side) {
    if (side) filterPanelSide = side;
    filterPanelEl.hidden = !visible;
    contentLayoutEl.classList.toggle('filters-left',  visible && filterPanelSide === 'left');
    contentLayoutEl.classList.toggle('filters-right', visible && filterPanelSide === 'right');
    fpLeftBtn.classList.toggle('fp-side-active',  filterPanelSide === 'left');
    fpRightBtn.classList.toggle('fp-side-active', filterPanelSide === 'right');
    filterToggleBtn.title = visible ? 'Hide filter panel' : 'Show filter panel';
  }

  filterToggleBtn.addEventListener('click', () => {
    setFilterPanelVisible(filterPanelEl.hidden, null);
  });
  fpLeftBtn.addEventListener('click', () => {
    setFilterPanelVisible(true, 'left');
  });
  fpRightBtn.addEventListener('click', () => {
    setFilterPanelVisible(true, 'right');
  });

  // Update the funnel button with a dot indicator when any filter is active.
  function updateFilterActiveIndicator() {
    filterToggleBtn.classList.toggle('filter-active', hasActiveFilters());
  }

  // ---- Dynamic multiselects (Accounts / Folders) ----
  // Rebuilds the checkbox list for a multiselect container. Stale selections
  // (values no longer present in the result set) are removed from the Set first
  // so they don't silently swallow all results.
  function buildCheckboxes(container, values, selectedSet, displayFn, onChange) {
    // Remove selections that are no longer in the current result set.
    for (const sel of [...selectedSet]) {
      if (!values.includes(sel)) selectedSet.delete(sel);
    }
    container.replaceChildren();
    if (values.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'fp-empty-hint';
      hint.textContent = 'No results yet';
      container.appendChild(hint);
      return;
    }
    for (const value of values) {
      const label = document.createElement('label');
      label.className = 'fp-check-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedSet.has(value);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedSet.add(value);
        else selectedSet.delete(value);
        onChange();
      });
      const span = document.createElement('span');
      span.textContent = displayFn(value);
      label.append(cb, span);
      container.appendChild(label);
    }
  }

  // Rebuild the Accounts and Folders multiselects from the current result set.
  // Called after every new search so the options always reflect what's visible.
  function buildDynamicFilters(results) {
    const accountIds = new Set();
    const folderNames = new Set();
    for (const r of results) {
      if (r.accountId) accountIds.add(r.accountId);
      const rFolders = (r.folders && r.folders.length ? r.folders : [r.folderName]).filter(Boolean);
      for (const f of rFolders) folderNames.add(f);
    }
    buildCheckboxes(
      fpAccountsEl,
      [...accountIds].sort((a, b) => (accountNames.get(a) || a).localeCompare(accountNames.get(b) || b)),
      filters.accounts,
      (id) => accountNames.get(id) || id,
      applyAndRender,
    );
    buildCheckboxes(
      fpFoldersEl,
      [...folderNames].sort((a, b) => a.localeCompare(b)),
      filters.folders,
      (name) => name,
      applyAndRender,
    );
  }

  // ---- Filter input wiring ----
  function applyAndRender() {
    renderResults(lastResults, lastQuery);
  }

  fpDateFromEl.addEventListener('change', () => {
    filters.dateFrom = fpDateFromEl.value;
    applyAndRender();
  });
  fpDateToEl.addEventListener('change', () => {
    filters.dateTo = fpDateToEl.value;
    applyAndRender();
  });

  let fpSubjectDebounce, fpFromDebounce, fpToDebounce;
  fpSubjectEl.addEventListener('input', () => {
    clearTimeout(fpSubjectDebounce);
    fpSubjectDebounce = setTimeout(() => { filters.subject = fpSubjectEl.value; applyAndRender(); }, FILTER_DEBOUNCE_MS);
  });
  fpFromEl.addEventListener('input', () => {
    clearTimeout(fpFromDebounce);
    fpFromDebounce = setTimeout(() => { filters.from = fpFromEl.value; applyAndRender(); }, FILTER_DEBOUNCE_MS);
  });
  fpToEl.addEventListener('input', () => {
    clearTimeout(fpToDebounce);
    fpToDebounce = setTimeout(() => { filters.to = fpToEl.value; applyAndRender(); }, FILTER_DEBOUNCE_MS);
  });

  fpResetBtn.addEventListener('click', () => {
    filters.dateFrom = '';
    filters.dateTo = '';
    filters.subject = '';
    filters.from = '';
    filters.to = '';
    filters.accounts.clear();
    filters.folders.clear();
    fpDateFromEl.value = '';
    fpDateToEl.value = '';
    fpSubjectEl.value = '';
    fpFromEl.value = '';
    fpToEl.value = '';
    buildDynamicFilters(lastResults); // uncheck all checkboxes
    applyAndRender();
  });

  // ---- Status rendering ----

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
    showLoadingHint(false);
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
        // The Rebuild control lives in Settings, not this popup, so make the word
        // itself the trigger — otherwise "click Rebuild" points at nothing here.
        statusEl.replaceChildren();
        statusEl.append('No index yet — ');
        const rebuildLink = document.createElement('button');
        rebuildLink.type = 'button';
        rebuildLink.className = 'linkbtn';
        rebuildLink.textContent = 'Rebuild';
        rebuildLink.addEventListener('click', () => void startRebuild());
        statusEl.append(rebuildLink, ' to index your mail.');
      } else {
        const parts = [`${s.count.toLocaleString()} messages indexed`];
        if (s.updatedAt) parts.push(`updated ${new Date(s.updatedAt).toLocaleTimeString()}`);
        statusEl.textContent = parts.join(' · ');
      }
    }
  }

  // ---- Sorting ----
  // Sort results client-side according to the chosen sort key. The results
  // arrive from MiniSearch already sorted by descending relevance score, which
  // is the 'relevance' option, so no work is needed for that case. Messages
  // with no date sort as if they were the oldest possible entry.
  function sortResults(results, sortBy) {
    if (!sortBy || sortBy === 'relevance') return results;
    const sorted = [...results];
    switch (sortBy) {
      case 'date-desc': sorted.sort((a, b) => (b.date || Number.MIN_SAFE_INTEGER) - (a.date || Number.MIN_SAFE_INTEGER)); break;
      case 'date-asc':  sorted.sort((a, b) => (a.date || Number.MIN_SAFE_INTEGER) - (b.date || Number.MIN_SAFE_INTEGER)); break;
      case 'subject':   sorted.sort((a, b) => (a.subject || '').localeCompare(b.subject || '')); break;
      case 'from':      sorted.sort((a, b) => (a.from || '').localeCompare(b.from || '')); break;
      case 'to':        sorted.sort((a, b) => (a.to || '').localeCompare(b.to || '')); break;
      case 'folder':    sorted.sort((a, b) => (a.folderName || '').localeCompare(b.folderName || '')); break;
    }
    return sorted;
  }

  // Attach a normalised relevance percentage to each result. The top-scoring hit
  // is 100%; all others are expressed relative to it. MiniSearch scores are
  // unbounded positive numbers, so normalising to the max-in-set is the most
  // meaningful way to turn them into a human-readable percentage.
  function withRelevance(results) {
    const maxScore = results.reduce((m, r) => Math.max(m, r.score || 0), 0);
    if (maxScore < Number.EPSILON) return results;
    return results.map((r) => ({ ...r, _pct: Math.round(((r.score || 0) / maxScore) * 100) }));
  }

  // ---- Results rendering ----
  function renderResults(results, query) {
    resultsEl.replaceChildren();
    emptyEl.textContent = '';
    if (!query.trim()) {
      updateFilterActiveIndicator();
      return;
    }

    const filtered = applyFilters(results);

    if (filtered.length === 0) {
      emptyEl.textContent =
        results.length > 0 && hasActiveFilters()
          ? 'No matches for the current filters.'
          : 'No matches.';
      updateFilterActiveIndicator();
      return;
    }

    const normed = withRelevance(filtered);
    const sorted = sortResults(normed, sortEl ? sortEl.value : 'relevance');

    for (const r of sorted) {
      const li = document.createElement('li');
      li.className = 'result';
      li.tabIndex = 0; // focusable for keyboard navigation

      // Built entirely with DOM nodes + textContent, never innerHTML: result
      // fields (subject/from/to/preview) come from email content and are therefore
      // attacker-controlled. textContent cannot inject markup, so there is no HTML
      // escaping to get right — and the addons-linter's "unsafe innerHTML" warning
      // goes away because no markup string is ever assigned.
      const subject = document.createElement('span');
      subject.className = 'subject';
      subject.textContent = r.subject || '(no subject)';
      if (r.encrypted || !r.bodyAvailable) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        if (r.encrypted) {
          badge.title = 'Encrypted message — indexed by subject/sender only';
          badge.textContent = 'encrypted';
        } else {
          badge.title = 'Indexed by header only';
          badge.textContent = 'header-only';
        }
        subject.appendChild(badge); // .badge margin-left provides the gap
      }

      // Relevance score badge (percentage of the top-scoring result).
      const scoreWrap = document.createElement('span');
      scoreWrap.className = 'date-score';
      if (r._pct != null) {
        const scoreEl = document.createElement('span');
        scoreEl.className = 'score';
        scoreEl.title = 'Relevance score';
        scoreEl.textContent = r._pct + '%';
        scoreWrap.appendChild(scoreEl);
      }
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = fmtDate(r.date);
      scoreWrap.appendChild(date);

      const row = document.createElement('div');
      row.className = 'row';
      row.append(subject, scoreWrap);

      // A deduplicated result lists every folder the email appears in (e.g. a
      // Gmail message in both Inbox and All Mail). Fall back to the single
      // folderName for older result payloads.
      const folders = (r.folders && r.folders.length ? r.folders : [r.folderName]).filter(Boolean);
      const folder = document.createElement('span');
      folder.className = 'folder';
      folder.textContent = folders.join(' · ');

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.append(`${r.from} → ${r.to} · `, folder);

      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = r.preview;

      li.append(row, meta, preview);
      li.addEventListener('click', async () => {
        await send({ type: 'open', id: r.id, headerMessageId: r.headerMessageId });
        // In tab mode the tab should stay open. In popup/spotlight mode, close
        // unless the user opted to keep it open in settings.
        if (!isTab) {
          const settings = await getSettings();
          if (!settings.keepOpenAfterResult) window.close();
        }
      });
      resultsEl.appendChild(li);
    }

    updateFilterActiveIndicator();
  }

  // Cache last results and query so sort and filter changes can re-render
  // without hitting the index again.
  let lastResults = [];
  let lastQuery = '';

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
    if (reply && reply.type === 'results') {
      lastResults = reply.results;
      lastQuery = query;
      // Rebuild the dynamic multiselects (accounts/folders) from the new result
      // set, preserving any existing selections that are still valid.
      buildDynamicFilters(lastResults);
      renderResults(lastResults, lastQuery);
      // Update the tab's title with the query so multiple open tabs are
      // distinguishable by the text on their tab strip.
      if (isTab) {
        const trimmed = query.trim();
        document.title = trimmed ? `OmniSearch: ${trimmed}` : 'OmniSearch';
      }
    } else {
      emptyEl.textContent = 'No response from the index.';
    }
  }

  // Kick off a full index build from the empty-state "Rebuild" link. The
  // background returns immediately (the build runs async); the status poll then
  // picks up the 'building' state and shows progress, so we just nudge it.
  async function startRebuild() {
    try {
      await send({ type: 'rebuild' });
    } catch (e) {
      statusEl.textContent = 'Could not start indexing — open Settings to rebuild.';
      return;
    }
    void refreshStatus();
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
      // usable yet — keep the indicator up (worded for which one) and don't search.
      const usable = s.state === 'ready' || s.state === 'empty';
      if (!usable) {
        showLoadingHint(true, s.state === 'building');
        return;
      }

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
      showLoadingHint(false);
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
    lastResults = [];
    lastQuery = '';
    resultsEl.replaceChildren();
    emptyEl.textContent = '';
    buildDynamicFilters([]); // clear the dynamic option lists
    updateFilterActiveIndicator();
    if (isTab) document.title = 'OmniSearch';
    queryInput.focus();
  });

  // Re-render the cached results with the newly chosen sort order without
  // re-querying the index.
  sortEl.addEventListener('change', () => {
    renderResults(lastResults, lastQuery);
  });

  // Esc clears the field when it has text; when empty, the anchored popup closes
  // natively, but the Spotlight window must close itself.
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (queryInput.value) {
        e.stopPropagation();
        e.preventDefault();
        clearBtn.click();
      } else if (isModal) {
        e.preventDefault();
        window.close();
      }
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
  // Close the search window once Settings opens so it doesn't linger over the
  // options tab. (The toolbar popup would close on blur anyway; the centered
  // window must close itself.) In tab mode the search tab should stay open.
  $('settings').addEventListener('click', async () => {
    try {
      await messenger.runtime.openOptionsPage();
    } finally {
      if (!isTab) window.close();
    }
  });

  if (isModal) {
    document.documentElement.classList.add('modal');
    // Floor the window at its opening size so the empty/loading state never
    // resizes (only real results grow it) — kills the open-time flicker.
    modalMinHeight = MODAL_MIN_H;
    // Learn our own window id, then size to fit and keep fitting as content
    // (results) changes.
    messenger.windows
      .getCurrent()
      .then((w) => {
        modalWinId = w.id;
        fitModalWindow();
      })
      .catch(() => {});
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fitModalWindow);
    }).observe(document.body);
    // Dismiss with Escape or by opening a result. (We deliberately do NOT close
    // on window blur: GNOME/Wayland fires a blur when you start dragging the
    // window, which made it vanish mid-move.)
  }

  if (isTab) {
    // Full-width layout for the tab context (same approach as #modal).
    document.documentElement.classList.add('tab');
  }

  // Show the (non-blocking) loading hint until the first status reply. The field
  // stays enabled and focused the whole time so the user can type immediately.
  showLoadingHint(true);
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

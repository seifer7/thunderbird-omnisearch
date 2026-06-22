# OmniSearch for Thunderbird

Fast, fuzzy, relevance-ranked email search for Thunderbird — built on
[MiniSearch](https://github.com/lucaong/minisearch), the same engine behind the
[Obsidian OmniSearch](https://github.com/scambier/obsidian-omnisearch) plugin.

It maintains **its own search index, completely independent of Thunderbird's
Gloda** (the built-in global database that frequently fails to find messages
that demonstrably exist — including locally-composed sent mail). Where Gloda
silently drops messages, this index keeps itself correct with live updates and a
"Verify & repair" self-heal pass.

## Features

**Search quality**
- **BM25 relevance ranking**, with header fields (subject / from / to) boosted
  over the body.
- **Typo-tolerant fuzzy** matching and **prefix ("as you type")** search.
- An **independent index that bypasses Gloda**, so it finds mail Gloda misses.

**The search popup**
- Opens as a **native popup panel** (no browser address bar) from the toolbar
  button or the **`Alt+S`** keyboard shortcut.
- **Keyboard navigation**: type a query, press **Tab** (or **↓**) to jump to the
  first result, **Tab / ↓ / ↑** to move through results, **Enter** to open the
  selected message, **Esc** to clear the field.
- A **clear (×)** button, and a focus outline that uses your **theme accent**.
- Results show sender, date, folder and a snippet; the focused result is
  highlighted.
- Clicking or pressing Enter **opens the message** (resolved by its stable RFC
  Message-ID, so it works even after a restart). The popup then closes —
  unless you turn on "keep open" in Settings.
- Badges flag results indexed **`header-only`** (body not downloaded) or
  **`encrypted`** (see Privacy).

**Indexing**
- **Live incremental updates** as mail is received, updated, moved, copied or
  deleted — the thing Gloda does unreliably.
- **Verify & repair**: re-walks every folder, removes stale entries and indexes
  anything missing, so a message can never stay permanently hidden.
- Bodies are read **concurrently** for speed; a progress indicator shows
  `indexed / total (%)`.
- A **loading spinner** appears while the index deserializes after a Thunderbird
  restart, and search is disabled until it's ready.
- The index is **persisted to IndexedDB**, so search is instant after a restart.

**Privacy**
- **No network access** (no host permissions) — the index can't be exfiltrated
  by the add-on.
- **Encrypted (OpenPGP/S-MIME) mail is indexed by header only by default** — its
  decrypted contents are never written to disk unless you opt in. See
  [SECURITY.md](SECURITY.md).

## Install (temporary, for testing)

**No build step.** The extension is plain JavaScript, loadable as-is:

1. In Thunderbird: **≡ → Add-ons and Themes → gear icon → Debug Add-ons →
   Load Temporary Add-on…**
2. Select **`manifest.json` in this folder** (the project root — *not* a `dist`
   subfolder; there isn't one).
3. Click the grey **magnifier** toolbar button (or press **`Alt+S`**) to open the
   search popup. On first install it auto-builds the index.

To build a packaged `.xpi`, run `./build.sh` (needs `zip`).

### Permanent install

Temporary add-ons are removed when Thunderbird restarts. To install permanently:

1. **Local (no signing).** Thunderbird honours a config switch that Firefox
   release does not: in `about:config` set `xpinstall.signatures.required` to
   **false**, then install the `.xpi` via Add-ons Manager → gear → *Install
   Add-on From File…*. It persists across restarts. Simplest for personal use.
2. **Signed (for distribution).** Real signing is done by Mozilla — submit the
   `.xpi` to [addons.thunderbird.net](https://addons.thunderbird.net) (ATN),
   which reviews and signs it. There is no purely local way to produce a
   Thunderbird-valid signature.

The **`Alt+S`** shortcut is assigned automatically on install; change it under
Add-ons Manager → gear → *Manage Extension Shortcuts*.

## What gets indexed

- **Junk (Spam) and Trash are NOT indexed by default.** Every other folder of
  every *included* account is. Opt Junk/Trash back in under Settings.
- **Encrypted messages are indexed by header only by default** (subject/sender),
  so no decrypted text is written to the index. Opt in to index their bodies.
- **IMAP bodies must be on disk to be indexed.** Thunderbird downloads IMAP
  bodies "on demand" by default, so not-yet-downloaded messages are indexed
  **by header only** (shown with a `header-only` badge). To make every IMAP body
  searchable: **Account Settings → Synchronization & Storage → "Keep messages …
  on this computer"**, synchronise *all* messages (per-folder; subfolders aren't
  inherited), then Rebuild.

## Settings

Open via the **cog** in the search popup, or Add-ons Manager → OmniSearch →
gear → Options.

| Setting | Default | Effect |
|---------|---------|--------|
| Keep the search popup open after opening a result | off | Leave the popup open instead of closing when you open a message. |
| Accounts to index | all included | Per-account include/exclude (opt-out: new accounts are included automatically). |
| Include Junk (Spam) and Trash folders | off | Index those folders too. |
| Index the contents of encrypted emails | off | Index decrypted bodies of OpenPGP/S-MIME mail (stored unencrypted in the index). |
| Rebuild index | — | Re-index all mail from scratch. |
| Verify & repair | — | Reconcile the index against your folders (add missing, remove stale). |

### Applying scope changes incrementally (no full rebuild)

When you change which accounts are indexed, or toggle Junk/Trash, an **"Apply
now"** banner appears. It runs **Verify & repair**, which **adds only the
newly-included messages and removes the newly-excluded ones** — a full rebuild is
*not* required. (The "index encrypted bodies" toggle is the exception: it changes
how existing messages are read, so its banner offers a **Rebuild**.) The banner
stays up while applying and disappears when done.

## How it works

Plain classic scripts loaded in order via `manifest.json` → `background.scripts`
(each attaches to `globalThis`); the popup and options page talk to the
background over `runtime.sendMessage`.

| File | Role |
|------|------|
| `lib/minisearch.js` | Vendored MiniSearch UMD build (defines `globalThis.MiniSearch`). |
| `lib/engine.js`     | `OmniEngine` — MiniSearch wrapper. The *only* file to touch to swap engines (FlexSearch/Orama). |
| `lib/store.js`      | `OmniStore` — IndexedDB persistence of the serialised index. |
| `lib/indexer.js`    | `OmniIndexer` — walks accounts/folders, reads bodies (`getFull({decrypt:false})`), applies account / Junk-Trash / encrypted rules, builds index docs concurrently. |
| `lib/events.js`     | `OmniEvents` — live incremental updates + `reconcile()` self-heal. |
| `background.js`     | Orchestrator: owns the in-memory index, persistence, message handling, the toolbar button. |
| `ui/`               | The search popup (HTML/CSS/JS). |
| `options/`          | The settings page (HTML/CSS/JS). |
| `icons/search.svg`  | Fixed mid-grey magnifier (TB per-theme icon tinting is unreliable for action icons). |

## Engine choice

MiniSearch (v7) was chosen over FlexSearch (fastest, but phonetic not
edit-distance fuzzy), Orama (heavier; good if you later want semantic/faceted
search), Fuse.js (no inverted index — won't scale to full bodies) and Lunr
(immutable index — no cheap incremental updates). The engine is isolated behind
`lib/engine.js` so switching later touches one file.

## Security & privacy

The index is stored **unencrypted in your Thunderbird profile** (IndexedDB),
much like Thunderbird's own Gloda full-text index, and the add-on has **no
network access**. For ordinary mail it's about as exposed as data Thunderbird
already keeps on disk. **Encrypted (OpenPGP/S-MIME) messages are indexed by
header only by default.** Use disk encryption, and see [SECURITY.md](SECURITY.md)
for the full review, threat model, and mitigations.

## License

MIT. Uses MiniSearch (MIT). Does **not** reuse Obsidian OmniSearch's GPL-3 code
— only the same underlying engine and approach.

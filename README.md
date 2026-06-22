# OmniSearch for Thunderbird

Fast, fuzzy, relevance-ranked email search for Thunderbird — built on
[MiniSearch](https://github.com/lucaong/minisearch), the same engine behind the
[Obsidian OmniSearch](https://github.com/scambier/obsidian-omnisearch) plugin.

It maintains **its own search index, completely independent of Thunderbird's
Gloda** (the built-in global database that frequently fails to find messages
that demonstrably exist — including locally-composed sent mail). Where Gloda
silently drops messages, this index keeps itself correct with live updates and a
"verify & repair" self-heal pass.

## Install (temporary, for testing)

**No build step.** The extension is plain JavaScript, loadable as-is:

1. In Thunderbird: **≡ → Add-ons and Themes → gear icon → Debug Add-ons →
   Load Temporary Add-on…**
2. Select **`manifest.json` in this folder** (the project root — *not* a `dist`
   subfolder; there isn't one).
3. Click the blue **OmniSearch** toolbar button to open the search tab. On first
   install it auto-builds the index; you can also click **Rebuild** any time.

To build a packaged `.xpi`, run `./build.sh` (needs `zip`).

### Permanent install

Temporary add-ons are removed when Thunderbird restarts. To install
permanently you have two options:

1. **Local (no signing).** Thunderbird honours a config switch that Firefox
   release does not: in `about:config` set
   `xpinstall.signatures.required` to **false**, then install the `.xpi` via
   Add-ons Manager → gear → *Install Add-on From File…*. It persists across
   restarts. Simplest for personal use on your own machine.
2. **Signed (for distribution).** Real signing is done by Mozilla — submit the
   `.xpi` to [addons.thunderbird.net](https://addons.thunderbird.net) (ATN),
   which reviews and signs it. Required if you want it to install on other
   machines without flipping the config switch. There is no purely local way to
   produce a Thunderbird-valid signature.

## What you get

- **BM25 relevance ranking** with header fields (subject/from/to) boosted over body.
- **Typo-tolerant fuzzy** + **prefix ("as you type")** matching.
- **Live incremental updates** on new/updated/moved/deleted mail.
- **Verify & repair**: re-walks every folder, removes stale entries, indexes
  anything missing — so a message can never stay permanently hidden.
- Index persisted to **IndexedDB**, so search is instant after a restart.

## What gets indexed

**Junk (Spam) and Trash folders are NOT indexed by default.** Every other folder
of every included account is indexed. You can opt Junk/Trash back in under
Settings → *Accounts to index* → "Include Junk (Spam) and Trash folders", then
**Rebuild** (or **Verify & repair**) to apply it. Account-level selection lives
in the same place. (Per-individual-folder selection isn't implemented; it's
account-level plus the Junk/Trash toggle.)

Open the search with the toolbar button or the **`Alt+S`** (Option-S) shortcut,
which is assigned automatically on install; change it under Add-ons Manager →
gear → *Manage Extension Shortcuts*.

## Making IMAP mail fully searchable (recommended one-time setting)

An in-extension indexer can only read message bodies that are **on disk**.
Thunderbird defaults IMAP folders to "download bodies on demand", so
not-yet-downloaded messages get indexed **by header only** (still findable by
subject/sender, shown with a `header-only` badge — already better than Gloda
dropping them).

To make every IMAP body fully searchable:
**Account Settings → Synchronization & Storage → check "Keep messages in this
folder on this computer", and synchronise _all_ messages (not just recent).**
Do this per-folder (subfolders are not inherited), then click **Rebuild**.

## How it works

Plain classic scripts loaded in order via `manifest.json` → `background.scripts`
(each attaches to `globalThis`); the search tab talks to the background over
`runtime.sendMessage`.

| File | Role |
|------|------|
| `lib/minisearch.js` | Vendored MiniSearch UMD build (defines `globalThis.MiniSearch`). |
| `lib/engine.js`     | `OmniEngine` — MiniSearch wrapper. The *only* file to touch to swap engines (FlexSearch/Orama). |
| `lib/store.js`      | `OmniStore` — IndexedDB persistence of the serialised index. |
| `lib/indexer.js`    | `OmniIndexer` — walks accounts/folders, reads bodies via `messages.getFull`, builds index docs in batches. |
| `lib/events.js`     | `OmniEvents` — live incremental updates + `reconcile()` self-heal. |
| `background.js`     | Orchestrator + UI message handling + toolbar button. |
| `ui/`               | The search tab (HTML/CSS/JS). |

## Engine choice

MiniSearch (v7) was chosen over FlexSearch (fastest, but phonetic not
edit-distance fuzzy), Orama (heavier; good if you later want semantic/faceted
search), Fuse.js (no inverted index — won't scale to full bodies) and Lunr
(immutable index — no cheap incremental updates). The engine is isolated behind
`lib/engine.js` so switching later touches one file.

## Security & privacy

The index is stored **unencrypted in your Thunderbird profile** (IndexedDB),
much like Thunderbird's own Gloda full-text index. It has **no network access**
(no host permissions), so it can't be exfiltrated by the add-on itself. For
ordinary mail it's about as exposed as data Thunderbird already keeps on disk.
**Encrypted (OpenPGP/S-MIME) messages are indexed by header only by default** —
their decrypted contents are *not* written to the index unless you opt in under
Settings. Use disk encryption, and see [SECURITY.md](SECURITY.md) for the full
review, threat model, and mitigations.

## License

MIT. Uses MiniSearch (MIT). Does **not** reuse Obsidian OmniSearch's GPL-3 code
— only the same underlying engine and approach.

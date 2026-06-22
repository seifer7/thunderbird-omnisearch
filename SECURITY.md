# Security & privacy of the OmniSearch index

A review of how indexed email is stored, how exposed it is, and the threat model.

## What is stored, and where

OmniSearch keeps its own search index in the extension's **IndexedDB**, which
Thunderbird writes — **unencrypted** — inside your profile directory, under
roughly:

```
<profile>/storage/default/moz-extension+++<extension-uuid>/idb/
```

The index contains, per message:

- **Stored verbatim** (recoverable as-is): `subject`, `from`, `to`, `date`,
  folder name, the message's RFC `Message-ID`, and a **~200-character preview**
  of the body.
- **Tokenized into the inverted index**: the full text of `subject`, `from`,
  `to`, and the body (capped at 20,000 chars). The raw body is *not* stored
  verbatim, but the inverted index reveals the **set of words** each message
  contains (and the verbatim preview), which leaks a great deal of content.

There is no separate copy of attachments, and no body text beyond the preview is
stored verbatim.

## Is it more exposed than your original mail?

**For ordinary (unencrypted) mail: roughly the same exposure.** Thunderbird
already stores your messages unencrypted in the profile (mbox/maildir), and its
own **Gloda** database (`global-messages-db.sqlite`) already keeps a full-text
index of message bodies there. OmniSearch's index lives in the same profile with
the same file permissions, so it does not create a materially new at-rest
exposure for normal mail — it's a second index alongside one Thunderbird already
maintains.

**For OpenPGP / S-MIME encrypted mail: yes, more exposed — this is the key
finding.** Encrypted messages are stored as *ciphertext* at rest in your message
store, and Gloda does not index their decrypted contents. But Thunderbird's
`listInlineTextParts()` and `getFull()` APIs **decrypt by default**, so
OmniSearch currently indexes the **decrypted plaintext** (the preview, plus the
body's word set) of encrypted messages and writes that to IndexedDB in the clear.
That converts "encrypted at rest" into "plaintext-derived data at rest" for
exactly your most sensitive mail. See *Recommendations* below.

## Threat model — when could content be compromised?

- **Any process running as your user account** can read the IndexedDB files,
  just as it can read your mbox/maildir files and the Gloda database. The OS does
  not sandbox one of your apps from another's files. So local malware running as
  you can read the index — but it could already read your actual mail. The index
  is not a *new* capability for such malware, **except** that it exposes the
  decrypted content of encrypted messages (which the raw store does not).
- **Other Thunderbird extensions**: IndexedDB is origin-isolated per extension
  (keyed to this add-on's UUID), so another extension cannot read OmniSearch's
  database directly. (An extension granted `messagesRead` could read your mail
  itself anyway.)
- **Network / exfiltration**: OmniSearch requests **no host permissions and no
  network access** (`permissions`: `messagesRead`, `accountsRead`, `storage`,
  `unlimitedStorage` only). It cannot send your index anywhere. Everything stays
  on disk locally.
- **At rest / device theft**: the index is only as protected as the profile
  directory. Full-disk or encrypted-home protects the index and your mail
  equally; without it, both are readable from the raw disk.

## Recommendations

1. **Use full-disk or encrypted-home encryption.** It protects the index, your
   mail store, and Gloda together. This is the single biggest mitigation.
2. **Encrypted (GPG/S-MIME) mail is the real concern.** The safe default is to
   *not* index the decrypted bodies of encrypted messages — index them by header
   only (subject/from/to/date), so no decrypted plaintext is written to disk.
   This is a planned/optional behavior; if you index encrypted mail today, its
   plaintext-derived terms and preview are in IndexedDB. (Open an issue / ask to
   enable the "don't index encrypted bodies" default.)
3. **Removing the add-on** does not guarantee the IndexedDB is wiped immediately;
   to purge the index, use Settings or clear the extension's storage, or delete
   the `moz-extension+++<uuid>` storage directory from the profile.

## Summary

For normal mail, the index is about as exposed as data Thunderbird already keeps
unencrypted (Gloda). It adds **no network exposure**. The one genuine increase in
exposure is that **encrypted messages are decrypted and indexed in the clear by
default** — mitigate with disk encryption and/or by not indexing encrypted
bodies.

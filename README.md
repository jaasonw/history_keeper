# History Keeper

Chrome deletes browsing history after 90 days, and Chrome Sync propagates that same
expiry to every device — so there is no built-in way to keep a long-term record. This
extension mirrors every visit into its own IndexedDB store as it happens, rescues
whatever is still inside Chrome's 90-day window at install time, and merges archives
across machines through an ordinary cloud-synced folder.

No build step, no server, no dependencies at runtime.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. The initial import starts immediately. Progress shows in the popup and the dashboard.

Chrome 116 or newer. The toolbar button opens the popup — counters, backfill progress, and
links to the dashboard (search, sync, backup) and options (blocklist, device label,
maintenance).

## How capture works

Two paths, deliberately overlapping:

| Path | Fires | Covers |
|---|---|---|
| `chrome.history.onVisited` | Immediately on each visit | Everything, while the service worker is alive |
| 15-minute alarm sweep | Every 15 min, re-reading a window that overlaps the last sweep by 5 min | Visits made while Chrome had evicted the worker |

The overlap is free. A visit's id is `sha256(url)[0:16]:visitTime`, so re-reading a visit
already archived is a no-op. That single property is also what makes the backfill
re-runnable and cross-device merge conflict-free.

## Search

Results update as you type (140 ms debounce). Matching is fuzzy, in four tiers per
word, cheapest first:

| Tier | Example | Score |
|---|---|---|
| Substring at a word boundary | `git` → **git**hub.com | 1.00 |
| Substring anywhere | `hub` → git**hub**.com | 0.85 |
| Subsequence | `gthb` → **g**i**t**hu**b** | 0.55, scaled by how tightly it fits |
| Typo, within an edit distance | `pythom` → python | 0.35 |

Every word you type must match somehow — `github anthropics` finds only pages matching
both. Recency and visit count then nudge the ranking, by at most 20% and 10%
respectively, so they break ties rather than outranking a better textual match.

**Sort** switches between *Best match* (one row per page, with a `3×` visit-count badge)
and *Newest first* (one row per visit). It follows the search box automatically until
you set it yourself.

### Why it stays fast

Search scores an in-memory mirror of the `pages` store, refreshed every 30 seconds and
on any write. An IndexedDB cursor per keystroke is not affordable; a plain array scan is.

Tier 4 is the expensive one, so it only runs as a second pass when the cheap tiers
returned fewer than 20 hits — exactly when you have mistyped something. Even then, most
words never reach the edit-distance table: walking the haystack accumulates a 32-bit
character-presence mask, and a word can only be within *d* edits of the token if at most
*d* of the token's distinct characters are missing from it. That test is a few integer
ops and rejects the vast majority of words before anything is allocated.

Measured on a synthetic 150,000-page corpus: cheap pass 17–44 ms, typo pass 83–137 ms.

## Cross-device sync

Point the dashboard at a folder inside Google Drive, OneDrive, or Dropbox. Inside it the
extension keeps a `history-keeper/` subfolder of append-only NDJSON shards:

```
history-keeper/
  a1b2c3d4-2026-08.ndjson    <- desktop, August
  a1b2c3d4-2026-09.ndjson    <- desktop, September
  e5f6a7b8-2026-09.ndjson    <- laptop, September
```

**No file is ever written by two devices.** Each device appends only to shards named
after its own device id and reads everyone else's. That is what makes this safe on top of
file-sync clients, which handle concurrent edits badly. Shards rotate monthly so the
cloud client is not re-uploading one ever-growing file on every append.

Importing reads only the bytes that appeared since last time, and stops at the last
complete line — a trailing partial line, which a cloud client mid-download will produce,
is left for the next pass.

**One caveat:** Chrome does not reliably persist a folder permission grant across browser
restarts. When it lapses, the dashboard shows a **Reconnect folder** button. While the
dashboard is open it syncs on load and every 5 minutes.

Sync runs in the dashboard page rather than the background worker because the File System
Access API does not exist in service workers.

## Backup and transfer

If you would rather not connect a folder, the dashboard's **Download snapshot** writes the
whole archive as one `.ndjson` file, and **Import file…** merges one back in with the same
union semantics — importing a snapshot twice adds nothing the second time. A weekly alarm
raises a reminder banner when a snapshot is due.

## Layout

```
manifest.json                      MV3 manifest; permissions and entry points
package.json                       test script and the one dev dependency
icons/                             16 / 32 / 48 / 128 px
src/background/service-worker.js   capture, sweep, backfill, alarms
src/lib/db.js                      IndexedDB schema and writes
src/lib/record.js                  normalisation, hashing, the dedupe key
src/lib/search.js                  query engine, page cache, and stats
src/lib/fuzzy.js                   tiered fuzzy matcher and relevance scoring
src/lib/blocklist.js               pattern matching and retroactive purge
src/lib/sync.js                    folder handle, shard export/import
src/dashboard/                     search UI, sync controls, backup
src/options/                       blocklist, device label, maintenance
src/popup/                         counters and progress
tests/logic.test.mjs               storage, search, blocklist, merge semantics
```

Everything is plain ES modules loaded straight by Chrome. `CLAUDE.md` holds the
contributor notes: execution contexts, invariants, and what a schema change requires.

### Stores

| Store | Key | Purpose |
|---|---|---|
| `visits` | `urlHash:visitTime` | One row per visit; the archive itself |
| `pages` | `urlHash` | Distinct-URL rollup, so search and stats scan the smaller set |
| `meta` | `key` | Device id, sweep/sync timestamps, sequence counter, folder handle |
| `imports` | `filename` | Per-shard byte offset already consumed |
| `backfill` | `url` | Work queue for the initial import |

Locally captured visits carry a `localSeq`; imported ones do not. Since IndexedDB omits
records missing an indexed property, the `localSeq` index contains exactly the set this
device still needs to export.

## Blocklist

Options page, empty by default. Patterns are applied on write and can be purged
retroactively:

```
mybank.example          that host and all subdomains
*.internal.corp         subdomains only
/\/health\/records\//i  regular expression against the whole URL
# comment
```

## Tests

```bash
npm install && npm test
```

27 tests over the real modules against a fake IndexedDB: dedupe, page rollup accounting,
`localSeq` partitioning, search filters and pagination, all four fuzzy tiers and their
ranking, bounded edit distance, blocklist matching and purge, NDJSON round-trip,
repeat-import idempotency, and partial-line handling. `fake-indexeddb` is a dev
dependency only — the extension ships with none.

## Deliberate non-behaviours

- **Deleting history in Chrome does not delete it here.** That is the point of the
  extension. To remove something from the archive, use the ✕ on a dashboard row or add a
  blocklist pattern and purge.
- **Incognito is never captured** — those visits never enter `chrome.history` at all.
- **Page content is not archived**, only URL, title, timestamp, and transition type.
- **The archive is unencrypted**, on disk and in the cloud folder. If that matters, the
  natural addition is passphrase encryption of shard files via WebCrypto AES-GCM.

## Permissions

`history` to read visits, `storage` + `unlimitedStorage` for the archive, `alarms` for
the sweep. No host permissions, no network access; nothing leaves the machine except the
files you point the sync folder at.

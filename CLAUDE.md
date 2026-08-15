# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A Manifest V3 Chrome extension that mirrors `chrome.history` into its own IndexedDB
store so visits survive Chrome's 90-day expiry, and merges archives across machines
through a cloud-synced folder of append-only NDJSON files.

**No build step.** Source under `src/` is loaded directly by Chrome as ES modules
(`"type": "module"` in both `manifest.json` and `package.json`). Do not introduce a
bundler, transpiler, or framework — nothing in `src/` may require a compile pass, and the
extension must keep shipping zero runtime dependencies. `fake-indexeddb` is a dev
dependency for tests only.

## Commands

```bash
npm install && npm test
```

`npm test` runs `tests/logic.test.mjs` directly under Node — no test framework. It imports
the real modules from `src/lib/` against `fake-indexeddb` and a hand-stubbed `chrome`
global. There is no linter and no CI.

To exercise it in the browser: `chrome://extensions` → Developer mode → **Load unpacked**
→ this folder. After editing the service worker, hit reload on the extension card;
extension pages just need a refresh.

## Execution contexts

Three contexts share one `chrome-extension://` origin and therefore one IndexedDB:

| Context | Entry | Can use |
|---|---|---|
| Service worker | `src/background/service-worker.js` | `chrome.*`, IndexedDB. **Not** File System Access. |
| Dashboard / options / popup pages | `src/*/[popup\|options\|dashboard].js` | `chrome.*`, IndexedDB, File System Access, DOM |

Consequences to respect:

- **`src/lib/db.js` must never touch `chrome.*`.** It is imported by every context and
  stays a pure IndexedDB layer.
- **`src/lib/sync.js` only runs in a page.** The File System Access API does not exist in
  service workers, which is why sync lives in the dashboard and runs on load plus every
  5 minutes while that tab is open — not on an alarm.
- **`src/lib/theme.js` only runs in a page** too; it touches `document`, and the worker
  has nothing to paint.
- The service worker is evicted freely. Anything that must survive eviction goes in
  IndexedDB (`meta`, `backfill`), never in a module-level variable.

## Invariants

Break any of these and duplicates or merge conflicts follow:

1. **The visit id is `sha256(url)[0:16]:visitTime` and contains nothing device-specific.**
   This single property is what makes the overlapping capture paths, the re-runnable
   backfill, repeat shard imports, and cross-device merge all idempotent unions rather
   than conflict resolution. `putVisits` never adds a second row for an `id` that
   already exists. Its one exception is the title, which the first capture usually does
   not have (see *Titles* below): a later record may fill a blank one in, strictly
   empty → non-empty, so the write stays idempotent under a repeated sweep.
2. **Visit times are rounded** (`normaliseTime`). Chrome reports floats with a
   sub-millisecond fraction; the rounded value is half the dedupe key, so an unrounded
   read of the same visit mints a second row.
3. **Only locally captured visits carry `localSeq`.** IndexedDB omits records missing an
   indexed property, so the `localSeq` index *is* the set of records this device has yet
   to export. Passing `assignLocalSeq: true` for imported records would re-export another
   device's data under this device's shard name.
4. **No shard file is ever written by two devices.** Each device appends only to
   `<deviceId>-<YYYY-MM>.ndjson` and reads everyone else's. This is what makes the scheme
   safe on top of file-sync clients, which handle concurrent edits badly.
5. **`pages` must stay consistent with `visits`.** Every write path through
   `putVisits`/`deleteVisit`/`deletePage` maintains the rollup; adding a new write path
   means maintaining it there too.
6. **Import stops at the last complete line.** A cloud client mid-download produces a
   trailing partial line; the byte offset in `imports` may only advance past `\n`.

## Data model

`DB_NAME = 'historykeeper'`, `DB_VERSION = 1`, all in `src/lib/db.js`.

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `visits` | `urlHash:visitTime` | `visitTime`, `host`, `urlHash`, `localSeq` | The archive |
| `pages` | `urlHash` | `host`, `lastSeen` | Distinct-URL rollup; search and stats scan this smaller set |
| `meta` | `key` | — | Device id, sweep/sync timestamps, `seqCounter`, folder handle |
| `imports` | `filename` | — | Bytes already consumed per shard |
| `backfill` | `url` | — | Initial-import work queue |

Schema changes require bumping `DB_VERSION` and adding a branch to `migrate()` — the
existing `if (oldVersion < 1)` block must stay intact for users upgrading. Two things
are kept outside IndexedDB, in `chrome.storage.local`: blocklist patterns under
`blocklist`, and the theme choice under `theme`. Both are settings rather than archive
data, and both need `chrome.storage.onChanged` so an already-open page follows an edit
made elsewhere.

## Capture paths

- `chrome.history.onVisited` — real time, only while the worker is alive.
- 15-minute `sweep` alarm — re-queries a window overlapping the last sweep by 5 minutes,
  covering visits made while the worker was evicted.
- `backfill` alarm — drains the queue in 250-URL chunks under a 20-second budget, deleting
  queue rows only after the visits they produced commit.
- Weekly `snapshot` alarm — only sets `meta.snapshotDue`; the download itself needs a page.

The overlap between the first two is free, per invariant 1. Message types the worker
accepts from pages: `sweepNow`, `restartBackfill`, `ping`.

## Titles

Chrome records a visit when the navigation commits and learns the page title only once
the renderer reports it. `onVisited` therefore fires with an empty title for any URL
being seen for the first time, and single-page apps widen the gap — YouTube pushes a
history entry per video and sets `document.title` well afterwards.

Three things repair that, all sharing the empty → non-empty rule so a title carrying a
live counter (`(3) Inbox`) cannot churn the export delta:

- `scheduleRetitle()` in the worker: a URL captured blank is re-read ~6 s later through
  one batched `history.search`, then `backfillTitle()`. **`chrome.history` has no title
  event** — only `onVisited` and `onVisitRemoved` — so this is a timer, and a timer does
  not survive worker eviction. It is best effort on purpose; the sweep is the guarantee.
- The sweep and a backfill re-run, through `putVisits`, which is what makes
  **Re-scan all Chrome history** in the options page a title repair as well.
- Another device's shard, through the same `putVisits` path.

A repair re-stamps `localSeq` so it reaches other devices — but only where `localSeq` is
already present, per invariant 3.

Every listener in the worker is registered at module scope, so **a `chrome.*` API that
does not exist is not a degraded feature — it is a `TypeError` that aborts module
evaluation and unregisters every other listener with it, capture included.** Check an
API against the reference before calling it.

## Conventions

- Plain DOM, no framework. Build nodes with `document.createElement` and set
  `textContent` — never `innerHTML` with archived titles or URLs in it.
- Colours are Catppuccin: Latte for light, Macchiato for dark. Every page reads the same
  custom properties from `dashboard.css` (the popup keeps its own copy of just the ones
  it uses); no page hard-codes a hex value. `prefers-color-scheme` picks the default and
  `:root[data-theme]` overrides it in both directions, so the Macchiato block appears
  twice and the two copies must stay in step.
- Comments explain *why*, particularly where a line protects an invariant above. Match
  that density; do not add narration of what the code plainly does.
- `async`/`await` throughout; wrap raw IndexedDB requests with `reqToPromise`/`txDone`/
  `cursorEach` from `db.js` rather than hand-rolling `onsuccess` handlers.
- British spelling appears in existing identifiers (`normaliseTime`, `tokenise`).
- Keep permissions minimal. The extension has no host permissions and makes no network
  requests; adding either changes the privacy story stated in the README.

## Testing changes

`tests/logic.test.mjs` covers `db.js`, `record.js`, `search.js`, `blocklist.js`, and the
merge semantics of `sync.js` (round-trip, validation, repeat import, partial line) — it
cannot import `sync.js` itself, which needs File System Access, nor `theme.js`, which
needs a DOM. Changes to the invariants above belong in this file as a test; changes to a
UI file are unavoidably manual.

The title-repair tests are seeded last, alongside the fuzzy-search pages, because the
earlier tests assert absolute row counts.

The final test imports `service-worker.js` against a `chrome` stub holding exactly the
APIs the reference documents. It asserts nothing beyond "the module evaluated", which is
the point: that is the failure the worker cannot survive. When the worker starts using a
new `chrome.*` API, add it to that stub — and if it is not in the stub because it is not
in the docs, that is the test doing its job.

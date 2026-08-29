# ARCHITECTURE.md

Implementation detail for History Keeper. [AGENTS.md](AGENTS.md) holds the short contract —
the hard rules, the execution contexts, and the seven invariants referenced throughout this
file. Read that first; read the relevant section here before changing the code it covers.

**§11 lists things that look like bugs and are deliberate.** Read it before "fixing" anything.

---

## 1. Data model

`DB_NAME = 'historykeeper'`, `DB_VERSION = 1`, all in `src/lib/db.js`.

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `visits` | `id` = `urlHash:visitTime` | `visitTime`, `host`, `urlHash`, `localSeq` | The archive |
| `pages` | `urlHash` | `host`, `lastSeen` | Distinct-URL rollup; search and stats scan this smaller set |
| `meta` | `key` | — | Device id, sweep/sync timestamps, `seqCounter`, folder handle |
| `imports` | `filename` | — | Bytes already consumed per shard |
| `backfill` | `url` | — | Initial-import work queue |

### 1.1 Record shapes

A `visits` row, as produced by `makeRecord()`:

```js
{
  id:         'a1b2c3d4e5f60718:1768478400000', // urlHash + ':' + visitTime
  urlHash:    'a1b2c3d4e5f60718',   // first 16 hex chars (8 bytes) of SHA-256(url)
  url:        'https://example.com/page',
  title:      'Example',            // '' when Chrome did not know it yet
  host:       'example.com',        // hostname only, trailing dot stripped
  visitTime:  1768478400000,        // integer ms since epoch
  transition: 'link',               // Chrome's TransitionType, defaults to 'link'
  deviceId:   'a1b2c3d4',           // 8 chars of a UUID, minted once per install
  localSeq:   4711,                 // ONLY on locally captured rows (invariant 3)
}
```

A `pages` row:

```js
{
  urlHash:    'a1b2c3d4e5f60718',
  url:        'https://example.com/page',
  host:       'example.com',
  title:      'Example',            // '' until some visit supplies one
  firstSeen:  1768478400000,        // min visitTime across this page's visits
  lastSeen:   1768564800000,        // max visitTime
  visitCount: 3,
}
```

A `backfill` row: `{ url, title }`. An `imports` row:
`{ filename, bytesConsumed, lastModified }`. A `meta` row: `{ key, value }`.

### 1.2 Every `meta` key in use

| Key | Written by | Meaning |
|---|---|---|
| `deviceId` | worker `getDeviceId()` | 8 hex chars from `crypto.randomUUID()`. Minted once, never changes. Names this device's shards. |
| `deviceLabel` | options page | Cosmetic only. Never leaves the device. |
| `seqCounter` | `putVisits`, `backfillTitle` | Monotonic counter behind `localSeq`. |
| `lastSweepTime` | `sweep()`, `handleInstalled()` | Start of the next sweep window (minus the overlap). |
| `lastSweepAdded` | `sweep()` | Diagnostic only. |
| `backfillTotal` / `backfillDone` | `startBackfill()` / `runBackfillChunk()` | Progress bar numerator and denominator. |
| `backfillStartedAt` / `backfillFinishedAt` | `startBackfill()` / `finishBackfill()` | Presence of `backfillStartedAt` is how `handleInstalled` knows not to re-queue. |
| `backfillComplete` | `startBackfill()` / `finishBackfill()` | Hides the banner; gates the resume path on `onStartup`. |
| `snapshotDue` | weekly alarm; cleared by `downloadSnapshot()` | The worker cannot download, so it only raises a flag a page acts on. |
| `lastExportedSeq` | `exportDelta()` | High-water mark of `localSeq` already written to a shard. |
| `lastExportAt` / `lastSyncTime` | `exportDelta()` / `importAll()` | Display only. |
| `syncDirHandle` | `chooseDirectory()` | The live `FileSystemDirectoryHandle`. IndexedDB can structured-clone it; `chrome.storage` cannot, which is why it lives here and not with the other settings. |

### 1.3 Schema changes

Bump `DB_VERSION` and add a branch to `migrate()` — the existing `if (oldVersion < 1)`
block must stay intact for users upgrading. `migrate()` receives `(db, oldVersion)` and
runs inside the `versionchange` transaction, so it may only use synchronous
`createObjectStore`/`createIndex` calls; to backfill data into a new index you must do it
lazily afterwards, not in there.

Two things are kept outside IndexedDB, in `chrome.storage.local`: blocklist patterns
under `blocklist`, and the theme choice under `theme`. Both are settings rather than
archive data, and both need `chrome.storage.onChanged` so an already-open page follows an
edit made elsewhere.

---

## 2. Capture paths

All four run in the service worker, all four funnel into `putVisits(..., { assignLocalSeq: true })`.

### 2.1 `chrome.history.onVisited` — real time

Fires whenever Chrome commits a navigation, but only while the worker is alive. The
listener is registered at module scope; `captureVisit()`:

1. `isArchivable(url)` — only `http:`, `https:`, `ftp:`, `file:`. Drops `chrome://`,
   `chrome-extension://`, `data:`, `about:`.
2. `isBlocked(url, host)` — see §6.
3. **Re-reads the timestamp through `chrome.history.getVisits()` rather than trusting
   `HistoryItem.lastVisitTime`.** The two can disagree in their fractional part, and a
   disagreement mints a second row for a visit the sweep already stored. Falls back to
   `item.lastVisitTime ?? Date.now()` if the URL vanished between the event and the
   lookup.
4. `makeRecord()` → `putVisits()`.
5. If the record has no title, `scheduleRetitle(url)` (§3).

### 2.2 The 15-minute `sweep` alarm

Covers everything the worker missed while evicted. `sweep()`:

- Window is `[lastSweepTime - 5 min, now]`. The 5-minute overlap is free because of
  invariant 1.
- `chrome.history.search({ text: '', startTime, endTime, maxResults: 10_000 })` gives
  *pages*; each page then needs `getVisits()` to get individual visit times, filtered
  back down to the window.
- **Truncation handling matters.** `history.search` returns newest-first, so hitting
  `maxResults` means the older part of the window was never actually searched. Advancing
  `lastSweepTime` to `now` would mark that unsearched stretch as swept forever. Instead
  `lastSweepTime` becomes `min(item.lastVisitTime)` over what was returned, and the next
  sweep picks up right behind it. Do not "simplify" this.

### 2.3 The `backfill` alarm — initial import

`startBackfill()` queries all of Chrome's remaining history (`maxResults: 100_000`) and
writes one `backfill` row per URL. The queue is in IndexedDB, not memory, because it can
be 100k+ URLs and the worker will be evicted many times before it drains.

`runBackfillChunk()` runs on a 1-minute alarm and loops until a 20-second budget expires:
take 250 queue rows → `getVisits()` for each → `putVisits()` → **then** delete those
queue rows → bump `backfillDone`. Deleting only after the visits commit means an eviction
mid-chunk costs one repeated chunk, not the run. When the queue is empty,
`finishBackfill()` clears the alarm and sets `backfillComplete`.

Triggered by `chrome.runtime.onInstalled` (on `install`, or whenever `backfillStartedAt`
is absent), and re-armed by `chrome.runtime.onStartup` if it was still incomplete.
Re-runnable at any time from the options page — that is the **Re-scan all Chrome history**
button, which is also the strongest title repair (§3).

### 2.4 The weekly `snapshot` alarm

Sets `meta.snapshotDue = true` and nothing else. Downloading needs a DOM, so the
dashboard shows a banner and does the work.

### 2.5 Messages the worker accepts from pages

`chrome.runtime.onMessage` handles exactly three types; the handler returns `true` to keep
the response channel open for the async reply.

| Type | Effect | Reply |
|---|---|---|
| `sweepNow` | runs `sweep()` | `{ added, titled }` |
| `restartBackfill` | `startBackfill()` then one chunk | `{ ok: true }` |
| `ping` | — | `{ ok: true, deviceId }` |

Anything else replies `{ error: 'unknown message ...' }`. A thrown error replies
`{ error: String(err) }`, so callers must check `response?.error`.

---

## 3. Titles

Chrome records a visit when the navigation commits and learns the page title only once
the renderer reports it. `onVisited` therefore fires with an empty title for any URL
being seen for the first time, and single-page apps widen the gap — YouTube pushes a
history entry per video and sets `document.title` well afterwards.

Three things repair that, all sharing the **empty → non-empty rule**: a blank title may be
filled in, but a title that merely *differs* is never overwritten. That second half is
load-bearing — titles carrying a live counter (`(3) Inbox`, a YouTube view count) would
otherwise be rewritten, re-stamped with a new `localSeq`, and re-exported on every single
sweep, churning the shard files forever.

- **`scheduleRetitle()`** in the worker: a URL captured blank is added to an in-memory
  `Set`, and ~6 s later the whole batch is re-read through **one** `history.search` over
  the last 5 minutes, then written via `backfillTitle()`. **`chrome.history` has no title
  event** — only `onVisited` and `onVisitRemoved` — so this is a timer, and a timer does
  not survive worker eviction. It is best effort on purpose; the sweep is the guarantee.
- **The sweep and a backfill re-run**, through `putVisits`, which is what makes
  **Re-scan all Chrome history** in the options page a title repair as well.
- **Another device's shard**, through the same `putVisits` path.

A repair re-stamps `localSeq` so it reaches other devices — but only where `localSeq` is
already present, per invariant 3. `backfillTitle()` walks the `urlHash` index and patches
every blank visit for that URL, plus the `pages` row.

Every listener in the worker is registered at module scope, so **a `chrome.*` API that
does not exist is not a degraded feature — it is a `TypeError` that aborts module
evaluation and unregisters every other listener with it, capture included.** Check an
API against the reference before calling it, and add it to the stub in the last test.

---

## 4. Sync

### 4.1 On-disk layout

```
<folder the user picked>/
  history-keeper/
    a1b2c3d4-2026-01.ndjson     <- device a1b2c3d4, January 2026
    a1b2c3d4-2026-02.ndjson
    9f8e7d6c-2026-02.ndjson     <- another device, same month, separate file
```

One JSON object per line, terminated by `\n`. Shards rotate monthly by
**`visitTime`**, not by wall clock at write time, so a late-arriving old visit lands in
the month it happened. Monthly rotation keeps the cloud client from re-uploading one
ever-growing file on every append.

### 4.2 Export (`exportDelta`)

Cursor the `localSeq` index over `lowerBound(lastExportedSeq, /* exclusive */ true)`,
capped at 20 000 records per call (`{ more: true }` in the return says another pass is
needed). Group lines by `monthKey(visit.visitTime)`, `forExport()` each one to strip
`localSeq`, then append per file with `createWritable({ keepExistingData: true })` +
a `seek` to the current byte size. Only after all writes does `lastExportedSeq` advance.

### 4.3 Import (`importAll`)

For each `*.ndjson` in the folder that is **not** ours (`name.startsWith(deviceId + '-')`):

1. Look up `imports[name].bytesConsumed`. If the file is *smaller* than the bookmark it
   was replaced or truncated, so re-read from 0 — dedupe makes that safe, just slower.
2. `file.slice(consumed)` → bytes → find `lastIndexOf(0x0a)`. If there is no newline in
   the new bytes, skip the file entirely this pass (invariant 6). Decode only up to and
   including that newline.
3. Parse, validate (§4.4), `putVisits(..., { assignLocalSeq: false })` in batches of 500.
4. Only then write the new `bytesConsumed`.

`syncNow()` is `exportDelta()` then `importAll()`, and the dashboard calls it on load and
every 5 minutes while visible.

### 4.4 The trust boundary

The import loop is the **only** place another party's data enters the archive; the
capture paths in the worker have already filtered everything they produce. Each parsed
line must pass, in order:

- `isValidRecord(rec)` — types, `title.length <= 500`, `Number.isInteger(visitTime)`,
  `isArchivable(url)`, and `rec.id === visitId(rec.urlHash, rec.visitTime)` (internal
  consistency).
- `await urlHashMatches(rec)` — that `urlHash` was *actually* derived from `url`. This is
  separate and async because `isValidRecord` is synchronous and used widely; without it a
  line could claim any hash for any URL, landing it in the wrong page's rollup and hiding
  it from the blocklist purge (which scans by URL).
- `await isBlocked(rec.url, rec.host)` — this device's blocklist applies to peers' data
  too.

A line failing any check, or failing `JSON.parse`, is skipped silently; the rest of the
file still imports. `importFromFile()` (the manual **Import file…** button) runs the same
three checks — keep them in step if you touch either.

### 4.5 Picker availability

`showDirectoryPicker` is Chromium-only and withheld from opaque origins, frames, and
insecure contexts; Brave ships it disabled behind a flag. `directoryPickerBlockedReason()`
returns a specific human sentence for each case and `syncEnvironmentDetail()` prints the
context in one line, so a "sync doesn't work" report is diagnosable without a
back-and-forth. The snapshot/import path works everywhere and is the documented fallback.

`verifyPermission(handle, { request })` exists because Chrome does not reliably persist a
directory grant across browser restarts. `request: true` needs user activation — only
pass it from inside a click handler.

`doSync()` guards on a module-level `syncInFlight` flag. The 5-minute timer only checks
`state.dirUsable`, not the button's disabled state, so without the guard two concurrent
File System Access writes to the same shard would silently clobber each other.

---

## 5. Search

### 5.1 The page cache

`search.js` keeps an in-memory mirror of the `pages` store (`getPageCache`), rebuilt at
most every 30 s. Search-as-you-type cannot afford an IndexedDB cursor per keystroke:
scoring a cached array of 100k pages is a few milliseconds, cursoring the same rows is
hundreds. Each cached row precomputes `hay = (title + '\n' + url).toLowerCase()` and
`titleLen` so the hot loop never lowercases anything.

**Call `invalidatePageCache()` after any write the dashboard makes** — delete, import,
sync, backfill progress. Forgetting this is the most likely way to ship a stale-results
bug.

### 5.2 Two orderings

- `relevanceQuery()` — one row per **page**, best match first. What you want while typing.
  The ✕ on such a row deletes the whole page.
- `query()` — one row per **visit**, newest first, cursoring the `visitTime` index
  backwards. What you want while browsing. The ✕ deletes one visit.

Both accept `{ text, host, from, to, limit, offset }`. `relevanceQuery` does a cheap
in-memory range rejection against `page.firstSeen`/`lastSeen` before paying for
`latestVisitInRange()`.

### 5.3 Scoring (`fuzzy.js`)

Per token, four tiers, cheapest first, `AND` across tokens (any token scoring 0 rejects
the page):

| Tier | Score | Example |
|---|---|---|
| substring at a word boundary | 1.00 | `git` in `github.com` |
| substring anywhere | 0.85 | `hub` in `github.com` |
| subsequence | 0.55 × (0.6 + 0.4 × compactness) | `gthb` in `github` |
| typo, bounded edit distance | 0.35 | `pythom` → `python` |

`+0.05` if the match falls inside the title rather than the URL. Then two small
multiplicative nudges — recency (`exp(-ageDays/180)`, up to +20%) and familiarity
(`log10(visitCount)`, up to +10%) — deliberately small so they break ties rather than
outrank a better textual match.

The typo tier is the expensive one and is only attempted on a **second pass**, and only
when the first pass returned fewer than 20 hits — which is precisely when the user has
mistyped. Even then most words never reach the Levenshtein table: a 32-bit character
presence mask (letters get a bit each, digits fold onto six — folding can only ever
overstate presence, so the filter stays sound) rejects a word in a couple of integer ops
if more than `maxDist` of the token's distinct characters are missing. `maxDist` is 0 for
tokens ≤3 chars, 1 for ≤5, else 2. The DP rows are two module-level `Uint16Array`s reused
across calls; allocating them per call used to dominate the pass.

---

## 6. Blocklist

Patterns live in `chrome.storage.local.blocklist` as a string array, one pattern per line
in the options textarea. `compile()` turns them into `{ raw, test(url, host) }` objects:

| Pattern | Matches |
|---|---|
| `example.com` | that host **and all subdomains** |
| `*.example.com` | subdomains only |
| `/regex/flags` | tested against the whole URL |
| `# text` | comment, skipped |

Hosts are normalised through `new URL('http://' + raw).hostname`, which punycodes and
lowercases them the same way `hostOf()` does, so a Unicode or mixed-case pattern still
matches. A pattern containing a scheme, path, query, fragment, whitespace, or port can
never equal `hostOf()`'s bare hostname, so `compile()` **drops it** — and the options page
counts the difference and tells the user, rather than reporting a save count full of
patterns that do nothing. A malformed regex is likewise ignored rather than allowed to
block all writes.

The compiled list is cached module-side and invalidated by `chrome.storage.onChanged`, so
the worker follows an edit made on the options page without a restart.

`purgeMatching()` is the retroactive half: scan `pages`, collect matching `urlHash`es,
`deletePage()` each one (which deletes its visits too), reporting progress every 25 pages.

---

## 7. UI conventions

- Plain DOM, no framework. Build nodes with `document.createElement` and set
  `textContent` — **never** `innerHTML` with archived titles or URLs in it. Archived
  titles are attacker-influenced content.
- `const $ = (id) => document.getElementById(id);` is the idiom in all three pages. IDs in
  the HTML are the contract between markup and script; grep for the id before renaming.
- Colours are Catppuccin: Latte for light, Macchiato for dark. Every page reads the same
  custom properties from `dashboard.css` (the popup keeps its own copy of just the ones
  it uses); no page hard-codes a hex value. `prefers-color-scheme` picks the default and
  `:root[data-theme]` overrides it in both directions, so **the Macchiato block appears
  twice and the two copies must stay in step** — a media query cannot be folded into a
  selector list. Contrast-adjusted values (`--muted`, `--ok` in Latte) carry a comment
  with their measured ratio; keep it if you change them.
- `theme.js` stores `auto | latte | macchiato`. `auto` **removes** `data-theme` rather
  than setting a third value, because absence is what lets the media query decide.
- Accessibility basics are not optional here: icon-only buttons (`✕`) get an `aria-label`
  reusing their descriptive `title`, the result summary is `aria-live="polite"`, and the
  theme button's label names both state and action.
- The dashboard debounces typing by 140 ms and stamps each search with an incrementing
  `state.generation` so a slow query cannot overwrite a newer one's results. Enter skips
  the debounce.
- `state.sortTouched` makes the sort control follow the text box (relevance when there is
  text, time when there is not) until the user overrides it themselves.

---

## 8. Code conventions

- Comments explain *why*, particularly where a line protects an invariant. Match that
  density; do not add narration of what the code plainly does.
- `async`/`await` throughout; wrap raw IndexedDB requests with `reqToPromise`/`txDone`/
  `cursorEach` from `db.js` rather than hand-rolling `onsuccess` handlers. `cursorEach`
  stops early when the callback returns `false` — that is the idiom for "first/last row".
- IndexedDB transactions auto-commit when the microtask queue drains with no pending
  request, so **never `await` something unrelated (a `chrome.*` call, a `fetch`) in the
  middle of a transaction** — do that work first and open the transaction after.
- British spelling appears in existing identifiers (`normaliseTime`, `tokenise`,
  `normaliseHost`).
- Errors in fire-and-forget paths are caught and logged with the `[HistoryKeeper]` prefix
  rather than left to become unhandled rejections in a worker no one is watching.

---

## 9. Testing changes

`tests/logic.test.mjs` covers `db.js`, `record.js`, `search.js`, `blocklist.js`,
`fuzzy.js`, and the merge semantics of `sync.js` (round-trip, validation, repeat import,
partial line, `importFromFile`'s filtering). It cannot exercise the File System Access
half of `sync.js`, nor `theme.js`, which needs a DOM. Changes to the invariants belong in
this file as a test; changes to a UI file are unavoidably manual.

Structure to be aware of before adding tests:

- Tests run top-to-bottom in one process against one shared fake database. **Several
  assert absolute row counts**, so a new test that seeds visits belongs at the *end*, not
  in the middle. The fuzzy-search pages and the title-repair fixtures are already seeded
  last for exactly this reason.
- `chrome` is a hand-built global at the top of the file: `chrome.storage.local` with an
  in-memory `_data`, and a no-op `onChanged`. Extend it there if a module you touch needs
  more.
- **The final test imports `service-worker.js`** against a `chrome` stub holding exactly
  the APIs the reference documents — `alarms.{onAlarm,getAll,create,clear}`,
  `history.{onVisited,onVisitRemoved,search,getVisits}`,
  `runtime.{onInstalled,onStartup,onMessage}`. It asserts nothing beyond "the module
  evaluated", which is the point: that is the failure the worker cannot survive. When the
  worker starts using a new `chrome.*` API, add it to that stub — and if it is not in the
  stub because it is not in the docs, that is the test doing its job.

---

## 10. Recipes for common changes

**Add a field to visit records.** Add it in `makeRecord()`; decide whether
`isValidRecord()` should require it (it will reject every existing shard line if you do —
prefer optional); confirm `forExport()` still strips only local fields. No schema bump is
needed for a non-indexed field.

**Add an index.** Bump `DB_VERSION` to 2, add `if (oldVersion < 2) { ... }` to
`migrate()`, leave the `< 1` block alone. Remember the store must be reached through
`transaction.objectStore(...)` inside the upgrade transaction, not a fresh one.

**Add a new `chrome.*` call in the worker.** Verify it exists in the extension API
reference *first*, then add it to the stub in the last test, then use it. Skipping the
first step ships a worker that registers no listeners at all.

**Add a periodic background job.** Use `chrome.alarms` with a name constant next to the
existing three, create it in `ensureAlarms()`, dispatch it in the `onAlarm` listener. Do
not use `setInterval` — it dies with the worker. Minimum alarm period is 1 minute.

**Add something the worker cannot do (downloads, File System Access, DOM).** Follow the
snapshot pattern: the worker sets a `meta` flag, a page notices it and does the work.

**Add a new write path into `visits`.** Route it through `putVisits`/`deleteVisit`/
`deletePage` rather than opening your own transaction, or you will break invariant 5.

**Touch anything the dashboard reads.** Call `invalidatePageCache()` afterwards.

---

## 11. Traps

Things that look wrong but are deliberate. Do not "fix" one without reading the reasoning
above.

1. `sweep()` sometimes sets `lastSweepTime` to an *older* value than `now` — that is the
   truncation guard (§2.2).
2. `putVisits` refuses to overwrite a non-empty title with a different one (§3).
3. `importAll` skips a whole file when the new bytes contain no newline (invariant 6).
4. `openDb()` nulls its own cached promise on rejection, so one transient `onblocked`
   does not wedge every later call in that context for the rest of its life.
5. The retitle timer is expendable and there is no attempt to persist it (§3).
6. `chrome.tabs.create` in the popup works without the `tabs` permission — that permission
   only gates reading tab URLs and titles. Do not add it.
7. `dashboard.js` calls `initTheme()` unawaited, above `init()`, so the page is not
   painted in the wrong flavour while the archive queries run.

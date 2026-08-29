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

Page text lives in a **second database**, `historykeeper-content` (version 1,
`openContentDb()` in the same file), deliberately outside `DB_VERSION` — see §1.3.

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `content` | `urlHash` | `tokens` (multiEntry), `capturedAt`, `exportAt` | Gzipped page text and its terms |

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

A `content` row, in the second database:

```js
{
  urlHash:    'a1b2c3d4e5f60718',   // same key as the pages row it belongs to
  host:       'example.com',        // carried so a purge need not join `pages`
  gz:         Uint8Array(1842),     // gzipped normalised text, ~4:1
  tokens:     ['mitochondrion', …], // ≤500 distinct terms; this array IS the index
  capturedAt: 1768478400000,        // also the LRU stamp for eviction
  chars:      7431,                 // uncompressed length, before gzip
  bytes:      1842,                 // gz.length, for the size readout
  exportAt:   1768478400000,        // ONLY on locally captured rows (invariant 8)
}
```

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
| `snapshotDue` | `snapshot` alarm; cleared by `downloadSnapshot()` | The worker cannot download, so it only raises a flag a page acts on. |
| `lastExportedSeq` | `exportDelta()` | High-water mark of `localSeq` already written to a shard. |
| `lastExportAt` / `lastSyncTime` | `exportDelta()` / `importAll()` | Display only. |
| `contentEnabled` | options page | Governs **capture** of page text. Off stops new text arriving; it does not hide what is stored. |
| `contentStoreExists` | options page | Governs whether anything opens the content database at all. Keeps text searchable after capture is switched off, and keeps the database from being created for a user who never opted in. |
| `contentSyncEnabled` | options page | Whether `syncNow` also writes and reads content shards. |
| `lastExportedContentAt` | `exportContent()` | High-water mark of `exportAt` already written to a content shard. |
| `lastContentExportAt` | `exportContent()` | Display only. |
| `syncDirHandle` | `chooseDirectory()` | The live `FileSystemDirectoryHandle`. IndexedDB can structured-clone it; `chrome.storage` cannot, which is why it lives here and not with the other settings. |

### 1.3 Schema changes

**First ask whether it belongs in the archive database at all.** Bumping `DB_VERSION` is a
one-way door: every build already shipped hardcodes `DB_VERSION = 1`, and `indexedDB.open`
at a version *below* the one on disk fails with `VersionError`. `openDb()` backs every
context, so a user who rolled back to an earlier build — or loaded an older unpacked copy
— would get an extension that could no longer capture, search or sync, and no patch to the
new code could rescue them, because the old code is already out there. Derived,
device-local, re-creatable state belongs in its own database, which is why page text is
`historykeeper-content` rather than a sixth store. The cost of that choice is that a
cascade across the two cannot be one transaction; see §5.4 and invariant 5 for the
ordering that makes it safe anyway.

If the archive schema really must change: bump `DB_VERSION` and add a branch to
`migrate()` — the existing `if (oldVersion < 1)`
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

### 2.4 The `snapshot` alarm

Sets `meta.snapshotDue = true` and nothing else. Downloading needs a DOM, so the
dashboard shows a banner and does the work.

Fires every `meta.snapshotIntervalDays` days — 90 (quarterly) unless the options page
stores otherwise. `ensureAlarms()` compares the live alarm's period against that setting
and recreates it when they differ, so a change takes effect on the next worker wake, or
immediately via the `rescheduleSnapshot` message the options page sends.

### 2.5 Page text (`captureText`) — opt-in, forward-only

`chrome.tabs.onUpdated` at `status === 'complete'` →
`chrome.scripting.executeScript({ func: () => document.body.innerText })` → `putContent`.

Gated twice: `meta.contentEnabled`, and the host permission that lives in
`optional_host_permissions` and is requested from the options page. That permission is
`TEXT_ORIGINS` from `content.js` — `['http://*/*', 'https://*/*']`, shared by the worker
and the options page so the request cannot drift from the manifest. **Not `<all_urls>`:**
Chrome rejects that literal in `optional_host_permissions`, and the request throws "Only
permissions specified in the manifest may be requested". Until that permission
is granted Chrome does not populate `tab.url` here at all, so `isArchivable(tab.url)` is a
free early-out for everyone who never turned the feature on — which is why this listener
costs nothing by default. `isBlocked` applies as it does to every other capture path.

**The URL comes from Chrome's own tab record, never from the injected function.** The
script runs in the isolated world and returns text and nothing else; a page must not get
to say which URL its text is filed under.

`innerText` rather than `textContent`: it follows what is actually rendered, so hidden
markup and scripts drop out with no parsing of our own.

**There is no backfill counterpart and there cannot be.** Re-reading an already-archived
page means a network request, which this extension does not make. Text accrues only as you
browse, which also keeps index growth gradual — a few pages a minute, never a bulk write.
`putContent` skips a page captured within the last 30 days, and `evictContent` trims the
store to `CONTENT_MAX_ROWS` oldest-first once past budget.

### 2.6 Messages the worker accepts from pages

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
    a1b2c3d4-content-001.jsonl  <- page text, only if that opt-in is on (§4.6)
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

### 4.6 Page-text shards

A separate opt-in (`contentSyncEnabled`) and separate files:
`<deviceId>-content-<NNN>.jsonl`, rotating at 8MB, still append-only and still
single-writer, so invariant 4 is unchanged. Text is per *page* while a visit line is per
visit; folding it into the visit stream would re-send the same article once per time you
opened it.

One line per page: `{ urlHash, url, capturedAt, gz }`, where `gz` is **base64** of the
gzipped text. Base64 costs about a third of the compression back — net ~3:1, roughly
2.7 KB a page — and it is not optional: invariant 6 finds the last complete line by
scanning for `0x0A`, and raw gzip output contains that byte freely.

**The `.jsonl` extension is load-bearing.** `importAll` takes every `.ndjson` in the folder
that is not its own, so a machine still running an older build and sharing the folder would
otherwise download every content shard whole, reject every line against `isValidRecord`,
and bookmark it — safe, but tens of MB per sync forever. A different extension is skipped
at the filename filter for zero bytes read.

`mergeContentLine` is the trust boundary: shape, `urlHash` really derived from `url`,
`isBlocked`, plus a hard cap on the encoded line *before* anything is decompressed and on
the decoded text after. Tokens are recomputed locally rather than trusted, so the tokeniser
can change without invalidating anyone's shards, and imported rows are written with
`local: false` so they carry no `exportAt` (invariant 8).

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

### 5.4 Page text is a second lane, not a bigger haystack

Body text averages ~8 KB a page against ~150 bytes for `title\nurl` — roughly 1 GB across
100k pages. It can never enter `pageCache`, and the Levenshtein tier can never scan it per
keystroke. So there are two lanes, and lane A is exactly what §5.1–5.3 describe, untouched:

- **Lane A**, title and URL: the in-memory mirror and the four tiers above.
- **Lane B**, page text: term lookup through the `tokens` multiEntry index — the platform's
  own inverted index, which is why there is no postings store to maintain.

`scorePage` keeps `AND` **per token across both lanes**: every token must match something,
but each may do so through either, so `react useEffect` matches a page titled *React* that
only mentions `useEffect` in its body. `TIER_CONTENT` (0.45) sits below every tier in §5.3,
so a page actually *called* what you typed always outranks one that merely mentions it;
`TIER_CONTENT_TYPO` is 0.20.

Tokens shorter than 3 characters skip lane B entirely — a prefix range on one or two
characters covers most of the vocabulary. Posting lists are capped at 20 000 keys.

**Typo tolerance over text** comes from the term dictionary: `'nextunique'` over that same
index enumerates the distinct term set, so the platform already maintains it and there is
no second store to keep consistent. A mistyped token is expanded into up to 5 real terms —
reusing `boundedEditDistance` and the same mask prefilter from §5.3 — before the index is
touched, and only on the second pass, on the same threshold as lane A. The walk uses
`keyCursorEach`, not `cursorEach`: `openCursor` would deserialise every gzipped page to
hand back a value nobody reads.

**Open a fresh transaction per index lookup.** An IndexedDB transaction commits as soon as
the event loop drains without a pending request, and the dictionary walk between two
lookups does exactly that. A held handle is a `TransactionInactiveError` — this was a real
bug, caught by the typo test.

`invalidatePageCache()` drops the dictionary and the `contentStoreExists` memo along with
the page mirror, so every existing call site keeps working unchanged.

Snippets are built only for rows actually returned *and* only where the match came from
text — `row.snippet` is null otherwise, which makes its presence the answer to "why is
this here?". Nothing is decompressed for the thousands of pages merely scored.

`snippetAround` returns **segments** (`{text, hit}[]`), not marked-up text, and the
dashboard's `appendParts()` turns each into a text node or a `<mark>` with
`createElement`/`textContent`. Archived text never goes near `innerHTML`, so the emphasis
cannot be the thing that finally makes a hostile page's own words executable.

The row's **label** is marked the same way, through `markUp()` — the no-window sibling of
`snippetAround` — off `row.titleParts`, in both orderings, and null when the query is
empty so plain browsing pays for none of it. Which terms light up depends on the tier that
matched:

| Tier | Marked | Why |
|---|---|---|
| substring / boundary | the token, widened to its whole word | it is literally there |
| typo | the word it was rescued to (`nearestWord`) | the user never typed the real word; marking what they typed would mark nothing |
| subsequence | nothing | its characters are scattered across the string, and emphasising them individually reads as corrupted text |

`nearestWord` is `typoScore`'s own walk, exported to return the matched word instead of a
score, so the highlight cannot disagree with the ranking about what matched.

Hit ranges are widened to whole words — a term reaches the index by prefix, so typing
`mit` matches the stored term `mitochondrion`, and lighting up three letters of a long
word reads as a rendering bug rather than an answer — and overlapping ranges are merged so
two query tokens landing on one word emphasise it once. The window is `SNIPPET_WIDTH`
(420 chars, about three lines) and starts a quarter-width *before* the first hit so the
match reads inside a sentence rather than at the edge of one.

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
`fuzzy.js`, `content.js`, and the merge semantics of `sync.js` (round-trip, validation,
repeat import, partial line, `importFromFile`'s filtering, `mergeContentLine`). It cannot exercise the File System Access
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
- **The page-text block switches `contentEnabled` on itself and off again at the end.**
  Everything before that line runs with the feature off, which is the state an updating
  user is in — so the whole suite doubles as the regression test for "nothing changed for
  anyone who did not opt in". Keep it that way: do not hoist the flag.
- **The final test imports `service-worker.js`** against a `chrome` stub holding exactly
  the APIs the reference documents — `alarms.{onAlarm,getAll,create,clear}`,
  `history.{onVisited,onVisitRemoved,search,getVisits}`,
  `runtime.{onInstalled,onStartup,onMessage}`, `tabs.onUpdated`,
  `scripting.executeScript`, `permissions.{contains,request,onAdded,onRemoved}`. It asserts nothing beyond "the module
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
8. Page text is a **second database** rather than `DB_VERSION = 2`. That is not an
   oversight — see §1.3. It is also why `deletePage` deletes text *before* it opens the
   archive transaction and `deleteVisit` does it *after*: the two cannot share one
   transaction, and those orderings are each the safe one for their path (invariant 5).
9. `putContent`'s `now` defaults to `nextStamp()`, not `Date.now()`, so stamps are
   strictly increasing within a context — `capturedAt`/`exportAt` is the export cursor and
   two captures in one millisecond would let the second slip past an exclusive range. A
   caller that passes `now` explicitly gets exactly what it asked for.
10. `contentEnabled` and `contentStoreExists` are two flags on purpose. The first governs
    capture, the second governs whether the content database is opened at all — which is
    what keeps stored text searchable after capture is switched off, and keeps the
    database from existing for a user who never opted in.

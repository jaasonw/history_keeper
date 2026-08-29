# AGENTS.md

A Manifest V3 Chrome extension that mirrors `chrome.history` into its own IndexedDB store
so visits survive Chrome's 90-day expiry, and merges archives across machines through a
cloud-synced folder of append-only NDJSON files.

**Before any non-trivial change, read [ARCHITECTURE.md](ARCHITECTURE.md)** — data model,
capture paths, sync protocol and its trust boundary, search scoring, and per-task recipes.
Its **§11 lists seven things that look like bugs and are deliberate**; check it before
"fixing" one.

## Hard rules

- **No build step.** `src/` is loaded directly by Chrome as ES modules (`"type": "module"`
  in both `manifest.json` and `package.json`). No bundler, transpiler, framework, or
  runtime dependency — ever. `fake-indexeddb` is dev-only, for tests.
- **No network requests and no host permissions.** Adding either breaks the privacy claim
  the README makes. Permissions are `history`, `storage`, `unlimitedStorage`, `alarms`.
- **`src/lib/db.js` never touches `chrome.*`.** Every context imports it, and the tests
  run it under Node.
- Comments explain *why*, not what. Match the existing density.
- British spelling in identifiers (`normaliseTime`, `tokenise`).

## Commands

```bash
npm install && npm test
```

`tests/logic.test.mjs` runs directly under Node — no framework, no config, no linter, no
CI. Browser: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
Reload the extension card after editing the worker; pages just need F5.

## Execution contexts

Three contexts share one `chrome-extension://` origin and therefore one IndexedDB.

| Context | Entry | Notably cannot |
|---|---|---|
| Service worker | `src/background/service-worker.js` | File System Access, DOM, or keep anything in memory — it is evicted after ~30 s idle |
| Dashboard / options / popup | `src/*/[dashboard\|options\|popup].js` | — |

So: sync (File System Access) and `theme.js` (DOM) are **page-only**, which is why sync
runs on a dashboard timer rather than an alarm. Anything that must survive eviction goes
in IndexedDB, never a module-level variable.

## Invariants

Break one and duplicates or merge conflicts follow. Each has a test.

1. **The visit id is `sha256(url)[0:16]:visitTime`, with nothing device-specific in it.**
   This is what makes overlapping capture, a re-runnable backfill, repeat imports, and
   cross-device merge idempotent unions rather than conflict resolution.
2. **Visit times are rounded** (`normaliseTime`). Chrome reports sub-millisecond floats;
   the rounded value is half the dedupe key, so an unrounded read mints a second row.
3. **Only locally captured visits carry `localSeq`.** IndexedDB omits records missing an
   indexed property, so the `localSeq` index *is* the un-exported set. Assigning one to an
   imported record re-exports another device's data under this device's name.
4. **No shard file is ever written by two devices.** Each appends only to
   `<deviceId>-<YYYY-MM>.ndjson` and reads the rest. That is what makes this safe on top
   of file-sync clients, which handle concurrent edits badly.
5. **`pages` stays consistent with `visits`.** `putVisits`/`deleteVisit`/`deletePage`
   maintain the rollup; a new write path must maintain it too.
6. **Import stops at the last complete line.** A cloud client mid-download leaves a
   trailing partial line; the byte offset in `imports` may only advance past `\n`.
7. **Untrusted records are validated before they are written** — `isValidRecord` →
   `urlHashMatches` → `isBlocked`, at every import boundary.

A blank title may later be filled in (strictly empty → non-empty), which is the one
exception to 1 and is itself load-bearing. See ARCHITECTURE.md §3.

## Layout

| Path | What |
|---|---|
| `src/background/service-worker.js` | All capture: alarms, `onVisited`, backfill drain, message handler |
| `src/lib/db.js` | The only IndexedDB layer |
| `src/lib/record.js` | Hashing, normalisation, validation of untrusted records |
| `src/lib/sync.js` | File System Access export/import, snapshots (**pages only**) |
| `src/lib/search.js` · `fuzzy.js` | Dashboard queries and the scoring function |
| `src/lib/blocklist.js` · `theme.js` | Settings in `chrome.storage.local` |
| `src/{dashboard,options,popup}/` | The three UIs; `dashboard.css` holds shared tokens |
| `tests/logic.test.mjs` | The whole suite |

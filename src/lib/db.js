// IndexedDB layer for History Keeper.
//
// Shared verbatim by the service worker and by every extension page: they all run on
// the same chrome-extension:// origin and therefore see the same database. Nothing in
// here may touch chrome.* APIs, so it stays usable from both contexts.

import { gzip, gunzip, normaliseText, tokenise } from './content.js';
import { hostOf } from './record.js';

export const DB_NAME = 'historykeeper';
export const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => migrate(req.result, event.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
    // A transient failure (onblocked, a one-off onerror) must not wedge every future
    // call behind the same rejected promise for the rest of this context's lifetime.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    // One row per (page, moment-in-time). `id` is device-independent, which is what
    // makes cross-device merge an idempotent union instead of a conflict resolution.
    const visits = db.createObjectStore('visits', { keyPath: 'id' });
    visits.createIndex('visitTime', 'visitTime');
    visits.createIndex('host', 'host');
    visits.createIndex('urlHash', 'urlHash');
    // Only records this device captured carry `localSeq`, so records imported from
    // other devices are absent from this index, exactly what the export delta wants.
    visits.createIndex('localSeq', 'localSeq');

    // Distinct-URL rollup. Keyword search and domain stats scan this (tens of
    // thousands of rows) rather than the visit set (hundreds of thousands).
    const pages = db.createObjectStore('pages', { keyPath: 'urlHash' });
    pages.createIndex('host', 'host');
    pages.createIndex('lastSeen', 'lastSeen');

    db.createObjectStore('meta', { keyPath: 'key' });

    // Per-shard byte offsets so importing only reads the tail that grew.
    db.createObjectStore('imports', { keyPath: 'filename' });

    // Work queue for the initial backfill; rows are deleted as they are processed,
    // which is what makes the backfill survive service worker eviction.
    db.createObjectStore('backfill', { keyPath: 'url' });
  }
}

export function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const row = await reqToPromise(db.transaction('meta').objectStore('meta').get(key));
  return row === undefined ? fallback : row.value;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
  return value;
}

export async function setManyMeta(entries) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  for (const [key, value] of Object.entries(entries)) store.put({ key, value });
  await txDone(tx);
}

export async function countStore(name) {
  const db = await openDb();
  return reqToPromise(db.transaction(name).objectStore(name).count());
}

/**
 * Bytes on disk. This is the browser's own estimate for the whole extension origin
 * rather than a sum over the records: measuring the records means a full scan of
 * `visits`, which is far more than a headline figure is worth.
 *
 * The origin holds the archive *and* the page-text database, so this figure covers both.
 * contentStats() is what breaks the page-text share out separately.
 *
 * Returns null where the API is absent (Node under test) or the browser declines.
 */
export async function storageBytes() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage } = await navigator.storage.estimate();
    return typeof usage === 'number' ? usage : null;
  } catch {
    return null;
  }
}

/**
 * Write visit records, keeping the `pages` rollup in step.
 *
 * Records whose `id` already exists never produce a second row: that is the dedupe
 * rule that lets the sweep overlap with onVisited, lets the backfill re-run, and lets
 * the same shard be imported twice, all without producing duplicates. The one thing
 * such a record may still do is fill in a missing title, see below.
 *
 * @param {object[]} records  Output of makeRecord() in record.js.
 * @param {boolean} assignLocalSeq  True for locally captured visits (they need a
 *   sequence number so the sync engine can find what has not been exported yet),
 *   false for records imported from another device's shard.
 * @returns {Promise<{added: number, titled: number}>}
 */
export async function putVisits(records, { assignLocalSeq = false } = {}) {
  if (!records.length) return { added: 0, titled: 0 };

  const db = await openDb();
  const tx = db.transaction(['visits', 'pages', 'meta'], 'readwrite');
  const visits = tx.objectStore('visits');
  const pages = tx.objectStore('pages');
  const meta = tx.objectStore('meta');

  let seq = 0;
  if (assignLocalSeq) {
    const row = await reqToPromise(meta.get('seqCounter'));
    seq = row === undefined ? 0 : row.value;
  }

  let added = 0;
  let titled = 0;
  for (const rec of records) {
    const existing = await reqToPromise(visits.get(rec.id));
    if (existing) {
      // onVisited fires before the title exists, so a visit is routinely title-less;
      // fill it in later rather than freezing the blank in forever.
      //
      // Strictly empty -> non-empty: a title that merely *differs* (a live counter like
      // "(3) Inbox") is left alone, or it gets re-queued for export on every sweep.
      if (rec.title && !existing.title) {
        existing.title = rec.title;
        // Re-stamping puts the repair back in the export delta so other devices holding
        // the same blank visit get it filled too. Only for records this device captured:
        // adding localSeq to an imported record would export another device's data.
        if (assignLocalSeq && existing.localSeq !== undefined) existing.localSeq = ++seq;
        visits.put(existing);
        titled++;

        const stale = await reqToPromise(pages.get(rec.urlHash));
        if (stale && !stale.title) {
          stale.title = rec.title;
          pages.put(stale);
        }
      }
      continue;
    }

    const row = { ...rec };
    // A shard file can carry a localSeq field (a hand-edited or corrupted line) even
    // though this import didn't assign one, keeping it would make this device believe
    // it already exported someone else's sequence number and stop exporting its own.
    if (assignLocalSeq) row.localSeq = ++seq;
    else delete row.localSeq;
    visits.put(row);
    added++;

    // Reads inside a transaction see that transaction's earlier writes, so a batch
    // containing several visits to the same URL accumulates correctly.
    const page = await reqToPromise(pages.get(rec.urlHash));
    if (page) {
      page.visitCount += 1;
      if (rec.visitTime < page.firstSeen) page.firstSeen = rec.visitTime;
      if (rec.visitTime >= page.lastSeen) {
        page.lastSeen = rec.visitTime;
        if (rec.title) page.title = rec.title;
      } else if (rec.title && !page.title) {
        // The newest-known visit still has no title, but this older one (arriving late
        // from a backfill or another device's shard) does. Take it rather than leaving
        // the page permanently blank until something newer happens to carry a title.
        page.title = rec.title;
      }
      pages.put(page);
    } else {
      pages.put({
        urlHash: rec.urlHash,
        url: rec.url,
        host: rec.host,
        title: rec.title || '',
        firstSeen: rec.visitTime,
        lastSeen: rec.visitTime,
        visitCount: 1,
      });
    }
  }

  if (assignLocalSeq && (added > 0 || titled > 0)) meta.put({ key: 'seqCounter', value: seq });
  await txDone(tx);
  return { added, titled };
}

/**
 * Fill in the title on every archived visit to one URL that is missing one, and on its
 * page rollup.
 *
 * This is what the worker's deferred re-title pass feeds: Chrome only learns the title
 * a second or two after it records the visit, so the title arrives with no visit
 * attached to hang it on.
 *
 * Same empty -> non-empty rule as putVisits, for the same reason.
 */
export async function backfillTitle(urlHash, title) {
  if (!title) return 0;

  const db = await openDb();
  const tx = db.transaction(['visits', 'pages', 'meta'], 'readwrite');
  const visits = tx.objectStore('visits');
  const pages = tx.objectStore('pages');
  const meta = tx.objectStore('meta');

  const counter = await reqToPromise(meta.get('seqCounter'));
  let seq = counter === undefined ? 0 : counter.value;
  let patched = 0;

  await cursorEach(visits.index('urlHash'), IDBKeyRange.only(urlHash), 'next', (visit, cursor) => {
    if (visit.title) return;
    visit.title = title;
    if (visit.localSeq !== undefined) visit.localSeq = ++seq;
    cursor.update(visit);
    patched++;
  });

  if (patched) {
    const page = await reqToPromise(pages.get(urlHash));
    if (page && !page.title) {
      page.title = title;
      pages.put(page);
    }
    meta.put({ key: 'seqCounter', value: seq });
  }

  await txDone(tx);
  return patched;
}

/** Delete a single visit and decrement (or remove) its page rollup. */
export async function deleteVisit(id) {
  const db = await openDb();
  const tx = db.transaction(['visits', 'pages'], 'readwrite');
  const visits = tx.objectStore('visits');
  const pages = tx.objectStore('pages');

  const visit = await reqToPromise(visits.get(id));
  if (!visit) {
    await txDone(tx);
    return false;
  }
  visits.delete(id);

  let pageRemoved = false;
  const page = await reqToPromise(pages.get(visit.urlHash));
  if (page) {
    page.visitCount -= 1;
    if (page.visitCount <= 0) {
      pages.delete(visit.urlHash);
      pageRemoved = true;
    } else {
      // Only recompute if the deleted visit could actually have set one of these; the
      // common case (deleting some visit in the middle of a page's history) never needs
      // the extra scan.
      if (visit.visitTime === page.firstSeen || visit.visitTime === page.lastSeen) {
        let min = Infinity;
        let max = -Infinity;
        await cursorEach(visits.index('urlHash'), IDBKeyRange.only(visit.urlHash), 'next', (v) => {
          if (v.visitTime < min) min = v.visitTime;
          if (v.visitTime > max) max = v.visitTime;
        });
        page.firstSeen = min;
        page.lastSeen = max;
      }
      pages.put(page);
    }
  }
  await txDone(tx);
  // Page text lives in a second database, so this cannot join the transaction above.
  // Afterwards is the right side: a failure leaves an orphan content row, which is
  // inert since nothing resolves a hit with no page behind it.
  if (pageRemoved) await deleteContent(visit.urlHash);
  return true;
}

/** Delete every visit for a page, plus the page row itself. Used by the blocklist purge. */
export async function deletePage(urlHash) {
  // Before the archive rows, not after: this is the path the blocklist purge takes, and
  // a half-finished purge that has dropped the history but kept the page's *text* is
  // worse than one that has kept both and can be retried.
  await deleteContent(urlHash);

  const db = await openDb();
  const tx = db.transaction(['visits', 'pages'], 'readwrite');
  const index = tx.objectStore('visits').index('urlHash');
  let removed = 0;

  await cursorEach(index, IDBKeyRange.only(urlHash), 'next', (_visit, cursor) => {
    cursor.delete();
    removed++;
  });

  tx.objectStore('pages').delete(urlHash);
  await txDone(tx);
  return removed;
}

/**
 * Walk an index's keys without loading the records behind them.
 *
 * With 'nextunique' over a multiEntry index this enumerates the distinct term set, which
 * is what the typo pass needs. openCursor would deserialise every gzipped page to hand
 * back a value nobody reads.
 *
 * Return false from `onKey` to stop early.
 */
export function keyCursorEach(index, range, direction, onKey) {
  return new Promise((resolve, reject) => {
    const req = index.openKeyCursor(range, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      let keepGoing;
      try {
        keepGoing = onKey(cursor.key, cursor.primaryKey);
      } catch (err) {
        return reject(err);
      }
      if (keepGoing === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Walk an object store or index, calling `onRow` for each value.
 * Return false from `onRow` to stop early.
 */
export function cursorEach(source, range, direction, onRow) {
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range, direction);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      let keepGoing;
      try {
        keepGoing = onRow(cursor.value, cursor);
      } catch (err) {
        return reject(err);
      }
      if (keepGoing === false) return resolve();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------- page text

/**
 * Captured page text lives in its own database, deliberately outside DB_VERSION.
 *
 * Bumping the archive's version would be a one-way door: every build already shipped
 * hardcodes DB_VERSION = 1, and indexedDB.open at a *lower* version than the one on disk
 * fails with VersionError. Since openDb() backs every context, a user who rolled back to
 * an earlier build would get an extension that could no longer capture, search or sync,
 * and no patch to the new code could rescue them because the old code is already out
 * there. A second database is invisible to that code instead.
 *
 * It also means page text is derived, disposable state: clearing it wholesale cannot
 * touch the archive, because the archive is not reachable from here.
 */
export const CONTENT_DB_NAME = 'historykeeper-content';

// Re-capturing on every visit would rewrite hundreds of KB a day for pages you merely
// keep coming back to. A month is long enough to pick up a page that genuinely changed.
const CONTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let contentPromise = null;

export function openContentDb() {
  if (!contentPromise) {
    contentPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(CONTENT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('content', { keyPath: 'urlHash' });
        // The platform's own inverted index: one index entry per term, so a query term
        // resolves to the pages carrying it without scanning any text.
        store.createIndex('tokens', 'tokens', { multiEntry: true });
        store.createIndex('capturedAt', 'capturedAt');
        // Only text captured *on this device* carries exportAt, exactly as with visits
        // and localSeq, so this index is the set of rows still to be exported. Text
        // imported from a peer has no exportAt, so it can never be re-exported under
        // this device's shard name.
        store.createIndex('exportAt', 'exportAt');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Content DB upgrade blocked by another tab'));
    });
    // Same self-clear as openDb: a transient failure must not wedge every later call.
    contentPromise.catch(() => {
      contentPromise = null;
    });
  }
  return contentPromise;
}

// capturedAt doubles as the export cursor, so this keeps it strictly increasing, else
// two captures in the same millisecond could slip past a range.
//
// Default for `now`, not applied inside putContent, so a caller passing an explicit
// timestamp (an import, a test) gets exactly what it asked for.
let lastCapturedAt = 0;

function nextStamp() {
  lastCapturedAt = Math.max(Date.now(), lastCapturedAt + 1);
  return lastCapturedAt;
}

/**
 * Store one page's text, tokenised and gzipped.
 *
 * @param {boolean} local  True for text this device read off a page, false for text
 *   arriving from a peer's shard. Only local text is enlisted for export.
 * @returns {Promise<boolean>} false when an existing capture was still fresh.
 */
export async function putContent(
  urlHash,
  url,
  text,
  now = nextStamp(),
  { local = true, thumb = null } = {},
) {
  const clean = normaliseText(text);
  if (!clean) return false;

  const db = await openContentDb();
  const existing = await reqToPromise(
    db.transaction('content').objectStore('content').get(urlHash),
  );
  if (existing && now - existing.capturedAt < CONTENT_TTL_MS) {
    // The text is still fresh, but the row may predate thumbnails entirely, or the page
    // may only just have grown an og:image. Patching the thumbnail on its own is what
    // stops rows captured before this feature from staying blank for a whole TTL.
    if (!thumb || existing.thumb) return false;
    existing.thumb = thumb;
    const patch = db.transaction('content', 'readwrite');
    patch.objectStore('content').put(existing);
    await txDone(patch);
    return false;
  }

  const gz = await gzip(clean);
  const row = {
    urlHash,
    /**
     * The url is stored, not just its hash: a content shard line has to carry it so the
     * receiving device can re-derive the hash and check it, and `host` falls out of it
     * for the blocklist purge.
     */
    url,
    host: hostOf(url),
    gz,
    tokens: tokenise(clean),
    capturedAt: now,
    chars: clean.length,
    bytes: gz.length,
  };
  // Absent, not undefined: IndexedDB omits a record missing an indexed property, and that
  // absence is what keeps a peer's text out of this device's export delta.
  if (local) row.exportAt = now;
  // Optional by design: every row written before thumbnails existed, and every page
  // without a usable preview image, simply has no `thumb` field. Nothing reads it
  // without checking, so old rows stay valid.
  if (thumb) row.thumb = thumb;

  const tx = db.transaction('content', 'readwrite');
  tx.objectStore('content').put(row);
  await txDone(tx);
  return true;
}

/** Locally captured text newer than `sinceExportAt`, oldest first. */
export async function contentToExport(sinceExportAt, limit) {
  const db = await openContentDb();
  const rows = [];
  await cursorEach(
    db.transaction('content').objectStore('content').index('exportAt'),
    IDBKeyRange.lowerBound(sinceExportAt, true),
    'next',
    (row) => {
      rows.push(row);
      return rows.length < limit;
    },
  );
  return rows;
}

/**
 * Thumbnails for the rows being rendered, keyed by urlHash. Hashes with no stored
 * thumbnail (every page captured before this feature, and every page without a
 * preview image) are simply absent from the map.
 *
 * Guarded on contentStoreExists so that merely opening the dashboard does not conjure a
 * text database for a user who never turned page capture on.
 */
export async function getThumbs(urlHashes) {
  const map = new Map();
  if (!urlHashes.length || !(await getMeta('contentStoreExists', false))) return map;

  const db = await openContentDb();
  const store = db.transaction('content').objectStore('content');
  await Promise.all(
    [...new Set(urlHashes)].map(async (hash) => {
      const row = await reqToPromise(store.get(hash));
      if (row?.thumb) map.set(hash, row.thumb);
    }),
  );
  return map;
}

export async function getContentText(urlHash) {
  const db = await openContentDb();
  const row = await reqToPromise(db.transaction('content').objectStore('content').get(urlHash));
  return row ? gunzip(row.gz) : null;
}

export async function deleteContent(urlHash) {
  const db = await openContentDb();
  const tx = db.transaction('content', 'readwrite');
  tx.objectStore('content').delete(urlHash);
  await txDone(tx);
}

export async function clearContent() {
  const db = await openContentDb();
  const tx = db.transaction('content', 'readwrite');
  tx.objectStore('content').clear();
  await txDone(tx);
}

export async function contentStats() {
  const db = await openContentDb();
  const tx = db.transaction('content');
  const rows = await reqToPromise(tx.objectStore('content').count());
  let chars = 0;
  let bytes = 0;
  await cursorEach(tx.objectStore('content').index('capturedAt'), null, 'next', (row) => {
    chars += row.chars || 0;
    bytes += (row.bytes || 0) + (row.thumb ? row.thumb.length : 0);
  });
  return { rows, chars, bytes };
}

/**
 * Drop the least recently captured rows once the store exceeds its budget.
 *
 * capturedAt doubles as an LRU stamp because a re-visit past the TTL rewrites the row,
 * so pages you actually return to keep floating up.
 */
export async function evictContent(maxRows) {
  const db = await openContentDb();
  const tx = db.transaction('content', 'readwrite');
  const store = tx.objectStore('content');
  const total = await reqToPromise(store.count());
  let overflow = total - maxRows;
  if (overflow <= 0) {
    await txDone(tx);
    return 0;
  }

  const removed = overflow;
  await cursorEach(store.index('capturedAt'), null, 'next', (_row, cursor) => {
    cursor.delete();
    return --overflow > 0;
  });
  await txDone(tx);
  return removed;
}

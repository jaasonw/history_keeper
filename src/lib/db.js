// IndexedDB layer for History Keeper.
//
// Shared verbatim by the service worker and by every extension page — they all run on
// the same chrome-extension:// origin and therefore see the same database. Nothing in
// here may touch chrome.* APIs, so it stays usable from both contexts.

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
    // other devices are absent from this index — exactly what the export delta wants.
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
 * Bytes on disk for the archive. This is the browser's own estimate for the whole
 * extension origin rather than a sum over the records: measuring the records means a
 * full scan of `visits`, which is far more than a headline figure is worth. The origin
 * holds nothing but this database, so the two numbers track each other.
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
 * such a record may still do is fill in a missing title — see below.
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
      // The visit is already archived, but its title may not be. onVisited fires when
      // the navigation commits, before the document title exists — and on pushState
      // sites like YouTube, long before it — so a freshly captured visit is routinely
      // title-less. The sweep, a backfill re-run and another device's shard all carry
      // the real title later; discarding it here would freeze the blank in forever.
      //
      // Strictly empty -> non-empty. A title that merely *differs* is left alone,
      // because titles carrying a live counter ("(3) Inbox", a YouTube view count)
      // would otherwise be rewritten, and re-queued for export, on every sweep.
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
    // though this import didn't assign one — keeping it would make this device believe
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
        // The newest-known visit still has no title, but this older one — arriving late
        // from a backfill or another device's shard — does. Take it rather than leaving
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
 * This is what the worker's deferred re-title pass feeds — Chrome only learns the title
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

  const page = await reqToPromise(pages.get(visit.urlHash));
  if (page) {
    page.visitCount -= 1;
    if (page.visitCount <= 0) {
      pages.delete(visit.urlHash);
    } else {
      // Only recompute if the deleted visit could actually have set one of these — the
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
  return true;
}

/** Delete every visit for a page, plus the page row itself. Used by the blocklist purge. */
export async function deletePage(urlHash) {
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

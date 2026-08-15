// Query engine for the dashboard.
//
// Search text is matched fuzzily (see fuzzy.js) against an in-memory mirror of the
// `pages` store. The mirror exists because search-as-you-type cannot afford an
// IndexedDB cursor per keystroke: scoring a cached array of 100k pages is a handful of
// milliseconds, cursoring the same rows is hundreds.
//
// Two result orderings:
//   - relevance: one row per page, best match first. What you want while typing.
//   - time:      one row per visit, newest first. What you want while browsing.

import { openDb, cursorEach, countStore, storageBytes } from './db.js';
import { prepareQuery, scorePage } from './fuzzy.js';

const CACHE_TTL_MS = 30_000;
const MAX_CANDIDATES = 5_000;
// Below this many hits, assume the query is mistyped and pay for the typo pass.
const TYPO_PASS_THRESHOLD = 20;

let pageCache = null;
let pageCacheAt = 0;

/** Call after any write the dashboard makes: delete, import, sync. */
export function invalidatePageCache() {
  pageCache = null;
}

async function getPageCache() {
  if (pageCache && Date.now() - pageCacheAt < CACHE_TTL_MS) return pageCache;

  const db = await openDb();
  const rows = [];
  await cursorEach(db.transaction('pages').objectStore('pages'), null, 'next', (page) => {
    const title = page.title || '';
    rows.push({
      urlHash: page.urlHash,
      url: page.url,
      title,
      host: page.host,
      firstSeen: page.firstSeen,
      lastSeen: page.lastSeen,
      visitCount: page.visitCount,
      // Lowercased once here rather than per keystroke.
      hay: `${title}\n${page.url}`.toLowerCase(),
      titleLen: title.length,
    });
  });

  pageCache = rows;
  pageCacheAt = Date.now();
  return rows;
}

function rank(pages, prepared, host) {
  let scored = [];

  for (let allowTypos = false; ; allowTypos = true) {
    scored = [];
    for (const page of pages) {
      if (host && page.host !== host) continue;
      const score = scorePage(page, prepared, allowTypos);
      if (score > 0) scored.push({ page, score });
      if (scored.length >= MAX_CANDIDATES) break;
    }
    if (allowTypos || scored.length >= TYPO_PASS_THRESHOLD) break;
  }

  scored.sort((a, b) => b.score - a.score || b.page.lastSeen - a.page.lastSeen);
  return scored;
}

function inRange(time, from, to) {
  return (from === null || time >= from) && (to === null || time <= to);
}

/** Newest visit of a page that falls inside the range, or null. */
async function latestVisitInRange(db, urlHash, from, to) {
  let found = null;
  await cursorEach(
    db.transaction('visits').objectStore('visits').index('urlHash'),
    IDBKeyRange.only(urlHash),
    'prev',
    (visit) => {
      if (to !== null && visit.visitTime > to) return;
      if (from !== null && visit.visitTime < from) return false;
      found = visit;
      return false;
    },
  );
  return found;
}

/**
 * Best-match-first, one row per page.
 *
 * @returns {Promise<{rows: object[], hasMore: boolean, matched: number}>}
 */
export async function relevanceQuery({ text, host = '', from = null, to = null, limit = 100, offset = 0 }) {
  const prepared = prepareQuery(text);
  if (prepared.empty) return { rows: [], hasMore: false, matched: 0 };

  const db = await openDb();
  const scored = rank(await getPageCache(), prepared, host);

  const rows = [];
  let skipped = 0;
  let hasMore = false;

  for (const { page, score } of scored) {
    // Cheap in-memory rejection before paying for a visit lookup.
    if (from !== null && page.lastSeen < from) continue;
    if (to !== null && page.firstSeen > to) continue;

    let visitTime = page.lastSeen;
    if ((from !== null || to !== null) && !inRange(page.lastSeen, from, to)) {
      const visit = await latestVisitInRange(db, page.urlHash, from, to);
      if (!visit) continue;
      visitTime = visit.visitTime;
    }

    if (skipped < offset) {
      skipped++;
      continue;
    }
    if (rows.length === limit) {
      hasMore = true;
      break;
    }

    rows.push({
      urlHash: page.urlHash,
      url: page.url,
      title: page.title,
      host: page.host,
      visitTime,
      visitCount: page.visitCount,
      score,
    });
  }

  return { rows, hasMore, matched: scored.length };
}

/**
 * Newest-first, one row per visit. With search text, the fuzzy matcher decides which
 * pages qualify and chronology decides the order.
 *
 * @returns {Promise<{rows: object[], hasMore: boolean, scanned: number}>}
 */
export async function query({ text = '', host = '', from = null, to = null, limit = 100, offset = 0 } = {}) {
  const db = await openDb();
  const prepared = prepareQuery(text);

  let hashes = null;
  if (!prepared.empty) {
    hashes = new Set(rank(await getPageCache(), prepared, host).map(({ page }) => page.urlHash));
    if (hashes.size === 0) return { rows: [], hasMore: false, scanned: 0 };
  }

  const range =
    from !== null || to !== null
      ? IDBKeyRange.bound(from ?? 0, to ?? Number.MAX_SAFE_INTEGER)
      : null;

  const rows = [];
  let skipped = 0;
  let scanned = 0;
  let hasMore = false;

  const index = db.transaction('visits').objectStore('visits').index('visitTime');
  await cursorEach(index, range, 'prev', (visit) => {
    scanned++;
    if (hashes && !hashes.has(visit.urlHash)) return;
    if (host && visit.host !== host) return;
    if (skipped < offset) {
      skipped++;
      return;
    }
    if (rows.length === limit) {
      hasMore = true;
      return false;
    }
    rows.push(visit);
  });

  return { rows, hasMore, scanned };
}

export async function stats() {
  const db = await openDb();
  const [visits, pages] = await Promise.all([countStore('visits'), countStore('pages')]);

  let oldest = null;
  let newest = null;
  const timeIndex = () => db.transaction('visits').objectStore('visits').index('visitTime');
  await cursorEach(timeIndex(), null, 'next', (visit) => {
    oldest = visit.visitTime;
    return false;
  });
  await cursorEach(timeIndex(), null, 'prev', (visit) => {
    newest = visit.visitTime;
    return false;
  });

  const byHost = new Map();
  await cursorEach(db.transaction('pages').objectStore('pages'), null, 'next', (page) => {
    byHost.set(page.host, (byHost.get(page.host) || 0) + page.visitCount);
  });

  const topHosts = [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([hostname, count]) => ({ host: hostname, count }));

  return { visits, pages, oldest, newest, topHosts, bytes: await storageBytes() };
}

/**
 * Visits grouped by originating device. Kept out of stats() because it is a full scan
 * of the visit store — the dashboard only runs it when that panel is expanded.
 */
export async function deviceBreakdown() {
  const db = await openDb();
  const byDevice = new Map();
  await cursorEach(db.transaction('visits').objectStore('visits'), null, 'next', (visit) => {
    byDevice.set(visit.deviceId, (byDevice.get(visit.deviceId) || 0) + 1);
  });
  return [...byDevice.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
}

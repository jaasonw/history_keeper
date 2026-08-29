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

import {
  openDb,
  openContentDb,
  cursorEach,
  keyCursorEach,
  countStore,
  storageBytes,
  getMeta,
  getContentText,
} from './db.js';
import {
  prepareQuery,
  scorePage,
  maskOf,
  popcount,
  boundedEditDistance,
  nearestWord,
} from './fuzzy.js';
import { snippetAround, markUp } from './content.js';

const CACHE_TTL_MS = 30_000;
const MAX_CANDIDATES = 5_000;
// Below this many hits, assume the query is mistyped and pay for the typo pass.
const TYPO_PASS_THRESHOLD = 20;

// The distinct-term walk is far more expensive than the page mirror, and a term that has
// existed for four minutes is not worth rebuilding for: the page carrying it was visited
// moments ago and is still findable by title.
const DICT_TTL_MS = 5 * 60_000;
// A term this common tells you nothing the other tokens do not. Truncating its posting
// list keeps one stopword from dragging the whole corpus into memory.
// ponytail: flat cap, no IDF. If common terms start crowding results, weight by df.
const MAX_POSTINGS = 20_000;
// Below three characters a prefix range matches most of the corpus, so page text is all
// noise. Title and URL still match short tokens as they always did.
const MIN_CONTENT_TERM = 3;
const MAX_EXPANSIONS = 5;

let pageCache = null;
let pageCacheAt = 0;
let contentActive = null;
let dictionary = null;
let dictionaryAt = 0;

/** Call after any write the dashboard makes: delete, import, sync. */
export function invalidatePageCache() {
  pageCache = null;
  contentActive = null;
  dictionary = null;
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

/**
 * Whether a page-text store exists to search.
 *
 * Deliberately not `contentEnabled`: that flag governs *capture*, and switching capture
 * off should stop new text arriving, not hide the text already stored. Text goes away
 * when the user forgets it, not when they stop collecting it.
 *
 * Checked before openContentDb() is ever called, so a user who never enabled the feature
 * never has the database created for them. Memoised alongside the page mirror and dropped
 * by the same invalidation, which bounds staleness to one cache lifetime.
 */
async function contentIndexed() {
  if (contentActive === null) contentActive = await getMeta('contentStoreExists', false);
  return contentActive;
}

/**
 * Every distinct term in the corpus, with its character-presence mask.
 *
 * 'nextunique' over the multiEntry index *is* the term dictionary — the platform already
 * maintains it, so there is no second store to keep consistent.
 *
 * ponytail: full walk of the tokens index. If it gets slow, maintain a `terms` store
 * incrementally on each putContent instead.
 */
async function getDictionary() {
  if (dictionary && Date.now() - dictionaryAt < DICT_TTL_MS) return dictionary;

  const db = await openContentDb();
  const terms = [];
  const masks = [];
  await keyCursorEach(
    db.transaction('content').objectStore('content').index('tokens'),
    null,
    'nextunique',
    (term) => {
      terms.push(term);
      masks.push(maskOf(term));
    },
  );

  dictionary = { terms, masks };
  dictionaryAt = Date.now();
  return dictionary;
}

/**
 * Real terms within maxDist edits of a mistyped token.
 *
 * Same two-step filter the haystack typo pass uses — length window, then the mask
 * popcount — so the edit-distance table is only filled in for genuine candidates.
 */
function expandTerm(token, dict) {
  const maxDist = token.maxDist;
  if (maxDist === 0) return [];

  const out = [];
  for (let i = 0; i < dict.terms.length; i++) {
    const term = dict.terms[i];
    if (Math.abs(term.length - token.text.length) > maxDist) continue;
    if (popcount(token.mask & ~dict.masks[i]) > maxDist) continue;
    if (boundedEditDistance(token.text, term, maxDist) > maxDist) continue;
    out.push(term);
    if (out.length >= MAX_EXPANSIONS) break;
  }
  return out;
}

/**
 * Pages whose text carries `term`, or any term starting with it.
 *
 * A fresh transaction per lookup, deliberately: an IndexedDB transaction commits as soon
 * as the event loop drains without a pending request, and the dictionary walk between
 * two lookups is long enough to do exactly that. Read transactions are cheap; a stale
 * handle is a TransactionInactiveError.
 */
async function postings(db, term, into) {
  const index = db.transaction('content').objectStore('content').index('tokens');
  const keys = await new Promise((resolve, reject) => {
    // '￿' sorts above any character that can follow the prefix, so this range is
    // exactly "the term, plus every term extending it".
    const req = index.getAllKeys(IDBKeyRange.bound(term, `${term}￿`), MAX_POSTINGS);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const key of keys) into.add(key);
}

/**
 * Resolve each query token against the term index.
 *
 * @returns {Promise<object[]|null>} Parallel to prepared.tokens; null when page text is
 *   not indexed, which keeps the whole lane out of the scoring path.
 */
async function contentHitsFor(prepared, allowTypos) {
  if (!(await contentIndexed())) return null;

  const db = await openContentDb();
  const hits = [];

  for (const token of prepared.tokens) {
    if (token.text.length < MIN_CONTENT_TERM) {
      hits.push(null);
      continue;
    }

    const hashes = new Set();
    await postings(db, token.text, hashes);
    let terms = [token.text];
    let fuzzy = false;

    // Only once the cheap pass has already come up short — the same trigger the haystack
    // typo tier uses, and for the same reason.
    if (hashes.size === 0 && allowTypos) {
      const expansions = expandTerm(token, await getDictionary());
      for (const term of expansions) await postings(db, term, hashes);
      if (expansions.length) {
        terms = expansions;
        fuzzy = true;
      }
    }

    hits.push(hashes.size ? { hashes, fuzzy, terms } : null);
  }

  return hits;
}

async function rank(pages, prepared, host) {
  let scored = [];
  let contentHits = null;

  for (let allowTypos = false; ; allowTypos = true) {
    contentHits = await contentHitsFor(prepared, allowTypos);
    scored = [];
    for (const page of pages) {
      if (host && page.host !== host) continue;
      const score = scorePage(page, prepared, allowTypos, contentHits);
      if (score > 0) scored.push({ page, score });
      if (scored.length >= MAX_CANDIDATES) break;
    }
    if (allowTypos || scored.length >= TYPO_PASS_THRESHOLD) break;
  }

  scored.sort((a, b) => b.score - a.score || b.page.lastSeen - a.page.lastSeen);
  return { scored, contentHits };
}

/**
 * What to emphasise in the label a row displays.
 *
 * A token that appears literally is its own answer. One that does not got here through
 * the typo tier, so the word it was closest to is what the user should see lit up —
 * `nearestWord` is the same walk the scorer already made, asked for the word instead of
 * the score. The subsequence tier deliberately contributes nothing: its characters are
 * scattered across the string, and emphasising them individually reads as corruption.
 */
function labelTerms(label, prepared) {
  const hay = label.toLowerCase();
  const terms = [];
  for (const token of prepared.tokens) {
    if (hay.includes(token.text)) terms.push(token.text);
    else {
      const near = nearestWord(token, hay);
      if (near) terms.push(near);
    }
  }
  return terms;
}

/** The link text a row shows, split into segments so the dashboard can mark the hits. */
function labelParts(title, url, prepared) {
  if (prepared.empty) return null;
  const label = title || url;
  return label ? markUp(label, labelTerms(label, prepared)) : null;
}

/** Terms whose posting list contains this page, for the snippet window. */
function matchedTerms(contentHits, urlHash) {
  const terms = [];
  for (const hit of contentHits || []) {
    if (hit && hit.hashes.has(urlHash)) terms.push(...hit.terms);
  }
  return terms;
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
  const { scored, contentHits } = await rank(await getPageCache(), prepared, host);

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
      // Filled in below, only for the rows that actually matched on text. Segments, not
      // a string — see snippetAround.
      snippet: null,
      titleParts: labelParts(page.title, page.url, prepared),
    });
  }

  // Decompressing is worth it only for a page whose text is *why* it is here, and only
  // for the rows being rendered — never for the thousands merely scored.
  if (contentHits) {
    for (const row of rows) {
      const terms = matchedTerms(contentHits, row.urlHash);
      if (!terms.length) continue;
      try {
        const text = await getContentText(row.urlHash);
        if (text) row.snippet = snippetAround(text, terms);
      } catch {
        // A snippet is a nicety; a page that will not decompress still belongs in results.
      }
    }
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
    const { scored } = await rank(await getPageCache(), prepared, host);
    hashes = new Set(scored.map(({ page }) => page.urlHash));
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
    // Time order is still a text search when the box has something in it, so its rows
    // get the same emphasis the relevance rows do.
    rows.push({ ...visit, titleParts: labelParts(visit.title, visit.url, prepared) });
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

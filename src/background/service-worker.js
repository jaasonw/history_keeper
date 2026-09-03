// History Keeper background worker.
//
// Two capture paths, deliberately overlapping:
//   1. chrome.history.onVisited: real time, fires while the worker is alive.
//   2. A 15-minute alarm sweep, re-querying chrome.history over a window that overlaps
//      the last sweep, so visits made while the worker was evicted are still archived.
// The overlap costs nothing because the visit id is a content hash plus timestamp, so
// re-reading the same visit is a no-op.
//
// Neither path knows the page title at the moment it captures a visit, so a third,
// visit-free pass re-reads titles a few seconds later, see scheduleRetitle below.
//
// chrome.history has exactly two events, onVisited and onVisitRemoved. There is no title
// event to listen for; reaching for one throws at module scope and takes the whole worker
// down, capture included.
//
// A fourth path, captureText, reads the *text* of a finished page load. It is opt-in and
// has no bearing on the three above: it needs a host permission that is optional in the
// manifest, it writes to a separate database, and nothing it does can fail a visit.

import {
  openDb,
  txDone,
  getMeta,
  setMeta,
  setManyMeta,
  putVisits,
  backfillTitle,
  cursorEach,
  putContent,
  evictContent,
} from '../lib/db.js';
import { makeRecord, isArchivable, hostOf, urlHash } from '../lib/record.js';
import { isBlocked } from '../lib/blocklist.js';
import { TEXT_ORIGINS } from '../lib/content.js';

const SWEEP_ALARM = 'sweep';
const BACKFILL_ALARM = 'backfill';
const SNAPSHOT_ALARM = 'snapshot';

const SWEEP_PERIOD_MIN = 15;
const SWEEP_OVERLAP_MS = 5 * 60 * 1000;
const SWEEP_MAX_RESULTS = 10_000;
// Reminder cadence for the manual backup snapshot: quarterly unless the options page
// stores a different day count, in which case ensureAlarms() reschedules on the next
// wake or when that page asks it to.
const SNAPSHOT_DEFAULT_DAYS = 90;

async function snapshotPeriodMin() {
  const days = Number(await getMeta('snapshotIntervalDays', SNAPSHOT_DEFAULT_DAYS));
  return (Number.isFinite(days) && days >= 1 ? Math.round(days) : SNAPSHOT_DEFAULT_DAYS) * 24 * 60;
}

const BACKFILL_CHUNK = 250;
const BACKFILL_BUDGET_MS = 20_000;

// Long enough for the renderer to have reported a title, short enough that the worker is
// very likely still alive. The lookback only has to cover the delay itself, with slack.
const RETITLE_DELAY_MS = 6_000;
const RETITLE_LOOKBACK_MS = 5 * 60 * 1000;

// Pages kept in the text index. Compressed, a page averages ~2KB, so this is on the order
// of 40MB, enough to cover a long stretch of real browsing without the store becoming
// something the user has to think about.
const CONTENT_MAX_ROWS = 20_000;

// A 160px WebP data URL is ~6KB. The cap only exists for the pathological case (a page
// whose og:image is a 4000px PNG that re-encodes badly); past it the thumbnail is
// dropped and the text capture carries on unaffected.
const THUMB_WIDTH = 160;
const MAX_THUMB_CHARS = 96_000;

// ---------------------------------------------------------------- identity & alarms

async function getDeviceId() {
  let id = await getMeta('deviceId');
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    await setManyMeta({ deviceId: id, deviceLabel: '' });
  }
  return id;
}

async function ensureAlarms() {
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some((a) => a.name === SWEEP_ALARM)) {
    chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN, delayInMinutes: 1 });
  }
  const period = await snapshotPeriodMin();
  const snapshot = alarms.find((a) => a.name === SNAPSHOT_ALARM);
  // Recreating on a period change restarts the countdown, so a shortened interval does not
  // fire immediately off a long-running old alarm, and a lengthened one is not cut short.
  if (!snapshot || snapshot.periodInMinutes !== period) {
    chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: period, delayInMinutes: period });
  }
}

// ------------------------------------------------------------------------- capture

chrome.history.onVisited.addListener((item) => {
  captureVisit(item).catch((err) => console.error('[HistoryKeeper] capture failed', err));
});

async function captureVisit(item) {
  if (!isArchivable(item.url)) return;
  const host = hostOf(item.url);
  if (await isBlocked(item.url, host)) return;

  // Read the timestamp back through getVisits rather than trusting
  // HistoryItem.lastVisitTime: the two can disagree in their fractional part, and a
  // disagreement here would mint a second row for a visit the sweep already stored.
  let latest = null;
  try {
    const visits = await chrome.history.getVisits({ url: item.url });
    latest = visits[visits.length - 1] || null;
  } catch {
    // URL was removed between the event and the lookup.
  }

  const record = await makeRecord({
    url: item.url,
    title: item.title,
    visitTime: latest ? latest.visitTime : item.lastVisitTime ?? Date.now(),
    transition: latest?.transition,
    deviceId: await getDeviceId(),
  });
  await putVisits([record], { assignLocalSeq: true });

  if (!record.title) scheduleRetitle(record.url);
}

/**
 * Re-read the titles of URLs that were captured without one.
 *
 * Chrome records a visit the moment the navigation commits and only learns the page
 * title once the renderer reports it, so item.title above is empty for any URL being
 * seen for the first time, and on pushState sites like YouTube, which mint a history
 * entry per video, essentially always. A few seconds later Chrome has the title, so a
 * second read gets it.
 *
 * Best effort by design. setTimeout does not survive worker eviction, so a queued
 * re-read can simply be lost; the sweep repairs whatever this misses, which makes a lost
 * timer cost latency and nothing else. That is also why the whole batch goes through one
 * history.search rather than one call per URL.
 */
const pendingTitles = new Set();
let retitleTimer = null;

function scheduleRetitle(url) {
  pendingTitles.add(url);
  if (retitleTimer) return;
  retitleTimer = setTimeout(() => {
    const urls = [...pendingTitles];
    pendingTitles.clear();
    retitleTimer = null;
    applyTitles(urls).catch((err) => console.error('[HistoryKeeper] retitle failed', err));
  }, RETITLE_DELAY_MS);
}

async function applyTitles(urls) {
  const wanted = new Set(urls);
  const items = await chrome.history.search({
    text: '',
    startTime: Date.now() - RETITLE_LOOKBACK_MS,
    maxResults: 1000,
  });
  for (const item of items) {
    if (!item.title || !wanted.has(item.url)) continue;
    await backfillTitle(await urlHash(item.url), item.title);
  }
}

async function sweep() {
  const deviceId = await getDeviceId();
  const now = Date.now();
  const lastSweep = await getMeta('lastSweepTime', now - 24 * 60 * 60 * 1000);
  const since = Math.max(0, lastSweep - SWEEP_OVERLAP_MS);

  const items = await chrome.history.search({
    text: '',
    startTime: since,
    endTime: now,
    maxResults: SWEEP_MAX_RESULTS,
  });

  const records = [];
  for (const item of items) {
    if (!isArchivable(item.url)) continue;
    if (await isBlocked(item.url, hostOf(item.url))) continue;

    let visits = [];
    try {
      visits = await chrome.history.getVisits({ url: item.url });
    } catch {
      continue;
    }
    for (const visit of visits) {
      if (visit.visitTime < since || visit.visitTime > now) continue;
      records.push(
        await makeRecord({
          url: item.url,
          title: item.title,
          visitTime: visit.visitTime,
          transition: visit.transition,
          deviceId,
        }),
      );
    }
  }

  const { added, titled } = await putVisits(records, { assignLocalSeq: true });
  // chrome.history.search returns newest-first, so hitting maxResults means the older
  // part of [since, now) was never searched. Advancing lastSweepTime to `now` would mark
  // that stretch as swept and it would never be retried, so stop at the oldest item seen.
  const truncated = items.length >= SWEEP_MAX_RESULTS;
  const nextSweepTime = truncated ? Math.min(...items.map((item) => item.lastVisitTime)) : now;
  await setManyMeta({ lastSweepTime: nextSweepTime, lastSweepAdded: added });
  return { added, titled };
}

// ------------------------------------------------------------------------ backfill

/**
 * Queue every URL Chrome still remembers. The queue lives in IndexedDB rather than in
 * memory because this can be 100k+ URLs and the worker will be evicted several times
 * before the queue drains.
 */
async function startBackfill() {
  const items = await chrome.history.search({
    text: '',
    startTime: 0,
    endTime: Date.now(),
    maxResults: 100_000,
  });

  const db = await openDb();
  const tx = db.transaction('backfill', 'readwrite');
  const store = tx.objectStore('backfill');
  let queued = 0;
  for (const item of items) {
    if (!isArchivable(item.url)) continue;
    store.put({ url: item.url, title: item.title || '' });
    queued++;
  }
  await txDone(tx);

  await setManyMeta({
    backfillTotal: queued,
    backfillDone: 0,
    backfillComplete: queued === 0,
    backfillStartedAt: Date.now(),
  });

  if (queued) chrome.alarms.create(BACKFILL_ALARM, { periodInMinutes: 1 });
}

/**
 * Drain the queue for up to BACKFILL_BUDGET_MS. Queue rows are deleted only after the
 * visits they produced have committed, so an eviction mid-chunk costs one repeated
 * chunk rather than the whole run.
 */
async function runBackfillChunk() {
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  const deviceId = await getDeviceId();
  const db = await openDb();

  while (Date.now() < deadline) {
    const batch = [];
    await cursorEach(db.transaction('backfill').objectStore('backfill'), null, 'next', (row) => {
      batch.push(row);
      if (batch.length >= BACKFILL_CHUNK) return false;
    });

    if (!batch.length) {
      await finishBackfill();
      return;
    }

    const records = [];
    for (const row of batch) {
      if (await isBlocked(row.url, hostOf(row.url))) continue;
      let visits = [];
      try {
        visits = await chrome.history.getVisits({ url: row.url });
      } catch {
        continue;
      }
      for (const visit of visits) {
        records.push(
          await makeRecord({
            url: row.url,
            title: row.title,
            visitTime: visit.visitTime,
            transition: visit.transition,
            deviceId,
          }),
        );
      }
    }

    await putVisits(records, { assignLocalSeq: true });

    const tx = db.transaction('backfill', 'readwrite');
    for (const row of batch) tx.objectStore('backfill').delete(row.url);
    await txDone(tx);

    await setMeta('backfillDone', (await getMeta('backfillDone', 0)) + batch.length);
  }
}

async function finishBackfill() {
  await chrome.alarms.clear(BACKFILL_ALARM);
  await setManyMeta({ backfillComplete: true, backfillFinishedAt: Date.now() });
}

// ----------------------------------------------------------------------- page text

/**
 * Capture the visible text of a finished page load.
 *
 * Opt-in twice over: `contentEnabled` in meta, and the TEXT_ORIGINS host permission, which
 * is optional in the manifest and requested from the options page. Until that permission
 * is granted Chrome does not even populate `tab.url` here, so the first check below is
 * what makes this listener free for everyone who never turned the feature on.
 *
 * There is no backfill counterpart and cannot be: re-reading an already-archived page
 * would mean a network request, which this extension does not make.
 */
async function captureText(tabId, tab) {
  // Attribution comes from Chrome's own tab record. The injected function returns only
  // text and a thumbnail; a page must never get to say which URL its text is filed
  // under.
  const url = tab?.url;
  if (!isArchivable(url)) return;

  if (!(await getMeta('contentEnabled', false))) return;
  const host = hostOf(url);
  if (await isBlocked(url, host)) return;
  if (!(await chrome.permissions.contains({ origins: TEXT_ORIGINS }))) return;

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [THUMB_WIDTH],
      func: readPage,
    });
  } catch {
    // The tab closed, navigated away, or is one Chrome will not inject into (a PDF
    // viewer, the web store). Nothing to repair; the next visit tries again.
    return;
  }

  const { text, thumb } = results?.[0]?.result || {};
  if (!text) return;

  // The page produced this string, so it is checked rather than trusted: the prefix is
  // pinned to the one encoding readPage can actually emit, which keeps a hostile page
  // from filing anything but an image under its own row.
  const usableThumb =
    typeof thumb === 'string' && thumb.startsWith('data:image/webp;base64,') && thumb.length <= MAX_THUMB_CHARS
      ? thumb
      : null;
  if (await putContent(await urlHash(url), url, text, undefined, { thumb: usableThumb })) {
    await evictContent(CONTENT_MAX_ROWS);
  }
}

/**
 * Runs inside the page, not the worker: no closure over anything above, because
 * executeScript serialises the function itself.
 *
 * The thumbnail is the page's own preview image, downscaled to a data URL right there in
 * the tab. Doing it in the page rather than the worker is what keeps the extension's "no
 * network requests of its own" property: the fetch is same-page, for an image the
 * document already loaded, so it comes off the HTTP cache and no server sees a request
 * the page did not itself make. A page without og:image simply has no thumbnail; the
 * dashboard is built for that being the common case.
 */
async function readPage(width) {
  // innerText, not textContent: it follows what is actually rendered, so it skips
  // hidden markup and scripts without any parsing of our own.
  const text = document.body?.innerText ?? '';

  const src = document.querySelector(
    'meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"]',
  )?.content;
  if (!src) return { text, thumb: null };

  try {
    const response = await fetch(new URL(src, location.href), { credentials: 'omit' });
    if (!response.ok) return { text, thumb: null };
    const bitmap = await createImageBitmap(await response.blob());
    const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
    return {
      text,
      thumb: await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      }),
    };
  } catch {
    // A cross-origin image the page's own CSP or CORS setup will not hand back, an SVG
    // that will not decode, a canvas the browser taints. The text still counts.
    return { text, thumb: null };
  }
}

// -------------------------------------------------------------------------- wiring

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch((err) => console.error('[HistoryKeeper] install failed', err));
});

async function handleInstalled(details) {
  await getDeviceId();
  await ensureAlarms();

  const alreadyStarted = await getMeta('backfillStartedAt');
  if (details.reason === 'install' || !alreadyStarted) {
    // The backfill covers everything up to now, so the first sweep should only look
    // forward from here.
    await setMeta('lastSweepTime', Date.now());
    await startBackfill();
    await runBackfillChunk();
  }
}

chrome.runtime.onStartup.addListener(() => {
  resume().catch((err) => console.error('[HistoryKeeper] startup failed', err));
});

async function resume() {
  await ensureAlarms();
  if (!(await getMeta('backfillComplete', false)) && (await getMeta('backfillStartedAt'))) {
    chrome.alarms.create(BACKFILL_ALARM, { periodInMinutes: 1 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  const run = async () => {
    if (alarm.name === SWEEP_ALARM) await sweep();
    else if (alarm.name === BACKFILL_ALARM) await runBackfillChunk();
    else if (alarm.name === SNAPSHOT_ALARM) await setMeta('snapshotDue', true);
  };
  run().catch((err) => console.error(`[HistoryKeeper] alarm ${alarm.name} failed`, err));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  captureText(tabId, tab).catch((err) => console.error('[HistoryKeeper] text capture failed', err));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'sweepNow':
        return sweep();
      case 'restartBackfill':
        await startBackfill();
        await runBackfillChunk();
        return { ok: true };
      case 'rescheduleSnapshot':
        await ensureAlarms();
        return { ok: true };
      case 'ping':
        return { ok: true, deviceId: await getDeviceId() };
      default:
        return { error: `unknown message ${message?.type}` };
    }
  };
  run().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // keep the channel open for the async response
});

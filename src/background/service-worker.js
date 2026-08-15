// History Keeper background worker.
//
// Two capture paths, deliberately overlapping:
//   1. chrome.history.onVisited — real time, fires while the worker is alive.
//   2. A 15-minute alarm sweep — re-queries chrome.history over a window that overlaps
//      the last sweep, so visits made while the worker was evicted are still archived.
// The overlap costs nothing because the visit id is a content hash plus timestamp, so
// re-reading the same visit is a no-op.
//
// Neither path knows the page title at the moment it captures a visit, so a third,
// visit-free pass re-reads titles a few seconds later — see scheduleRetitle below.
//
// chrome.history has exactly two events, onVisited and onVisitRemoved. There is no title
// event to listen for; reaching for one throws at module scope and takes the whole worker
// down, capture included.

import {
  openDb,
  txDone,
  getMeta,
  setMeta,
  setManyMeta,
  putVisits,
  backfillTitle,
  cursorEach,
} from '../lib/db.js';
import { makeRecord, isArchivable, hostOf, urlHash } from '../lib/record.js';
import { isBlocked } from '../lib/blocklist.js';

const SWEEP_ALARM = 'sweep';
const BACKFILL_ALARM = 'backfill';
const SNAPSHOT_ALARM = 'snapshot';

const SWEEP_PERIOD_MIN = 15;
const SWEEP_OVERLAP_MS = 5 * 60 * 1000;
const SNAPSHOT_PERIOD_MIN = 60 * 24 * 7;

const BACKFILL_CHUNK = 250;
const BACKFILL_BUDGET_MS = 20_000;

// Long enough for the renderer to have reported a title, short enough that the worker is
// very likely still alive. The lookback only has to cover the delay itself, with slack.
const RETITLE_DELAY_MS = 6_000;
const RETITLE_LOOKBACK_MS = 5 * 60 * 1000;

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
  const names = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  if (!names.has(SWEEP_ALARM)) {
    chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN, delayInMinutes: 1 });
  }
  if (!names.has(SNAPSHOT_ALARM)) {
    chrome.alarms.create(SNAPSHOT_ALARM, {
      periodInMinutes: SNAPSHOT_PERIOD_MIN,
      delayInMinutes: SNAPSHOT_PERIOD_MIN,
    });
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
 * seen for the first time — and on pushState sites like YouTube, which mint a history
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
    maxResults: 10_000,
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
  await setManyMeta({ lastSweepTime: now, lastSweepAdded: added });
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case 'sweepNow':
        return sweep();
      case 'restartBackfill':
        await startBackfill();
        await runBackfillChunk();
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

import { getMeta, countStore, openDb, cursorEach, storageBytes } from '../lib/db.js';
import { initTheme } from '../lib/theme.js';

// The popup has no room for the control, so it only follows what the dashboard or the
// options page has set.
initTheme();

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();

function formatAgo(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

async function oldestVisit() {
  const db = await openDb();
  let oldest = null;
  await cursorEach(
    db.transaction('visits').objectStore('visits').index('visitTime'),
    null,
    'next',
    (visit) => {
      oldest = visit.visitTime;
      return false;
    },
  );
  return oldest;
}

async function load() {
  const [visits, pages, oldest, bytes] = await Promise.all([
    countStore('visits'),
    countStore('pages'),
    oldestVisit(),
    storageBytes(),
  ]);

  $('visits').textContent = nf.format(visits);
  $('pages').textContent = nf.format(pages);
  $('oldest').textContent = oldest
    ? new Date(oldest).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
  $('size').textContent = formatBytes(bytes);
  $('sync').textContent = formatAgo(await getMeta('lastSyncTime', null));

  if (!(await getMeta('backfillComplete', false)) && (await getMeta('backfillStartedAt'))) {
    const total = await getMeta('backfillTotal', 0);
    const done = await getMeta('backfillDone', 0);
    $('note').textContent = `Importing existing history: ${nf.format(done)} of ${nf.format(total)} pages.`;
    const bar = $('progress');
    bar.max = Math.max(total, 1);
    bar.value = done;
    bar.hidden = false;
  } else if (await getMeta('snapshotDue', false)) {
    $('note').textContent = 'Weekly backup snapshot is due — open the dashboard to save it.';
  }
}

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/index.html') });
  window.close();
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

load();

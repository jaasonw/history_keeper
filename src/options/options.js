import { getMeta, setMeta, countStore, contentStats, clearContent } from '../lib/db.js';
import { getPatterns, setPatterns, purgeMatching, compile } from '../lib/blocklist.js';
import { initTheme, mountThemeToggle } from '../lib/theme.js';
import { TEXT_ORIGINS } from '../lib/content.js';

const $ = (id) => document.getElementById(id);
const SNAPSHOT_DEFAULT_DAYS = 90; // quarterly
const nf = new Intl.NumberFormat();

initTheme();
mountThemeToggle($('theme'));

async function load() {
  $('patterns').value = (await getPatterns()).join('\n');
  $('device-id').textContent = (await getMeta('deviceId')) || '…';
  $('device-label').value = (await getMeta('deviceLabel', '')) || '';
  $('snapshot-days').value = await getMeta('snapshotIntervalDays', SNAPSHOT_DEFAULT_DAYS);

  const [visits, pages, pending] = await Promise.all([
    countStore('visits'),
    countStore('pages'),
    countStore('backfill'),
  ]);
  const complete = await getMeta('backfillComplete', false);
  $('maintenance-detail').textContent =
    `${nf.format(visits)} visits across ${nf.format(pages)} pages. ` +
    (complete ? 'Initial import complete.' : `Initial import running: ${nf.format(pending)} pages queued.`);
}

// ------------------------------------------------------------------ page text

// Declared optionally in the manifest, so it is absent from the install prompt until
// this box is ticked. The origin list is shared with the worker rather than repeated:
// Chrome matches the request against the manifest literally.
const TEXT_ACCESS = { origins: TEXT_ORIGINS };

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadContent() {
  // The permission is the real authority; it can be revoked from chrome://extensions
  // without this page ever hearing about it, so the stored flag follows it, never leads.
  const granted = await chrome.permissions.contains(TEXT_ACCESS);
  const enabled = (await getMeta('contentEnabled', false)) && granted;
  if (!granted && (await getMeta('contentEnabled', false))) await setMeta('contentEnabled', false);

  $('content-toggle').checked = enabled;
  $('content-sync-toggle').checked = await getMeta('contentSyncEnabled', false);
  // Nothing to sync, and nothing to sync it from, until text is being stored at all.
  $('content-sync-toggle').disabled = !enabled;

  const { rows, bytes } = rowsOnly(await safeContentStats());
  $('content-detail').textContent = rows
    ? `${nf.format(rows)} page${rows === 1 ? '' : 's'} indexed, ${formatBytes(bytes)} compressed.`
    : enabled
      ? 'No pages indexed yet. Text is captured as you browse, not backdated.'
      : 'No page text stored.';
  $('forget-content').disabled = rows === 0;
}

// contentStats() opens the text database, which should not spring into existence just
// because someone opened this page with the feature off.
async function safeContentStats() {
  if (!(await getMeta('contentStoreExists', false))) return null;
  try {
    return await contentStats();
  } catch {
    return null;
  }
}

const rowsOnly = (stats) => stats || { rows: 0, chars: 0, bytes: 0 };

$('content-toggle').addEventListener('change', async (event) => {
  const on = event.target.checked;
  $('content-status').textContent = '';

  if (on) {
    // request() must run inside the user gesture that ticked the box, so it is awaited
    // here rather than behind any other await.
    //
    // It can also *throw* rather than resolve false, e.g. a mismatched manifest. Left
    // uncaught, the box stays ticked while claiming a feature that is not on.
    let granted = false;
    try {
      granted = await chrome.permissions.request(TEXT_ACCESS);
    } catch (err) {
      event.target.checked = false;
      $('content-status').textContent = `Chrome refused the permission request: ${err.message}`;
      return;
    }
    if (!granted) {
      event.target.checked = false;
      $('content-status').textContent = 'Chrome declined the permission. Nothing changed.';
      return;
    }
    await setMeta('contentStoreExists', true);
  }

  await setMeta('contentEnabled', on);
  $('content-status').textContent = on
    ? 'On. Pages you visit from now on will have their text stored.'
    : 'Off. No new text is stored; what is already there stays searchable until you forget it.';
  await loadContent();
});

$('content-sync-toggle').addEventListener('change', async (event) => {
  await setMeta('contentSyncEnabled', event.target.checked);
  $('content-status').textContent = event.target.checked
    ? 'Page text will be included the next time the dashboard syncs.'
    : 'Page text will stay on this device. Text already in the sync folder is left alone.';
});

$('forget-content').addEventListener('click', async () => {
  await clearContent();
  $('content-status').textContent = 'All stored page text deleted. Your history is untouched.';
  await loadContent();
});

// Revoking from chrome://extensions has to switch the feature off here too, otherwise the
// toggle claims something the worker can no longer do.
chrome.permissions.onRemoved.addListener(() => {
  loadContent().catch(() => {});
});

$('save').addEventListener('click', async () => {
  const patterns = $('patterns').value.split('\n').map((line) => line.trim()).filter(Boolean);
  await setPatterns(patterns);

  // A pattern with a scheme, path, or port (https://x.com, x.com/page) can never equal
  // hostOf()'s bare hostname, so compile() silently drops it: tell the user, rather
  // than reporting a count that includes patterns doing nothing.
  const working = compile(patterns).length;
  const nonComment = patterns.filter((p) => !p.startsWith('#')).length;
  const skipped = nonComment - working;
  $('blocklist-status').textContent = skipped
    ? `Saved ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}: ` +
      `${skipped} will never match (remove any scheme, path, or port) and were skipped.`
    : `Saved ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}. New visits are filtered immediately.`;
});

$('purge').addEventListener('click', async () => {
  const button = $('purge');
  button.disabled = true;
  $('blocklist-status').textContent = 'Scanning archive…';
  try {
    const { pages, visits } = await purgeMatching((done, total) => {
      $('blocklist-status').textContent = `Deleting ${done}/${total} pages…`;
    });
    $('blocklist-status').textContent = pages
      ? `Deleted ${nf.format(visits)} visits across ${nf.format(pages)} pages.`
      : 'Nothing already archived matches the current patterns.';
    await load();
  } catch (err) {
    $('blocklist-status').textContent = `Purge failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

$('snapshot-days').addEventListener('change', async (event) => {
  // The input's min/max only constrain the spinner; a typed value still arrives as
  // anything at all, including empty, so it is clamped here before it reaches the alarm.
  const days = Math.round(Number(event.target.value));
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    event.target.value = await getMeta('snapshotIntervalDays', SNAPSHOT_DEFAULT_DAYS);
    $('snapshot-status').textContent = 'Enter a whole number of days between 1 and 365.';
    return;
  }
  event.target.value = days;
  await setMeta('snapshotIntervalDays', days);
  await chrome.runtime.sendMessage({ type: 'rescheduleSnapshot' });
  $('snapshot-status').textContent = `Saved. Next reminder in ${days} day${days === 1 ? '' : 's'}.`;
});

$('save-label').addEventListener('click', async () => {
  await setMeta('deviceLabel', $('device-label').value.trim());
  $('label-status').textContent = 'Label saved.';
});

$('sweep').addEventListener('click', async () => {
  $('maintenance-status').textContent = 'Sweeping…';
  const response = await chrome.runtime.sendMessage({ type: 'sweepNow' });
  if (response?.error) {
    $('maintenance-status').textContent = `Sweep failed: ${response.error}`;
  } else {
    const { added, titled } = response;
    $('maintenance-status').textContent =
      `Sweep added ${nf.format(added)} visit${added === 1 ? '' : 's'}` +
      (titled ? `, and filled in ${nf.format(titled)} missing title${titled === 1 ? '' : 's'}.` : '.');
  }
  await load();
});

$('rebackfill').addEventListener('click', async () => {
  // Safe to repeat at any time: re-reading a visit that is already archived is a no-op.
  $('maintenance-status').textContent = 'Queueing every URL Chrome still remembers…';
  const response = await chrome.runtime.sendMessage({ type: 'restartBackfill' });
  $('maintenance-status').textContent = response?.error
    ? `Re-scan failed: ${response.error}`
    : 'Re-scan started. Progress shows on the dashboard.';
  await load();
});

load();
loadContent();

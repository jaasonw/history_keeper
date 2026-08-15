import { getMeta, setMeta, countStore } from '../lib/db.js';
import { getPatterns, setPatterns, purgeMatching } from '../lib/blocklist.js';
import { initTheme, mountThemeToggle } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();

initTheme();
mountThemeToggle($('theme'));

async function load() {
  $('patterns').value = (await getPatterns()).join('\n');
  $('device-id').textContent = (await getMeta('deviceId')) || '…';
  $('device-label').value = (await getMeta('deviceLabel', '')) || '';

  const [visits, pages, pending] = await Promise.all([
    countStore('visits'),
    countStore('pages'),
    countStore('backfill'),
  ]);
  const complete = await getMeta('backfillComplete', false);
  $('maintenance-detail').textContent =
    `${nf.format(visits)} visits across ${nf.format(pages)} pages. ` +
    (complete ? 'Initial import complete.' : `Initial import running — ${nf.format(pending)} pages queued.`);
}

$('save').addEventListener('click', async () => {
  const patterns = $('patterns').value.split('\n').map((line) => line.trim()).filter(Boolean);
  await setPatterns(patterns);
  $('blocklist-status').textContent =
    `Saved ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}. New visits are filtered immediately.`;
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

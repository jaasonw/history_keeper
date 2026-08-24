import { getMeta, setMeta, deleteVisit, deletePage } from '../lib/db.js';
import { initTheme, mountThemeToggle } from '../lib/theme.js';
import {
  query,
  relevanceQuery,
  stats,
  deviceBreakdown,
  invalidatePageCache,
} from '../lib/search.js';
import {
  chooseDirectory,
  directoryPickerBlockedReason,
  loadDirectory,
  verifyPermission,
  syncNow,
  syncEnvironmentDetail,
  buildSnapshot,
  importFromFile,
} from '../lib/sync.js';

const PAGE_SIZE = 100;
const AUTO_SYNC_MS = 5 * 60 * 1000;
const TYPING_DEBOUNCE_MS = 140;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();

const state = {
  page: 0,
  filters: {},
  dirHandle: null,
  dirUsable: false,
  // Incremented per search so a slow query cannot overwrite the results of a faster
  // one the user triggered afterwards by typing another character.
  generation: 0,
  sortTouched: false,
};

// ------------------------------------------------------------------ utilities

function formatWhen(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: '2-digit' })} ${d
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function formatAgo(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
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

function startOfDay(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function endOfDay(value) {
  const start = startOfDay(value);
  return start === null ? null : start + 24 * 60 * 60 * 1000 - 1;
}

function banner(id, text, { kind = '', progress = null, action = null } = {}) {
  let el = $(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    $('banners').append(el);
  }
  el.className = `banner ${kind}`;
  el.replaceChildren();

  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);

  if (progress) {
    const bar = document.createElement('progress');
    bar.max = progress.max;
    bar.value = progress.value;
    el.append(bar);
  }
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    el.append(button);
  }
}

function clearBanner(id) {
  $(id)?.remove();
}

// --------------------------------------------------------------------- stats

async function renderStats() {
  const s = await stats();
  $('stat-visits').textContent = nf.format(s.visits);
  $('stat-pages').textContent = nf.format(s.pages);
  $('stat-oldest').textContent = s.oldest
    ? new Date(s.oldest).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
  $('stat-span').textContent =
    s.oldest && s.newest ? nf.format(Math.max(1, Math.round((s.newest - s.oldest) / 86400000))) : '—';
  $('stat-size').textContent = formatBytes(s.bytes);

  const list = $('top-hosts');
  list.replaceChildren();
  for (const { host, count } of s.topHosts) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = host || '(no host)';
    button.title = `Filter to ${host}`;
    button.addEventListener('click', () => {
      $('host').value = host;
      runSearch(0);
    });
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = nf.format(count);
    li.append(button, badge);
    list.append(li);
  }
}

// -------------------------------------------------------------------- search

function readFilters() {
  return {
    text: $('q').value.trim(),
    host: $('host').value.trim().toLowerCase(),
    from: startOfDay($('from').value),
    to: endOfDay($('to').value),
  };
}

/**
 * Relevance ordering only means anything with search text, so the control follows the
 * text box until the user overrides it themselves.
 */
function effectiveSort(hasText) {
  if (state.sortTouched) return $('sort').value;
  const wanted = hasText ? 'relevance' : 'time';
  $('sort').value = wanted;
  return wanted;
}

async function runSearch(page = 0) {
  const generation = ++state.generation;
  state.page = page;
  state.filters = readFilters();

  const sort = effectiveSort(Boolean(state.filters.text));
  $('sort').disabled = !state.filters.text;

  const started = performance.now();
  const args = { ...state.filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
  const result = sort === 'relevance' ? await relevanceQuery(args) : await query(args);

  // A later keystroke already superseded this search.
  if (generation !== state.generation) return;

  const elapsed = Math.round(performance.now() - started);
  renderRows(result.rows, sort);

  if (!result.rows.length) {
    $('result-summary').textContent = state.filters.text
      ? `Nothing matches “${state.filters.text}”.`
      : 'No matches.';
  } else if (sort === 'relevance') {
    $('result-summary').textContent =
      `${nf.format(result.matched)} matching page${result.matched === 1 ? '' : 's'}, ` +
      `best first · ${elapsed} ms`;
  } else {
    $('result-summary').textContent =
      `${nf.format(result.rows.length)} visit${result.rows.length === 1 ? '' : 's'} on this page · ${elapsed} ms`;
  }

  $('page-label').textContent = `Page ${page + 1}`;
  $('prev').disabled = page === 0;
  $('next').disabled = !result.hasMore;
}

// Search on every keystroke, but only after the user pauses — otherwise a fast typist
// queues a full scan per character.
let debounceTimer = null;
function scheduleSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(0), TYPING_DEBOUNCE_MS);
}

function renderRows(rows, sort) {
  const list = $('results');
  list.replaceChildren();

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.gridColumn = '1 / -1';
    li.textContent = 'Nothing archived matches those filters.';
    list.append(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement('li');

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = formatWhen(row.visitTime);

    const entry = document.createElement('div');
    entry.className = 'entry';
    const link = document.createElement('a');
    link.href = row.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = row.title || row.url;
    link.title = row.url;
    const url = document.createElement('span');
    url.className = 'url';
    url.textContent = row.url;
    entry.append(link, url);

    // The count and the ✕ share the trailing column: the delete button reserves its slot
    // even while hidden, so the badge does not shift when the row is hovered.
    const actions = document.createElement('div');
    actions.className = 'row-actions';

    // A relevance row stands for a whole page, so it shows how often that page was
    // visited and its ✕ removes every visit to it.
    if (sort === 'relevance' && row.visitCount > 1) {
      const visits = document.createElement('span');
      visits.className = 'visit-count';
      visits.textContent = `${nf.format(row.visitCount)}×`;
      visits.title = `${nf.format(row.visitCount)} visits to this page`;
      actions.append(visits);
    }

    const remove = document.createElement('button');
    remove.className = 'row-delete';
    remove.textContent = '✕';
    remove.title =
      sort === 'relevance'
        ? 'Delete this page and all its visits from the archive'
        : 'Delete this visit from the archive';
    // The visible label is '✕', which screen readers don't announce usefully — reuse
    // the descriptive title text as the accessible name instead of writing a second one.
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      try {
        if (sort === 'relevance') await deletePage(row.urlHash);
        else await deleteVisit(row.id);
        invalidatePageCache();
        li.remove();
        await renderStats();
      } catch (err) {
        banner('init-error', `Delete failed: ${err.message}`, { kind: 'error' });
      }
    });

    actions.append(remove);
    li.append(when, entry, actions);
    list.append(li);
  }
}

// ---------------------------------------------------------------------- sync

async function refreshSyncPanel() {
  // No picker in this context: say why up front rather than letting the click fail, and
  // leave the snapshot/import path — which works everywhere — as the way through.
  const blocked = directoryPickerBlockedReason();
  if (blocked) {
    state.dirHandle = null;
    state.dirUsable = false;
    $('sync-status').textContent = blocked;
    $('sync-status').className = 'warn';
    $('connect').disabled = true;
    $('sync-now').disabled = true;
    $('sync-detail').textContent =
      `Download snapshot and Import file still work here. (${syncEnvironmentDetail()})`;
    return;
  }

  state.dirHandle = await loadDirectory();

  if (!state.dirHandle) {
    state.dirUsable = false;
    $('sync-status').textContent = 'Not connected.';
    $('sync-status').className = 'muted';
    $('connect').textContent = 'Connect folder';
    $('sync-now').disabled = true;
    return;
  }

  state.dirUsable = await verifyPermission(state.dirHandle);
  $('connect').textContent = state.dirUsable ? 'Change folder' : 'Reconnect folder';
  $('sync-now').disabled = !state.dirUsable;

  if (state.dirUsable) {
    $('sync-status').textContent = `Connected to “${state.dirHandle.name}”.`;
    $('sync-status').className = 'ok';
  } else {
    // Chrome dropped the grant, which it may do after a browser restart.
    $('sync-status').textContent = `“${state.dirHandle.name}” needs permission again.`;
    $('sync-status').className = 'warn';
  }

  const lastSync = await getMeta('lastSyncTime', null);
  const lastExport = await getMeta('lastExportAt', null);
  $('sync-detail').textContent = `Last sync ${formatAgo(lastSync)} · last export ${formatAgo(lastExport)}`;
}

let syncInFlight = false;

async function doSync({ interactive = false } = {}) {
  // The 5-minute timer only checks state.dirUsable, not the button's disabled state, so
  // it can fire while a manual sync (or another timer tick) is still running. Two
  // concurrent File System Access writes to the same shard silently clobber each
  // other — this guard is what makes doSync itself safe to call re-entrantly.
  if (syncInFlight) return;
  if (!state.dirHandle) return;
  if (!(await verifyPermission(state.dirHandle, { request: interactive }))) {
    await refreshSyncPanel();
    return;
  }

  syncInFlight = true;
  $('sync-now').disabled = true;
  $('sync-status').textContent = 'Syncing…';
  $('sync-status').className = 'muted';
  try {
    const result = await syncNow(state.dirHandle, (name, done, total) => {
      $('sync-status').textContent = `Importing ${name} (${done}/${total})…`;
    });
    await refreshSyncPanel();
    $('sync-detail').textContent =
      `Exported ${nf.format(result.exported)} · imported ${nf.format(result.added)} new ` +
      `from ${result.filesRead} file${result.filesRead === 1 ? '' : 's'}`;
    if (result.added || result.titled) invalidatePageCache();
    await renderStats();
    await runSearch(state.page);
  } catch (err) {
    $('sync-status').textContent = `Sync failed: ${err.message}`;
    $('sync-status').className = 'warn';
  } finally {
    syncInFlight = false;
    $('sync-now').disabled = !state.dirUsable;
  }
}

// ------------------------------------------------------------------- banners

async function refreshBackfillBanner() {
  const complete = await getMeta('backfillComplete', false);
  const started = await getMeta('backfillStartedAt', null);
  if (complete || !started) {
    clearBanner('backfill-banner');
    return false;
  }

  const total = await getMeta('backfillTotal', 0);
  const done = await getMeta('backfillDone', 0);
  banner('backfill-banner', `Importing existing Chrome history — ${nf.format(done)} of ${nf.format(total)} pages`, {
    progress: { max: Math.max(total, 1), value: done },
  });
  return true;
}

async function refreshSnapshotBanner() {
  if (!(await getMeta('snapshotDue', false))) return;
  banner('snapshot-banner', 'Weekly backup snapshot is due.', {
    action: { label: 'Download now', onClick: () => downloadSnapshot() },
  });
}

// ------------------------------------------------------------ backup buttons

async function downloadSnapshot() {
  $('backup-detail').textContent = 'Building snapshot…';
  try {
    const blob = await buildSnapshot();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `history-keeper-${new Date().toISOString().slice(0, 10)}.ndjson`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    await setMeta('snapshotDue', false);
    clearBanner('snapshot-banner');
    $('backup-detail').textContent = `Snapshot written (${(blob.size / 1048576).toFixed(1)} MB).`;
  } catch (err) {
    $('backup-detail').textContent = `Snapshot failed: ${err.message}`;
  }
}

async function handleImport(file) {
  $('backup-detail').textContent = `Reading ${file.name}…`;
  try {
    const { added, titled, total } = await importFromFile(file, (done, all) => {
      $('backup-detail').textContent = `Merging ${done}/${all}…`;
    });
    $('backup-detail').textContent =
      `Merged ${nf.format(added)} new of ${nf.format(total)} records` +
      (titled ? `, and filled in ${nf.format(titled)} missing title${titled === 1 ? '' : 's'}.` : '.');
    invalidatePageCache();
    await renderStats();
    await runSearch(0);
  } catch (err) {
    $('backup-detail').textContent = `Import failed: ${err.message}`;
  }
}

// --------------------------------------------------------------------- wiring

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  runSearch(0);
});

$('q').addEventListener('input', scheduleSearch);
$('q').addEventListener('keydown', (event) => {
  // There is no Search button any more, so Enter means "skip the debounce".
  if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(debounceTimer);
    runSearch(0);
  }
});
$('host').addEventListener('input', scheduleSearch);
$('from').addEventListener('change', () => runSearch(0));
$('to').addEventListener('change', () => runSearch(0));

$('sort').addEventListener('change', () => {
  state.sortTouched = true;
  runSearch(0);
});

$('clear').addEventListener('click', () => {
  $('q').value = '';
  $('host').value = '';
  $('from').value = '';
  $('to').value = '';
  state.sortTouched = false;
  runSearch(0);
});

$('prev').addEventListener('click', () => runSearch(Math.max(0, state.page - 1)));
$('next').addEventListener('click', () => runSearch(state.page + 1));

$('connect').addEventListener('click', async () => {
  try {
    if (state.dirHandle && !state.dirUsable) {
      await verifyPermission(state.dirHandle, { request: true });
    } else {
      await chooseDirectory();
    }
    await refreshSyncPanel();
    await doSync({ interactive: true });
  } catch (err) {
    if (err.name !== 'AbortError') {
      $('sync-status').textContent = `Could not open folder: ${err.message}`;
      $('sync-status').className = 'warn';
    }
  }
});

$('sync-now').addEventListener('click', () => doSync({ interactive: true }));
$('snapshot').addEventListener('click', () => downloadSnapshot());
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) handleImport(file);
  event.target.value = '';
});

$('load-devices').addEventListener('click', async () => {
  const button = $('load-devices');
  button.disabled = true;
  button.textContent = 'Counting…';
  const rows = await deviceBreakdown();
  const thisDevice = await getMeta('deviceId');
  const list = $('devices');
  list.replaceChildren();
  for (const { id, count } of rows) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = id === thisDevice ? `${id} (this device)` : id || '(unknown)';
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = nf.format(count);
    li.append(name, badge);
    list.append(li);
  }
  button.remove();
});

// ----------------------------------------------------------------- lifecycle

// Ahead of init() and unawaited: the archive queries below take long enough that waiting
// on them would leave the page in the wrong flavour while they run.
initTheme();

async function init() {
  await mountThemeToggle($('theme'));
  $('device-badge').textContent = (await getMeta('deviceId')) || '…';

  await renderStats();
  await runSearch(0);
  await refreshSyncPanel();
  await refreshSnapshotBanner();

  // While the backfill runs, keep the banner and counters moving.
  if (await refreshBackfillBanner()) {
    const timer = setInterval(async () => {
      const running = await refreshBackfillBanner();
      invalidatePageCache(); // pages are streaming in behind us
      await renderStats();
      if (!running) {
        clearInterval(timer);
        await runSearch(state.page);
      }
    }, 2000);
  }

  // The dashboard is the only context that can touch the sync folder, so it syncs on
  // open and then on a timer for as long as the tab stays around.
  if (state.dirUsable) await doSync();
  setInterval(() => {
    if (state.dirUsable && document.visibilityState === 'visible') doSync();
  }, AUTO_SYNC_MS);

  if (location.hash === '#sync' && state.dirHandle) await doSync({ interactive: true });
}

init().catch((err) => {
  console.error(err);
  banner('init-error', `Dashboard failed to start: ${err.message}`, { kind: 'error' });
});

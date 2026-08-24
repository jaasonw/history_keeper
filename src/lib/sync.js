// Cross-device sync over an ordinary cloud-synced folder (Drive / OneDrive / Dropbox).
//
// The safety property that makes this work on top of file-sync clients, which handle
// concurrent edits badly, is that NO FILE IS EVER WRITTEN BY TWO DEVICES. Each device
// appends only to shards named after its own device id; every device reads all the
// others. Merge is an idempotent union because the visit id is device-independent.
//
// This module must run in an extension PAGE. The File System Access API does not exist
// in service workers.

import { openDb, reqToPromise, txDone, getMeta, setMeta, setManyMeta, putVisits, cursorEach } from './db.js';
import { isValidRecord, urlHashMatches, forExport } from './record.js';
import { isBlocked } from './blocklist.js';

const FOLDER_NAME = 'history-keeper';
const HANDLE_KEY = 'syncDirHandle';
const EXPORT_BATCH = 20_000;

// -------------------------------------------------------------------- folder handle

/**
 * The File System Access API is Chromium-only, and even there it is withheld from pages
 * with an opaque origin — a `file://` page does not get it. Opening the dashboard by
 * double-clicking index.html instead of loading the unpacked extension lands there, and
 * everything else on the page works, so the failure only shows up at the picker.
 */
export function directoryPickerSupported() {
  return typeof self.showDirectoryPicker === 'function';
}

function isBrave() {
  // navigator.brave.isBrave() is async; the brand list carries the same answer synchronously.
  return Boolean(navigator.brave) ||
    Boolean(navigator.userAgentData?.brands?.some((b) => b.brand === 'Brave'));
}

function isFramed() {
  try {
    return self.top !== self.self;
  } catch {
    return true; // Cross-origin parent: framed, and not by us.
  }
}

/** Human-readable reason the picker is unavailable, or null when it is available. */
export function directoryPickerBlockedReason() {
  if (directoryPickerSupported()) return null;
  if (location.protocol === 'file:') {
    return 'This page is open from disk, where Chrome withholds folder access. Load the ' +
      'extension at chrome://extensions → Load unpacked, then open the dashboard from the toolbar.';
  }
  if (!self.isSecureContext) {
    return 'Folder sync needs a secure context; this page is not one.';
  }
  if (isFramed()) {
    // A frame only gets the API when its embedder delegates it, which nothing here does.
    return 'The dashboard is running inside a frame, which is not granted folder access. ' +
      'Open it as a top-level tab: toolbar icon → Open dashboard.';
  }
  if (isBrave()) {
    // Brave deviates from Chromium here and ships the API off, but leaves a flag for it.
    return 'Brave disables the File System Access API by default. Open ' +
      'brave://flags/#file-system-access-api, set it to Enabled, restart Brave, and reopen ' +
      'this page.';
  }
  return 'This browser has no File System Access API. Folder sync needs desktop Chrome, ' +
    'Edge, or another Chromium browser.';
}

/**
 * One line naming the context, so a "not supported" report is diagnosable without having
 * to ask which browser the page is in.
 */
export function syncEnvironmentDetail() {
  const brands = navigator.userAgentData?.brands
    ?.filter((b) => !/Not.?A.?Brand/i.test(b.brand))
    .map((b) => `${b.brand} ${b.version}`)
    .join(', ');
  const parts = [
    `origin ${location.protocol}//${location.host || '(opaque)'}`,
    brands || navigator.userAgent,
    isFramed() ? 'in a frame' : 'top-level',
    self.isSecureContext ? 'secure' : 'not secure',
  ];
  return parts.join(' · ');
}

export async function chooseDirectory() {
  const blocked = directoryPickerBlockedReason();
  if (blocked) throw new Error(blocked);

  const handle = await self.showDirectoryPicker({
    id: 'history-keeper-sync',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await setMeta(HANDLE_KEY, handle);
  return handle;
}

export async function loadDirectory() {
  return getMeta(HANDLE_KEY, null);
}

/**
 * Chrome does not always persist a directory grant across browser restarts, so this
 * distinguishes "we have a handle and may use it" from "we have a handle but need the
 * user to click something". `request: true` requires user activation — only pass it
 * from inside a click handler.
 */
export async function verifyPermission(handle, { request = false } = {}) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function syncFolder(handle) {
  return handle.getDirectoryHandle(FOLDER_NAME, { create: true });
}

function monthKey(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// -------------------------------------------------------------------------- export

/**
 * Append everything captured on this device since the last export.
 *
 * Shards rotate monthly so the cloud client is not re-uploading one ever-growing file
 * on every append.
 */
export async function exportDelta(handle) {
  const dir = await syncFolder(handle);
  const db = await openDb();
  const deviceId = await getMeta('deviceId');
  const lastSeq = await getMeta('lastExportedSeq', 0);

  const byMonth = new Map();
  let highestSeq = lastSeq;
  let count = 0;

  const index = db.transaction('visits').objectStore('visits').index('localSeq');
  await cursorEach(index, IDBKeyRange.lowerBound(lastSeq, true), 'next', (visit) => {
    const key = monthKey(visit.visitTime);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(JSON.stringify(forExport(visit)));
    if (visit.localSeq > highestSeq) highestSeq = visit.localSeq;
    count++;
    if (count >= EXPORT_BATCH) return false;
  });

  for (const [month, lines] of byMonth) {
    await appendLines(dir, `${deviceId}-${month}.ndjson`, lines);
  }

  if (count) {
    await setManyMeta({ lastExportedSeq: highestSeq, lastExportAt: Date.now() });
  }
  return { exported: count, more: count >= EXPORT_BATCH };
}

async function appendLines(dir, filename, lines) {
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const existing = await fileHandle.getFile();
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  await writable.write({ type: 'seek', position: existing.size });
  await writable.write(`${lines.join('\n')}\n`);
  await writable.close();
}

// -------------------------------------------------------------------------- import

/**
 * Read the tail of every other device's shard.
 *
 * Only the bytes added since last time are read, and a trailing partial line — a real
 * possibility when a cloud client is mid-download — is left unconsumed so it is picked
 * up whole on the next pass.
 */
export async function importAll(handle, onProgress) {
  const dir = await syncFolder(handle);
  const deviceId = await getMeta('deviceId');
  const db = await openDb();

  let added = 0;
  // A shard can carry no new visits and still change the archive, by supplying a title
  // for a visit this device captured before Chrome knew one.
  let titled = 0;
  let filesRead = 0;

  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !name.endsWith('.ndjson')) continue;
    if (name.startsWith(`${deviceId}-`)) continue; // our own shard

    const file = await entry.getFile();
    const bookmark = await reqToPromise(
      db.transaction('imports').objectStore('imports').get(name),
    );
    // A shrunken file means it was replaced or truncated; re-read it in full. Dedupe
    // makes that safe, just slower.
    let consumed = bookmark && file.size >= bookmark.bytesConsumed ? bookmark.bytesConsumed : 0;
    if (consumed === file.size) continue;

    const bytes = new Uint8Array(await file.slice(consumed).arrayBuffer());
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline === -1) continue; // no complete line yet

    const text = new TextDecoder().decode(bytes.subarray(0, lastNewline + 1));
    consumed += lastNewline + 1;

    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        // isBlocked and urlHashMatches apply here because this is the only place a
        // peer's data crosses into this device's archive — the three capture paths in
        // the service worker already filter through isBlocked before a record exists.
        if (!isValidRecord(rec)) continue;
        if (!(await urlHashMatches(rec))) continue;
        if (await isBlocked(rec.url, rec.host)) continue;
        records.push(rec);
      } catch {
        // Skip corrupt lines rather than abandoning the file.
      }
    }

    for (let i = 0; i < records.length; i += 500) {
      const result = await putVisits(records.slice(i, i + 500), { assignLocalSeq: false });
      added += result.added;
      titled += result.titled;
      if (onProgress) onProgress(name, Math.min(i + 500, records.length), records.length);
    }

    const tx = db.transaction('imports', 'readwrite');
    tx.objectStore('imports').put({ filename: name, bytesConsumed: consumed, lastModified: file.lastModified });
    await txDone(tx);
    filesRead++;
  }

  await setMeta('lastSyncTime', Date.now());
  return { added, titled, filesRead };
}

export async function syncNow(handle, onProgress) {
  const exported = await exportDelta(handle);
  const imported = await importAll(handle, onProgress);
  return { ...exported, ...imported };
}

// ------------------------------------------------------- manual snapshot and import

/** Whole archive as NDJSON, for the download-to-disk fallback. */
export async function buildSnapshot() {
  const db = await openDb();
  const chunks = [];
  await cursorEach(
    db.transaction('visits').objectStore('visits').index('visitTime'),
    null,
    'next',
    (visit) => {
      chunks.push(`${JSON.stringify(forExport(visit))}\n`);
    },
  );
  return new Blob(chunks, { type: 'application/x-ndjson' });
}

/** Merge a user-picked .ndjson file. Same union semantics as shard import. */
export async function importFromFile(file, onProgress) {
  const text = await file.text();
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!isValidRecord(rec)) continue;
      if (!(await urlHashMatches(rec))) continue;
      if (await isBlocked(rec.url, rec.host)) continue;
      records.push(rec);
    } catch {
      /* skip */
    }
  }

  let added = 0;
  let titled = 0;
  for (let i = 0; i < records.length; i += 500) {
    const result = await putVisits(records.slice(i, i + 500), { assignLocalSeq: false });
    added += result.added;
    titled += result.titled;
    if (onProgress) onProgress(Math.min(i + 500, records.length), records.length);
  }
  return { added, titled, total: records.length };
}

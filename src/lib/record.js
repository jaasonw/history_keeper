// Normalisation of Chrome history entries into the archive's record shape.

const ARCHIVABLE_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'file:']);

/**
 * First 16 hex chars (8 bytes) of SHA-256(url). Collision odds across even a few
 * million URLs are negligible, and short keys keep the composite visit id compact.
 */
export async function urlHash(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const bytes = new Uint8Array(digest, 0, 8);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hostOf(url) {
  try {
    const hostname = new URL(url).hostname;
    // A trailing-dot FQDN (https://bank.example./x) is a real, navigable URL, but it
    // would otherwise never match a blocklist pattern for "bank.example" — strip it here
    // so every consumer (capture, blocklist matching, the page rollup) sees one host.
    return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  } catch {
    return '';
  }
}

/** Chrome's own pages, the extension's own pages, and data: URLs are never archived. */
export function isArchivable(url) {
  if (!url) return false;
  try {
    return ARCHIVABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function visitId(hash, visitTime) {
  return `${hash}:${visitTime}`;
}

/**
 * Chrome reports visit times as floats with a sub-millisecond fraction. Rounding is
 * mandatory, not cosmetic: the rounded value is half of the dedupe key, so an
 * unrounded read of the same visit would land in a second row.
 */
export function normaliseTime(visitTime) {
  return Math.round(visitTime);
}

export async function makeRecord({ url, title, visitTime, transition, deviceId }) {
  const time = normaliseTime(visitTime);
  const hash = await urlHash(url);
  return {
    id: visitId(hash, time),
    urlHash: hash,
    url,
    title: title || '',
    host: hostOf(url),
    visitTime: time,
    transition: transition || 'link',
    deviceId,
  };
}

/** Shape check for records arriving from another device's shard file. */
export function isValidRecord(rec) {
  return (
    typeof rec === 'object' &&
    rec !== null &&
    typeof rec.id === 'string' &&
    typeof rec.url === 'string' &&
    isArchivable(rec.url) &&
    typeof rec.urlHash === 'string' &&
    typeof rec.title === 'string' &&
    rec.title.length <= 500 &&
    typeof rec.host === 'string' &&
    Number.isInteger(rec.visitTime) &&
    rec.id === visitId(rec.urlHash, rec.visitTime)
  );
}

/**
 * Confirms urlHash was actually derived from url. isValidRecord alone only checks that
 * a record's own fields are internally consistent (id matches urlHash+visitTime); a
 * shard line can still claim any hash for any URL, which would land it in the wrong
 * page's rollup and make it invisible to blocklist purge (which scans by URL). Async,
 * so it is checked separately from isValidRecord at the actual import boundary rather
 * than folded into that widely-used synchronous check.
 */
export async function urlHashMatches(rec) {
  return rec.urlHash === (await urlHash(rec.url));
}

/** Strip local-only fields before a record is written to a shard file. */
export function forExport(rec) {
  const { localSeq, ...rest } = rec;
  return rest;
}

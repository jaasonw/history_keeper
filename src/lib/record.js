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
    return new URL(url).hostname;
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
    typeof rec.urlHash === 'string' &&
    Number.isFinite(rec.visitTime) &&
    rec.id === visitId(rec.urlHash, rec.visitTime)
  );
}

/** Strip local-only fields before a record is written to a shard file. */
export function forExport(rec) {
  const { localSeq, ...rest } = rec;
  return rest;
}

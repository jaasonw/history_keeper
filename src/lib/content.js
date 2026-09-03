// Page-text helpers: tokenising for the term index, gzip for storage.
//
// Pure: no chrome.*, no DOM, no IndexedDB, so the service worker, the pages and the
// tests all import it, and db.js can depend on it without a cycle.

/**
 * Body text is capped before anything else touches it. An 8KB page is typical; the cap
 * exists for the pathological ones (an infinite-scroll feed, a generated log dump) where
 * text keeps growing without adding anything you would ever search for.
 */
export const MAX_TEXT_CHARS = 64_000;

/**
 * The host permission page-text capture needs, as `chrome.permissions` wants it.
 *
 * Not `<all_urls>`: Chrome refuses that literal in `optional_host_permissions` and a
 * request for it fails with "Only permissions specified in the manifest may be
 * requested". Explicit schemes are what it accepts, and they must match the manifest
 * exactly, which is why this lives in one place that the worker and the options page
 * both read, rather than being spelled out twice and drifting.
 *
 * `file:` and `ftp:` are archivable but not listed: Chrome gates file access behind its
 * own separate opt-in, and capture simply never fires for them.
 */
export const TEXT_ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * Distinct terms indexed per page. Each one becomes a row in the `tokens` multiEntry
 * index, so this is the number that decides how the index scales: 500 terms is roughly
 * the vocabulary of a long article, and everything beyond it is the long tail of words
 * that appear once.
 */
export const MAX_TOKENS = 500;

const MIN_TERM = 2;
const MAX_TERM = 32;

// Unicode-aware on purpose: \W is ASCII-only and would shred any page not written in a
// Latin script into single characters.
const SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * Distinct terms of a page, most frequent first and capped.
 *
 * Frequency decides what survives the cap rather than document order, so a page's real
 * subject beats whatever happened to sit in its nav bar.
 */
export function tokenise(text) {
  const counts = new Map();
  for (const raw of String(text).toLowerCase().split(SEPARATOR)) {
    if (raw.length < MIN_TERM || raw.length > MAX_TERM) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  if (counts.size <= MAX_TOKENS) return [...counts.keys()];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOKENS)
    .map(([term]) => term);
}

/** Collapse runs of whitespace so a stored page is text rather than layout. */
export function normaliseText(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);
}

/**
 * CompressionStream is native in both the worker and the pages, so compression costs a
 * helper pair rather than a dependency. Page text gzips at roughly 4:1.
 */
export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Roughly three lines at the dashboard's snippet size. */
export const SNIPPET_WIDTH = 420;

// A snippet this size cannot hold more than a handful of hits; the cap only stops a
// pathological page (one word repeated ten thousand times) from building a huge list.
const MAX_HITS = 200;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Character ranges to highlight, widened to whole words and merged where they overlap.
 *
 * Widened because a term reaches the index by prefix (typing `mit` matches the stored
 * term `mitochondrion`), and lighting up three letters of a long word reads as a
 * rendering bug rather than as an answer. Merged because two query tokens landing on the
 * same word would otherwise produce overlapping, double-counted spans.
 */
function hitRanges(hay, terms) {
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(term, from);
      if (idx === -1) break;

      let start = idx;
      while (start > 0 && WORD_CHAR.test(hay[start - 1])) start--;
      let end = idx + term.length;
      while (end < hay.length && WORD_CHAR.test(hay[end])) end++;

      ranges.push([start, end]);
      from = end;
      if (ranges.length >= MAX_HITS) return ranges.sort((a, b) => a[0] - b[0]);
    }
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * Split the whole of `text` into segments, marking every occurrence of `terms`.
 *
 * The no-window sibling of snippetAround, for short strings a result row shows in full:
 * a page title, or the URL standing in for one.
 *
 * @returns {{text: string, hit: boolean}[]}
 */
export function markUp(text, terms) {
  if (!text) return [];
  const ranges = terms.length ? hitRanges(text.toLowerCase(), terms) : [];
  if (!ranges.length) return [{ text, hit: false }];

  const parts = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push({ text: text.slice(at, from), hit: false });
    parts.push({ text: text.slice(from, to), hit: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * A window of text around the first matching term, split into segments so the caller can
 * emphasise the hits.
 *
 * Returns segments rather than marked-up text on purpose: archived page text is
 * untrusted, and the dashboard builds these with `createElement`/`textContent`, never
 * `innerHTML`.
 *
 * @returns {{text: string, hit: boolean}[]} Empty when there is nothing to show.
 */
export function snippetAround(text, terms, width = SNIPPET_WIDTH) {
  if (!text) return [];

  const ranges = hitRanges(text.toLowerCase(), terms);
  if (!ranges.length) {
    // No term survived into the stored text: it matched a term that the text cap cut, or
    // one only the tokeniser produced. The head of the page is still better than nothing.
    const head = text.slice(0, width).trim();
    return head ? [{ text: head, hit: false }] : [];
  }

  // Lead with a little context before the first hit rather than starting on it, so the
  // match reads as part of a sentence.
  const start = Math.max(0, ranges[0][0] - Math.floor(width / 4));
  const end = Math.min(text.length, start + width);

  const parts = [];
  const push = (chunk, hit) => {
    if (chunk) parts.push({ text: chunk, hit });
  };

  if (start > 0) push('…', false);
  let at = start;
  for (const [from, to] of ranges) {
    if (to <= start) continue;
    if (from >= end) break;
    push(text.slice(at, Math.max(at, from)), false);
    push(text.slice(Math.max(at, from), Math.min(to, end)), true);
    at = Math.min(to, end);
  }
  push(text.slice(at, end), false);
  if (end < text.length) push('…', false);

  return parts;
}


/**
 * Base64, because a content shard is still NDJSON.
 *
 * Gzip output contains 0x0A bytes freely, and the import path finds the last complete
 * line by scanning for exactly that byte, and a partial line is a real possibility when a
 * cloud client is mid-download. Base64 costs about a third of the compression back and
 * keeps that arithmetic correct.
 */
export function toBase64(bytes) {
  let binary = '';
  // Chunked: spreading a large array into fromCharCode overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Fuzzy matching for the dashboard's search-as-you-type.
//
// Four tiers per token, cheapest first, because this runs over every page in the
// archive on every keystroke:
//
//   1. substring at a word boundary   "git" in "github.com"
//   2. substring anywhere             "hub" in "github.com"
//   3. subsequence                    "gthb" in "github"      (scored by compactness)
//   4. typo, within an edit distance  "pythom" -> "python"
//
// Tier 4 is the expensive one: it is only attempted on a second pass, and only when
// the cheap pass came up nearly empty, which is precisely when the user has mistyped.
// Even then it never reaches the edit-distance loop for most words; see typoScore.

const TIER_BOUNDARY = 1.0;
const TIER_SUBSTRING = 0.85;
const TIER_SUBSEQUENCE = 0.55;
// Page text, when the title and URL say nothing. Deliberately below every tier above:
// a page actually *called* what you typed should always beat one that merely mentions it.
const TIER_CONTENT = 0.45;
const TIER_TYPO = 0.35;
const TIER_CONTENT_TYPO = 0.20;
const TITLE_BONUS = 0.05;

const MAX_WORD = 64;

function isWordChar(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57); // a-z 0-9
}

/**
 * Which bit of a 32-bit presence mask a character occupies. Letters get their own bit;
 * the ten digits are folded onto six. Folding only ever makes the mask claim a
 * character *might* be present, so the filter built on it stays sound.
 */
export function charBit(code) {
  return code >= 97 ? code - 97 : 26 + ((code - 48) % 6);
}

export function maskOf(text) {
  let mask = 0;
  for (let i = 0; i < text.length; i++) mask |= 1 << charBit(text.charCodeAt(i));
  return mask;
}

export function popcount(n) {
  n -= (n >> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >> 24;
}

/** Typo tolerance scales with token length; short tokens are far too noisy for it. */
function maxDistanceFor(token) {
  if (token.length <= 3) return 0;
  if (token.length <= 5) return 1;
  return 2;
}

export function prepareQuery(text) {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ({ text: token, maxDist: maxDistanceFor(token), mask: maskOf(token) }));
  return { tokens, empty: tokens.length === 0 };
}

/** Greedy leftmost subsequence. Returns the span it occupied, or null. */
function subsequenceSpan(token, hay) {
  let ti = 0;
  let first = -1;
  let last = -1;
  for (let j = 0; j < hay.length && ti < token.length; j++) {
    if (hay.charCodeAt(j) === token.charCodeAt(ti)) {
      if (ti === 0) first = j;
      last = j;
      ti++;
    }
  }
  return ti === token.length ? { first, last } : null;
}

// Scratch rows for the edit-distance table, reused across calls. Allocating these per
// call dominated the typo pass, which runs a million-plus times over a large archive.
const dpA = new Uint16Array(MAX_WORD + 1);
const dpB = new Uint16Array(MAX_WORD + 1);

/**
 * Levenshtein distance, abandoned as soon as every cell in a row exceeds maxDist.
 * Returns maxDist + 1 to mean "further away than we care about".
 */
export function boundedEditDistance(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  if (a.length > MAX_WORD || b.length > MAX_WORD) return maxDist + 1;

  let prev = dpA;
  let curr = dpB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      let best = prev[j] + 1;
      const insert = curr[j - 1] + 1;
      if (insert < best) best = insert;
      const substitute = prev[j - 1] + (ac === b.charCodeAt(j - 1) ? 0 : 1);
      if (substitute < best) best = substitute;
      curr[j] = best;
      if (best < rowBest) rowBest = best;
    }
    if (rowBest > maxDist) return maxDist + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[b.length] <= maxDist ? prev[b.length] : maxDist + 1;
}

/**
 * The first word of the haystack within `maxDist` edits of the token, or null.
 *
 * Word boundaries are walked by index, accumulating a character-presence mask as we
 * go. A word can only be within maxDist edits of the token if at most maxDist of the
 * token's distinct characters are missing from it, and that test is a couple of integer
 * ops and rejects the overwhelming majority of words before any string is allocated
 * or any table filled in.
 */
export function nearestWord(token, hay, maxDist = token.maxDist) {
  if (maxDist === 0) return null;

  const text = token.text;
  const minLen = text.length - maxDist;
  const maxLen = Math.min(text.length + maxDist, MAX_WORD);
  let start = -1;
  let mask = 0;

  for (let i = 0; i <= hay.length; i++) {
    if (i < hay.length) {
      const code = hay.charCodeAt(i);
      if (isWordChar(code)) {
        if (start === -1) {
          start = i;
          mask = 0;
        }
        mask |= 1 << charBit(code);
        continue;
      }
    }
    if (start === -1) continue;

    const length = i - start;
    if (
      length >= minLen &&
      length <= maxLen &&
      popcount(token.mask & ~mask) <= maxDist &&
      boundedEditDistance(text, hay.slice(start, i), maxDist) <= maxDist
    ) {
      return hay.slice(start, i);
    }
    start = -1;
  }
  return null;
}

// The word itself is what the dashboard needs to emphasise a typo'd match; the score is
// all the ranking needs. One walk serves both.
function typoScore(token, hay, maxDist) {
  return nearestWord(token, hay, maxDist) ? TIER_TYPO : 0;
}

function scoreToken(token, page, allowTypos) {
  const hay = page.hay;
  const idx = hay.indexOf(token.text);

  if (idx !== -1) {
    const atBoundary = idx === 0 || !isWordChar(hay.charCodeAt(idx - 1));
    const base = atBoundary ? TIER_BOUNDARY : TIER_SUBSTRING;
    return idx < page.titleLen ? base + TITLE_BONUS : base;
  }

  const span = subsequenceSpan(token.text, hay);
  if (span) {
    // A tight span ("gthb" inside "github") is a much better signal than characters
    // scattered across the whole URL.
    const compactness = token.text.length / (span.last - span.first + 1);
    return TIER_SUBSEQUENCE * (0.6 + 0.4 * compactness);
  }

  return allowTypos ? typoScore(token, hay, token.maxDist) : 0;
}

/**
 * @param {object[]|null} contentHits  Parallel to prepared.tokens. Each entry is
 *   `{hashes: Set<urlHash>, fuzzy: boolean}`, the pages whose *text* carries that term,
 *   resolved from the term index by search.js. Null when page text is not indexed.
 * @returns {number} 0 when any token fails to match, otherwise a relevance score.
 *   All tokens must match, which is the AND semantics of the original exact search, but
 *   each one may satisfy that through the title/URL haystack *or* through page text, so
 *   "react useEffect" can match a page titled "react" that only mentions useEffect.
 */
export function scorePage(page, prepared, allowTypos = false, contentHits = null) {
  let total = 0;
  for (let i = 0; i < prepared.tokens.length; i++) {
    const token = prepared.tokens[i];
    let score = scoreToken(token, page, allowTypos);
    if (score === 0 && contentHits) {
      const hit = contentHits[i];
      if (hit && hit.hashes.has(page.urlHash)) score = hit.fuzzy ? TIER_CONTENT_TYPO : TIER_CONTENT;
    }
    if (score === 0) return 0;
    total += score;
  }

  let score = total / prepared.tokens.length;

  // Recency and familiarity nudges, kept small on purpose: they break ties between
  // comparable matches rather than outranking a better textual match.
  const ageDays = Math.max(0, (Date.now() - page.lastSeen) / 86_400_000);
  score *= 1 + 0.2 * Math.exp(-ageDays / 180);
  score *= 1 + 0.1 * Math.min(1, Math.log10(page.visitCount + 1) / 2);

  return score;
}

// URL blocklist: patterns the archive must never store, and a retroactive purge for
// anything that was already stored before a pattern was added.
//
// Pattern syntax (one per line in the options page):
//   example.com        host match, including subdomains
//   *.example.com      subdomains only
//   /pattern/flags     regular expression, tested against the full URL

import { openDb, cursorEach, deletePage } from './db.js';

export const STORAGE_KEY = 'blocklist';

let cache = null;

/**
 * Punycode-encode and lowercase a host the way hostOf() (record.js) does, so a pattern
 * typed as Unicode or mixed case still matches the ASCII form every captured host is
 * compared in.
 */
function normaliseHost(raw) {
  try {
    return new URL(`http://${raw}`).hostname;
  } catch {
    return raw.toLowerCase();
  }
}

export function compile(patterns) {
  const compiled = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) continue;

    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const end = pattern.lastIndexOf('/');
      try {
        const re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1));
        compiled.push({ raw, test: (url) => re.test(url) });
      } catch {
        // A malformed regex is ignored rather than allowed to block all writes.
      }
      continue;
    }

    const wildcard = pattern.startsWith('*.');
    const bare = wildcard ? pattern.slice(2) : pattern;
    // hostOf() always returns a bare hostname — no scheme, path, query or port. A
    // pattern carrying any of those can never equal it, so it would silently compile
    // into a rule that never fires. Skip it instead of pretending it works.
    if (/[/\s?#]/.test(bare) || bare.includes('://') || /:\d/.test(bare)) continue;

    const host = normaliseHost(bare);
    if (wildcard) {
      compiled.push({ raw, test: (_url, h) => h.endsWith(`.${host}`) });
    } else {
      compiled.push({ raw, test: (_url, h) => h === host || h.endsWith(`.${host}`) });
    }
  }
  return compiled;
}

export async function getPatterns() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

export async function setPatterns(patterns) {
  await chrome.storage.local.set({ [STORAGE_KEY]: patterns });
  cache = null;
}

async function getCompiled() {
  if (!cache) cache = compile(await getPatterns());
  return cache;
}

// Any context that imports this module keeps its cache honest across edits made in
// another context (options page vs service worker).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) cache = null;
  });
}

export async function isBlocked(url, host) {
  const rules = await getCompiled();
  if (!rules.length) return false;
  const lowerHost = (host || '').toLowerCase();
  return rules.some((rule) => rule.test(url, lowerHost));
}

/** Drop everything already archived that the current patterns would have excluded. */
export async function purgeMatching(onProgress) {
  const rules = await getCompiled();
  if (!rules.length) return { pages: 0, visits: 0 };

  const db = await openDb();
  const doomed = [];
  await cursorEach(db.transaction('pages').objectStore('pages'), null, 'next', (page) => {
    const host = (page.host || '').toLowerCase();
    if (rules.some((rule) => rule.test(page.url, host))) doomed.push(page.urlHash);
  });

  let visits = 0;
  for (let i = 0; i < doomed.length; i++) {
    visits += await deletePage(doomed[i]);
    if (onProgress && i % 25 === 0) onProgress(i + 1, doomed.length);
  }
  return { pages: doomed.length, visits };
}

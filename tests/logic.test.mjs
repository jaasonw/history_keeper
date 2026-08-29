// Exercises the real extension modules against a fake IndexedDB.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

const SRC = new URL('../src/', import.meta.url);
const load = (p) => import(new URL(p, SRC).href);

// The modules expect a browser-ish global surface.
globalThis.crypto ??= (await import('node:crypto')).webcrypto;
globalThis.chrome = {
  storage: {
    local: {
      _data: {},
      async get(key) {
        return key in this._data ? { [key]: this._data[key] } : {};
      },
      async set(obj) {
        Object.assign(this._data, obj);
      },
    },
    onChanged: { addListener() {} },
  },
};

const db = await load('lib/db.js');
const record = await load('lib/record.js');
const search = await load('lib/search.js');
const blocklist = await load('lib/blocklist.js');
const fuzzy = await load('lib/fuzzy.js');
const content = await load('lib/content.js');
// Only importFromFile is exercised here — every other export needs File System Access
// handles, which do not exist under Node — but nothing at module scope needs the DOM
// or that API, so the import boundary itself (the trust boundary for peer data) is
// reachable from this suite with a plain { text: async () => str } stub for File.
const sync = await load('lib/sync.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const DEVICE = 'devA';
const day = 86_400_000;
const base = Date.UTC(2026, 0, 15, 12, 0, 0);

const mk = (url, title, offsetDays, deviceId = DEVICE) =>
  record.makeRecord({ url, title, visitTime: base - offsetDays * day, deviceId });

console.log('\nrecord.js');

await test('visit id is stable and device-independent', async () => {
  const a = await mk('https://example.com/a', 'A', 0, 'devA');
  const b = await mk('https://example.com/a', 'A', 0, 'devB');
  assert.equal(a.id, b.id);
  assert.equal(a.host, 'example.com');
});

await test('fractional visit times round to the same id', async () => {
  const a = await record.makeRecord({ url: 'https://x.test/', visitTime: 1000.4, deviceId: DEVICE });
  const b = await record.makeRecord({ url: 'https://x.test/', visitTime: 1000.2, deviceId: DEVICE });
  assert.equal(a.id, b.id);
});

await test('chrome:// and extension pages are not archivable', () => {
  assert.equal(record.isArchivable('chrome://history'), false);
  assert.equal(record.isArchivable('chrome-extension://abc/page.html'), false);
  assert.equal(record.isArchivable('https://ok.test/'), true);
  assert.equal(record.isArchivable(''), false);
});

await test('hostOf strips a trailing dot so an FQDN still matches blocklist patterns', () => {
  assert.equal(record.hostOf('https://mybank.example./x'), 'mybank.example');
  assert.equal(record.hostOf('https://mybank.example/x'), 'mybank.example');
});

console.log('\ndb.js');

await test('a failed open does not wedge every later openDb() behind the same rejection', async () => {
  // Simulates onblocked/onerror on the underlying indexedDB.open — without this,
  // openDb() memoises the rejected promise forever and every future caller (including
  // the service worker's own capture paths) fails until the context is torn down.
  const realOpen = globalThis.indexedDB.open.bind(globalThis.indexedDB);
  globalThis.indexedDB.open = () => {
    const req = {};
    queueMicrotask(() => req.onerror?.());
    return req;
  };
  await assert.rejects(() => db.openDb());

  globalThis.indexedDB.open = realOpen;
  const conn = await db.openDb();
  assert.ok(conn, 'a later call must recover once the underlying open works again');
});

await test('putVisits dedupes and builds the page rollup', async () => {
  const recs = [
    await mk('https://news.test/a', 'Story A', 1),
    await mk('https://news.test/a', 'Story A again', 0),
    await mk('https://blog.test/z', 'Post Z', 2),
  ];
  const first = await db.putVisits(recs, { assignLocalSeq: true });
  assert.equal(first.added, 3);

  const second = await db.putVisits(recs, { assignLocalSeq: true });
  assert.equal(second.added, 0, 're-writing the same visits must be a no-op');

  assert.equal(await db.countStore('visits'), 3);
  assert.equal(await db.countStore('pages'), 2);

  const conn = await db.openDb();
  const hash = await record.urlHash('https://news.test/a');
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page.visitCount, 2);
  assert.equal(page.title, 'Story A again', 'title tracks the most recent visit');
  assert.equal(page.firstSeen, base - day);
  assert.equal(page.lastSeen, base);
});

await test('localSeq is assigned locally and withheld on import', async () => {
  const imported = await mk('https://other.test/p', 'From B', 3, 'devB');
  await db.putVisits([imported], { assignLocalSeq: false });

  const conn = await db.openDb();
  const row = await db.reqToPromise(conn.transaction('visits').objectStore('visits').get(imported.id));
  assert.equal(row.localSeq, undefined);
  assert.equal(row.deviceId, 'devB');

  // The localSeq index must therefore contain only this device's records.
  const seen = [];
  await db.cursorEach(
    conn.transaction('visits').objectStore('visits').index('localSeq'),
    null,
    'next',
    (v) => void seen.push(v.deviceId),
  );
  assert.deepEqual([...new Set(seen)], [DEVICE]);
  assert.equal(seen.length, 3);
});

await test('an imported record carrying a poisoned localSeq has it stripped, not kept', async () => {
  // A hand-edited or corrupted shard line could include a localSeq field. If putVisits
  // kept it, this device would believe it already exported that sequence number and
  // stop exporting its own future visits — a permanent, silent sync failure.
  const poisoned = await mk('https://poisoned.test/p', 'Poisoned', 4, 'devB');
  poisoned.localSeq = Number.MAX_SAFE_INTEGER;
  await db.putVisits([poisoned], { assignLocalSeq: false });

  const conn = await db.openDb();
  const row = await db.reqToPromise(conn.transaction('visits').objectStore('visits').get(poisoned.id));
  assert.equal(row.localSeq, undefined);

  // Remove it again so downstream tests' absolute row counts stay valid.
  await db.deleteVisit(poisoned.id);
});

await test('putVisits fills a blank page title from an older out-of-order visit', async () => {
  // A backfill or a peer shard can deliver an older visit after a newer, still-titleless
  // one is already on record. Only the >= lastSeen branch used to adopt a title, so the
  // rollup stayed blank forever in this order even though a title was available.
  const newer = await mk('https://outoforder.test/p', '', 30);
  await db.putVisits([newer], { assignLocalSeq: true });
  const older = await mk('https://outoforder.test/p', 'Older Title', 31);
  await db.putVisits([older], { assignLocalSeq: true });

  const hash = await record.urlHash('https://outoforder.test/p');
  const conn = await db.openDb();
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page.title, 'Older Title');
  assert.equal(page.firstSeen, base - 31 * day);
  assert.equal(page.lastSeen, base - 30 * day);

  await db.deletePage(hash); // net zero for downstream absolute counts
});

await test('deleteVisit recomputes firstSeen/lastSeen when the deleted visit was a boundary', async () => {
  const url = 'https://boundary.test/p';
  const oldest = await mk(url, 'Old', 40);
  const middle = await mk(url, '', 39);
  const newest = await mk(url, '', 38);
  await db.putVisits([oldest, middle, newest], { assignLocalSeq: true });

  const hash = await record.urlHash(url);
  await db.deleteVisit(newest.id); // removes the current lastSeen boundary

  const conn = await db.openDb();
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page.lastSeen, base - 39 * day, 'must fall back to what remains, not the deleted visit');
  assert.equal(page.firstSeen, base - 40 * day, 'the untouched boundary is left alone');

  await db.deletePage(hash); // net zero for downstream absolute counts
});

await test('deleteVisit decrements the rollup and removes empty pages', async () => {
  const hash = await record.urlHash('https://blog.test/z');
  const id = record.visitId(hash, base - 2 * day);
  assert.equal(await db.deleteVisit(id), true);
  assert.equal(await db.deleteVisit(id), false);

  const conn = await db.openDb();
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page, undefined, 'page row goes away with its last visit');
  assert.equal(await db.countStore('visits'), 3);
});

console.log('\nsearch.js');

await test('results come back newest first', async () => {
  const { rows } = await search.query({ limit: 10 });
  const times = rows.map((r) => r.visitTime);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.equal(rows.length, 3);
});

await test('all search terms must match, across title and URL', async () => {
  assert.equal((await search.query({ text: 'story' })).rows.length, 2);
  assert.equal((await search.query({ text: 'news.test' })).rows.length, 2);
  assert.equal((await search.query({ text: 'story nonexistent' })).rows.length, 0);
  assert.equal((await search.query({ text: 'STORY' })).rows.length, 2, 'case-insensitive');
});

await test('host and date filters narrow correctly', async () => {
  assert.equal((await search.query({ host: 'news.test' })).rows.length, 2);
  assert.equal((await search.query({ host: 'nope.test' })).rows.length, 0);
  const recent = await search.query({ from: base - day / 2, to: base + day });
  assert.equal(recent.rows.length, 1);
});

await test('pagination reports hasMore and does not repeat rows', async () => {
  const p0 = await search.query({ limit: 2, offset: 0 });
  const p1 = await search.query({ limit: 2, offset: 2 });
  assert.equal(p0.hasMore, true);
  assert.equal(p1.hasMore, false);
  assert.equal(p1.rows.length, 1);
  const ids = new Set([...p0.rows, ...p1.rows].map((r) => r.id));
  assert.equal(ids.size, 3);
});

await test('stats summarise the archive', async () => {
  const s = await search.stats();
  assert.equal(s.visits, 3);
  assert.equal(s.pages, 2);
  assert.equal(s.oldest, base - 3 * day);
  assert.equal(s.newest, base);
  assert.equal(s.topHosts[0].host, 'news.test');
  const devices = await search.deviceBreakdown();
  assert.deepEqual(devices.map((d) => d.id).sort(), ['devA', 'devB']);
});

console.log('\nblocklist.js');

await test('domain, wildcard and regex patterns all match', () => {
  const rules = blocklist.compile([
    'bank.test',
    '*.internal.test',
    String.raw`/\/secret\//i`,
    '# a comment',
  ]);
  const hit = (url) => rules.some((r) => r.test(url, new URL(url).hostname));

  assert.equal(hit('https://bank.test/x'), true);
  assert.equal(hit('https://login.bank.test/x'), true, 'subdomains included');
  assert.equal(hit('https://notbank.test/x'), false, 'suffix must be on a label boundary');
  assert.equal(hit('https://internal.test/x'), false, 'wildcard excludes the apex');
  assert.equal(hit('https://vpn.internal.test/x'), true);
  assert.equal(hit('https://any.test/SECRET/file'), true);
  assert.equal(hit('https://any.test/public'), false);
});

await test('a malformed regex is ignored, not fatal', () => {
  const rules = blocklist.compile(['/[unclosed/', 'ok.test']);
  assert.equal(rules.length, 1);
});

await test('a pattern with a scheme, path, or port can never match hostOf() and is skipped', () => {
  const rules = blocklist.compile([
    'https://mybank.example',
    'mybank.example/statements',
    'mybank.example:8443',
    '/admin', // one leading slash only — not a full /regex/flags pair
    'ok.test',
  ]);
  assert.equal(rules.length, 1, 'only the syntactically-valid bare host compiles');
  assert.equal(rules[0].raw, 'ok.test');
});

await test('blocklist patterns are punycode- and case-normalised, same as hostOf()', () => {
  const rules = blocklist.compile(['MyBank.Example', 'MÜNCHEN.de']);
  const hit = (url) => rules.some((r) => r.test(url, new URL(url).hostname));
  assert.equal(hit('https://mybank.example/x'), true, 'case must not matter');
  assert.equal(
    hit('https://xn--mnchen-3ya.de/x'),
    true,
    'a Unicode pattern must match the punycode Chrome reports for the same host',
  );
});

await test('purge deletes what the patterns would have excluded', async () => {
  await blocklist.setPatterns(['news.test']);
  const result = await blocklist.purgeMatching();
  assert.equal(result.pages, 1);
  assert.equal(result.visits, 2);
  assert.equal(await db.countStore('visits'), 1);
  assert.equal(await db.countStore('pages'), 1);
  await blocklist.setPatterns([]);
});

console.log('\nsync merge semantics');

await test('NDJSON round-trip through forExport/isValidRecord', async () => {
  const rec = await mk('https://round.test/trip', 'Trip', 0);
  rec.localSeq = 99;
  const line = JSON.stringify(record.forExport(rec));
  const parsed = JSON.parse(line);
  assert.equal(parsed.localSeq, undefined, 'local sequence never leaves the device');
  assert.equal(record.isValidRecord(parsed), true);
});

await test('tampered or truncated records are rejected on import', () => {
  assert.equal(record.isValidRecord({ id: 'x:1', url: 'u', urlHash: 'y', visitTime: 1 }), false);
  assert.equal(record.isValidRecord({}), false);
  assert.equal(record.isValidRecord(null), false);
});

await test('isValidRecord rejects fractional times, unarchivable schemes, and oversized titles', async () => {
  const hash = await record.urlHash('https://x.test/');
  const fields = { url: 'https://x.test/', urlHash: hash, host: 'x.test', title: '' };

  assert.equal(
    record.isValidRecord({ ...fields, id: `${hash}:1.5`, visitTime: 1.5 }),
    false,
    'a non-integer visitTime bypasses normaliseTime rounding, which is half the dedupe key',
  );

  const jsHash = await record.urlHash('javascript:alert(1)');
  assert.equal(
    record.isValidRecord({ url: 'javascript:alert(1)', urlHash: jsHash, host: '', title: '', id: `${jsHash}:1`, visitTime: 1 }),
    false,
    'a non-archivable scheme must not reach putVisits — dashboard.js renders url as a clickable href',
  );

  assert.equal(
    record.isValidRecord({ ...fields, id: `${hash}:1`, visitTime: 1, title: 'x'.repeat(501) }),
    false,
    'an unbounded title is concatenated into the fuzzy-search haystack on every keystroke',
  );
});

await test('urlHashMatches rejects a hash that was not actually derived from the url', async () => {
  const real = await mk('https://real.test/page', 'Real', 0);
  assert.equal(await record.urlHashMatches(real), true);

  const spoofed = { ...real, url: 'https://evil.test/phish' };
  assert.equal(
    await record.urlHashMatches(spoofed),
    false,
    'isValidRecord alone only checks the record is internally consistent — this catches a ' +
      'shard line claiming a benign hash for a different url',
  );
});

await test('importing the same shard twice adds nothing the second time', async () => {
  const shard = [
    await mk('https://shared.test/1', 'One', 5, 'devB'),
    await mk('https://shared.test/2', 'Two', 6, 'devB'),
  ].map((r) => JSON.stringify(r));

  const parse = (lines) => lines.map((l) => JSON.parse(l)).filter(record.isValidRecord);

  const first = await db.putVisits(parse(shard), { assignLocalSeq: false });
  const second = await db.putVisits(parse(shard), { assignLocalSeq: false });
  assert.equal(first.added, 2);
  assert.equal(second.added, 0);
});

await test('a partial trailing line is left unconsumed', () => {
  // Mirrors the byte handling in sync.js importAll().
  const text = '{"a":1}\n{"b":2}\n{"c":3';
  const bytes = new TextEncoder().encode(text);
  const lastNewline = bytes.lastIndexOf(0x0a);
  const complete = new TextDecoder().decode(bytes.subarray(0, lastNewline + 1));
  assert.equal(complete, '{"a":1}\n{"b":2}\n');
  assert.equal(lastNewline + 1, 16, 'offset advances only past whole lines');
});

await test('importFromFile filters blocked hosts and hash/url mismatches, not just malformed JSON', async () => {
  const good = await mk('https://imported.test/ok', 'OK', 50, 'devB');
  const blockedRec = await mk('https://blocked.test/x', 'Blocked', 50, 'devB');

  // Claims a foreign hash for its url — id is recomputed so it still passes the
  // internal-consistency check inside isValidRecord; only urlHashMatches catches this.
  const spoofed = await mk('https://spoofed.test/x', 'Spoofed', 50, 'devB');
  spoofed.urlHash = await record.urlHash('https://someone-else.test/');
  spoofed.id = record.visitId(spoofed.urlHash, spoofed.visitTime);

  await blocklist.setPatterns(['blocked.test']);
  const lines = [good, blockedRec, spoofed].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = { name: 'peer.ndjson', text: async () => lines };

  const result = await sync.importFromFile(file);
  assert.equal(result.added, 1, 'only the untampered, unblocked record is actually imported');
  assert.equal(result.total, 1, 'total reflects what passed validation, not the raw line count');

  const conn = await db.openDb();
  const store = conn.transaction('visits').objectStore('visits');
  assert.ok(await db.reqToPromise(store.get(good.id)), 'the good record made it in');
  assert.equal(await db.reqToPromise(store.get(blockedRec.id)), undefined, 'blocked host was filtered');
  assert.equal(await db.reqToPromise(store.get(spoofed.id)), undefined, 'hash/url mismatch was rejected');

  await blocklist.setPatterns([]);
  await db.deleteVisit(good.id); // net zero for downstream absolute counts
});

console.log('\nfuzzy search');

// A fresh set of pages, seeded last so the absolute counts asserted above stay valid.
const fuzzyPages = [
  ['https://github.com/anthropics/claude-code', 'GitHub - anthropics/claude-code', 3],
  ['https://gitlab.com/foo/bar', 'GitLab foo/bar', 1],
  ['https://docs.python.org/3/library/asyncio.html', 'asyncio — Asynchronous I/O', 2],
  ['https://news.ycombinator.com/item?id=1', 'Hacker News discussion', 1],
];
for (const [url, title, visits] of fuzzyPages) {
  const recs = [];
  for (let i = 0; i < visits; i++) recs.push(await mk(url, title, 10 + i));
  await db.putVisits(recs, { assignLocalSeq: true });
}
search.invalidatePageCache();

const topHit = async (text) => (await search.relevanceQuery({ text })).rows[0];

await test('exact substring matches', async () => {
  const hit = await topHit('github');
  assert.match(hit.url, /github\.com/);
});

await test('subsequence matches, ranked by how tightly it fits', async () => {
  // "gthb" is a subsequence of both github.com and (loosely, spanning the whole URL)
  // gitlab.com. The compact one must win.
  const { rows } = await search.relevanceQuery({ text: 'gthb' });
  assert.ok(rows.length >= 1);
  assert.match(rows[0].url, /github\.com/);
  const gitlab = rows.findIndex((r) => r.url.includes('gitlab'));
  assert.ok(gitlab === -1 || gitlab > 0, 'the loose match must not outrank the tight one');
});

await test('a typo still finds the page', async () => {
  // "pythom" is not a substring, and its 'm' appears nowhere in the haystack, so the
  // cheap tiers all fail — only the edit-distance pass can rescue it.
  const hit = await topHit('pythom');
  assert.ok(hit, 'expected the typo pass to produce a hit');
  assert.match(hit.url, /docs\.python\.org/);
});

await test('every token must still match', async () => {
  assert.equal((await search.relevanceQuery({ text: 'github anthropics' })).rows.length, 1);
  assert.equal((await search.relevanceQuery({ text: 'github zzzzqqqq' })).rows.length, 0);
});

await test('relevance returns one row per page, with its visit count', async () => {
  const { rows } = await search.relevanceQuery({ text: 'claude-code' });
  assert.equal(rows.length, 1, 'three visits to one page collapse to a single row');
  assert.equal(rows[0].visitCount, 3);
  assert.ok(rows[0].urlHash, 'relevance rows are keyed by page for whole-page delete');
});

await test('relevance and chronological paths agree on what matches', async () => {
  const relevance = await search.relevanceQuery({ text: 'github' });
  const chronological = await search.query({ text: 'github' });

  // Both paths run the same matcher. On this tiny corpus the cheap pass finds only
  // github.com, so the typo pass also runs and pulls in gitlab.com — "github" and
  // "gitlab" are two edits apart.
  assert.equal(relevance.rows.length, 2);
  assert.match(relevance.rows[0].url, /github\.com/, 'the exact match outranks the typo');
  assert.match(relevance.rows[1].url, /gitlab\.com/);

  assert.equal(chronological.rows.length, 4, '3 github visits plus 1 gitlab visit');
  const times = chronological.rows.map((r) => r.visitTime);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

await test('host filter still applies to fuzzy results', async () => {
  assert.equal((await search.relevanceQuery({ text: 'git', host: 'gitlab.com' })).rows.length, 1);
  assert.equal((await search.relevanceQuery({ text: 'git', host: 'nope.test' })).rows.length, 0);
});

await test('empty query returns nothing rather than everything', async () => {
  assert.deepEqual((await search.relevanceQuery({ text: '   ' })).rows, []);
});

await test('bounded edit distance stops counting past the limit', () => {
  const { boundedEditDistance } = fuzzy;
  assert.equal(boundedEditDistance('github', 'github', 2), 0);
  assert.equal(boundedEditDistance('githbu', 'github', 2), 2, 'transposition costs two');
  assert.equal(boundedEditDistance('pythom', 'python', 1), 1);
  assert.equal(boundedEditDistance('cat', 'elephant', 2), 3, 'reports maxDist + 1 once exceeded');
  assert.equal(boundedEditDistance('', 'abc', 2), 3);
});

console.log('\ntitle repair');

// Seeded last, like the fuzzy pages, so the absolute counts asserted earlier hold.

await test('a missing title is filled in without adding a visit', async () => {
  const blank = await mk('https://youtube.test/watch?v=1', '', 20);
  assert.equal((await db.putVisits([blank], { assignLocalSeq: true })).added, 1);

  const conn = await db.openDb();
  const read = () => db.reqToPromise(conn.transaction('visits').objectStore('visits').get(blank.id));
  const seqBefore = (await read()).localSeq;

  // What the sweep reads back once Chrome has learned the title.
  const titled = await mk('https://youtube.test/watch?v=1', 'Some Video', 20);
  const result = await db.putVisits([titled], { assignLocalSeq: true });
  assert.equal(result.added, 0, 'the visit itself already exists');
  assert.equal(result.titled, 1);

  const visit = await read();
  assert.equal(visit.title, 'Some Video');
  assert.ok(visit.localSeq > seqBefore, 'the repair goes back into the export delta');

  const hash = await record.urlHash('https://youtube.test/watch?v=1');
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page.title, 'Some Video', 'the rollup search reads from is repaired too');
});

await test('a title that merely changed is left alone', async () => {
  const first = await mk('https://mail.test/inbox', 'Inbox', 21);
  await db.putVisits([first], { assignLocalSeq: true });

  const conn = await db.openDb();
  const read = () => db.reqToPromise(conn.transaction('visits').objectStore('visits').get(first.id));
  const seqBefore = (await read()).localSeq;

  // An unread counter in the title would otherwise rewrite this row on every sweep,
  // so the export delta would never drain.
  const noisy = await mk('https://mail.test/inbox', '(3) Inbox', 21);
  assert.equal((await db.putVisits([noisy], { assignLocalSeq: true })).titled, 0);

  const visit = await read();
  assert.equal(visit.title, 'Inbox');
  assert.equal(visit.localSeq, seqBefore);
});

await test('backfillTitle repairs every blank visit to a URL', async () => {
  const url = 'https://youtube.test/watch?v=2';
  const recs = [await mk(url, '', 22), await mk(url, '', 23)];
  await db.putVisits(recs, { assignLocalSeq: true });

  const hash = await record.urlHash(url);
  assert.equal(await db.backfillTitle(hash, 'Second Video'), 2);
  assert.equal(await db.backfillTitle(hash, 'Second Video'), 0, 'nothing left to repair');

  const conn = await db.openDb();
  for (const rec of recs) {
    const visit = await db.reqToPromise(conn.transaction('visits').objectStore('visits').get(rec.id));
    assert.equal(visit.title, 'Second Video');
  }
  const page = await db.reqToPromise(conn.transaction('pages').objectStore('pages').get(hash));
  assert.equal(page.title, 'Second Video');
});

await test('repairing an imported record does not enlist it for export', async () => {
  const blank = await mk('https://other.test/quiet', '', 24, 'devB');
  await db.putVisits([blank], { assignLocalSeq: false });

  const repaired = await db.putVisits([{ ...blank, title: 'Quiet' }], { assignLocalSeq: true });
  assert.equal(repaired.titled, 1);

  const conn = await db.openDb();
  const visit = await db.reqToPromise(conn.transaction('visits').objectStore('visits').get(blank.id));
  assert.equal(visit.title, 'Quiet');
  assert.equal(visit.localSeq, undefined, 'only locally captured visits ever carry localSeq');

  assert.equal(await db.backfillTitle(await record.urlHash('https://other.test/quiet'), 'Louder'), 0);
});

console.log('\npage text');

const TEXT = 'The mitochondrion is the powerhouse of the cell. Mitochondria generate ATP.';

// A snippet is segments, not a string, so the dashboard can emphasise hits without
// putting archived page text through innerHTML.
const snippetText = (row) => (row.snippet || []).map((part) => part.text).join('');
const highlighted = (row) => (row.snippet || []).filter((p) => p.hit).map((p) => p.text);
const titleText = (row) => (row.titleParts || []).map((part) => part.text).join('');
const titleMarks = (row) => (row.titleParts || []).filter((p) => p.hit).map((p) => p.text);

await test('tokenise dedupes, bounds length, and keeps the most frequent past the cap', () => {
  const tokens = content.tokenise('alpha alpha beta! beta beta a ' + 'x'.repeat(40));
  // Order is irrelevant to a multiEntry index, so terms come back as first seen.
  assert.deepEqual(tokens, ['alpha', 'beta']);
  assert.ok(!tokens.includes('a'), 'single characters are not terms');
  assert.ok(!tokens.some((t) => t.length > 32), 'over-long runs are not terms');

  const many = content.tokenise(
    Array.from({ length: 900 }, (_, i) => `term${i}`).join(' ') + ' winner'.repeat(50),
  );
  assert.equal(many.length, content.MAX_TOKENS);
  assert.equal(many[0], 'winner', 'the cap keeps what the page is actually about');
});

await test('tokenise does not shred non-Latin script', () => {
  assert.deepEqual(content.tokenise('日本語 テスト'), ['日本語', 'テスト']);
});

await test('gzip round-trips, including non-ASCII', async () => {
  const original = TEXT + ' — naïve café 日本語';
  const bytes = await content.gzip(original);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(await content.gunzip(bytes), original);
});

await test('normaliseText collapses layout and applies the cap', () => {
  assert.equal(content.normaliseText('  a\n\n  b \t c '), 'a b c');
  assert.equal(content.normaliseText('x'.repeat(200_000)).length, content.MAX_TEXT_CHARS);
});

// The content path is only reachable once the feature is switched on; everything above
// this line ran with it off, which is the state an updating user is in.
await db.setMeta('contentEnabled', true);
await db.setMeta('contentStoreExists', true);
search.invalidatePageCache();

const CELL_URL = 'https://bio.test/organelles';
const DECOY_URL = 'https://bio.test/atp-glossary';
const cellHash = await record.urlHash(CELL_URL);
const decoyHash = await record.urlHash(DECOY_URL);

await db.putVisits([await mk(CELL_URL, 'Organelles', 1)], { assignLocalSeq: true });
await db.putVisits([await mk(DECOY_URL, 'ATP glossary', 1)], { assignLocalSeq: true });
await db.putContent(cellHash, CELL_URL, TEXT);
await db.putContent(decoyHash, DECOY_URL, 'A glossary of terms with no organelle detail.');
search.invalidatePageCache();

await test('a snippet is wide enough to read and marks every hit in the window', () => {
  const prose =
    'Chapter one. '.repeat(20) +
    'The kestrel hovered above the meadow. ' +
    'Filler sentence. '.repeat(40) +
    'A second kestrel appeared.';
  const parts = content.snippetAround(prose, ['kestrel']);
  const text = parts.map((p) => p.text).join('');

  // Wide enough that the sentence around the match survives, and led into rather than
  // started on, so the match reads in context.
  assert.ok(text.length > 300, `expected a wide excerpt, got ${text.length}`);
  assert.ok(text.includes('hovered above the meadow'));
  assert.ok(text.startsWith('…'), 'a window taken from mid-document says so');
  assert.ok(parts.some((p) => p.hit && p.text === 'kestrel'));

  // Segments reassemble into a contiguous slice — no character duplicated or dropped.
  assert.ok(prose.includes(text.replace(/…/g, '')));
});

await test('overlapping terms highlight once, not twice', () => {
  const parts = content.snippetAround('the mitochondrion matters', ['mito', 'chondrion']);
  assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['mitochondrion']);
});

await test('a term the text cap cut still yields a readable head', () => {
  const parts = content.snippetAround('some stored prose', ['absent']);
  assert.deepEqual(parts, [{ text: 'some stored prose', hit: false }]);
  assert.deepEqual(content.snippetAround('', ['x']), []);
});

await test('putContent skips a still-fresh capture and replaces a stale one', async () => {
  assert.equal(await db.putContent(cellHash, CELL_URL, 'newer text'), false);
  assert.equal(await db.getContentText(cellHash), content.normaliseText(TEXT));

  const stale = Date.now() + 60 * 86_400_000;
  assert.equal(await db.putContent(cellHash, CELL_URL, TEXT + ' Revised.', stale), true);
  assert.ok((await db.getContentText(cellHash)).endsWith('Revised.'));
  await db.putContent(cellHash, CELL_URL, TEXT, stale + 60 * 86_400_000);
});

await test('a thumbnail lands on a row captured before thumbnails existed', async () => {
  const THUMB = 'data:image/webp;base64,AAAA';
  // The row is still fresh, so no re-capture happens — the thumbnail is patched in on
  // its own, which is what keeps pre-existing rows from staying blank for a whole TTL.
  assert.equal(await db.putContent(cellHash, CELL_URL, TEXT, undefined, { thumb: THUMB }), false);

  const thumbs = await db.getThumbs([cellHash, decoyHash]);
  assert.equal(thumbs.get(cellHash), THUMB);
  assert.ok(!thumbs.has(decoyHash), 'a page with no thumbnail is absent, not blank');
  assert.equal(await db.getContentText(cellHash), content.normaliseText(TEXT), 'text untouched');
});

await test('a term only in the page text finds the page', async () => {
  const { rows } = await search.relevanceQuery({ text: 'powerhouse' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, CELL_URL);
  assert.ok(snippetText(rows[0]).includes('powerhouse'), 'the row says why it matched');
  assert.deepEqual(highlighted(rows[0]), ['powerhouse'], 'and shows which word did it');
});

await test('a title hit is marked, and the label still reads whole', async () => {
  const { rows } = await search.relevanceQuery({ text: 'organelles' });
  const hit = rows.find((r) => r.url === CELL_URL);
  assert.deepEqual(titleMarks(hit), ['Organelles']);
  // Segments must reassemble into exactly the label, or the row renders mangled text.
  assert.equal(titleText(hit), 'Organelles');
});

await test('a typo in the query marks the word it was rescued to', async () => {
  // The user typed neither of these; the typo tier found them. Emphasising what they
  // literally typed would highlight nothing at all.
  const { rows } = await search.relevanceQuery({ text: 'organellez' });
  const hit = rows.find((r) => r.url === CELL_URL);
  assert.ok(hit, 'the typo still matched');
  assert.deepEqual(titleMarks(hit), ['Organelles']);
});

await test('a subsequence match marks nothing rather than scattering', async () => {
  // 'ognls' matches "Organelles" by subsequence. Lighting up five separated letters
  // reads as corrupted text, so the title is left plain.
  const { rows } = await search.relevanceQuery({ text: 'ognls' });
  const hit = rows.find((r) => r.url === CELL_URL);
  assert.ok(hit, 'subsequence still matches, it just is not highlighted');
  assert.deepEqual(titleMarks(hit), []);
  assert.equal(titleText(hit), 'Organelles');
});

await test('a page with no title marks the url standing in for it', async () => {
  const url = 'https://untitled.test/annual-report';
  await db.putVisits([await mk(url, '', 5)], { assignLocalSeq: true });
  search.invalidatePageCache();

  const { rows } = await search.relevanceQuery({ text: 'annual' });
  const hit = rows.find((r) => r.url === url);
  assert.deepEqual(titleMarks(hit), ['annual']);
  assert.equal(titleText(hit), url);
  await db.deletePage(await record.urlHash(url));
  search.invalidatePageCache();
});

await test('time-ordered rows carry the same emphasis, and none without a query', async () => {
  const withText = await search.query({ text: 'organelles' });
  const hit = withText.rows.find((r) => r.url === CELL_URL);
  assert.deepEqual(titleMarks(hit), ['Organelles']);

  // Plain browsing pays for none of this.
  const browsing = await search.query({ limit: 5 });
  assert.ok(browsing.rows.every((r) => r.titleParts === null));
});

await test('a title match outranks a page that merely mentions the word', async () => {
  const { rows } = await search.relevanceQuery({ text: 'atp' });
  assert.equal(rows[0].url, DECOY_URL, 'ATP is in one title and the other page body');
  assert.ok(rows.some((r) => r.url === CELL_URL));
  assert.ok(rows[0].score > rows.find((r) => r.url === CELL_URL).score);
});

await test('a mistyped term is rescued through the term dictionary', async () => {
  const { rows } = await search.relevanceQuery({ text: 'mitochondrian' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, CELL_URL);
});

await test('AND holds across the two lanes', async () => {
  // "organelles" only in the title, "powerhouse" only in the text.
  const both = await search.relevanceQuery({ text: 'organelles powerhouse' });
  assert.equal(both.rows.length, 1);
  assert.equal(both.rows[0].url, CELL_URL);

  const missing = await search.relevanceQuery({ text: 'organelles ribosome' });
  assert.equal(missing.rows.length, 0, 'a token matching in neither lane still fails');
});

await test('short tokens do not drag the corpus in through prefix matching', async () => {
  // A prefix range on one or two characters covers most of the vocabulary, so page text
  // is skipped below the minimum term length. A snippet is only ever set from a content
  // hit, which makes it the honest witness here — the title/URL lane still matches short
  // tokens by subsequence, exactly as it did before any of this.
  const long = await search.relevanceQuery({ text: 'mit' });
  const hit = long.rows.find((r) => r.url === CELL_URL);
  assert.ok(hit && snippetText(hit).includes('itochondri'), 'three characters reach the text');
  // Widened to the whole word: highlighting just the "mit" of "mitochondrion" would read
  // as a rendering bug rather than as an answer.
  assert.deepEqual(highlighted(hit), ['mitochondrion', 'Mitochondria']);

  const short = await search.relevanceQuery({ text: 'mi' });
  const skipped = short.rows.find((r) => r.url === CELL_URL);
  assert.ok(!skipped || !skipped.snippet, 'two characters do not');
});

await test('deleting a page takes its text with it', async () => {
  const url = 'https://bio.test/doomed';
  const hash = await record.urlHash(url);
  await db.putVisits([await mk(url, 'Doomed', 2)], { assignLocalSeq: true });
  await db.putContent(hash, url, 'Ephemeral body text about lysosomes.');
  assert.ok(await db.getContentText(hash));

  await db.deletePage(hash);
  assert.equal(await db.getContentText(hash), null);
});

await test('deleteVisit drops the text only when the last visit goes', async () => {
  const url = 'https://bio.test/twice';
  const hash = await record.urlHash(url);
  const first = await mk(url, 'Twice', 3);
  const second = await mk(url, 'Twice', 4);
  await db.putVisits([first, second], { assignLocalSeq: true });
  await db.putContent(hash, url, 'Body text about vacuoles.');

  await db.deleteVisit(first.id);
  assert.ok(await db.getContentText(hash), 'a page still in the archive keeps its text');
  await db.deleteVisit(second.id);
  assert.equal(await db.getContentText(hash), null);
});

await test('eviction drops the least recently captured first', async () => {
  const before = (await db.contentStats()).rows;
  await db.putContent('aaaaaaaaaaaaaaaa', 'https://evict.test/old', 'oldest text here', 1000);
  await db.putContent('bbbbbbbbbbbbbbbb', 'https://evict.test/new', 'newest text here', 9_000_000_000_000);

  assert.equal(await db.evictContent(before + 2), 0, 'under budget removes nothing');
  assert.equal(await db.evictContent(before + 1), 1);
  assert.equal(await db.getContentText('aaaaaaaaaaaaaaaa'), null);
  assert.ok(await db.getContentText('bbbbbbbbbbbbbbbb'));
  await db.deleteContent('bbbbbbbbbbbbbbbb');
});

await test('the archive database is untouched by any of this', async () => {
  // The whole point of a second database: an older build hardcodes DB_VERSION = 1 and
  // would fail to open the archive at all if this feature had bumped it.
  assert.equal(db.DB_VERSION, 1);
  const handle = await db.openDb();
  assert.equal(handle.version, 1);
  assert.ok(!handle.objectStoreNames.contains('content'));
  assert.deepEqual([...handle.objectStoreNames].sort(), [
    'backfill', 'imports', 'meta', 'pages', 'visits',
  ]);
});

await test('clearContent empties the text index without touching history', async () => {
  const pagesBefore = await db.countStore('pages');
  await db.clearContent();
  assert.equal((await db.contentStats()).rows, 0);
  assert.equal(await db.countStore('pages'), pagesBefore);

  search.invalidatePageCache();
  const { rows } = await search.relevanceQuery({ text: 'organelles' });
  assert.equal(rows.length, 1, 'title search still works with no text indexed at all');
});

await test('switching capture off leaves stored text searchable', async () => {
  // contentEnabled governs capture only. Text already stored goes away when the user
  // forgets it, not when they stop collecting more.
  await db.putContent(cellHash, CELL_URL, TEXT, Date.now() + 400 * 86_400_000);
  await db.setMeta('contentEnabled', false);
  search.invalidatePageCache();

  const { rows } = await search.relevanceQuery({ text: 'powerhouse' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, CELL_URL);
});

await test('a content shard is invisible to the visit importer', async () => {
  // An older build takes every .ndjson in the folder that is not its own. If content
  // shards ended in .ndjson it would download each one whole, reject every line, and
  // bookmark it — forever. The extension is what keeps them out of its way.
  const visitShardFilter = (name) => name.endsWith('.ndjson');
  assert.equal(visitShardFilter('devB-content-001.jsonl'), false);
  assert.equal(visitShardFilter('devB-2026-01.ndjson'), true);
});

const peerLine = async (url, text, capturedAt = 1_700_000_000_000) => ({
  urlHash: await record.urlHash(url),
  url,
  capturedAt,
  gz: content.toBase64(await content.gzip(text)),
});

await test('an exported content line carries the url its hash came from', async () => {
  // Without the url on the row, every exported line would reach a peer with url '' and be
  // rejected by the trust boundary — a sync that silently transfers nothing.
  const pending = await db.contentToExport(0, 100);
  assert.ok(pending.length > 0);
  for (const row of pending) {
    assert.equal(typeof row.url, 'string');
    assert.equal(row.urlHash, await record.urlHash(row.url));
  }
});

await test('a peer content line round-trips through the shard format', async () => {
  const url = 'https://peer.test/article';
  const body = 'Distributed consensus needs a quorum. Paxos and Raft both use one.';
  assert.equal(await sync.mergeContentLine(await peerLine(url, body)), true);

  const hash = await record.urlHash(url);
  assert.equal(await db.getContentText(hash), body);

  // The page has no visit here yet, so it is searchable the moment its visit arrives.
  await db.putVisits([await mk(url, 'Consensus', 1)], { assignLocalSeq: true });
  search.invalidatePageCache();
  const { rows } = await search.relevanceQuery({ text: 'quorum' });
  assert.ok(rows.some((r) => r.url === url));
});

await test("imported text is never re-exported under this device's name", async () => {
  // Invariant 3, applied to page text: exportAt is absent on a peer's row, and IndexedDB
  // omits a record missing an indexed property, so the export index cannot see it.
  const peerHash = await record.urlHash('https://peer.test/article');
  const pending = await db.contentToExport(0, 100);
  assert.ok(pending.length > 0, 'locally captured text is queued');
  assert.ok(!pending.some((row) => row.urlHash === peerHash), 'a peer row is not');
  assert.ok(pending.every((row) => row.exportAt !== undefined));
});

await test('the content trust boundary rejects what the visit boundary would', async () => {
  const good = await peerLine('https://peer.test/ok', 'ordinary body text');

  // A hash that was not derived from this URL would land the text on another page.
  assert.equal(await sync.mergeContentLine({ ...good, urlHash: 'f'.repeat(16) }), false);
  // Schemes the archive never stores.
  assert.equal(
    await sync.mergeContentLine(await peerLine('javascript:alert(1)', 'x').catch(() => ({}))),
    false,
  );
  // Shape.
  assert.equal(await sync.mergeContentLine({ ...good, capturedAt: 1.5 }), false);
  assert.equal(await sync.mergeContentLine({ ...good, gz: 42 }), false);
  assert.equal(await sync.mergeContentLine(null), false);
  // Size, before anything is decompressed.
  assert.equal(await sync.mergeContentLine({ ...good, gz: 'A'.repeat(300_000) }), false);

  await blocklist.setPatterns(['peer.test']);
  assert.equal(await sync.mergeContentLine(await peerLine('https://peer.test/secret', 'x')), false);
  await blocklist.setPatterns([]);
});

await db.setMeta('contentStoreExists', false);
search.invalidatePageCache();

await test('the requested origins are exactly what the manifest declares', async () => {
  // chrome.permissions.request matches its argument against the manifest literally. A
  // mismatch is not a lint error, it is "Only permissions specified in the manifest may
  // be requested" thrown at the user the first time they tick the box — which is exactly
  // how <all_urls> failed here, Chrome having refused that literal in
  // optional_host_permissions.
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', SRC), 'utf8'));

  assert.deepEqual(manifest.optional_host_permissions, content.TEXT_ORIGINS);
  assert.ok(!JSON.stringify(manifest.optional_host_permissions).includes('all_urls'));
  // `scripting` is what makes chrome.scripting exist at all; without it the worker throws
  // at module scope and takes every other listener down with it.
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.host_permissions, 'host access stays optional, never required');
});

console.log('\nservice worker');

await test('the worker evaluates against documented chrome APIs only', async () => {
  // Every listener is registered at module scope, so reaching for a chrome.* API that
  // does not exist is not a missing feature — it is a TypeError that aborts module
  // evaluation and silently unregisters onVisited with it, capturing nothing at all.
  // The stub below is deliberately exhaustive: it carries what the API reference says
  // exists and not one property more, so an invented API throws here instead of in
  // someone's browser.
  const event = () => ({ addListener() {} });
  Object.assign(globalThis.chrome, {
    alarms: {
      onAlarm: event(),
      async getAll() { return []; },
      create() {},
      async clear() {},
    },
    history: {
      onVisited: event(),
      onVisitRemoved: event(),
      async search() { return []; },
      async getVisits() { return []; },
    },
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    // onUpdated fires without the "tabs" permission; the url field it carries is what
    // the optional <all_urls> grant unlocks.
    tabs: { onUpdated: event() },
    scripting: { async executeScript() { return []; } },
    permissions: {
      async contains() { return false; },
      async request() { return false; },
      onAdded: event(),
      onRemoved: event(),
    },
  });

  await load('background/service-worker.js');
});

console.log(`\n${passed} tests passed\n`);

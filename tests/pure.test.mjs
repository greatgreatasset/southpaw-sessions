// Unit tests for the pure modules (no database, no browser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExport } from '../extension/lib/export.js';
import { parseImportFile } from '../extension/lib/importers/index.js';
import { decodeLz4Block, decodeMozLz4 } from '../extension/lib/importers/lz4.js';
import { parseMySessionsDate } from '../extension/lib/importers/mysessions.js';
import { buildLibrary, buildSessionRows, filterRows, sortRows } from '../extension/lib/library.js';
import { needsCheck, newJob, runChecks } from '../extension/lib/linkcheck/checker.js';
import { parseImgur } from '../extension/lib/linkcheck/imgur.js';
import { contentSignature, fingerprint, normalizeWindows, urlBagSignature } from '../extension/lib/model.js';
import { sanitizeFolder, sanitizeSettings } from '../extension/lib/settings.js';
import { pickBestTitle } from '../extension/lib/titles.js';
import { canonicalize, classify, isMeaningfulUrl, isOpenableUrl } from '../extension/lib/url.js';

const enc = (s) => new TextEncoder().encode(s);
const file = (name, content, lastModified = 1_700_000_000_000) =>
  ({ name, bytes: typeof content === 'string' ? enc(content) : content, lastModified });

test('canonicalize collapses duplicates but keeps route fragments', () => {
  assert.equal(canonicalize('HTTPS://Example.com:443/a/?utm_source=x&b=2&a=1#frag'), 'https://example.com/a?a=1&b=2');
  assert.equal(canonicalize('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalize('https://example.com/x?fbclid=1'), 'https://example.com/x');
  // Hashbang links differ only in the fragment - they must stay distinct.
  assert.notEqual(canonicalize('https://mega.nz/#!abc!key1'), canonicalize('https://mega.nz/#!def!key2'));
  assert.equal(canonicalize('https://app.example/#/inbox/1'), 'https://app.example/#/inbox/1');
  assert.equal(canonicalize('  file:///C:/x.html '), 'file:///C:/x.html');
  assert.equal(canonicalize('not a url'), 'not a url');
});

test('classify routes links to the right checker', () => {
  assert.equal(classify('https://www.youtube.com/watch?v=abcdefghijk'), 'youtube_video');
  assert.equal(classify('https://youtu.be/abcdefghijk'), 'youtube_video');
  assert.equal(classify('https://www.youtube.com/shorts/abcdefghijk'), 'youtube_video');
  assert.equal(classify('https://www.youtube.com/results?search_query=x'), 'youtube_search');
  assert.equal(classify('https://www.youtube.com/@channel'), 'other');
  assert.equal(classify('https://i.imgur.com/abc.png'), 'imgur');
  assert.equal(classify('https://old.reddit.com/r/x'), 'other');
  assert.equal(classify('garbage'), 'other');
});

test('url predicates', () => {
  assert.equal(isOpenableUrl('https://a.b/'), true);
  assert.equal(isOpenableUrl('about:blank'), true);
  assert.equal(isOpenableUrl('about:config'), false);
  assert.equal(isOpenableUrl('file:///C:/x.html'), false);
  assert.equal(isOpenableUrl('javascript:alert(1)'), false);
  assert.equal(isOpenableUrl('data:text/html,hi'), false);
  assert.equal(isMeaningfulUrl('about:newtab'), false);
  assert.equal(isMeaningfulUrl('about:blank'), false);
  assert.equal(isMeaningfulUrl('https://a.b/'), true);
});

test('pickBestTitle prefers the richest non-placeholder title', () => {
  assert.equal(pickBestTitle('Imgur', 'A real caption'), 'A real caption');
  assert.equal(pickBestTitle('Longer real title', 'Short'), 'Longer real title');
  assert.equal(pickBestTitle(null, ''), null);
  assert.equal(pickBestTitle('', 'YouTube'), 'YouTube');
  assert.equal(pickBestTitle('https://a.b/c/d/e/f/g', 'Page'), 'Page');
});

test('normalizeWindows cleans tabs, ids and orphan groups', () => {
  const wins = normalizeWindows([
    {
      label: ' Work ',
      groups: [{ k: 'g1', title: 'A' }, { k: 'g9' }],
      tabs: [
        { url: ' https://a/ ', title: 'A', g: 'g1', t: 'same' },
        { url: 'https://b/', pinned: 1, t: 'same', g: 'gone' },
        { url: '' },
        null,
        { title: 'no url' },
      ],
    },
    null,
    { tabs: [] },
  ]);
  assert.equal(wins.length, 2);
  assert.equal(wins[0].label, 'Work');
  assert.equal(wins[0].tabs.length, 2);
  assert.equal(wins[0].tabs[0].url, 'https://a/');
  assert.notEqual(wins[0].tabs[0].t, wins[0].tabs[1].t, 'duplicate tab ids are re-issued');
  assert.equal(wins[0].tabs[1].pinned, true);
  assert.equal(wins[0].tabs[1].g, undefined, 'tab pointing at an unknown group loses it');
  assert.deepEqual(wins[0].groups, [{ k: 'g1', title: 'A' }]);
  assert.deepEqual(wins[1].tabs, []);
});

test('signatures', () => {
  const a = [{ tabs: [{ url: 'https://a/', title: 'x' }, { url: 'https://b/', title: 'y' }] }];
  const b = [{ tabs: [{ url: 'https://b/', title: 'changed' }] }, { tabs: [{ url: 'https://a/', title: '' }] }];
  assert.notEqual(contentSignature(a), contentSignature(b));
  assert.equal(urlBagSignature(a), urlBagSignature(b));
  assert.equal(fingerprint(' Foo ', 60000 * 5 + 10), fingerprint('foo', 60000 * 5 + 59000));
});

test('MySessions date is day-first, local time', () => {
  const d = new Date(parseMySessionsDate('2/7/2023_21:51'));
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()], [2023, 7, 2, 21, 51]);
  assert.equal(new Date(parseMySessionsDate('12/11/2026_9:05')).getMinutes(), 5);
  assert.equal(parseMySessionsDate('2023-07-02'), null);
  assert.equal(parseMySessionsDate('32/13/2023_1:00'), null);
  assert.equal(parseMySessionsDate(undefined), null);
});

test('import: .mysessions array', async () => {
  const data = [
    {
      title: 'trip', date: '2/7/2023_21:51', urls: [], tabsCount: 3, folderId: 'AAA',
      windows: {
        w1: [{ title: 'One', url: 'https://one/' }, { title: 'Pin&&pinned', url: 'https://pin/' }],
        w2: [{ title: 'Two', url: 'https://two/' }],
        w3: [],
      },
      labels: { w1: 'window 1', w2: 'Reading' },
    },
    { title: '', date: 'bogus', folderId: 'BBB', windows: { w: [{ url: 'https://x/' }, { title: 'no url' }] } },
  ];
  const p = await parseImportFile(file('backup.mysessions', JSON.stringify(data), 123456789));
  assert.equal(p.type, 'mysessions');
  assert.equal(p.sessions.length, 2);
  const [a, b] = p.sessions;
  assert.equal(a.name, 'trip');
  assert.equal(a.originKey, 'mysessions:AAA');
  assert.equal(a.windows.length, 2, 'empty windows are dropped');
  assert.equal(a.windows[0].label, undefined, 'default "window N" labels are dropped');
  assert.equal(a.windows[1].label, 'Reading');
  assert.deepEqual(a.windows[0].tabs[1], { url: 'https://pin/', title: 'Pin', pinned: true });
  assert.equal(b.name, '(untitled)');
  assert.equal(b.createdAt, 123456789, 'unparseable date falls back to the file time');
  assert.equal(b.windows[0].tabs.length, 1);
});

test('import: MySessions-Backup json shares a fingerprint with the .mysessions copy', async () => {
  const arr = [{ title: 'evening reading', date: '12/11/2026_15:48', folderId: 'F1', windows: { w: [{ title: 'a', url: 'https://a/' }] } }];
  const bk = {
    format: 'MySessions-Backup', version: 1, createdAt: '2026-11-12T21:48:20.896Z',
    sessions: [{
      title: 'evening reading (12/11/2026_15:48)--1tabs',
      children: [{ title: 'window 1', children: [{ title: 'a', url: 'https://a/' }] }],
    }],
  };
  const p1 = await parseImportFile(file('x.mysessions', JSON.stringify(arr)));
  const p2 = await parseImportFile(file('mysessions-x.json', JSON.stringify(bk)));
  assert.equal(p2.type, 'mysessions-backup');
  assert.equal(p2.sessions[0].name, 'evening reading');
  assert.equal(p2.sessions[0].fp, p1.sessions[0].fp);
  assert.equal(p2.sessions[0].windows[0].tabs[0].url, 'https://a/');
});

const STORE = {
  version: ['sessionrestore', 1],
  windows: [{
    groups: [{ id: 'grp', name: 'Research', color: 'blue' }],
    tabs: [
      { entries: [{ url: 'https://old/', title: 'Old' }, { url: 'https://now/', title: 'Now' }, { url: 'https://fwd/', title: 'Fwd' }], index: 2, pinned: true },
      { entries: [{ url: 'https://only/', title: 'Only' }], groupId: 'grp' },
      { entries: [] },
    ],
    _closedTabs: [{ state: { entries: [{ url: 'https://closed/' }] } }],
  }],
  _closedWindows: [{ tabs: [{ entries: [{ url: 'https://closedwin/' }] }] }],
  session: { lastUpdate: 1505617144685 },
  cookies: [{ host: 'secret', value: 'do-not-import' }],
};

test('import: Session Manager .session (CRLF header)', async () => {
  const text = [
    '[SessionManager v2]',
    'name=before the move',
    'timestamp=1505617144718',
    'autosave=false\tcount=1/2\tgroup=Backup Sessions\tscreensize=1920x1080',
    JSON.stringify(STORE),
  ].join('\r\n');
  const p = await parseImportFile(file('before the move.session', text));
  assert.equal(p.type, 'sessionmanager');
  const s = p.sessions[0];
  assert.equal(s.name, 'before the move');
  assert.equal(s.createdAt, 1505617144718);
  assert.equal(s.origin.group, 'Backup Sessions');
  assert.equal(s.windows.length, 1);
  assert.deepEqual(s.windows[0].tabs.map((t) => t.url), ['https://now/', 'https://only/'], 'takes the entry the tab was on; skips closed tabs');
  assert.equal(s.windows[0].tabs[0].pinned, true);
  assert.equal(s.windows[0].tabs[1].g, 'g1');
  assert.deepEqual(s.windows[0].groups, [{ k: 'g1', title: 'Research', color: 'blue' }]);
  const encrypted = '[SessionManager v2]\nname=x\ntimestamp=1\nautosave=false\nBASE64GARBAGE';
  await assert.rejects(parseImportFile(file('enc.session', encrypted)), /encrypted/);
});

/** Minimal LZ4 "compressor": one literals-only sequence. */
function lz4Literals(bytes) {
  const out = [];
  const n = bytes.length;
  out.push(Math.min(n, 15) << 4);
  if (n >= 15) {
    let r = n - 15;
    while (r >= 255) {
      out.push(255);
      r -= 255;
    }
    out.push(r);
  }
  return Uint8Array.from([...out, ...bytes]);
}

function mozLz4(bytes) {
  const n = bytes.length;
  const head = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  return Uint8Array.from([...head, ...lz4Literals(bytes)]);
}

test('lz4 block decoder handles literals, matches and overlap', () => {
  // "abc" + match(offset 3, len 9) -> "abcabcabcabc"
  const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]);
  assert.equal(new TextDecoder().decode(decodeLz4Block(block, 12)), 'abcabcabcabc');
  const big = enc('x'.repeat(700));
  assert.deepEqual(decodeMozLz4(mozLz4(big)), big);
  assert.throws(() => decodeLz4Block(Uint8Array.from([0x10, 0x61, 0x09, 0x00]), 10), /offset/);
  assert.throws(() => decodeMozLz4(enc('not lz4 at all')), /mozLz4/);
});

test('import: Firefox sessionstore (.jsonlz4 and plain json)', async () => {
  const p = await parseImportFile(file('recovery.jsonlz4', mozLz4(enc(JSON.stringify(STORE)))));
  assert.equal(p.type, 'sessionstore');
  assert.equal(p.sessions[0].createdAt, 1505617144685);
  assert.equal(p.sessions[0].windows[0].tabs.length, 2);
  const plain = await parseImportFile(file('previous.js', JSON.stringify(STORE)));
  assert.equal(plain.type, 'sessionstore');
  assert.ok(!JSON.stringify(plain).includes('do-not-import'), 'cookies are never carried over');
});

test('import: Southpaw backup, gzipped, and analyzer state', async () => {
  const backup = {
    format: 'southpaw-sessions-backup',
    version: 1,
    sessions: [
      { id: 'id-1', kind: 'saved', name: 'S', createdAt: 5, updatedAt: 6, windows: [{ tabs: [{ t: 'x', url: 'https://a/', title: 'A' }] }], deletedAt: 9 },
      { id: 'bad' },
      null,
    ],
    checks: [{ url: 'https://a/', status: 'dead', httpCode: 404, checkedAt: 7 }, { url: 'https://b/', status: 'bogus' }],
    tombstones: [{ url: 'https://t/', scope: 'global' }, { url: 'https://s/', scope: 'session' }],
    settings: { lazyRestore: false },
  };
  const stream = new Blob([JSON.stringify(backup)]).stream().pipeThrough(new CompressionStream('gzip'));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  const p = await parseImportFile(file('southpaw-backup-2026-11-12.json.gz', gz));
  assert.equal(p.type, 'southpaw');
  assert.equal(p.sessions.length, 1);
  assert.equal(p.sessions[0].id, 'id-1');
  assert.equal(p.sessions[0].deletedAt, 9);
  assert.equal(p.checks.length, 1);
  assert.equal(p.tombstones.length, 1, 'session-scoped tombstone without an originKey is dropped');
  assert.deepEqual(p.settings, { lazyRestore: false });

  const state = { format: 'southpaw-analyzer-state', tombstones: [{ url: 'https://t/', scope: 'global' }], checks: [] };
  const st = await parseImportFile(file('state.json', JSON.stringify(state)));
  assert.equal(st.type, 'analyzer-state');
  assert.equal(st.sessions.length, 0);
  const newer = { format: 'southpaw-sessions-backup', version: 2, sessions: [] };
  await assert.rejects(parseImportFile(file('new.json', JSON.stringify(newer))), /newer/);
  await assert.rejects(parseImportFile(file('junk.txt', 'hello world')), /not a recognised/);
  await assert.rejects(parseImportFile(file('obj.json', '{"a":1}')), /not a recognised/);
});

const metas = [
  { id: 's1', kind: 'saved', name: 'one', createdAt: 2000 },
  { id: 's2', kind: 'saved', name: 'two', createdAt: 1000 },
  { id: 's3', kind: 'saved', name: 'trashed', createdAt: 500, deletedAt: 1 },
  { id: 'auto', kind: 'previous', name: 'auto', createdAt: 100 },
];
const YT = 'https://www.youtube.com/watch?v=abcdefghijk';
const data = new Map([
  ['s1', [{ tabs: [{ t: 'a', url: 'https://x.com/p?utm_source=q', title: 'Imgur' }, { t: 'b', url: YT, title: 'Vid' }] }]],
  ['s2', [{ tabs: [{ t: 'c', url: 'https://x.com/p/', title: 'A much better title' }, { t: 'd', url: 'https://www.youtube.com/results?search_query=z', title: 'search' }] }]],
  ['s3', [{ tabs: [{ t: 'e', url: 'https://trash/', title: 't' }] }]],
  ['auto', [{ tabs: [{ t: 'f', url: 'https://auto/', title: 'a' }] }]],
]);
const checks = new Map([[YT, { url: YT, status: 'dead', checkedAt: 1 }]]);

test('library folds sessions into unique links', () => {
  const rows = buildLibrary(metas, data, checks);
  assert.equal(rows.length, 3, 'trash and automatic snapshots are not part of the library');
  const x = rows.find((r) => r.canonical === 'https://x.com/p');
  assert.equal(x.title, 'A much better title');
  assert.equal(x.sessionCount, 2);
  assert.equal(x.refs.length, 2);
  assert.equal(x.date, 1000, 'earliest session date');
  assert.equal(rows.find((r) => r.kind === 'youtube_video').status, 'dead');
  assert.equal(rows.find((r) => r.kind === 'youtube_search').status, 'not_checkable');

  assert.equal(filterRows(rows, { q: 'better x.com' }).length, 1, 'all terms must match, across title and url');
  assert.equal(filterRows(rows, { status: 'dead' }).length, 1);
  assert.equal(filterRows(rows, { status: 'unchecked' }).length, 1);
  assert.equal(filterRows(rows, { kinds: new Set(['youtube_video', 'youtube_search']) }).length, 2);
  assert.deepEqual(sortRows(rows, 'status', 'asc').map((r) => r.status), ['dead', 'not_checkable', null], 'unchecked sinks');
  assert.deepEqual(sortRows(rows, 'status', 'desc').map((r) => r.status), ['not_checkable', 'dead', null]);

  const sr = buildSessionRows({ ...metas[0], windows: data.get('s1') }, checks);
  assert.deepEqual(sr.map((r) => [r.key, r.order, r.w]), [['a', 0, 0], ['b', 1, 0]]);
});

test('export escapes html and honours the dead-link mode', () => {
  const rows = [
    { title: '<b>x</b> & "y"', url: 'https://a/?q=<1>', kind: 'other', status: 'dead', sessionCount: 1, titleLc: 'b' },
    { title: 'evil', url: 'javascript:alert(1)', kind: 'other', status: null, sessionCount: 1, titleLc: 'a' },
  ];
  const html = buildExport(rows, { format: 'html', label: 'All <links>' });
  assert.ok(!html.body.includes('<b>x</b>'));
  assert.ok(html.body.includes('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;'));
  assert.ok(!html.body.includes('href="javascript:'), 'script URLs never become links');
  assert.equal(html.filename, 'links-all-links.html');
  const only = buildExport(rows, { format: 'json', dead: 'only', label: 'x' });
  assert.equal(JSON.parse(only.body).count, 1);
  assert.equal(only.filename, 'dead-links-x.json');
  assert.equal(buildExport(rows, { format: 'json', dead: 'exclude', label: 'x' }).count, 1);
});

test('imgur ids', () => {
  assert.deepEqual(parseImgur('https://imgur.com/some-title-AbCdEfG'), { type: 'image', id: 'AbCdEfG' });
  assert.deepEqual(parseImgur('https://i.imgur.com/hIjKlMn.gifv'), { type: 'image', id: 'hIjKlMn' });
  assert.deepEqual(parseImgur('https://imgur.com/a/oPqRsTu'), { type: 'album', id: 'oPqRsTu' });
  assert.deepEqual(parseImgur('https://imgur.com/gallery/abc'), { type: 'gallery', id: 'abc' });
  assert.equal(parseImgur('https://imgur.com/'), null);
});

test('link checker: resumable, retries unknowns, honours stop', async () => {
  assert.equal(needsCheck('imgur', undefined), true);
  assert.equal(needsCheck('imgur', { status: 'alive' }), false);
  assert.equal(needsCheck('imgur', { status: 'unknown' }), true);
  assert.equal(needsCheck('imgur', { status: 'not_checkable' }), true);
  assert.equal(needsCheck('youtube_video', { status: 'dead', httpCode: 401 }), true);
  assert.equal(needsCheck('youtube_video', { status: 'dead', httpCode: 404 }), false);

  const links = [
    { canonical: 'yt1', url: 'https://www.youtube.com/watch?v=1', kind: 'youtube_video' },
    { canonical: 'yt1', url: 'https://www.youtube.com/watch?v=1', kind: 'youtube_video' }, // duplicate
    { canonical: 'im1', url: 'https://imgur.com/x', kind: 'imgur' },
    { canonical: 'done', url: 'https://imgur.com/y', kind: 'imgur' },
    { canonical: 'flaky', url: 'https://imgur.com/z', kind: 'imgur' },
    { canonical: 'srch', url: 'https://www.youtube.com/results?search_query=a', kind: 'youtube_search' },
    { canonical: 'oth', url: 'https://example.com/', kind: 'other' },
  ];
  const cache = new Map([
    ['done', { url: 'done', status: 'alive', checkedAt: 1 }],
    ['flaky', { url: 'flaky', status: 'unknown', checkedAt: 1 }],
  ]);
  const called = [];
  const saved = [];
  const check = async (kind, url) => {
    called.push(url);
    return url.endsWith('x') ? { status: 'dead', httpCode: 302 } : { status: 'alive', httpCode: 200 };
  };
  const job = newJob();
  await runChecks({ links, checks: cache, job, save: async (b) => { saved.push(...b); }, check });
  assert.deepEqual(called.sort(), ['https://imgur.com/x', 'https://imgur.com/z', 'https://www.youtube.com/watch?v=1']);
  assert.equal(job.total, 3);
  assert.equal(job.checked, 3);
  assert.equal(job.dead, 1);
  assert.equal(job.running, false);
  assert.equal(saved.length, 3);
  assert.equal(cache.get('im1').status, 'dead');

  // Second run: everything settled -> no network.
  called.length = 0;
  await runChecks({ links, checks: cache, job: newJob(), save: async () => {}, check });
  assert.deepEqual(called, []);

  // Opt-in generic checking includes ordinary sites.
  await runChecks({ links, checks: cache, job: newJob(), save: async () => {}, check, otherSites: true });
  assert.deepEqual(called, ['https://example.com/']);

  // Stop: an aborted request leaves no verdict behind.
  const ac = new AbortController();
  const cache2 = new Map();
  const job2 = newJob();
  await runChecks({
    links, checks: cache2, job: job2, save: async () => {}, signal: ac.signal, concurrency: 1,
    check: async () => {
      ac.abort();
      return { status: 'alive' };
    },
  });
  assert.equal(cache2.size, 0);
  assert.equal(job2.stopped, true);
});

test('settings are sanitised', () => {
  const s = sanitizeSettings({ checkpointMinutes: 'abc', keepPrevious: 9999, backupFolder: '..\\..\\Windows/Sys?tem ', lazyRestore: 0, bogus: 1 });
  assert.equal(s.checkpointMinutes, 15);
  assert.equal(s.keepPrevious, 100);
  assert.equal(s.backupFolder, 'Windows/System');
  assert.equal(s.lazyRestore, false);
  assert.equal('bogus' in s, false);
  assert.equal(sanitizeFolder('  '), 'SouthpawSessions');
  assert.equal(sanitizeFolder('C:\\Users\\me'), 'C/Users/me');
});

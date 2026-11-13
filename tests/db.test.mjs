// Tests for the database-backed modules, run against fake-indexeddb.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as db from '../extension/lib/db.js';
import { addParsed, applyImport, createBatch, planImport } from '../extension/lib/importer.js';
import { parseImportFile } from '../extension/lib/importers/index.js';
import { buildLibrary } from '../extension/lib/library.js';
import * as sessions from '../extension/lib/sessions.js';

beforeEach(async () => {
  await db.closeDb();
  globalThis.indexedDB = new IDBFactory();
});

const tab = (url, title = url) => ({ url, title });
const urlsOf = (session) => session.windows.map((w) => w.tabs.map((t) => t.url));

test('sessions round-trip with derived counts', async () => {
  const meta = await sessions.createSession({
    name: '  My session ',
    windows: [{ tabs: [tab('https://a/'), tab('https://b/')] }, { tabs: [] }, { label: 'L', tabs: [tab('https://c/')] }],
  });
  assert.equal(meta.name, 'My session');
  assert.equal(meta.tabCount, 3);
  assert.equal(meta.windowCount, 2, 'empty windows are not counted');
  const s = await db.getSession(meta.id);
  assert.deepEqual(urlsOf(s), [['https://a/', 'https://b/'], [], ['https://c/']]);
  assert.ok(s.windows[0].tabs.every((t) => typeof t.t === 'string' && t.t.length > 4));
  assert.equal((await db.listMeta()).length, 1);
  assert.equal(await db.getSession('nope'), null);
});

test('rename, trash, restore, purge', async () => {
  const a = await sessions.createSession({ name: 'a', windows: [{ tabs: [tab('https://a/')] }] });
  assert.equal((await sessions.renameSession(a.id, ' renamed ')).name, 'renamed');
  assert.equal(await sessions.renameSession(a.id, '   '), null, 'blank names are refused');

  await sessions.trashSessions([a.id]);
  assert.ok((await db.getMeta(a.id)).deletedAt > 0);
  await sessions.restoreSessions([a.id]);
  assert.equal((await db.getMeta(a.id)).deletedAt, undefined);

  await sessions.trashSessions([a.id]);
  const fresh = await sessions.purgeExpired({ trashDays: 30 });
  assert.equal(fresh.sessions, 0, 'recently trashed sessions are kept');
  await db.patchMetas([a.id], () => ({ deletedAt: Date.now() - 40 * 86400000 }));
  assert.equal((await sessions.purgeExpired({ trashDays: 30 })).sessions, 1);
  assert.equal(await db.getSession(a.id), null);
});

test('removeTabs + undo restores the exact arrangement', async () => {
  const meta = await sessions.createSession({
    name: 's',
    originKey: 'mysessions:F1',
    windows: [
      { tabs: [tab('https://a/'), tab('https://b/'), tab('https://c/'), tab('https://d/')] },
      { tabs: [tab('https://e/'), tab('https://f/')] },
    ],
  });
  const before = await db.getSession(meta.id);
  const pick = (url) => ({ sessionId: meta.id, t: before.windows.flatMap((w) => w.tabs).find((t) => t.url === url).t });

  const res = await sessions.removeTabs([pick('https://a/'), pick('https://c/'), pick('https://e/'), pick('https://f/')], { tombstone: 'session' });
  assert.equal(res.removed, 4);
  const after = await db.getSession(meta.id);
  assert.deepEqual(urlsOf(after), [['https://b/', 'https://d/'], []]);
  assert.equal(after.tabCount, 2);
  assert.equal(after.windowCount, 1);
  const tomb = await db.getTombstoneIndex();
  assert.equal(tomb.perOrigin.get('mysessions:F1').size, 4);
  assert.equal(tomb.global.size, 0);

  const undone = await sessions.undo(res.undoId);
  assert.deepEqual(undone, { restored: 4, lost: 0 });
  const restored = await db.getSession(meta.id);
  assert.deepEqual(urlsOf(restored), urlsOf(before));
  assert.deepEqual(restored.windows.flatMap((w) => w.tabs.map((t) => t.t)), before.windows.flatMap((w) => w.tabs.map((t) => t.t)));
  assert.equal((await db.getTombstoneIndex()).count, 0, 'undo forgets the tombstones it created');
  assert.equal(await sessions.undo(res.undoId), null, 'an undo entry can be used once');
});

test('delete everywhere: global tombstone, undo keeps unrelated tombstones', async () => {
  const a = await sessions.createSession({ name: 'a', windows: [{ tabs: [tab('https://x/?utm_source=1'), tab('https://keep/')] }] });
  const b = await sessions.createSession({ name: 'b', windows: [{ tabs: [tab('https://x/')] }] });
  await db.addTombstones([{ url: 'https://older/', scope: 'global' }]);

  const lib = buildLibrary(await db.listMeta(), await db.getAllData(), new Map());
  const row = lib.find((r) => r.canonical === 'https://x/');
  assert.equal(row.refs.length, 2);
  const res = await sessions.removeTabs(row.refs, { tombstone: 'global' });
  assert.equal(res.removed, 2);
  assert.equal(res.sessions, 2);
  assert.deepEqual(urlsOf(await db.getSession(a.id)), [['https://keep/']]);
  assert.deepEqual(urlsOf(await db.getSession(b.id)), [[]]);
  assert.ok((await db.getTombstoneIndex()).global.has('https://x/'));

  // The session is deleted for good before the undo: its tab cannot come back.
  await sessions.purgeSessions([b.id]);
  const undone = await sessions.undo(res.undoId);
  assert.deepEqual(undone, { restored: 1, lost: 1 });
  const tomb = await db.getTombstoneIndex();
  assert.equal(tomb.global.has('https://x/'), false);
  assert.equal(tomb.global.has('https://older/'), true);
});

test('saveCopy turns an automatic snapshot into a saved session', async () => {
  await db.putSession({ id: 'auto:current', kind: 'current', name: 'Current browser session', windows: [{ winId: 7, tabs: [tab('https://a/')] }] });
  const copy = await sessions.saveCopy('auto:current', 'Kept');
  assert.equal(copy.kind, 'saved');
  assert.equal(copy.name, 'Kept');
  const s = await db.getSession(copy.id);
  assert.equal(s.windows[0].winId, undefined, 'live window ids are not copied');
  assert.notEqual(s.windows[0].tabs[0].t, (await db.getSession('auto:current')).windows[0].tabs[0].t);
});

test('removed links are kept for good, with their titles, until erased', async () => {
  const a = await sessions.createSession({ name: 'a', windows: [{ tabs: [tab('https://x/?utm_source=1', 'The X page'), tab('https://keep/')] }] });
  const s = await db.getSession(a.id);
  const res = await sessions.removeTabs([{ sessionId: a.id, t: s.windows[0].tabs[0].t }], { tombstone: 'global' });

  // Age the log entry far beyond the trash retention: housekeeping must leave it.
  const [entry] = await db.listUndo();
  assert.equal(typeof entry.uid, 'string');
  assert.equal(entry.payload.sessions[0].removed[0].tab.title, 'The X page');
  assert.deepEqual(await sessions.purgeExpired({ trashDays: 1 }), { sessions: 0 });
  assert.equal((await db.listUndo()).length, 1);

  // The blocklist entry remembers what the link was called.
  let [tomb] = await db.listTombstones();
  assert.deepEqual([tomb.url, tomb.title, tomb.original], ['https://x/', 'The X page', 'https://x/?utm_source=1']);

  // A title arriving later fills in a record that had none; it never overwrites.
  await db.addTombstones([{ url: 'https://bare/', scope: 'global' }]);
  assert.deepEqual(await db.addTombstones([{ url: 'https://bare/', scope: 'global', title: 'Now named' }, { url: 'https://x/', scope: 'global', title: 'Other' }]), []);
  const byUrl = new Map((await db.listTombstones()).map((t) => [t.url, t]));
  assert.equal(byUrl.get('https://bare/').title, 'Now named');
  assert.equal(byUrl.get('https://x/').title, 'The X page');

  // Erasing the record drops the title everywhere but keeps the link blocked.
  await sessions.forgetRemovals([res.undoId]);
  assert.equal((await db.listUndo()).length, 0);
  [tomb] = (await db.listTombstones()).filter((t) => t.url === 'https://x/');
  assert.equal(tomb.title, undefined);
  assert.equal(tomb.original, undefined);
  assert.ok((await db.getTombstoneIndex()).global.has('https://x/'));
  assert.equal(await sessions.undo(res.undoId), null, 'an erased record cannot be put back');
});

// ---- import pipeline ----------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s);
const ms = (list) => JSON.stringify(list.map(([folderId, title, date, urls]) => ({
  title, date, folderId, urls: [], tabsCount: urls.length,
  windows: { w1: urls.map((u) => ({ title: `T ${u}`, url: u })) }, labels: { w1: 'window 1' },
})));

async function batchOf(files) {
  const batch = createBatch();
  for (const [name, content, lastModified] of files) {
    addParsed(batch, await parseImportFile({ name, bytes: enc(content), lastModified }), { name, lastModified });
  }
  return batch;
}

test('import: newest backup wins, older-only sessions are opt-in, re-import is a no-op', async () => {
  const old = ms([
    ['F1', 'alpha', '1/1/2024_10:00', ['https://a1/', 'https://a2/', 'https://a3/']],
    ['F2', 'deleted later', '2/1/2024_10:00', ['https://gone/']],
  ]);
  const recent = ms([
    ['F1', 'alpha', '1/1/2024_10:00', ['https://a1/', 'https://a3/']], // a2 was removed by the user
    ['F3', 'gamma', '3/1/2024_10:00', ['https://g/']],
  ]);
  // Deliberately added newest-first: order of arrival must not matter.
  const batch = await batchOf([['new.mysessions', recent, 2000], ['old.mysessions', old, 1000]]);
  const plan = await planImport(batch);
  assert.deepEqual(plan.fresh.map((i) => i.session.name).sort(), ['alpha', 'gamma']);
  assert.deepEqual(plan.olderOnly.map((i) => i.session.name), ['deleted later']);
  assert.equal(plan.newestLibraryFile, 'new.mysessions');

  const summary = await applyImport(batch, plan);
  assert.equal(summary.added, 2);
  assert.equal(summary.skippedOlderOnly, 1);
  const metas = await db.listMeta();
  const alpha = await db.getSession(metas.find((m) => m.name === 'alpha').id);
  assert.deepEqual(urlsOf(alpha), [['https://a1/', 'https://a3/']], 'the newest file\'s copy of the session is used');
  assert.equal(alpha.originKey, 'mysessions:F1');
  const d = new Date(alpha.createdAt);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2024, 0, 1, 10]);

  // Same files again: nothing new.
  const again = await planImport(await batchOf([['new.mysessions', recent, 2000], ['old.mysessions', old, 1000]]));
  assert.equal(again.fresh.length, 0);
  assert.equal(again.existing.length, 2);
  assert.equal(again.olderOnly.length, 1);

  // Opting in recovers the session that only older backups hold.
  const batch3 = await batchOf([['new.mysessions', recent, 2000], ['old.mysessions', old, 1000]]);
  const s3 = await applyImport(batch3, await planImport(batch3), { includeOlderOnly: true });
  assert.equal(s3.added, 1);
  assert.equal((await db.listMeta()).length, 3);
});

test('import: existing sessions are kept unless overwrite is requested', async () => {
  const v1 = ms([['F1', 'alpha', '1/1/2024_10:00', ['https://a1/', 'https://a2/']]]);
  let batch = await batchOf([['a.mysessions', v1, 1000]]);
  await applyImport(batch, await planImport(batch));
  const id = (await db.listMeta())[0].id;
  const s = await db.getSession(id);
  await sessions.removeTabs([{ sessionId: id, t: s.windows[0].tabs[0].t }]); // user prunes a1 (no tombstone)

  batch = await batchOf([['a.mysessions', v1, 1000]]);
  let plan = await planImport(batch);
  assert.equal(plan.existing.length, 1);
  const kept = await applyImport(batch, plan);
  assert.equal(kept.skippedExisting, 1);
  assert.deepEqual(urlsOf(await db.getSession(id)), [['https://a2/']], 'library copy untouched');

  batch = await batchOf([['a.mysessions', v1, 1000]]);
  plan = await planImport(batch);
  const over = await applyImport(batch, plan, { overwriteExisting: true });
  assert.equal(over.overwritten, 1);
  assert.deepEqual(urlsOf(await db.getSession(id)), [['https://a1/', 'https://a2/']]);
  assert.equal((await db.listMeta()).length, 1, 'overwrite reuses the session id');
});

test('import: the same session in two formats is imported once', async () => {
  const arr = ms([['F1', 'evening reading', '12/11/2026_15:48', ['https://a/']]]);
  const single = JSON.stringify({
    format: 'MySessions-Backup', version: 1,
    sessions: [{ title: 'evening reading (12/11/2026_15:48)--1tabs', children: [{ title: 'window 1', children: [{ title: 'a', url: 'https://a/' }] }] }],
  });
  const batch = await batchOf([['mysessions-x.json', single, 3000], ['b.mysessions', arr, 1000]]);
  const plan = await planImport(batch);
  assert.equal(plan.fresh.length, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.fresh[0].session.originKey, 'mysessions:F1', 'the copy with a real id is preferred');
  await applyImport(batch, plan);

  // Later, the standalone export alone is recognised as already imported.
  const later = await planImport(await batchOf([['mysessions-x.json', single, 3000]]));
  assert.equal(later.fresh.length, 0);
  assert.equal(later.existing.length, 1);
});

test('import: deleted links never come back; analyzer state applies both ways', async () => {
  const lib = ms([
    ['F1', 'alpha', '1/1/2024_10:00', ['https://dead/?utm_medium=x', 'https://ok/']],
    ['F2', 'beta', '2/1/2024_10:00', ['https://dead/']],
  ]);
  const state = JSON.stringify({
    format: 'southpaw-analyzer-state',
    tombstones: [{ url: 'https://dead/', scope: 'global' }],
    checks: [{ url: 'https://ok/', status: 'alive', httpCode: 200, checkedAt: 50 }],
  });

  // Sessions first, analyzer state second: deletions apply retroactively.
  let batch = await batchOf([['lib.mysessions', lib, 1000]]);
  await applyImport(batch, await planImport(batch));
  batch = await batchOf([['state.json', state, 2000]]);
  const s1 = await applyImport(batch, await planImport(batch));
  assert.equal(s1.tombstonesAdded, 1);
  assert.equal(s1.tabsRemoved, 2);
  assert.equal(s1.checksAdded, 1);
  let all = await db.getAllData();
  assert.ok(![...all.values()].flat().flatMap((w) => w.tabs).some((t) => t.url.includes('dead')));
  assert.equal((await db.listUndo()).length, 1, 'the retroactive removal can be undone');

  // Fresh library, state first: sessions are filtered on the way in.
  await db.closeDb();
  globalThis.indexedDB = new IDBFactory();
  batch = await batchOf([['state.json', state, 2000]]);
  await applyImport(batch, await planImport(batch));
  batch = await batchOf([['lib.mysessions', lib, 1000]]);
  const s2 = await applyImport(batch, await planImport(batch));
  assert.equal(s2.blockedTabs, 2);
  assert.equal(s2.added, 1);
  assert.equal(s2.emptyAfterFilter, 1, 'a session left with no tabs is not created');
  all = await db.getAllData();
  assert.deepEqual([...all.values()].flat().flatMap((w) => w.tabs).map((t) => t.url), ['https://ok/']);

  // A newer verdict already in the cache is not overwritten by an older one.
  await db.putChecks([{ url: 'https://ok/', status: 'dead', checkedAt: 999 }]);
  batch = await batchOf([['state.json', state, 2000]]);
  const s3 = await applyImport(batch, await planImport(batch));
  assert.equal(s3.checksAdded, 0);
  assert.equal((await db.getAllChecks()).get('https://ok/').status, 'dead');
});

test('import: Southpaw backup restores ids, trash state and kinds', async () => {
  const backup = JSON.stringify({
    format: 'southpaw-sessions-backup',
    version: 1,
    sessions: [
      { id: 'keep-1', kind: 'saved', name: 'kept', createdAt: 10, updatedAt: 20, windows: [{ tabs: [{ t: 'tt', url: 'https://a/', title: 'A', pinned: true }] }] },
      { id: 'trash-1', kind: 'saved', name: 'binned', createdAt: 11, deletedAt: 12, windows: [{ tabs: [{ url: 'https://b/', title: 'B' }] }] },
      { id: 'prev-1', kind: 'previous', name: 'Previous browser session', createdAt: 13, windows: [{ tabs: [{ url: 'https://c/', title: 'C' }] }] },
      { id: 'cur', kind: 'current', name: 'live', createdAt: 14, windows: [{ tabs: [{ url: 'https://d/', title: 'D' }] }] },
    ],
    tombstones: [{ url: 'https://t/', scope: 'global', createdAt: 5, title: 'Deleted long ago', original: 'https://t/?fbclid=1' }],
    checks: [{ url: 'https://a/', status: 'alive', checkedAt: 6 }],
    removed: [
      {
        uid: 'log-1', at: 7, type: 'removeTabs', label: 'Removed 1 link from “kept”',
        payload: { count: 1, tombstoneKeys: ['g|https://t/'], sessions: [{ id: 'keep-1', name: 'kept', removed: [{ w: 0, i: 1, tab: { t: 'gone', url: 'https://t/?fbclid=1', title: 'Deleted long ago' } }] }] },
      },
      { uid: 'broken', at: 8, type: 'removeTabs', label: 'x', payload: { sessions: [{ id: 'keep-1', removed: [{ tab: {} }] }] } },
      { type: 'somethingElse' },
    ],
    settings: { lazyRestore: false },
  });
  const batch = await batchOf([['southpaw-backup.json', backup, 1000]]);
  const plan = await planImport(batch);
  assert.equal(plan.fresh.length, 3, 'the live autosave record is never imported');
  let applied = null;
  const summary = await applyImport(batch, plan, { applySettings: async (s) => { applied = s; } });
  assert.equal(summary.added, 3);
  assert.equal(summary.settingsRestored, true);
  assert.deepEqual(applied, { lazyRestore: false });

  const kept = await db.getSession('keep-1');
  assert.equal(kept.updatedAt, 20, 'timestamps survive a restore');
  assert.deepEqual(kept.windows[0].tabs[0], { t: 'tt', url: 'https://a/', title: 'A', pinned: true });
  assert.equal((await db.getMeta('trash-1')).deletedAt, 12);
  assert.equal((await db.getMeta('prev-1')).kind, 'previous');
  assert.equal((await db.getTombstoneIndex()).global.has('https://t/'), true);
  assert.equal((await db.listTombstones())[0].title, 'Deleted long ago');

  // The log of removed links comes back too, and works: putting the link back
  // re-inserts it at its old position and lifts the import block.
  assert.equal(summary.removedLogAdded, 1, 'malformed log entries are dropped');
  const [entry] = await db.listUndo();
  assert.equal(entry.uid, 'log-1');
  assert.deepEqual(await sessions.undo(entry.id), { restored: 1, lost: 0 });
  assert.deepEqual(urlsOf(await db.getSession('keep-1')), [['https://a/', 'https://t/?fbclid=1']]);
  assert.equal((await db.getTombstoneIndex()).count, 0);

  // Restoring the same backup again: its log entry returns (it was consumed by
  // the undo above), and its deletion is applied to the library once more —
  // which is logged as a removal of its own.
  const batch2 = await batchOf([['southpaw-backup.json', backup, 1000]]);
  const s2 = await applyImport(batch2, await planImport(batch2));
  assert.equal(s2.removedLogAdded, 1);
  assert.equal(s2.tabsRemoved, 1);
  assert.equal((await db.listUndo()).length, 2);

  // A third time changes nothing: no duplicate log entries.
  const batch3 = await batchOf([['southpaw-backup.json', backup, 1000]]);
  const s3 = await applyImport(batch3, await planImport(batch3));
  assert.deepEqual([s3.removedLogAdded, s3.tabsRemoved, s3.tombstonesAdded], [0, 0, 0]);
  assert.equal((await db.listUndo()).length, 2);

  const again = await planImport(await batchOf([['southpaw-backup.json', backup, 1000]]));
  assert.equal(again.fresh.length, 0);
  assert.equal(again.existing.length, 3);
});

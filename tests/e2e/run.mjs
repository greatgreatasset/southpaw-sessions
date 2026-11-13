// End-to-end test: drives the real extension in a real (headless) Firefox.
//
//   npm run e2e
//
// Optional environment:
//   SOUTHPAW_E2E_HEADED=1     watch it run
//   SOUTHPAW_E2E_LINKS=file   JSON [{url, expect}] — also run the live
//                             dead-link checker against these and compare
//   FIREFOX_BIN=path          use a specific Firefox
//
// Uses a throwaway profile and download folder; your own Firefox profile,
// sessions and Downloads are never touched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { By, Key } from 'selenium-webdriver';
import { BASE, buildAddon, cleanup, inPage, launch, makeTempDir, until } from './harness.mjs';

const tmp = makeTempDir();
const profileDir = join(tmp, 'profile');
const downloadDir = join(tmp, 'downloads');
const fixtures = join(tmp, 'fixtures');
const results = [];
let driver;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}${note ? ` — ${note}` : ''} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split('\n').join('\n        ')}`);
  }
}

// ---- fixtures -------------------------------------------------------------------

const SHARED = 'https://example.com/shared?utm_source=newsletter';
const msSession = (folderId, title, date, urls) => ({
  title, date, folderId, urls: [], tabsCount: urls.length,
  windows: { w1: urls.map((u, i) => ({ title: `${title} tab ${i + 1}`, url: u })) },
  labels: { w1: 'window 1' },
});
const big = Array.from({ length: 150 }, (_, i) => `https://example.com/big/${i}`);

function writeFixtures() {
  mkdirSync(fixtures, { recursive: true });
  {
    const older = [
      msSession('F1', 'alpha', '1/3/2024_10:00', ['https://example.com/a1', 'https://example.com/a2', SHARED, 'https://example.com/removed-later']),
      msSession('F2', 'deleted later', '2/3/2024_11:00', ['https://example.com/gone']),
    ];
    const newer = [
      msSession('F1', 'alpha', '1/3/2024_10:00', ['https://example.com/a1', 'https://example.com/a2', SHARED]),
      msSession('F3', 'gamma', '3/3/2024_12:00', ['https://example.com/g1', 'https://example.com/shared']),
      msSession('F4', 'big one', '4/3/2024_13:00', big),
    ];
    const put = (name, content, mtime) => {
      const p = join(fixtures, name);
      writeFileSync(p, content);
      utimesSync(p, mtime, mtime);
      return p;
    };
    const day = 86400;
    const base = 1_720_000_000;
    const store = {
      windows: [{ tabs: [
        { entries: [{ url: 'https://example.com/old-entry', title: 'Old' }, { url: 'https://example.com/sm1', title: 'SM one' }], index: 2 },
        { entries: [{ url: 'https://example.com/sm2', title: 'SM two' }], pinned: true },
      ] }],
      session: { lastUpdate: 1505617144685 },
    };
    const sm = ['[SessionManager v2]', 'name=before the trip', 'timestamp=1505617144718', 'autosave=false\tcount=1/2', JSON.stringify(store)].join('\r\n');
    const state = JSON.stringify({
      format: 'southpaw-analyzer-state',
      tombstones: [{ url: 'https://example.com/a2', scope: 'global' }],
      checks: [{ url: 'https://example.com/a1', status: 'dead', httpCode: 404, checkedAt: 1_700_000_000_000 }],
    });
    return {
      older: put('backup - old.mysessions', JSON.stringify(older), base),
      // A byte-identical copy of the newest backup, as the old add-on produced by the thousand.
      newer: put('backup - new.mysessions', JSON.stringify(newer), base + day),
      dupe: put('backup - new (copy).mysessions', JSON.stringify(newer), base + day + 60),
      sm: put('before the trip.session', sm, base),
      junk: put('notes.txt', 'this is not a session file', base),
      state: put('analyzer-state.json', state, base + 2 * day),
    };
  }
}

// ---- page helpers ---------------------------------------------------------------------

const $ = (css) => driver.findElement(By.css(css));
const $$ = (css) => driver.findElements(By.css(css));
const text = async (css) => (await $(css)).getText();
const exists = async (css) => (await $$(css)).length > 0;
const click = async (css) => (await $(css)).click();

/** Query the extension's database from inside the page. */
const dbState = () => inPage(driver, `
  const db = await import(browser.runtime.getURL('lib/db.js'));
  const metas = await db.listMeta();
  const data = await db.getAllData();
  return metas.map((m) => ({
    id: m.id, kind: m.kind, name: m.name, tabCount: m.tabCount, windowCount: m.windowCount, deletedAt: m.deletedAt ?? null,
    urls: (data.get(m.id) ?? []).flatMap((w) => w.tabs.map((t) => t.url)),
    groups: (data.get(m.id) ?? []).flatMap((w) => w.groups ?? []),
    pinned: (data.get(m.id) ?? []).flatMap((w) => w.tabs.filter((t) => t.pinned).map((t) => t.url)),
  }));
`);
const saved = async () => (await dbState()).filter((s) => s.kind === 'saved' && !s.deletedAt);
const byName = async (name) => (await dbState()).find((s) => s.name === name);
const liveTabs = () => inPage(driver, `
  const tabs = await browser.tabs.query({});
  return tabs.map((t) => ({ id: t.id, url: t.url, windowId: t.windowId, discarded: !!t.discarded, pinned: t.pinned, active: t.active, groupId: t.groupId ?? -1, title: t.title }));
`);
const manager = async (hash = '') => {
  await driver.get(`${BASE}/pages/manager.html${hash}`);
  await until(() => exists('#head h2'), { what: 'manager page' });
};
const waitToast = (re) => until(async () => {
  const els = await $$('.toast .toast-msg');
  for (const el of els) if (re.test(await el.getText())) return true;
  return false;
}, { what: `toast ${re}` });
const selectSession = async (name) => {
  // The sidebar refreshes a moment after a change made elsewhere, and its
  // buttons are rebuilt on every refresh — so look the button up until a
  // click on it lands.
  await until(async () => {
    for (const b of await $$('#side-list .sess')) {
      if ((await b.findElement(By.css('.sess-name')).getText()) === name) {
        await b.click();
        return true;
      }
    }
    return false;
  }, { timeout: 15000, what: `session "${name}" in the sidebar` });
  await until(async () => (await text('#head h2')) === name, { what: `session ${name} to open` });
};
const closeExtraWindows = async () => {
  await inPage(driver, `
    const me = (await browser.tabs.getCurrent()).windowId;
    for (const w of await browser.windows.getAll()) if (w.id !== me) await browser.windows.remove(w.id);
    const mine = await browser.tabs.query({ windowId: me });
    const self = (await browser.tabs.getCurrent()).id;
    await browser.tabs.remove(mine.filter((t) => t.id !== self).map((t) => t.id));
  `);
};

// ---- scenario --------------------------------------------------------------------------

async function phaseA(files) {
  await manager();

  await step('first run shows the welcome screen', async () => {
    assert.ok(await exists('.welcome'), 'welcome panel');
    assert.equal((await saved()).length, 0);
  });

  await step('import: a folder of mixed files', async () => {
    await click('#btn-import');
    const input = await until(() => $('dialog input[type=file][multiple]'), { what: 'file input' });
    await input.sendKeys([files.older, files.newer, files.dupe, files.sm, files.junk].join('\n'));
    await until(() => exists('dialog dl.kv'), { what: 'import plan' });
    const plan = await text('dialog');
    assert.match(plan, /3 read/, 'three distinct session files parsed');
    assert.match(plan, /1 identical copy skipped/);
    assert.match(plan, /1 not recognised/);
    assert.match(plan, /New sessions\s*4 \(15[0-9] tabs\)/);
    assert.match(plan, /Only in older backups\s*1/);
    const go = await $('dialog .dialog-actions .btn.primary');
    assert.equal(await go.getText(), 'Import 4 sessions');
    await go.click();
    await until(async () => /Sessions added/.test(await text('dialog')), { what: 'import result' });
    await click('dialog .dialog-actions .btn.primary');
    const list = await saved();
    assert.deepEqual(list.map((s) => s.name).sort(), ['alpha', 'before the trip', 'big one', 'gamma']);
    const alpha = list.find((s) => s.name === 'alpha');
    assert.deepEqual(alpha.urls, ['https://example.com/a1', 'https://example.com/a2', SHARED], 'newest backup wins');
    const sm = list.find((s) => s.name === 'before the trip');
    assert.deepEqual(sm.urls, ['https://example.com/sm1', 'https://example.com/sm2']);
    assert.deepEqual(sm.pinned, ['https://example.com/sm2']);
    return (await text('#stats'));
  });

  await step('all links: duplicates fold into one row', async () => {
    await manager('#all');
    // 3 (alpha) + 2 (gamma) + 150 + 2 (session manager), minus one shared link.
    await until(async () => /156 unique links across 4 saved sessions/.test(await text('.head-sub')), { what: 'library header' });
    const search = await $('#toolbar input[type=search]');
    await search.sendKeys('shared');
    await until(async () => /^1 of 156 links$/.test(await text('#bar')), { what: 'filtered count' });
    assert.equal(await text('.lt-row .c-sessions .count'), '2', 'the shared link is in two sessions');
    await search.clear();
    await search.sendKeys(Key.SPACE, Key.BACK_SPACE);
  });

  await step('import again: nothing new; analyzer state applies retroactively', async () => {
    await click('#btn-import');
    const input = await until(() => $('dialog input[type=file][multiple]'), { what: 'file input' });
    await input.sendKeys([files.newer, files.state].join('\n'));
    await until(() => exists('dialog dl.kv'), { what: 'import plan' });
    const plan = await text('dialog');
    assert.match(plan, /New sessions\s*0/);
    assert.match(plan, /Already in your library\s*3/);
    assert.match(plan, /Deleted-link records\s*1/);
    await click('dialog .dialog-actions .btn.primary');
    await until(async () => /Sessions added/.test(await text('dialog')), { what: 'import result' });
    const res = await text('dialog');
    assert.match(res, /Links removed from existing sessions\s*1/);
    assert.match(res, /Dead-link verdicts added\s*1/);
    await click('dialog .dialog-actions .btn.primary');
    assert.deepEqual((await byName('alpha')).urls, ['https://example.com/a1', SHARED], 'tombstoned link removed');
    await until(async () => /155 unique links/.test(await text('.head-sub')), { what: 'library to refresh' });
  });

  await step('session view: remove one link, then undo', async () => {
    await selectSession('alpha');
    await until(async () => (await $$('.lt-row')).length === 2, { what: 'two rows' });
    assert.equal(await text('.lt-row .badge.dead'), 'DEAD', 'imported verdict is shown');
    const rows = await $$('.lt-row');
    await rows[1].findElement(By.css('[data-act=remove]')).click();
    await waitToast(/Removed 1 link from this session/);
    assert.deepEqual((await byName('alpha')).urls, ['https://example.com/a1']);
    await click('.toast .btn.primary');
    await until(async () => (await byName('alpha')).urls.length === 2, { what: 'undo' });
    assert.deepEqual((await byName('alpha')).urls, ['https://example.com/a1', SHARED], 'put back in its place');
  });

  await step('delete from all sessions, then undo', async () => {
    await manager('#all');
    const search = await $('#toolbar input[type=search]');
    await search.sendKeys('shared');
    await until(async () => (await $$('.lt-row')).length === 1, { what: 'one row' });
    await click('.lt-row [data-act=remove]');
    await waitToast(/Deleted 1 link from all sessions \(2 tabs in 2 sessions\)/);
    assert.deepEqual((await byName('alpha')).urls, ['https://example.com/a1']);
    assert.deepEqual((await byName('gamma')).urls, ['https://example.com/g1']);
    await click('.toast .btn.primary');
    await until(async () => (await byName('gamma')).urls.length === 2, { what: 'undo' });
    assert.equal((await byName('alpha')).urls.length, 2);
  });

  await step('open a session in a new window (tabs stay unloaded)', async () => {
    const before = await liveTabs();
    await selectSession('gamma');
    await click('#head .split .btn.primary');
    await until(async () => (await liveTabs()).length === before.length + 2, { what: 'two new tabs' });
    const added = (await liveTabs()).filter((t) => !before.some((b) => b.id === t.id));
    assert.deepEqual(added.map((t) => t.url).sort(), ['https://example.com/g1', 'https://example.com/shared']);
    assert.equal(new Set(added.map((t) => t.windowId)).size, 1);
    assert.notEqual(added[0].windowId, before[0].windowId, 'opened in a new window');
    assert.equal(added.filter((t) => t.discarded).length, 1, 'only the visible tab is loaded');
    assert.equal(added.filter((t) => t.active).length, 1);
  });

  await step('open 150 tabs: asks first, restores lazily', async () => {
    const before = await liveTabs();
    await selectSession('big one');
    await click('#head .split .btn.primary');
    await until(() => exists('dialog.small'), { what: 'confirmation' });
    assert.match(await text('dialog.small h2'), /Open 150 tabs\?/);
    const t0 = Date.now();
    await click('dialog.small .btn.primary');
    await until(async () => (await liveTabs()).length === before.length + 150, { timeout: 90000, what: '150 tabs' });
    const newTabs = async () => (await liveTabs()).filter((t) => !before.some((b) => b.id === t.id));
    // The one tab that gets shown reports about:blank while it starts loading;
    // judge a single consistent reading in which every tab has its address.
    const added = await until(async () => {
      const tabs = await newTabs();
      return tabs.length === 150 && tabs.every((t) => t.url.startsWith('https://example.com/big/')) ? tabs : null;
    }, { what: 'tab addresses' });
    assert.equal(added.filter((t) => t.discarded).length, 149);
    assert.deepEqual(added.map((t) => t.url), big, 'order preserved');
    return `${Date.now() - t0} ms for 150 tabs`;
  });

  await step('autosave records the live browser', async () => {
    const cur = await until(async () => {
      const s = (await dbState()).find((x) => x.kind === 'current');
      return s && s.tabCount >= 152 ? s : null;
    }, { timeout: 45000, what: 'autosave snapshot' });
    assert.ok(cur.urls.includes('https://example.com/big/149'));
    assert.ok(!cur.urls.some((u) => u.startsWith('moz-extension:')), 'own pages are not recorded');
  });

  await step('closing a window keeps it under "closed windows"', async () => {
    const closedBefore = (await dbState()).filter((s) => s.kind === 'closed').length;
    await inPage(driver, `
      const tabs = await browser.tabs.query({ url: 'https://example.com/g1' });
      await browser.windows.remove(tabs[0].windowId);
    `);
    const closed = await until(async () => {
      const list = (await dbState()).filter((s) => s.kind === 'closed');
      return list.length === closedBefore + 1 ? list : null;
    }, { what: 'closed-window record' });
    assert.deepEqual(closed[closed.length - 1].urls.sort(), ['https://example.com/g1', 'https://example.com/shared']);
  });

  await step('save current tabs and close them', async () => {
    await manager('#all');
    await click('#btn-save');
    await until(() => exists('dialog form'), { what: 'save dialog' });
    await (await $('dialog form input[type=text]')).sendKeys('everything open');
    await click('dialog form input[type=checkbox]');
    await click('dialog form .btn.primary');
    await until(async () => (await text('#head h2')) === 'everything open', { what: 'new session view' });
    const s = await byName('everything open');
    assert.equal(s.tabCount, 150);
    assert.deepEqual(s.urls, big);
    // What remains are the extension's own pages (this one, plus the welcome
    // tab it opened on install) — and the browser is still running.
    const left = await until(async () => {
      const tabs = await liveTabs();
      return tabs.every((t) => t.url.startsWith(BASE)) ? tabs : null;
    }, { what: 'saved tabs to close' });
    assert.ok(left.length >= 1);
    const closedNoise = (await dbState()).filter((x) => x.kind === 'closed' && x.tabCount === 150);
    assert.equal(closedNoise.length, 0, 'closing saved tabs does not create a "closed window" record');
  });

  await step('tab groups and pinned tabs survive save + reopen', async () => {
    await inPage(driver, `
      const w = await browser.windows.create({ url: 'https://example.com/pinned' });
      const ids = [];
      for (const u of ['https://example.com/grp1', 'https://example.com/grp2', 'https://example.com/loose']) {
        ids.push((await browser.tabs.create({ windowId: w.id, url: u, discarded: true, title: u })).id);
      }
      for (let i = 0; i < 100 && !(await browser.tabs.get(w.tabs[0].id)).url.includes('/pinned'); i++) await new Promise((r) => setTimeout(r, 100));
      await browser.tabs.update(w.tabs[0].id, { pinned: true });
      const gid = await browser.tabs.group({ tabIds: ids.slice(0, 2), createProperties: { windowId: w.id } });
      await browser.tabGroups.update(gid, { title: 'Research', color: 'green' });
      const res = await browser.runtime.sendMessage({ cmd: 'save', name: 'grouped', scope: 'window', windowId: w.id, closeAfter: true });
      if (!res.ok) throw new Error(res.error);
    `);
    const s = await until(() => byName('grouped'), { what: 'grouped session' });
    assert.deepEqual(s.urls, ['https://example.com/pinned', 'https://example.com/grp1', 'https://example.com/grp2', 'https://example.com/loose']);
    assert.deepEqual(s.pinned, ['https://example.com/pinned']);
    assert.deepEqual(s.groups, [{ k: 'g1', title: 'Research', color: 'green' }]);

    const res = await inPage(driver, `
      const r = await browser.runtime.sendMessage({ cmd: 'open', sessionId: args[0], mode: 'new-window' });
      if (!r.ok) throw new Error(r.error);
      const tabs = await browser.tabs.query({ url: 'https://example.com/grp*' });
      const group = await browser.tabGroups.get(tabs[0].groupId);
      // The pinned tab is a normally loading tab: give it a moment to get its address.
      let pinned = [];
      for (let i = 0; i < 150 && !pinned.length; i++) {
        pinned = await browser.tabs.query({ url: 'https://example.com/pinned' });
        if (!pinned.length) await new Promise((r) => setTimeout(r, 100));
      }
      const loose = await browser.tabs.query({ url: 'https://example.com/loose' });
      return { result: r.result, groupIds: tabs.map((t) => t.groupId), title: group.title, color: group.color, pinned: pinned[0].pinned, looseGroup: loose[0].groupId };
    `, s.id);
    assert.equal(res.result.opened, 4);
    assert.equal(res.groupIds.length, 2);
    assert.equal(res.groupIds[0], res.groupIds[1]);
    assert.ok(res.groupIds[0] >= 0);
    assert.deepEqual([res.title, res.color, res.pinned, res.looseGroup], ['Research', 'green', true, -1]);
    await closeExtraWindows();
  });

  await step('addresses Firefox refuses to open come back as a placeholder, and re-save as the original', async () => {
    const res = await inPage(driver, `
      const s = await import(browser.runtime.getURL('lib/sessions.js'));
      const meta = await s.createSession({ name: 'privileged', windows: [{ tabs: [
        { url: 'file:///C:/notes/todo.html', title: 'My notes' },
        { url: 'about:config', title: 'Advanced Preferences' },
        { url: 'https://example.com/normal', title: 'Normal' },
      ] }] });
      const r = await browser.runtime.sendMessage({ cmd: 'open', sessionId: meta.id, mode: 'new-window' });
      if (!r.ok) throw new Error(r.error);
      const me = (await browser.tabs.getCurrent()).windowId;
      let opened = [];
      for (let i = 0; i < 100; i++) {
        opened = (await browser.tabs.query({})).filter((t) => t.windowId !== me);
        if (opened.length === 3 && opened.every((t) => t.url && t.url !== 'about:blank')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const again = await browser.runtime.sendMessage({ cmd: 'save', name: 'privileged again', scope: 'window', windowId: opened[0].windowId, closeAfter: true });
      if (!again.ok) throw new Error(again.error);
      return { result: r.result, urls: opened.map((t) => t.url) };
    `);
    assert.equal(res.result.opened, 3);
    assert.equal(res.result.failed, 0);
    assert.equal(res.urls.filter((u) => u.startsWith(`${BASE}/pages/blocked.html?`)).length, 2);
    const again = await until(() => byName('privileged again'), { what: 're-saved session' });
    assert.deepEqual(again.urls, ['file:///C:/notes/todo.html', 'about:config', 'https://example.com/normal']);
  });

  await step('backup: one file per day, written on demand, restorable', async () => {
    await manager('#all');
    const alarm = await inPage(driver, 'const a = await browser.alarms.get("backup"); return a ? a.scheduledTime - Date.now() : null;');
    assert.ok(alarm !== null, 'a library change schedules an automatic backup');
    await click('#btn-settings');
    await until(() => exists('dialog .settings'), { what: 'settings' });
    const buttons = await $$('dialog .settings .row-inline .btn');
    await buttons[0].click();
    await waitToast(/Backup written to Downloads\/SouthpawSessions\/southpaw-backup-\d{4}-\d\d-\d\d\.json\.gz/);
    const dir = join(downloadDir, 'SouthpawSessions');
    const list = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('southpaw-backup-')) : []);
    await until(() => list().length === 1, { what: 'backup file on disk' });
    const first = JSON.parse(gunzipSync(readFileSync(join(dir, list()[0]))).toString('utf8'));
    assert.equal(first.format, 'southpaw-sessions-backup');
    const savedNow = await saved();
    assert.equal(first.counts.sessions, savedNow.length);
    assert.equal(first.tombstones.length, 1);
    assert.equal(first.checks.length, 1);
    assert.ok(first.sessions.some((s) => s.kind === 'closed'), 'recent closed windows are included');
    assert.ok(!first.sessions.some((s) => s.kind === 'current' || s.kind === 'checkpoint'));

    const lastAt = () => inPage(driver, 'return (await browser.storage.local.get("backupState")).backupState.lastAt');
    const firstAt = await lastAt();
    await buttons[0].click();
    await until(async () => (await lastAt()) !== firstAt, { what: 'second backup' });
    assert.equal(await inPage(driver, 'return (await browser.storage.local.get("backupState")).backupState.files.length'), 1);
    assert.equal(list().length, 1, 'the same day overwrites its own file — no pile-up');
    const auto = await inPage(driver, `
      const b = await import(browser.runtime.getURL('lib/backup.js'));
      return b.runBackup();
    `);
    assert.deepEqual(auto, { ok: false, skipped: 'unchanged' }, 'an automatic backup with nothing changed writes nothing');
    await driver.findElement(By.css('dialog .dialog-actions .btn.primary')).click();
    return `${list()[0]}, ${first.sessions.length} sessions`;
  });

  await step('trash: delete a session, restore it', async () => {
    await selectSession('gamma');
    await click('#head button[title="More actions"]');
    await until(() => exists('.menu'), { what: 'more menu' });
    await click('.menu .menu-item.danger');
    await waitToast(/Moved “gamma” to the trash/);
    assert.ok((await byName('gamma')).deletedAt > 0);
    assert.ok(!(await saved()).some((s) => s.name === 'gamma'));
    await manager('#trash');
    await until(() => exists('.list-plain'), { what: 'trash list' });
    assert.match(await text('.panel'), /Deleted sessions \(1\)/);
    assert.match(await text('.panel'), /Removed links \(1\)/, 'the imported deletion is listed and undoable');
    // The archive shows what the removed link was, and can be searched.
    await driver.findElement(By.xpath("//button[contains(., 'Show 1 link')]")).click();
    await until(async () => /alpha tab 2[\s\S]*example\.com\/a2/.test(await text('.rl-list')), { what: 'removed link details' });
    assert.ok(!/Earlier deletions/.test(await text('.panel')), 'a logged deletion is not listed twice');
    await (await $('.rl-search input')).sendKeys('no such link');
    await until(async () => /No removed link matches/.test(await text('.panel')), { what: 'archive search (no match)' });
    await (await $('.rl-search input')).clear();
    await (await $('.rl-search input')).sendKeys('alpha tab');
    await until(async () => /alpha tab 2/.test(await text('.panel')), { what: 'archive search (match)' });
    const restore = (await $$('.list-plain li .btn'))[1];
    await restore.click();
    await until(async () => (await byName('gamma')).deletedAt === null, { what: 'restore' });
  });

  await step('popup: lists sessions, saves, filters', async () => {
    await inPage(driver, 'await browser.tabs.create({ url: "https://example.com/popup-test", discarded: true, title: "x" });');
    await driver.get(`${BASE}/popup/popup.html`);
    await until(async () => (await $$('#sessions .row')).length >= 6, { what: 'popup rows' });
    await (await $('#name')).sendKeys('from the popup', Key.ENTER);
    await until(async () => /Saved “from the popup” — 1 tab/.test(await text('#notice')), { what: 'popup save notice' });
    assert.deepEqual((await byName('from the popup')).urls, ['https://example.com/popup-test']);
    await (await $('#filter')).sendKeys('big');
    await until(async () => (await $$('#sessions .row')).length === 1, { what: 'popup filter' });
    assert.match(await text('#sessions .row'), /big one[\s\S]*150 tabs/);
    await (await $('#sessions .row .row-main')).click();
    await until(() => exists('#sessions .row.confirm'), { what: 'popup confirm for a big session' });
    assert.match(await text('#sessions .row.confirm'), /Open 150 tabs\?/);
  });

  if (process.env.SOUTHPAW_E2E_LINKS) {
    await step('live dead-link check inside Firefox matches expectations', async () => {
      const links = JSON.parse(readFileSync(process.env.SOUTHPAW_E2E_LINKS, 'utf8'));
      await manager('#all');
      await inPage(driver, `
        const s = await import(browser.runtime.getURL('lib/sessions.js'));
        await s.createSession({ name: 'link check', windows: [{ tabs: args[0].map((l) => ({ url: l.url, title: l.expect })) }] });
      `, links);
      await manager('#all');
      await selectSession('link check');
      await click('#check-ui .btn');
      await waitToast(/Checked \d+ links?:/);
      const got = await inPage(driver, `
        const db = await import(browser.runtime.getURL('lib/db.js'));
        const { canonicalize } = await import(browser.runtime.getURL('lib/url.js'));
        const checks = await db.getAllChecks();
        return args[0].map((l) => ({ url: l.url, expect: l.expect, got: checks.get(canonicalize(l.url))?.status ?? null }));
      `, links);
      const wrong = got.filter((g) => g.got !== g.expect);
      assert.deepEqual(wrong, [], 'verdicts differ');
      return `${got.length} links agree`;
    });
  }
}

async function phaseB() {
  // Leave three tabs open, make sure the autosave saw them, then exit Firefox.
  await step('before the restart: autosave has the open tabs', async () => {
    await manager('#all');
    await closeExtraWindows();
    await inPage(driver, `
      for (const u of ['https://example.com/keep1', 'https://example.com/keep2', 'https://example.com/keep3']) {
        await browser.tabs.create({ url: u, discarded: true, title: u, active: false });
      }
    `);
    await until(async () => {
      const cur = (await dbState()).find((s) => s.kind === 'current');
      return cur && cur.urls.length === 3 && cur.urls.every((u) => u.includes('/keep'));
    }, { timeout: 45000, what: 'autosave of the three tabs' });
  });
  const savedBefore = (await saved()).map((s) => s.name).sort();
  await driver.quit();

  driver = await launch({ addon: globalThis.addonPath, profileDir, downloadDir });
  await manager('#all');

  await step('after a restart: the library is intact and the previous browser session is recoverable', async () => {
    assert.deepEqual((await saved()).map((s) => s.name).sort(), savedBefore);
    const prev = await until(async () => (await dbState()).filter((s) => s.kind === 'previous'), { what: 'previous session record' });
    assert.ok(prev.length >= 1, 'a "previous browser session" was recorded');
    const newest = prev[prev.length - 1];
    assert.deepEqual(prev.map((p) => p.urls.sort().join()).includes(['https://example.com/keep1', 'https://example.com/keep2', 'https://example.com/keep3'].join()), true);
    assert.ok(newest.tabCount >= 3);

    // The toolbar popup offers it.
    await driver.get(`${BASE}/popup/popup.html`);
    await until(async () => !(await $('#recover').getAttribute('hidden')), { what: 'recovery strip' });
    assert.match(await text('#recover'), /Previous browser session[\s\S]*3 tabs/);
    const before = (await liveTabs()).length;
    assert.equal(await text('#recover .btn.primary'), 'Restore');
    await inPage(driver, `
      const r = await browser.runtime.sendMessage({ cmd: 'open', sessionId: args[0], mode: 'new-window' });
      if (!r.ok) throw new Error(r.error);
    `, newest.id);
    await until(async () => (await liveTabs()).filter((t) => t.url.includes('/keep')).length === 3, { what: 'restored tabs' });
    return `restored 3 tabs (had ${before} open)`;
  });

  await step('a background reload does not create duplicate records', async () => {
    const count = async () => (await dbState()).filter((s) => s.kind === 'previous').length;
    const n = await count();
    // Simulate what Firefox does when it unloads and re-runs the event page.
    await manager('#all');
    await until(async () => {
      const cur = (await dbState()).find((s) => s.kind === 'current');
      return cur && cur.urls.length === 3 && cur.urls.every((u) => u.includes('/keep'));
    }, { timeout: 45000, what: 'autosave to catch up' });
    const runs = await inPage(driver, `
      const a = await import(browser.runtime.getURL('lib/autosave.js'));
      const out = [];
      for (let i = 0; i < 3; i++) {
        await browser.storage.session.remove('runId');
        out.push(await a.beginRun());
      }
      out.push(await a.beginRun());
      return out;
    `);
    assert.deepEqual(runs.map((r) => r.promoted), [false, false, false, false]);
    assert.deepEqual(runs.map((r) => r.newRun), [true, true, true, false]);
    assert.equal(await count(), n);
    const st = await inPage(driver, 'return (await browser.storage.local.get("backupState")).backupState ?? null;');
    assert.ok(st && st.files.length === 1, 'still exactly one backup file recorded');
  });
}

// ---- main ---------------------------------------------------------------------------------

try {
  globalThis.addonPath = buildAddon();
  const files = writeFixtures();
  console.log(`Firefox end-to-end test (temp dir ${tmp})`);
  driver = await launch({ addon: globalThis.addonPath, profileDir, downloadDir });
  const version = (await driver.getCapabilities()).get('browserVersion');
  console.log(`  Firefox ${version}`);
  await phaseA(files);
  await phaseB();
} catch (e) {
  results.push({ name: 'harness', ok: false });
  console.log(`  FAIL  harness\n        ${e?.stack ?? e}`);
} finally {
  await driver?.quit().catch(() => {});
  cleanup(tmp);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

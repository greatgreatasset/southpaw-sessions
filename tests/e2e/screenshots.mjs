// Dev utility: render the UI with made-up data and save screenshots, for
// checking layout after UI changes.
//
//   node tests/e2e/screenshots.mjs [output-dir] [light|dark]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { By, Key } from 'selenium-webdriver';
import { BASE, buildAddon, cleanup, inPage, launch, makeTempDir, until } from './harness.mjs';

const outDir = resolve(process.argv[2] ?? 'screenshots');
const scheme = process.argv[3] === 'dark' ? 'dark' : 'light';
mkdirSync(outDir, { recursive: true });

const tmp = makeTempDir();
const fx = join(tmp, 'fx');
mkdirSync(fx);

const topics = [
  ['Weekend trip planning', ['Cheap flights to Lisbon — Skyscanner|https://www.skyscanner.net/transport/flights/lis/', 'Lisbon travel guide — Lonely Planet|https://www.lonelyplanet.com/portugal/lisbon', '36 Hours in Lisbon|https://www.nytimes.com/interactive/2023/travel/things-to-do-lisbon.html', 'Tram 28 route map and tips|https://www.lisbon.net/tram-28', 'Pastéis de Belém — the original recipe since 1837|https://pasteisdebelem.pt/en/', 'Lisbon weather forecast|https://www.bbc.com/weather/2267057']],
  ['Keyboard build research', ['r/MechanicalKeyboards — beginner guide|https://old.reddit.com/r/MechanicalKeyboards/wiki/buyingguide', 'Switch comparison chart|https://switches.mx/', 'Lubing switches: a complete guide|https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Typing sound test compilation|https://www.youtube.com/watch?v=jNQXAC9IVRw', 'Keycap profiles compared|https://imgur.com/a/TnQ4j', 'GMMK Pro review — Rtings|https://www.rtings.com/keyboard/reviews/glorious/gmmk-pro', 'mechanical keyboard lube — YouTube|https://www.youtube.com/results?search_query=mechanical+keyboard+lube']],
  ['Reading list — autumn', ['The Case for Slow Software|https://example.org/essays/slow-software', 'How DNS works, a comic|https://howdns.works/', 'Lubing switches: a complete guide|https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s', 'Local-first software|https://www.inkandswitch.com/local-first/', 'A long-form history of the web browser|https://example.org/history/browsers', 'Crafting Interpreters|https://craftinginterpreters.com/contents.html']],
  ['Apartment hunt', ['2-bed near the park — listing 48213|https://example.com/listings/48213', 'Floor plan (image)|https://i.imgur.com/Zk3pQ9x.png', 'Kitchen photo|https://imgur.com/h7Rw2Lm', 'Commute time calculator|https://example.com/commute?from=park&to=center', 'Tenant rights overview|https://example.gov/housing/tenant-rights']],
];
const sessions = topics.map(([title, tabs], i) => ({
  title, date: `${3 + i * 6}/${9 + (i % 3)}/2026_${10 + i}:${15 + i * 7}`, folderId: `FX${i}`, urls: [], tabsCount: tabs.length,
  windows: i === 1
    ? { w1: tabs.slice(0, 4).map((t) => ({ title: t.split('|')[0], url: t.split('|')[1] })), w2: tabs.slice(4).map((t) => ({ title: t.split('|')[0], url: t.split('|')[1] })) }
    : { w1: tabs.map((t) => ({ title: t.split('|')[0], url: t.split('|')[1] })) },
  labels: {},
}));
for (let i = 0; i < 14; i++) {
  sessions.push({
    title: ['Recipes to try', 'Conference talks', 'Bike repair', 'Gift ideas', 'Tax paperwork', 'Garden plans', 'Job applications', 'Movie night shortlist', 'Home network notes', 'Language learning', 'Photo editing tutorials', 'Board games', 'Running plan', 'Old bookmarks'][i],
    date: `${1 + i}/${1 + (i % 8)}/2025_9:${10 + i}`, folderId: `FY${i}`, urls: [], tabsCount: 3,
    windows: { w: Array.from({ length: 3 + (i % 5) * 4 }, (_, k) => ({ title: `Reference page ${k + 1} for topic ${i + 1}`, url: `https://example.org/topic-${i + 1}/page-${k + 1}` })) },
    labels: {},
  });
}
const lib = join(fx, 'library.mysessions');
writeFileSync(lib, JSON.stringify(sessions));
const state = join(fx, 'state.json');
writeFileSync(state, JSON.stringify({
  format: 'southpaw-analyzer-state',
  tombstones: [],
  checks: [
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', status: 'alive', httpCode: 200, checkedAt: Date.now() },
    { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', status: 'paywalled', httpCode: 200, checkedAt: Date.now() },
    { url: 'https://imgur.com/a/TnQ4j', status: 'dead', httpCode: 301, checkedAt: Date.now() },
    { url: 'https://i.imgur.com/Zk3pQ9x.png', status: 'alive', httpCode: 200, checkedAt: Date.now() },
    { url: 'https://imgur.com/h7Rw2Lm', status: 'unknown', checkedAt: Date.now() },
  ],
}));

const driver = await launch({
  addon: buildAddon(),
  downloadDir: join(tmp, 'dl'),
  prefs: { 'layout.css.prefers-color-scheme.content-override': scheme === 'dark' ? 0 : 1 },
});
const $ = (css) => driver.findElement(By.css(css));
const exists = async (css) => (await driver.findElements(By.css(css))).length > 0;
const shot = async (name) => {
  await new Promise((r) => setTimeout(r, 350));
  const file = join(outDir, `${name}-${scheme}.png`);
  writeFileSync(file, Buffer.from(await driver.takeScreenshot(), 'base64'));
  console.log(file);
};

try {
  await driver.manage().window().setRect({ width: 1440, height: 900, x: 0, y: 0 });
  await driver.get(`${BASE}/pages/manager.html`);
  await until(() => exists('#head h2'));
  await shot('01-welcome');

  await $('#btn-import').click();
  await until(() => exists('dialog .drop'));
  await shot('02-import-choose');
  await (await $('dialog input[type=file][multiple]')).sendKeys([lib, state].join('\n'));
  await until(() => exists('dialog dl.kv'));
  await shot('03-import-plan');
  await $('dialog .dialog-actions .btn.primary').click();
  await until(async () => /Sessions added/.test(await (await $('dialog')).getText()));
  await shot('04-import-done');
  await $('dialog .dialog-actions .btn.primary').click();

  await driver.get(`${BASE}/pages/manager.html#all`);
  await until(() => exists('.lt-row'));
  await shot('05-all-links');

  await (await $('#toolbar input[type=search]')).sendKeys('lubing');
  await until(async () => (await driver.findElements(By.css('.lt-row'))).length <= 3);
  await $('.lt-row .c-sessions .count').click();
  await shot('06-search-and-sessions-menu');
  await driver.actions().sendKeys(Key.ESCAPE).perform();

  const id = await inPage(driver, `
    const db = await import(browser.runtime.getURL('lib/db.js'));
    return (await db.listMeta()).find((m) => m.name === 'Keyboard build research').id;
  `);
  await driver.get(`${BASE}/pages/manager.html#s/${id}`);
  await until(async () => (await (await $('#head h2')).getText()) === 'Keyboard build research');
  await shot('07-session');
  // Rows are re-rendered after every selection change, so look them up again.
  await (await driver.findElements(By.css('.lt-row [data-act=pick]')))[0].click();
  await (await driver.findElements(By.css('.lt-row [data-act=pick]')))[2].click();
  await shot('08-selection');
  await $('#head button[title="More actions"]').click();
  await shot('09-more-menu');
  await driver.actions().sendKeys(Key.ESCAPE).perform();
  await (await driver.findElements(By.css('.lt-row [data-act=remove]')))[1].click();
  await shot('10-removed-toast');

  await $('#btn-save').click();
  await until(() => exists('dialog form'));
  await shot('11-save-dialog');
  await inPage(driver, 'document.querySelector("dialog").close();');

  await $('#btn-settings').click();
  await until(() => exists('dialog .settings'));
  await shot('12-settings');
  await inPage(driver, 'document.querySelector("dialog").scrollTop = 9999;');
  await shot('13-settings-bottom');
  await inPage(driver, 'document.querySelector("dialog").close();');

  await driver.get(`${BASE}/pages/manager.html#trash`);
  await until(() => exists('.panel h3'));
  await driver.findElement(By.xpath("//button[contains(., 'Show 1 link')]")).click();
  await shot('14-trash');

  await driver.manage().window().setRect({ width: 416, height: 640, x: 0, y: 0 });
  await driver.get(`${BASE}/popup/popup.html`);
  await until(async () => (await driver.findElements(By.css('#sessions .row'))).length > 3);
  await shot('15-popup');
} finally {
  await driver.quit();
  cleanup(tmp);
}

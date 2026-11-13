// Opt-in scale check: import real files into a throwaway Firefox profile and
// report counts and timings. Nothing is written back to the source files, and
// only numbers are printed — never session names or links.
//
//   node tests/e2e/real-data.mjs <file-or-folder> [<file-or-folder> ...]
//
// Each argument is imported as one batch, in order (a folder = every file in it;
// append ":N" to a folder to take only its N newest files).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { By } from 'selenium-webdriver';
import { BASE, buildAddon, cleanup, inPage, launch, makeTempDir, until } from './harness.mjs';

const batches = process.argv.slice(2).map((arg) => {
  const m = /^(.*):(\d+)$/.exec(arg);
  const path = resolve(m && !existsSync(arg) ? m[1] : arg);
  const limit = m && !existsSync(arg) ? Number(m[2]) : Infinity;
  if (!statSync(path).isDirectory()) return { label: arg, files: [path] };
  const files = readdirSync(path)
    .map((f) => join(path, f))
    .filter((f) => statSync(f).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
  return { label: arg, files };
});
if (!batches.length) {
  console.error('usage: node tests/e2e/real-data.mjs <file-or-folder> [...]');
  process.exit(1);
}

const tmp = makeTempDir();
const downloadDir = join(tmp, 'downloads');
const driver = await launch({ addon: buildAddon(), downloadDir });
const $ = (css) => driver.findElement(By.css(css));
const exists = async (css) => (await driver.findElements(By.css(css))).length > 0;
const text = async (css) => (await $(css)).getText();
const ms = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

try {
  await driver.get(`${BASE}/pages/manager.html`);
  await until(() => exists('#head h2'), { what: 'manager page' });

  for (const batch of batches) {
    const bytes = batch.files.reduce((n, f) => n + statSync(f).size, 0);
    console.log(`\n== import ${batch.label}: ${batch.files.length} file(s), ${(bytes / 1048576).toFixed(0)} MB`);
    await $('#btn-import').click();
    const input = await until(() => $('dialog input[type=file][multiple]'), { what: 'file input' });
    let t0 = Date.now();
    await input.sendKeys(batch.files.join('\n'));
    await until(() => exists('dialog dl.kv'), { timeout: 30 * 60000, interval: 500, what: 'import plan' });
    console.log(`   analysed in ${ms(t0)}`);
    // Summary rows only (labels + numbers); file-level error lines are counted, not printed.
    const rows = await inPage(driver, `
      const out = [];
      const dl = document.querySelector('dialog dl.kv');
      const dts = [...dl.querySelectorAll('dt')], dds = [...dl.querySelectorAll('dd')];
      dts.forEach((dt, i) => out.push(dt.textContent.trim() + ': ' + dds[i].textContent.trim()));
      out.push('unrecognised file lines: ' + document.querySelectorAll('dialog .errors > div').length);
      return out;
    `);
    for (const r of rows) console.log(`   ${r}`);
    const go = await $('dialog .dialog-actions .btn.primary');
    console.log(`   button: "${await go.getText()}"`);
    if (await go.isEnabled()) {
      t0 = Date.now();
      await go.click();
      await until(async () => /Sessions added/.test(await text('dialog')), { timeout: 10 * 60000, what: 'import result' });
      console.log(`   written in ${ms(t0)}`);
      const res = await inPage(driver, `
        const dl = document.querySelector('dialog dl.kv');
        const dts = [...dl.querySelectorAll('dt')], dds = [...dl.querySelectorAll('dd')];
        return dts.map((dt, i) => dt.textContent.trim() + ': ' + dds[i].textContent.trim());
      `);
      for (const r of res) console.log(`   -> ${r}`);
      await $('dialog .dialog-actions .btn.primary').click();
    } else {
      await $('dialog .dialog-actions .btn').click();
    }
  }

  console.log('\n== library');
  let t0 = Date.now();
  await driver.get(`${BASE}/pages/manager.html#all`);
  await until(() => exists('.lt-row'), { timeout: 120000, what: 'link table' });
  console.log(`   manager page ready in ${ms(t0)}`);
  console.log(`   ${await text('#stats')}`);
  console.log(`   ${await text('.head-sub')}`);
  console.log(`   coverage: ${(await text('#check-ui')).replace(/\s+/g, ' ')}`);

  const timings = await inPage(driver, `
    const lib = await import(browser.runtime.getURL('lib/library.js'));
    const db = await import(browser.runtime.getURL('lib/db.js'));
    const t = {};
    let t0 = performance.now();
    const [metas, data, checks] = await Promise.all([db.listMeta(), db.getAllData(), db.getAllChecks()]);
    t.loadMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const rows = lib.buildLibrary(metas, data, checks);
    t.buildMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const sorted = lib.sortRows(rows, 'title', 'asc');
    t.sortMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const hits = lib.filterRows(sorted, { q: 'youtube watch' }).length;
    t.filterMs = Math.round(performance.now() - t0);
    const kinds = {};
    const status = {};
    for (const r of rows) {
      kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      status[r.status ?? 'unchecked'] = (status[r.status ?? 'unchecked'] ?? 0) + 1;
    }
    const est = await navigator.storage.estimate();
    const tomb = await db.getTombstoneIndex();
    return { ...t, rows: rows.length, hits, kinds, status, multi: rows.filter((r) => r.sessionCount > 1).length,
      tombstones: tomb.count, storageMB: Math.round((est.usage ?? 0) / 1048576),
      domRows: document.querySelectorAll('.lt-row').length };
  `);
  console.log(`   load ${timings.loadMs} ms · build ${timings.buildMs} ms · sort ${timings.sortMs} ms · filter ${timings.filterMs} ms (${timings.hits} hits)`);
  console.log(`   ${timings.rows} unique links · ${timings.multi} in more than one session · ${timings.domRows} rows in the DOM`);
  console.log(`   kinds ${JSON.stringify(timings.kinds)}`);
  console.log(`   status ${JSON.stringify(timings.status)}`);
  console.log(`   deleted-link records ${timings.tombstones} · storage ${timings.storageMB} MB`);

  t0 = Date.now();
  const backup = await inPage(driver, `
    const r = await browser.runtime.sendMessage({ cmd: 'backupNow' });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  `);
  console.log(`\n== backup: ${backup.ok ? `${(backup.file.bytes / 1048576).toFixed(2)} MB, ${backup.file.sessions} sessions, ${backup.file.tabs} tabs, written in ${ms(t0)}` : JSON.stringify(backup)}`);
} finally {
  await driver.quit();
  cleanup(tmp);
}

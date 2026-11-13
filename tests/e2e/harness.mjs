// Shared helpers for the end-to-end tests: start a real (headless) Firefox on a
// throwaway profile, install the extension temporarily, and talk to its pages.
// Nothing here touches your normal Firefox profile or your Downloads folder.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, Browser } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const ADDON_ID = 'southpaw-sessions@kirk.local';
// Pinned so the extension's pages have a known address.
export const UUID = '5c1a0b6e-7d1f-4c1e-9a53-50a7b9a55e55';
export const BASE = `moz-extension://${UUID}`;

/** Zip the extension (web-ext build) and return the archive path. */
export function buildAddon() {
  const out = join(ROOT, 'dist');
  const bin = join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  execFileSync(process.execPath, [bin, 'build', '-s', join(ROOT, 'extension'), '-a', out, '--overwrite-dest'], { stdio: 'pipe' });
  const zip = readdirSync(out).filter((f) => f.endsWith('.zip')).sort().pop();
  if (!zip) throw new Error('web-ext build produced no archive');
  return join(out, zip);
}

export function makeTempDir(prefix = 'southpaw-e2e-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {{addon: string, profileDir?: string, downloadDir: string, headless?: boolean, prefs?: Record<string, any>}} o
 */
export async function launch({ addon, profileDir, downloadDir, headless = process.env.SOUTHPAW_E2E_HEADED !== '1', prefs = {} }) {
  mkdirSync(downloadDir, { recursive: true });
  const options = new firefox.Options();
  if (headless) options.addArguments('-headless');
  if (profileDir) {
    mkdirSync(profileDir, { recursive: true });
    options.addArguments('-profile', profileDir);
  }
  options.setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }));
  // Keep the extension's data when the temporary install goes away, so a
  // second launch on the same profile sees it (crash-recovery test).
  options.setPreference('extensions.webextensions.keepStorageOnUninstall', true);
  options.setPreference('extensions.webextensions.keepUuidOnUninstall', true);
  options.setPreference('browser.download.folderList', 2);
  options.setPreference('browser.download.dir', downloadDir);
  options.setPreference('browser.download.useDownloadDir', true);
  options.setPreference('browser.download.alwaysOpenPanel', false);
  options.setPreference('browser.startup.page', 0); // never restore the previous session by itself
  options.setPreference('browser.sessionstore.resume_from_crash', false);
  options.setPreference('browser.shell.checkDefaultBrowser', false);
  options.setPreference('datareporting.policy.dataSubmissionEnabled', false);
  options.setPreference('browser.aboutwelcome.enabled', false);
  for (const [name, value] of Object.entries(prefs)) options.setPreference(name, value);
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

  // Firefox 138+ only lets WebDriver open privileged pages (moz-extension:)
  // when geckodriver is started with system access allowed.
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser(Browser.FIREFOX).setFirefoxOptions(options).setFirefoxService(service).build();
  await driver.manage().setTimeouts({ script: 120000, pageLoad: 60000 });
  await /** @type {any} */ (driver).installAddon(addon, true);

  // On a fresh profile the extension opens its welcome page in a new,
  // focused tab. Drive THAT tab and drop the blank one: Firefox throttles
  // timers to one second in background tabs, which would distort every wait.
  const original = await driver.getWindowHandle();
  let other = null;
  for (let i = 0; i < 12 && !other; i++) {
    other = (await driver.getAllWindowHandles()).find((handle) => handle !== original) ?? null;
    if (!other) await new Promise((r) => setTimeout(r, 250));
  }
  if (other) {
    await driver.close();
    await driver.switchTo().window(other);
  }
  return driver;
}

/**
 * Run async code inside the current extension page. The body receives `args`
 * and may use `browser.*`; its return value (JSON-serialisable) comes back.
 */
export async function inPage(driver, body, ...args) {
  const res = await driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     const args = Array.prototype.slice.call(arguments, 0, -1);
     (async () => { ${body} })().then(
       (value) => done({ ok: true, value }),
       (e) => done({ ok: false, error: String(e) + (e && e.stack ? ' @ ' + e.stack : '') }));`,
    ...args,
  );
  if (!res.ok) throw new Error(`in-page script failed: ${res.error}`);
  return res.value;
}

/** Poll until `fn` returns a truthy value. */
export async function until(fn, { timeout = 30000, interval = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function cleanup(...dirs) {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // A lingering Firefox handle on Windows; the OS temp cleaner gets it.
    }
  }
}

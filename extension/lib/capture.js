// Capture the live browser (all windows, one window, or chosen tabs) into the
// session shape.
import { newTid } from './model.js';
import { isMeaningfulUrl } from './url.js';

/** @typedef {import('./model.js').Win} Win */

const BLOCKED_PAGE = 'pages/blocked.html';

/** URL of the placeholder page shown for addresses Firefox won't let us open. */
export function blockedPageUrl(url, title) {
  const q = new URLSearchParams({ u: url, t: title ?? '' });
  return `${browser.runtime.getURL(BLOCKED_PAGE)}?${q}`;
}

/**
 * If `url` is one of our placeholder pages, return the address it stands for,
 * so re-saving a restored session keeps the original links.
 * @param {string} url
 * @returns {{url: string, title: string} | null}
 */
export function unwrapBlockedUrl(url) {
  const base = browser.runtime.getURL(BLOCKED_PAGE);
  if (!url || !url.startsWith(base)) return null;
  try {
    const q = new URL(url).searchParams;
    const original = q.get('u');
    return original ? { url: original, title: q.get('t') ?? '' } : null;
  } catch {
    return null;
  }
}

/** Our own UI pages are never part of a session. */
function isOwnPage(url) {
  return url.startsWith(browser.runtime.getURL('')) && !url.startsWith(browser.runtime.getURL(BLOCKED_PAGE));
}

/**
 * Whether a live tab would be part of a saved session (used for the counts
 * shown before saving, so they match what a save captures).
 * @param {browser.tabs.Tab} tab
 */
export function isSavableTab(tab) {
  return toSavedTab(tab) !== null;
}

/**
 * @param {browser.tabs.Tab} tab
 * @returns {{url: string, title: string, pinned?: boolean} | null}
 */
function toSavedTab(tab) {
  let url = tab.url || '';
  let title = tab.title || '';
  if (!url || isOwnPage(url)) return null;
  const wrapped = unwrapBlockedUrl(url);
  if (wrapped) ({ url, title } = wrapped);
  // Blank and new-tab pages carry nothing worth bringing back.
  if (!isMeaningfulUrl(url)) return null;
  // A tab that never loaded reports its URL as its title — not worth storing.
  if (title === url) title = '';
  const out = { url, title };
  if (tab.pinned) out.pinned = true;
  return out;
}

/**
 * @typedef {object} CaptureResult
 * @property {Win[]} windows
 * @property {number} tabCount
 * @property {number[]} tabIds   live ids of every captured tab
 * @property {number} pending    tabs that have not reported their address yet
 */

/**
 * @param {object} [opts]
 * @param {'all' | 'window' | 'tabs'} [opts.scope]
 * @param {number} [opts.windowId]     for scope 'window' (default: current)
 * @param {number[]} [opts.tabIds]     for scope 'tabs'
 * @param {boolean} [opts.includePrivate]
 * @param {boolean} [opts.withWinId]   tag windows with their live id (autosave)
 * @returns {Promise<CaptureResult>}
 */
export async function captureWindows({ scope = 'all', windowId, tabIds, includePrivate = false, withWinId = false } = {}) {
  /** @type {browser.windows.Window[]} */
  let wins;
  if (scope === 'window') {
    const w = windowId != null
      ? await browser.windows.get(windowId, { populate: true })
      : await browser.windows.getCurrent({ populate: true });
    wins = [w];
  } else {
    wins = await browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
  }
  const only = scope === 'tabs' ? new Set(tabIds ?? []) : null;

  /** @type {Win[]} */
  const windows = [];
  const captured = [];
  let pending = 0;
  for (const w of wins) {
    if (w.type && w.type !== 'normal') continue;
    if (w.incognito && !includePrivate) continue;
    const liveTabs = [...(w.tabs ?? [])].sort((a, b) => a.index - b.index);
    const tabs = [];
    /** @type {Map<number, string>} live group id -> key */
    const groupKeys = new Map();
    for (const lt of liveTabs) {
      if (only && !only.has(lt.id)) continue;
      // A tab that just started loading (for instance an unloaded tab the user
      // clicked) reports about:blank until the page commits.
      if (lt.status === 'loading' && (!lt.url || lt.url === 'about:blank')) pending++;
      const saved = toSavedTab(lt);
      if (!saved) continue;
      /** @type {import('./model.js').Tab} */
      const tab = { t: newTid(), ...saved };
      const gid = /** @type {any} */ (lt).groupId;
      if (typeof gid === 'number' && gid >= 0) {
        if (!groupKeys.has(gid)) groupKeys.set(gid, `g${groupKeys.size + 1}`);
        tab.g = groupKeys.get(gid);
      }
      tabs.push(tab);
      captured.push(lt.id);
    }
    if (!tabs.length) continue;
    /** @type {Win} */
    const win = { tabs };
    if (withWinId) win.winId = w.id;
    if (groupKeys.size) {
      const groups = await describeGroups(groupKeys);
      if (groups.length) win.groups = groups;
    }
    windows.push(win);
  }
  return { windows, tabCount: captured.length, tabIds: captured, pending };
}

/**
 * Capture for a user-requested save: if some tabs have not reported their
 * address yet, wait briefly for them rather than saving without them.
 * @param {Parameters<typeof captureWindows>[0]} [opts]
 * @param {number} [timeoutMs]
 * @returns {Promise<CaptureResult>}
 */
export async function captureSettled(opts, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cap = await captureWindows(opts);
    if (!cap.pending || Date.now() >= deadline) return cap;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Look up title/colour of live tab groups (Firefox 139+; absent elsewhere). */
async function describeGroups(groupKeys) {
  const api = /** @type {any} */ (browser).tabGroups;
  const out = [];
  for (const [gid, k] of groupKeys) {
    /** @type {import('./model.js').TabGroup} */
    const g = { k };
    try {
      const info = await api?.get?.(gid);
      if (info?.title) g.title = info.title;
      if (info?.color) g.color = info.color;
      if (info?.collapsed) g.collapsed = true;
    } catch {
      // No tabGroups API or the group vanished — keep the bare grouping.
    }
    out.push(g);
  }
  return out;
}

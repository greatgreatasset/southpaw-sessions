// Open saved tabs back into the browser. Runs in the background script — the
// popup that asked for it closes the moment a new window takes focus.
import { blockedPageUrl } from './capture.js';
import { isOpenableUrl } from './url.js';

/** @typedef {import('./model.js').Win} Win */
/** @typedef {import('./model.js').Tab} Tab */

/**
 * `about:reader?url=<encoded>` -> the article URL (opened in reader mode).
 * @param {string} url
 */
function readerTarget(url) {
  if (!/^about:reader\?/i.test(url)) return null;
  try {
    return new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('url');
  } catch {
    return null;
  }
}

/**
 * Create one tab. Tries the cheapest form first (unloaded), then falls back:
 * loaded tab -> placeholder page for addresses Firefox refuses to open.
 * @param {Tab | {url: string, title?: string, pinned?: boolean}} tab
 * @param {{windowId: number, lazy: boolean, index?: number}} opts
 * @returns {Promise<browser.tabs.Tab | null>}
 */
async function createTab(tab, { windowId, lazy, index }) {
  /** @type {browser.tabs._CreateCreateProperties} */
  const base = { windowId, active: false };
  if (index != null) base.index = index;
  if (tab.pinned) base.pinned = true;

  const reader = readerTarget(tab.url);
  const url = reader ?? tab.url;
  const attempts = [];
  if (isOpenableUrl(url) && url !== 'about:blank') {
    // Firefox cannot create a tab that is both unloaded and pinned.
    if (lazy && !tab.pinned && !reader && /^https?:/i.test(url)) {
      attempts.push({ ...base, url, discarded: true, title: tab.title || url });
    }
    attempts.push(reader ? { ...base, url, openInReaderMode: true } : { ...base, url });
  } else if (url === 'about:blank') {
    attempts.push({ ...base, url });
  }
  attempts.push({ ...base, url: blockedPageUrl(tab.url, tab.title) });

  for (const props of attempts) {
    try {
      return await browser.tabs.create(props);
    } catch {
      // Try the next, more conservative form.
    }
  }
  return null;
}

/** Recreate tab groups in a window (no-op where the API is missing). */
async function restoreGroups(windowId, win, created) {
  if (!win.groups?.length || typeof browser.tabs.group !== 'function') return;
  for (const g of win.groups) {
    const tabIds = created.filter((c) => c.saved.g === g.k && !c.saved.pinned).map((c) => c.live.id);
    if (!tabIds.length) continue;
    try {
      const groupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
      /** @type {any} */
      const update = {};
      if (g.title) update.title = g.title;
      if (g.color) update.color = g.color;
      if (g.collapsed) update.collapsed = true;
      if (Object.keys(update).length) await /** @type {any} */ (browser).tabGroups?.update?.(groupId, update);
    } catch {
      // Grouping is a nicety; the tabs themselves are already open.
    }
  }
}

/**
 * Open windows of saved tabs.
 *
 * mode 'new-window'     — one new browser window per saved window
 * mode 'current-window' — append everything to an existing window
 *
 * @param {Win[]} windows
 * @param {{mode?: 'new-window' | 'current-window', lazy?: boolean, windowId?: number}} [opts]
 * @returns {Promise<{opened: number, failed: number, windows: number}>}
 */
export async function openWindows(windows, { mode = 'new-window', lazy = true, windowId } = {}) {
  const wins = (windows ?? []).filter((w) => w.tabs?.length);
  let opened = 0;
  let failed = 0;
  let windowCount = 0;

  if (mode === 'current-window') {
    const targetId = windowId ?? (await browser.windows.getLastFocused({ windowTypes: ['normal'] })).id;
    for (const win of wins) {
      const created = [];
      for (const saved of win.tabs) {
        const live = await createTab(saved, { windowId: targetId, lazy });
        if (live) created.push({ saved, live });
        else failed++;
      }
      opened += created.length;
      await restoreGroups(targetId, win, created);
    }
    return { opened, failed, windows: 0 };
  }

  for (const win of wins) {
    // The new window starts with one blank tab; it is removed once the real
    // tabs exist (a window may never be left with zero tabs).
    const liveWin = await browser.windows.create({});
    const blankIds = (liveWin.tabs ?? []).map((t) => t.id);
    const created = [];
    for (const saved of win.tabs) {
      const live = await createTab(saved, { windowId: liveWin.id, lazy });
      if (live) created.push({ saved, live });
      else failed++;
    }
    if (!created.length) continue; // keep the blank tab; nothing could be opened
    windowCount++;
    opened += created.length;

    // Show the first tab (this is what loads it), then drop the blank one.
    const first = created.find((c) => !c.saved.pinned) ?? created[0];
    try {
      await browser.tabs.update(first.live.id, { active: true });
      if (blankIds.length) await browser.tabs.remove(blankIds);
    } catch {
      // The user may already be interacting with the window.
    }
    await restoreGroups(liveWin.id, win, created);
  }
  return { opened, failed, windows: windowCount };
}

/**
 * Open a loose list of links.
 * @param {{url: string, title?: string, pinned?: boolean}[]} tabs
 * @param {{mode?: 'new-window' | 'current-window', lazy?: boolean, windowId?: number}} [opts]
 */
export function openLinks(tabs, opts) {
  return openWindows([{ tabs: /** @type {any} */ (tabs) }], opts);
}

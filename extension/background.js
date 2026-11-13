// Background event page. Firefox loads and unloads this script at will, so:
//   - every listener is registered synchronously at the top level;
//   - no decision depends on in-memory state surviving, or on how many times
//     this file has been evaluated (see lib/autosave.js and lib/backup.js).
import { applyRetention, beginRun, recordClosedWindow, snapshot } from './lib/autosave.js';
import { getBackupState, runBackup } from './lib/backup.js';
import { captureSettled } from './lib/capture.js';
import * as db from './lib/db.js';
import { KIND, defaultSessionName } from './lib/model.js';
import { openLinks, openWindows } from './lib/restore.js';
import { createSession, purgeExpired, replaceWindows } from './lib/sessions.js';
import { getSettings } from './lib/settings.js';

const ALARM_BACKUP = 'backup';
const ALARM_HOUSEKEEPING = 'housekeeping';
const ALARM_SNAPSHOT = 'snapshot';

// ---- start-up ---------------------------------------------------------------

const ready = init().catch((e) => console.error('[southpaw] init failed', e));

async function init() {
  const run = await beginRun();
  if (!(await browser.alarms.get(ALARM_HOUSEKEEPING))) {
    browser.alarms.create(ALARM_HOUSEKEEPING, { delayInMinutes: 5, periodInMinutes: 12 * 60 });
  }
  // Safety net for the event-driven autosave below.
  if (!(await browser.alarms.get(ALARM_SNAPSHOT))) {
    browser.alarms.create(ALARM_SNAPSHOT, { delayInMinutes: 1, periodInMinutes: 5 });
  }
  if (run.newRun) await scheduleBackupIfDue();
}

// ---- autosave ---------------------------------------------------------------

let snapshotTimer = null;
let snapshotDue = 0;
let firstPendingAt = 0;
let quietUntil = 0; // suppress "closed window" records while we close tabs ourselves

/**
 * Debounced autosave: `delay` ms after the last change, but a steady stream of
 * changes still gets saved at least every 20 s.
 */
function scheduleSnapshot(delay = 3000) {
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  // A later, shorter request must not pull an earlier, longer deadline forward
  // (the long one follows a window closing — see onWindowRemoved).
  const due = Math.min(Math.max(snapshotDue, now + delay), firstPendingAt + 20000);
  snapshotDue = due;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(runSnapshot, Math.max(0, due - now));
}

async function runSnapshot() {
  snapshotTimer = null;
  snapshotDue = 0;
  firstPendingAt = 0;
  try {
    await ready;
    await snapshot();
  } catch (e) {
    console.error('[southpaw] autosave failed', e);
  }
}

browser.tabs.onCreated.addListener(() => scheduleSnapshot());
browser.tabs.onMoved.addListener(() => scheduleSnapshot());
browser.tabs.onAttached.addListener(() => scheduleSnapshot());
browser.tabs.onDetached.addListener(() => scheduleSnapshot());
browser.tabs.onRemoved.addListener((_tabId, info) => {
  // Tabs dying with their window are handled by windows.onRemoved.
  if (!info.isWindowClosing) scheduleSnapshot();
});
browser.tabs.onUpdated.addListener(() => scheduleSnapshot(), { properties: ['url', 'title', 'pinned'] });
browser.windows.onCreated.addListener(() => scheduleSnapshot());

browser.windows.onRemoved.addListener(async (windowId) => {
  // Wait well past a browser exit: when Firefox quits, its windows close one
  // by one, and a snapshot taken in between would record half a browser.
  scheduleSnapshot(10000);
  try {
    await ready;
    if (Date.now() >= quietUntil) await recordClosedWindow(windowId);
  } catch (e) {
    console.error('[southpaw] closed-window record failed', e);
  }
});

// ---- backups ------------------------------------------------------------------

async function scheduleBackupIfDue() {
  const settings = await getSettings();
  if (!settings.backupEnabled) return;
  const state = await getBackupState();
  const { libraryChangedAt = 0 } = await browser.storage.local.get('libraryChangedAt');
  if (libraryChangedAt <= state.lastChangedAt) return;
  if (await browser.alarms.get(ALARM_BACKUP)) return;
  const earliest = state.lastAt + settings.backupMinIntervalMin * 60000;
  // Two minutes of slack lets a burst of edits settle into one backup.
  browser.alarms.create(ALARM_BACKUP, { when: Math.max(Date.now() + 2 * 60000, earliest) });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.libraryChangedAt) scheduleBackupIfDue().catch(() => {});
  if (changes.settings) {
    applyRetention().catch(() => {});
    scheduleBackupIfDue().catch(() => {});
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === ALARM_SNAPSHOT) {
    await snapshot().catch((e) => console.error('[southpaw] autosave failed', e));
  } else if (alarm.name === ALARM_BACKUP) {
    const res = await runBackup();
    if (!res.ok && 'skipped' in res && res.skipped === 'too-soon') {
      browser.alarms.create(ALARM_BACKUP, { when: res.retryAt });
    } else if (!res.ok && 'error' in res) {
      browser.alarms.create(ALARM_BACKUP, { delayInMinutes: 15 });
    }
  } else if (alarm.name === ALARM_HOUSEKEEPING) {
    const settings = await getSettings();
    await purgeExpired({ trashDays: settings.trashDays }).catch(() => {});
    await scheduleBackupIfDue().catch(() => {});
  }
});

// ---- lifecycle ------------------------------------------------------------------

// Registered so a browser start wakes this page; init() above does the work.
browser.runtime.onStartup.addListener(() => {});

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  await ready;
  const metas = await db.listMeta();
  if (!metas.some((m) => m.kind === KIND.SAVED)) {
    await browser.tabs.create({ url: browser.runtime.getURL('pages/manager.html#welcome') });
  }
});

// ---- commands from the popup / manager page -----------------------------------------

/**
 * Capture + store a session; optionally close what was saved.
 * @param {{name?: string, scope?: 'all' | 'window' | 'tabs', windowId?: number, tabIds?: number[], closeAfter?: boolean}} args
 */
async function saveSession({ name, scope = 'all', windowId, tabIds, closeAfter = false }) {
  const settings = await getSettings();
  const cap = await captureSettled({ scope, windowId, tabIds, includePrivate: settings.savePrivate });
  if (!cap.tabCount) throw new Error('There are no tabs to save.');
  const meta = await createSession({ name: String(name ?? '').trim() || defaultSessionName(), windows: cap.windows });

  if (closeAfter) {
    const captured = new Set(cap.tabIds);
    const all = await browser.tabs.query({});
    // Closing the last tab would quit the browser — leave a fresh one behind.
    if (!all.some((t) => !captured.has(t.id))) {
      await browser.tabs.create(windowId != null ? { windowId } : {});
    }
    quietUntil = Date.now() + 8000;
    await browser.tabs.remove(cap.tabIds);
  }
  return { id: meta.id, name: meta.name, tabCount: meta.tabCount, windowCount: meta.windowCount };
}

/** @type {Record<string, (args: any) => Promise<any>>} */
const handlers = {
  save: saveSession,

  /** Open a stored session, or only the tabs listed in `tids`. */
  async open({ sessionId, mode = 'new-window', tids, windowId }) {
    const session = await db.getSession(sessionId);
    if (!session) throw new Error('That session no longer exists.');
    let windows = session.windows;
    if (Array.isArray(tids)) {
      const wanted = new Set(tids);
      windows = windows.map((w) => ({ ...w, tabs: w.tabs.filter((t) => wanted.has(t.t)) }));
    }
    const settings = await getSettings();
    return openWindows(windows, { mode, lazy: settings.lazyRestore, windowId });
  },

  /** Open loose links (a selection in the library). */
  async openLinks({ links, mode = 'new-window', windowId }) {
    const settings = await getSettings();
    return openLinks(links ?? [], { mode, lazy: settings.lazyRestore, windowId });
  },

  /** Re-save over an existing session with what is open now. */
  async replace({ sessionId, scope = 'all', windowId }) {
    const settings = await getSettings();
    const cap = await captureSettled({ scope, windowId, includePrivate: settings.savePrivate });
    if (!cap.tabCount) throw new Error('There are no tabs to save.');
    const meta = await replaceWindows(sessionId, cap.windows);
    if (!meta) throw new Error('That session no longer exists.');
    return { tabCount: meta.tabCount };
  },

  backupNow: () => runBackup({ force: true }),
};

browser.runtime.onMessage.addListener((msg) => {
  const handler = handlers[msg?.cmd];
  if (!handler) return undefined;
  return Promise.resolve(ready)
    .then(() => handler(msg))
    .then(
      (result) => ({ ok: true, result }),
      (e) => ({ ok: false, error: String(e?.message ?? e) }),
    );
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-save') return;
  try {
    await ready;
    await saveSession({ scope: 'all' });
    await flashBadge('✓', '#2e9e6b');
  } catch {
    await flashBadge('!', '#c8364f');
  }
});

async function flashBadge(text, color) {
  await browser.action.setBadgeBackgroundColor({ color });
  await browser.action.setBadgeText({ text });
  setTimeout(() => browser.action.setBadgeText({ text: '' }).catch(() => {}), 2500);
}

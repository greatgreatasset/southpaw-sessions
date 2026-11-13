// Crash recovery. The background script keeps one rolling record of the live
// browser ("current"), plus:
//   checkpoint — a copy of it every N minutes (history within a browser run)
//   previous   — what "current" held when the browser last went away
//   closed     — a window that was closed while the browser kept running
//
// Design rule: nothing here may depend on HOW OFTEN the background page loads.
// Firefox unloads and reloads it at will; every decision is made from stored
// state and the actual tabs, so a reload is always a no-op.
import { captureWindows } from './capture.js';
import * as db from './db.js';
import { CURRENT_ID, KIND, cloneWindows, contentSignature, countTabs, formatDateTime, newId, plural, urlBagSignature } from './model.js';
import { getSettings } from './settings.js';
import { isMeaningfulUrl } from './url.js';

/** @typedef {import('./model.js').Win} Win */

/** @param {Win[]} windows */
const hasMeaningfulTabs = (windows) => windows.some((w) => w.tabs.some((t) => isMeaningfulUrl(t.url)));

/** Signature that also notices retitled tabs and window regrouping. */
const fullSignature = (windows) =>
  windows.map((w) => `${w.winId ?? ''}:` + w.tabs.map((t) => `${t.pinned ? '*' : ''}${t.url}\t${t.title}`).join('\n')).join('\n\u0000\n');

/** Keep only the newest `keep` sessions of a kind. */
async function pruneKind(kind, keep) {
  const metas = (await db.listMeta()).filter((m) => m.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  const extra = metas.slice(Math.max(0, keep)).map((m) => m.id);
  if (extra.length) await db.deleteSessions(extra, { auto: true });
}

/**
 * Run once per background-page load, before anything else touches "current".
 *
 * A browser run is identified by a marker in storage.session, which the
 * browser wipes when it exits. Marker present -> the page merely reloaded.
 * Marker absent -> a new run (or the extension itself was reloaded): whatever
 * "current" holds is the state the browser was last in, so file it under
 * "previous" — unless the same pages are open right now, in which case nothing
 * was lost (Firefox restored them, or only the extension restarted).
 *
 * @returns {Promise<{newRun: boolean, promoted: boolean}>}
 */
export async function beginRun() {
  const { runId } = await browser.storage.session.get('runId');
  if (runId) return { newRun: false, promoted: false };
  await browser.storage.session.set({ runId: newId() });

  const settings = await getSettings();
  const cur = await db.getSession(CURRENT_ID);
  if (!cur || !hasMeaningfulTabs(cur.windows)) return { newRun: true, promoted: false };

  const live = await captureWindows({ includePrivate: settings.savePrivate });
  if (urlBagSignature(live.windows) === urlBagSignature(cur.windows)) {
    return { newRun: true, promoted: false };
  }

  // Windows closed after the final snapshot went down with the browser; their
  // tabs are still inside "current", so separate "closed window" entries
  // would only be duplicates.
  const metas = await db.listMeta();
  const exitNoise = metas.filter((m) => m.kind === KIND.CLOSED && m.createdAt > cur.updatedAt).map((m) => m.id);
  if (exitNoise.length) await db.deleteSessions(exitNoise, { auto: true });

  const previous = metas.filter((m) => m.kind === KIND.PREVIOUS).sort((a, b) => b.createdAt - a.createdAt);
  const newest = previous[0] ? await db.getSession(previous[0].id) : null;
  if (newest && contentSignature(newest.windows) === contentSignature(cur.windows)) {
    return { newRun: true, promoted: false };
  }

  await db.putSession({
    id: newId(),
    kind: KIND.PREVIOUS,
    name: 'Previous browser session',
    createdAt: cur.updatedAt || cur.createdAt,
    windows: cloneWindows(cur.windows),
  });
  await pruneKind(KIND.PREVIOUS, settings.keepPrevious);
  return { newRun: true, promoted: true };
}

let lastWrittenSig = null;
let lastWriteAt = 0;

/**
 * Record the live browser as "current" (and as a checkpoint when one is due).
 * Never overwrites the record with an empty browser.
 * @returns {Promise<'disabled' | 'empty' | 'pending' | 'unchanged' | 'saved'>}
 */
export async function snapshot() {
  const settings = await getSettings();
  if (!settings.autosave) return 'disabled';
  const live = await captureWindows({ includePrivate: settings.savePrivate, withWinId: true });
  if (!live.tabCount) return 'empty';

  const now = Date.now();
  // A tab in the middle of starting up would be recorded without its address.
  // Its address arriving triggers another snapshot, so skip this one — unless
  // the record is getting stale (a tab stuck loading must not block autosave).
  if (live.pending && now - lastWriteAt < 30000) return 'pending';

  const sig = fullSignature(live.windows);
  const { lastCheckpointAt = 0, lastCheckpointSig = '' } = await browser.storage.local.get(['lastCheckpointAt', 'lastCheckpointSig']);
  const pages = contentSignature(live.windows);
  const checkpointDue =
    settings.keepCheckpoints > 0 &&
    now - lastCheckpointAt >= settings.checkpointMinutes * 60000 &&
    pages !== lastCheckpointSig &&
    hasMeaningfulTabs(live.windows);

  if (sig === lastWrittenSig && !checkpointDue) return 'unchanged';

  await db.putSession({
    id: CURRENT_ID,
    kind: KIND.CURRENT,
    name: 'Current browser session',
    createdAt: now,
    windows: live.windows,
  });
  lastWrittenSig = sig;
  lastWriteAt = now;

  if (checkpointDue) {
    await db.putSession({
      id: newId(),
      kind: KIND.CHECKPOINT,
      name: `Autosave — ${formatDateTime(now)}`,
      createdAt: now,
      windows: cloneWindows(live.windows),
    });
    await browser.storage.local.set({ lastCheckpointAt: now, lastCheckpointSig: pages });
    await pruneKind(KIND.CHECKPOINT, settings.keepCheckpoints);
  }
  return 'saved';
}

/**
 * A browser window went away. If the browser is still running and the
 * window's pages are really gone (not just dragged into another window), keep
 * a copy under "closed" so a mis-clicked ✕ on a 40-tab window is recoverable.
 * @param {number} windowId
 */
export async function recordClosedWindow(windowId) {
  const settings = await getSettings();
  if (!settings.autosave || settings.keepClosed <= 0) return false;

  const remaining = await browser.windows.getAll({ windowTypes: ['normal'] });
  if (!remaining.length) return false; // the browser itself is exiting

  const cur = await db.getSession(CURRENT_ID);
  const win = cur?.windows.find((w) => w.winId === windowId);
  if (!win || !win.tabs.some((t) => isMeaningfulUrl(t.url))) return false;

  const live = await captureWindows({ includePrivate: true });
  const open = new Map();
  for (const w of live.windows) for (const t of w.tabs) open.set(t.url, (open.get(t.url) ?? 0) + 1);
  const gone = win.tabs.filter((t) => {
    const n = open.get(t.url) ?? 0;
    if (n > 0) open.set(t.url, n - 1);
    return n === 0;
  });
  if (!gone.some((t) => isMeaningfulUrl(t.url))) return false;

  const count = countTabs([win]);
  await db.putSession({
    id: newId(),
    kind: KIND.CLOSED,
    name: `Closed window — ${plural(count, 'tab')}`,
    createdAt: Date.now(),
    windows: cloneWindows([win]),
  });
  await pruneKind(KIND.CLOSED, settings.keepClosed);
  return true;
}

/** Apply retention limits after settings changed. */
export async function applyRetention() {
  const s = await getSettings();
  await pruneKind(KIND.CHECKPOINT, s.keepCheckpoints);
  await pruneKind(KIND.PREVIOUS, s.keepPrevious);
  await pruneKind(KIND.CLOSED, s.keepClosed);
}

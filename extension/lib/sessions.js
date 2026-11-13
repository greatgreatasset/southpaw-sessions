// Session operations: create, rename, trash, and the tab-level edits (remove a
// link from one session or from all of them) with an undo log.
import * as db from './db.js';
import { KIND, cloneWindows, countTabs, newId } from './model.js';
import { canonicalize } from './url.js';

/** @typedef {import('./model.js').Win} Win */
/** @typedef {import('./model.js').Tab} Tab */
/** @typedef {{sessionId: string, t: string}} TabRef */

/**
 * @param {{name: string, windows: Win[], kind?: import('./model.js').SessionKind,
 *          createdAt?: number, originKey?: string, origin?: any}} input
 */
export async function createSession({ name, windows, kind = KIND.SAVED, createdAt, originKey, origin }) {
  return db.putSession({
    id: newId(),
    kind,
    name,
    createdAt: createdAt ?? Date.now(),
    windows,
    originKey,
    origin,
  });
}

/** @param {string} id @param {string} name */
export async function renameSession(id, name) {
  const clean = String(name ?? '').trim();
  if (!clean) return null;
  return (await db.patchMetas([id], () => ({ name: clean })))[0] ?? null;
}

/** Move sessions to the trash (reversible). @param {string[]} ids */
export async function trashSessions(ids) {
  const at = Date.now();
  return db.patchMetas(ids, (m) => (m.deletedAt ? null : { deletedAt: at }));
}

/** Take sessions back out of the trash. @param {string[]} ids */
export async function restoreSessions(ids) {
  return db.patchMetas(ids, (m) => (m.deletedAt ? { deletedAt: undefined } : null));
}

/** Delete sessions for good. @param {string[]} ids */
export async function purgeSessions(ids) {
  return db.deleteSessions(ids);
}

/**
 * Copy any session (including an automatic snapshot) into a regular saved one.
 * @param {string} id
 * @param {string} [name]
 */
export async function saveCopy(id, name) {
  const src = await db.getSession(id);
  if (!src) return null;
  const isAuto = src.kind !== KIND.SAVED;
  return db.putSession({
    id: newId(),
    kind: KIND.SAVED,
    name: name?.trim() || (isAuto ? src.name : `${src.name} (copy)`),
    createdAt: isAuto ? src.createdAt : Date.now(),
    windows: cloneWindows(src.windows),
  });
}

/**
 * Replace a session's tabs (re-save over it), keeping its id, name and origin.
 * @param {string} id
 * @param {Win[]} windows
 */
export async function replaceWindows(id, windows) {
  const existing = await db.getSession(id);
  if (!existing) return null;
  return db.putSession({ ...existing, windows, createdAt: Date.now() });
}

/**
 * Append tabs to an existing session as a new window.
 * @param {string} id
 * @param {{url: string, title: string, pinned?: boolean}[]} tabs
 */
export async function appendTabs(id, tabs) {
  if (!tabs.length) return [];
  // Tab ids are issued when the session is normalized on write.
  return db.updateSessions([id], (s) => [...s.windows, { tabs: /** @type {any} */ (tabs.map((t) => ({ ...t }))) }]);
}

/**
 * Remove specific tabs from their sessions.
 *
 * tombstone:
 *   'none'    just remove
 *   'session' also remember "this link was removed from this imported session",
 *             so re-importing the same old backup does not bring it back
 *   'global'  also remember "this link was deleted everywhere" — no import
 *             will ever re-add it
 *
 * `recordKeys` names tombstones that already exist and belong to this removal
 * (deletions that arrived through an import), so putting the links back also
 * lifts those.
 *
 * @param {TabRef[]} refs
 * @param {{tombstone?: 'none' | 'session' | 'global', label?: string, recordKeys?: string[]}} [opts]
 * @returns {Promise<{removed: number, sessions: number, undoId: number | null}>}
 */
export async function removeTabs(refs, { tombstone = 'none', label, recordKeys = [] } = {}) {
  /** @type {Map<string, Set<string>>} */
  const bySession = new Map();
  for (const r of refs) {
    let set = bySession.get(r.sessionId);
    if (!set) bySession.set(r.sessionId, (set = new Set()));
    set.add(r.t);
  }
  if (!bySession.size) return { removed: 0, sessions: 0, undoId: null };

  /** @type {{id: string, name: string, originKey?: string, removed: {w: number, i: number, tab: Tab}[]}[]} */
  const log = [];
  await db.updateSessions([...bySession.keys()], (session) => {
    const wanted = bySession.get(session.id);
    const removed = [];
    const windows = session.windows.map((win, w) => {
      const keep = [];
      win.tabs.forEach((tab, i) => {
        if (wanted.has(tab.t)) removed.push({ w, i, tab });
        else keep.push(tab);
      });
      return keep.length === win.tabs.length ? win : { ...win, tabs: keep };
    });
    if (!removed.length) return null;
    log.push({ id: session.id, name: session.name, originKey: session.originKey, removed });
    return windows;
  });

  const removedCount = log.reduce((n, s) => n + s.removed.length, 0);
  if (!removedCount) return { removed: 0, sessions: 0, undoId: null };

  /** @type {string[]} */
  let tombstoneKeys = [];
  if (tombstone !== 'none') {
    const list = [];
    for (const s of log) {
      for (const { tab } of s.removed) {
        const url = canonicalize(tab.url);
        // The title travels with the record so a deleted link stays recognisable.
        const memo = { title: tab.title || undefined, original: tab.url };
        if (tombstone === 'global') list.push({ url, scope: /** @type {const} */ ('global'), ...memo });
        else if (s.originKey) list.push({ url, scope: /** @type {const} */ ('session'), originKey: s.originKey, ...memo });
      }
    }
    tombstoneKeys = await db.addTombstones(list);
  }

  const undoId = await db.addUndo({
    uid: newId(),
    at: Date.now(),
    type: 'removeTabs',
    label: label ?? `Removed ${removedCount} link${removedCount === 1 ? '' : 's'}`,
    payload: {
      count: removedCount,
      sessions: log.map(({ id, name, removed }) => ({ id, name, removed })),
      tombstoneKeys: [...new Set([...tombstoneKeys, ...recordKeys])],
    },
  });
  return { removed: removedCount, sessions: log.length, undoId };
}

/**
 * Revert a logged removal: put the tabs back where they were and forget the
 * tombstones that removal created.
 * @param {number} undoId
 * @returns {Promise<{restored: number, lost: number} | null>} null if unknown id
 */
export async function undo(undoId) {
  const entry = await db.getUndo(undoId);
  if (!entry) return null;
  if (entry.type !== 'removeTabs') {
    await db.deleteUndo([undoId]);
    return { restored: 0, lost: 0 };
  }

  const { sessions, tombstoneKeys } = entry.payload;
  /** @type {Map<string, {w: number, i: number, tab: Tab}[]>} */
  const byId = new Map(sessions.map((s) => [s.id, s.removed]));
  let restored = 0;
  const touched = await db.updateSessions([...byId.keys()], (session) => {
    const windows = session.windows.map((w) => ({ ...w, tabs: [...w.tabs] }));
    const present = new Set();
    for (const w of windows) for (const t of w.tabs) present.add(t.t);
    // Ascending (window, index) order re-creates the original arrangement.
    const items = [...byId.get(session.id)].sort((a, b) => a.w - b.w || a.i - b.i);
    let n = 0;
    for (const { w, i, tab } of items) {
      if (present.has(tab.t)) continue; // already back (double undo)
      while (windows.length <= w) windows.push({ tabs: [] });
      const tabs = windows[w].tabs;
      tabs.splice(Math.min(i, tabs.length), 0, tab);
      present.add(tab.t);
      n++;
    }
    restored += n;
    return n ? windows : null;
  });

  const total = sessions.reduce((n, s) => n + s.removed.length, 0);
  const touchedSet = new Set(touched);
  let lost = 0;
  // Tabs whose session was deleted for good in the meantime cannot go back.
  for (const s of sessions) if (!touchedSet.has(s.id) && !(await db.getMeta(s.id))) lost += s.removed.length;

  if (tombstoneKeys?.length) await db.removeTombstones(tombstoneKeys);
  await db.deleteUndo([undoId]);
  return { restored, lost: Math.min(lost, total - restored) };
}

/**
 * Housekeeping: empty the trash of sessions older than `trashDays`.
 *
 * The log of removed links is deliberately NOT trimmed here. It is the only
 * place a deleted link's title and address survive, and it is tiny; entries go
 * away only when the user puts the links back or erases the entry.
 * @param {{trashDays?: number}} [opts]
 */
export async function purgeExpired({ trashDays = 30 } = {}) {
  const cutoff = Date.now() - trashDays * 86400000;
  const metas = await db.listMeta();
  const expired = metas.filter((m) => m.deletedAt && m.deletedAt < cutoff).map((m) => m.id);
  if (expired.length) await db.deleteSessions(expired);
  return { sessions: expired.length };
}

/**
 * Erase removal-log entries for good. The links stay deleted and stay blocked
 * from re-import, but the record of what they were — titles, positions — is
 * dropped everywhere; only the bare normalized addresses remain on the
 * blocklist.
 * @param {number[]} undoIds
 */
export async function forgetRemovals(undoIds) {
  const keys = [];
  for (const id of undoIds) {
    const entry = await db.getUndo(id);
    if (entry?.payload?.tombstoneKeys?.length) keys.push(...entry.payload.tombstoneKeys);
  }
  await db.stripTombstoneDetails(keys);
  return db.deleteUndo(undoIds);
}

/**
 * Build one saved session out of loose links (e.g. a selection in the library).
 * @param {string} name
 * @param {{url: string, title: string}[]} links
 */
export async function createFromLinks(name, links) {
  const tabs = links.map((l) => ({ url: l.url, title: l.title ?? '' }));
  if (!countTabs([{ tabs: /** @type {any} */ (tabs) }])) return null;
  return createSession({ name, windows: [{ tabs: /** @type {any} */ (tabs) }] });
}

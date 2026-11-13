// IndexedDB storage. Every extension context (background, popup, manager page)
// opens the same database directly; transactions keep them consistent.
//
// Stores
//   meta        session metadata, keyed by id          (see model.js)
//   data        { id, windows } — the tabs of a session
//   checks      cached dead-link verdicts, keyed by canonical URL
//   tombstones  links the user deleted, so re-imports never resurrect them
//   undo        log of destructive edits that can still be reverted
import { KIND, countTabs, countWindows, fingerprint, normalizeWindows } from './model.js';

/** @typedef {import('./model.js').Session} Session */
/** @typedef {import('./model.js').SessionMeta} SessionMeta */
/** @typedef {import('./model.js').Win} Win */

/**
 * @typedef {object} Check
 * @property {string} url          canonical URL
 * @property {'alive' | 'dead' | 'paywalled' | 'unknown' | 'not_checkable'} status
 * @property {number} [httpCode]
 * @property {string} [detail]
 * @property {number} checkedAt
 */

/**
 * @typedef {object} Tombstone
 * @property {string} key
 * @property {string} url          canonical URL
 * @property {'global' | 'session'} scope
 * @property {string} [originKey]  for scope 'session': which imported session
 * @property {number} createdAt
 * @property {string} [title]      what the link was called — kept so a deleted
 *                                 link can still be looked up later
 * @property {string} [original]   the URL as it was saved (before normalizing)
 */

const DB_NAME = 'southpaw-sessions';
const DB_VERSION = 1;
const CHANNEL = 'southpaw-sessions';

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('meta')) {
        const meta = db.createObjectStore('meta', { keyPath: 'id' });
        meta.createIndex('kind', 'kind');
        meta.createIndex('originKey', 'originKey');
        meta.createIndex('fp', 'fp');
      }
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('checks')) db.createObjectStore('checks', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('undo')) db.createObjectStore('undo', { keyPath: 'id', autoIncrement: true });
    };
    open.onsuccess = () => {
      const db = open.result;
      // Another context upgrading the schema must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => {
      dbPromise = null;
      reject(open.error);
    };
    open.onblocked = () => reject(new Error('database upgrade blocked by another open page'));
  });
  return dbPromise;
}

/** Close the connection (tests). */
export async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  db?.close();
  dbPromise = null;
}

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBTransaction} tx */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/**
 * @param {string | string[]} stores
 * @param {IDBTransactionMode} mode
 */
async function begin(stores, mode) {
  const db = await openDb();
  return db.transaction(stores, mode);
}

// ---- change notification ----------------------------------------------------

/** @type {BroadcastChannel | null} */
let channel = null;
function getChannel() {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    // Node (unit tests) only: an open channel must not keep the process alive.
    /** @type {any} */ (channel).unref?.();
  }
  return channel;
}

/**
 * Tell the other open extension pages that something changed.
 *   'sessions' — the library (saved sessions) changed
 *   'auto'     — only automatic snapshots changed (happens every few seconds
 *                while browsing; listeners should treat it as cheap)
 * @param {'sessions' | 'auto' | 'checks' | 'tombstones' | 'undo'} what
 */
export function emitChange(what) {
  try {
    getChannel()?.postMessage({ what, at: Date.now() });
  } catch {
    // A closed channel only means nobody is listening.
  }
}

/**
 * Subscribe to changes made by OTHER contexts (a context never hears itself).
 * @param {(what: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onChange(listener) {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = (ev) => listener(ev.data?.what);
  ch.addEventListener('message', handler);
  return () => ch.removeEventListener('message', handler);
}

/**
 * Record that the user's library (saved sessions, link verdicts, tombstones)
 * changed. The background script watches this stamp to decide when a file
 * backup is due — backups follow changes, never page loads.
 */
export function markLibraryChanged() {
  try {
    globalThis.browser?.storage?.local?.set({ libraryChangedAt: Date.now() })?.catch?.(() => {});
  } catch {
    // Not running inside the extension (unit tests).
  }
}

// ---- sessions ---------------------------------------------------------------

/**
 * Build the meta record for a session.
 * @param {Partial<Session> & {id: string, windows: Win[]}} s
 * @returns {SessionMeta}
 */
function toMeta(s) {
  const now = Date.now();
  const createdAt = Number(s.createdAt) || now;
  const name = String(s.name ?? '').trim() || '(untitled)';
  /** @type {SessionMeta} */
  const meta = {
    id: s.id,
    kind: s.kind ?? KIND.SAVED,
    name,
    createdAt,
    updatedAt: Number(s.updatedAt) || now,
    tabCount: countTabs(s.windows),
    windowCount: countWindows(s.windows),
    fp: fingerprint(name, createdAt),
  };
  if (s.originKey) meta.originKey = s.originKey;
  if (s.origin) meta.origin = s.origin;
  if (s.deletedAt) meta.deletedAt = s.deletedAt;
  return meta;
}

/** @returns {Promise<SessionMeta[]>} */
export async function listMeta() {
  const tx = await begin('meta', 'readonly');
  return req(tx.objectStore('meta').getAll());
}

/** @param {string} id @returns {Promise<SessionMeta | null>} */
export async function getMeta(id) {
  const tx = await begin('meta', 'readonly');
  return (await req(tx.objectStore('meta').get(id))) ?? null;
}

/** @param {string} id @returns {Promise<Session | null>} */
export async function getSession(id) {
  const tx = await begin(['meta', 'data'], 'readonly');
  const [meta, data] = await Promise.all([
    req(tx.objectStore('meta').get(id)),
    req(tx.objectStore('data').get(id)),
  ]);
  if (!meta) return null;
  return { ...meta, windows: data?.windows ?? [] };
}

/** Every session's windows, keyed by id. @returns {Promise<Map<string, Win[]>>} */
export async function getAllData() {
  const tx = await begin('data', 'readonly');
  const rows = await req(tx.objectStore('data').getAll());
  return new Map(rows.map((r) => [r.id, r.windows]));
}

/**
 * Insert or replace sessions (meta + data) in one atomic transaction.
 * @param {(Partial<Session> & {id: string, windows: Win[]})[]} sessions
 * @param {{touch?: boolean}} [opts]  touch=false keeps the given updatedAt
 * @returns {Promise<SessionMeta[]>}
 */
export async function putSessions(sessions, { touch = true } = {}) {
  if (!sessions.length) return [];
  const tx = await begin(['meta', 'data'], 'readwrite');
  const metaStore = tx.objectStore('meta');
  const dataStore = tx.objectStore('data');
  const metas = [];
  let library = false;
  for (const s of sessions) {
    const windows = normalizeWindows(s.windows);
    const meta = toMeta({ ...s, windows, updatedAt: touch ? Date.now() : s.updatedAt });
    metaStore.put(meta);
    dataStore.put({ id: s.id, windows });
    metas.push(meta);
    if (meta.kind === KIND.SAVED) library = true;
  }
  await done(tx);
  emitChange(library ? 'sessions' : 'auto');
  if (library) markLibraryChanged();
  return metas;
}

/**
 * @param {Partial<Session> & {id: string, windows: Win[]}} session
 * @param {{touch?: boolean}} [opts]
 */
export async function putSession(session, opts) {
  return (await putSessions([session], opts))[0];
}

/**
 * Read-modify-write several sessions atomically. `mutate` receives each
 * existing session and returns the windows to store, or null to leave it
 * untouched. Missing ids are skipped.
 * @param {string[]} ids
 * @param {(session: Session) => Win[] | null} mutate
 * @returns {Promise<string[]>} ids actually rewritten
 */
export async function updateSessions(ids, mutate) {
  if (!ids.length) return [];
  const tx = await begin(['meta', 'data'], 'readwrite');
  const metaStore = tx.objectStore('meta');
  const dataStore = tx.objectStore('data');
  const changed = [];
  let library = false;
  for (const id of ids) {
    const metaReq = metaStore.get(id);
    metaReq.onsuccess = () => {
      const meta = metaReq.result;
      if (!meta) return;
      const dataReq = dataStore.get(id);
      dataReq.onsuccess = () => {
        const windows = mutate({ ...meta, windows: dataReq.result?.windows ?? [] });
        if (!windows) return;
        metaStore.put({
          ...meta,
          updatedAt: Date.now(),
          tabCount: countTabs(windows),
          windowCount: countWindows(windows),
        });
        dataStore.put({ id, windows });
        changed.push(id);
        if (meta.kind === KIND.SAVED) library = true;
      };
    };
  }
  await done(tx);
  if (changed.length) {
    emitChange(library ? 'sessions' : 'auto');
    if (library) markLibraryChanged();
  }
  return changed;
}

/**
 * Shallow-patch meta records (rename, trash/restore, change kind).
 * @param {string[]} ids
 * @param {(meta: SessionMeta) => Partial<SessionMeta> | null} patch
 */
export async function patchMetas(ids, patch) {
  if (!ids.length) return [];
  const tx = await begin('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const changed = [];
  for (const id of ids) {
    const r = store.get(id);
    r.onsuccess = () => {
      const meta = r.result;
      if (!meta) return;
      const p = patch(meta);
      if (!p) return;
      const next = { ...meta, ...p, updatedAt: Date.now() };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      next.fp = fingerprint(next.name, next.createdAt);
      store.put(next);
      changed.push(next);
    };
  }
  await done(tx);
  if (changed.length) {
    emitChange('sessions');
    markLibraryChanged();
  }
  return changed;
}

/**
 * Permanently delete sessions.
 * @param {string[]} ids
 * @param {{auto?: boolean}} [opts] auto: only automatic snapshots are involved
 */
export async function deleteSessions(ids, { auto = false } = {}) {
  if (!ids.length) return;
  const tx = await begin(['meta', 'data'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
  }
  await done(tx);
  emitChange(auto ? 'auto' : 'sessions');
  if (!auto) markLibraryChanged();
}

// ---- dead-link verdict cache --------------------------------------------------

/** @returns {Promise<Map<string, Check>>} */
export async function getAllChecks() {
  const tx = await begin('checks', 'readonly');
  const rows = await req(tx.objectStore('checks').getAll());
  return new Map(rows.map((c) => [c.url, c]));
}

/**
 * @param {Check[]} checks
 * @param {{onlyIfNewer?: boolean}} [opts] keep an existing, more recent verdict
 * @returns {Promise<number>} verdicts written
 */
export async function putChecks(checks, { onlyIfNewer = false } = {}) {
  if (!checks.length) return 0;
  const tx = await begin('checks', 'readwrite');
  const store = tx.objectStore('checks');
  let written = 0;
  for (const c of checks) {
    if (!onlyIfNewer) {
      store.put(c);
      written++;
      continue;
    }
    const r = store.get(c.url);
    r.onsuccess = () => {
      if (!r.result || (r.result.checkedAt ?? 0) < (c.checkedAt ?? 0)) {
        store.put(c);
        written++;
      }
    };
  }
  await done(tx);
  if (written) {
    emitChange('checks');
    markLibraryChanged();
  }
  return written;
}

// ---- tombstones ---------------------------------------------------------------

/** @param {'global' | 'session'} scope @param {string} url @param {string} [originKey] */
export function tombstoneKey(scope, url, originKey) {
  return scope === 'global' ? `g|${url}` : `s|${originKey}|${url}`;
}

/** @returns {Promise<Tombstone[]>} */
export async function listTombstones() {
  const tx = await begin('tombstones', 'readonly');
  return req(tx.objectStore('tombstones').getAll());
}

/**
 * Tombstones in lookup form.
 * @returns {Promise<{global: Set<string>, perOrigin: Map<string, Set<string>>, count: number}>}
 */
export async function getTombstoneIndex() {
  const all = await listTombstones();
  const global = new Set();
  /** @type {Map<string, Set<string>>} */
  const perOrigin = new Map();
  for (const t of all) {
    if (t.scope === 'global') global.add(t.url);
    else if (t.originKey) {
      let set = perOrigin.get(t.originKey);
      if (!set) perOrigin.set(t.originKey, (set = new Set()));
      set.add(t.url);
    }
  }
  return { global, perOrigin, count: all.length };
}

/**
 * @param {{url: string, scope: 'global' | 'session', originKey?: string, createdAt?: number,
 *          title?: string, original?: string}[]} list
 * @returns {Promise<string[]>} keys that did not exist before
 */
export async function addTombstones(list) {
  if (!list.length) return [];
  const tx = await begin('tombstones', 'readwrite');
  const store = tx.objectStore('tombstones');
  const added = [];
  let updated = false;
  const seen = new Set();
  for (const t of list) {
    const key = tombstoneKey(t.scope, t.url, t.originKey);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = store.get(key);
    r.onsuccess = () => {
      if (r.result) {
        // Already remembered: only fill in a title it did not have yet.
        if (t.title && !r.result.title) {
          const next = { ...r.result, title: t.title };
          if (t.original && !next.original) next.original = t.original;
          store.put(next);
          updated = true;
        }
        return;
      }
      /** @type {Tombstone} */
      const rec = { key, url: t.url, scope: t.scope, createdAt: t.createdAt || Date.now() };
      if (t.scope === 'session') rec.originKey = t.originKey;
      if (t.title) rec.title = t.title;
      if (t.original) rec.original = t.original;
      store.put(rec);
      added.push(key);
    };
  }
  await done(tx);
  if (added.length || updated) {
    emitChange('tombstones');
    markLibraryChanged();
  }
  return added;
}

/**
 * Reduce tombstones to the bare address needed to block re-imports, dropping
 * the remembered title and original URL.
 * @param {string[]} keys
 */
export async function stripTombstoneDetails(keys) {
  if (!keys.length) return;
  const tx = await begin('tombstones', 'readwrite');
  const store = tx.objectStore('tombstones');
  for (const k of keys) {
    const r = store.get(k);
    r.onsuccess = () => {
      const rec = r.result;
      if (!rec || (!rec.title && !rec.original)) return;
      delete rec.title;
      delete rec.original;
      store.put(rec);
    };
  }
  await done(tx);
  emitChange('tombstones');
  markLibraryChanged();
}

/** @param {string[]} keys */
export async function removeTombstones(keys) {
  if (!keys.length) return;
  const tx = await begin('tombstones', 'readwrite');
  for (const k of keys) tx.objectStore('tombstones').delete(k);
  await done(tx);
  emitChange('tombstones');
  markLibraryChanged();
}

export async function clearTombstones() {
  const tx = await begin('tombstones', 'readwrite');
  tx.objectStore('tombstones').clear();
  await done(tx);
  emitChange('tombstones');
  markLibraryChanged();
}

// ---- undo log -----------------------------------------------------------------

/**
 * One logged removal of links. The log is kept until the user erases an entry:
 * it is both the undo history and the archive of everything ever deleted.
 * @typedef {object} UndoEntry
 * @property {number} [id]       local key (auto-increment; differs per profile)
 * @property {string} [uid]      stable identity across backups
 * @property {number} at
 * @property {string} label
 * @property {'removeTabs' | 'trashSessions'} type
 * @property {any} payload
 */

/** Identity of a log entry that survives a backup/restore round trip. */
export function undoUid(entry) {
  return entry.uid ?? `${entry.at}:${entry.label}`;
}

/** @param {UndoEntry} entry @returns {Promise<number>} */
export async function addUndo(entry) {
  const tx = await begin('undo', 'readwrite');
  const id = await req(tx.objectStore('undo').add(entry));
  await done(tx);
  emitChange('undo');
  markLibraryChanged();
  return /** @type {number} */ (id);
}

/**
 * Add log entries restored from a backup, skipping those already present.
 * @param {UndoEntry[]} entries
 * @returns {Promise<number>} entries added
 */
export async function addUndoEntries(entries) {
  if (!entries.length) return 0;
  const have = new Set((await listUndo()).map(undoUid));
  const fresh = [];
  for (const e of entries) {
    const uid = undoUid(e);
    if (have.has(uid)) continue;
    have.add(uid);
    const { id: _localId, ...rest } = e;
    fresh.push(rest);
  }
  if (!fresh.length) return 0;
  const tx = await begin('undo', 'readwrite');
  for (const e of fresh) tx.objectStore('undo').add(e);
  await done(tx);
  emitChange('undo');
  markLibraryChanged();
  return fresh.length;
}

/** @param {number} id @returns {Promise<UndoEntry | null>} */
export async function getUndo(id) {
  const tx = await begin('undo', 'readonly');
  return (await req(tx.objectStore('undo').get(id))) ?? null;
}

/** Newest first. @returns {Promise<UndoEntry[]>} */
export async function listUndo() {
  const tx = await begin('undo', 'readonly');
  const rows = await req(tx.objectStore('undo').getAll());
  return rows.sort((a, b) => b.at - a.at);
}

/** @param {number[]} ids */
export async function deleteUndo(ids) {
  if (!ids.length) return;
  const tx = await begin('undo', 'readwrite');
  for (const id of ids) tx.objectStore('undo').delete(id);
  await done(tx);
  emitChange('undo');
  markLibraryChanged();
}

// ---- maintenance ----------------------------------------------------------------

/** Rough per-store record counts, for the settings page. */
export async function storeCounts() {
  const tx = await begin(['meta', 'checks', 'tombstones', 'undo'], 'readonly');
  const [sessions, checks, tombstones, undo] = await Promise.all([
    req(tx.objectStore('meta').count()),
    req(tx.objectStore('checks').count()),
    req(tx.objectStore('tombstones').count()),
    req(tx.objectStore('undo').count()),
  ]);
  return { sessions, checks, tombstones, undo };
}

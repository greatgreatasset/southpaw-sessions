// Importers built on Firefox's own "sessionstore" JSON:
//
//  - Firefox profile files: sessionstore.jsonlz4, and everything under
//    sessionstore-backups/ (recovery.jsonlz4, recovery.baklz4, previous.jsonlz4,
//    upgrade.jsonlz4-<build>), plus the pre-2017 uncompressed *.js variants.
//    Handy after a browser malfunction: point the importer at the profile's
//    sessionstore-backups folder and get the tabs back as sessions.
//  - The classic "Session Manager" add-on (*.session): four header lines
//    ("[SessionManager v2]", name=, timestamp=, tab-separated flags) followed
//    by the same sessionstore JSON.
import { fingerprint } from '../model.js';

/** @typedef {import('./index.js').ParsedSession} ParsedSession */

/** @param {unknown} data */
export function looksLikeSessionStore(data) {
  return !!data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).windows);
}

/**
 * Convert sessionstore windows to our shape. For each tab the entry the user
 * was actually looking at is kept (`index` is 1-based into its history).
 * @param {any} state
 */
export function sessionStoreToWindows(state) {
  const windows = [];
  for (const w of Array.isArray(state?.windows) ? state.windows : []) {
    if (!w) continue;
    const groupDefs = new Map();
    for (const g of Array.isArray(w.groups) ? w.groups : []) {
      if (g && g.id != null) groupDefs.set(String(g.id), g);
    }
    const usedGroups = new Map();
    const tabs = [];
    for (const t of Array.isArray(w.tabs) ? w.tabs : []) {
      const entries = Array.isArray(t?.entries) ? t.entries : [];
      if (!entries.length) continue;
      const idx = Math.min(Math.max((Number(t.index) || entries.length) - 1, 0), entries.length - 1);
      const e = entries[idx];
      if (!e || typeof e.url !== 'string' || !e.url.trim()) continue;
      const tab = { url: e.url.trim(), title: typeof e.title === 'string' ? e.title : '' };
      if (t.pinned) tab.pinned = true;
      if (t.groupId != null && groupDefs.has(String(t.groupId))) {
        const gid = String(t.groupId);
        if (!usedGroups.has(gid)) usedGroups.set(gid, `g${usedGroups.size + 1}`);
        tab.g = usedGroups.get(gid);
      }
      tabs.push(tab);
    }
    if (!tabs.length) continue;
    const win = { tabs };
    if (usedGroups.size) {
      win.groups = [...usedGroups].map(([gid, k]) => {
        const def = groupDefs.get(gid);
        const g = { k };
        if (def.name) g.title = String(def.name);
        if (def.color) g.color = String(def.color);
        if (def.collapsed) g.collapsed = true;
        return g;
      });
    }
    windows.push(win);
  }
  return windows;
}

/**
 * A bare sessionstore file -> one session named after the file.
 * @param {any} state
 * @param {string} fileName
 * @param {number} fileTime
 * @returns {ParsedSession[]}
 */
export function parseSessionStore(state, fileName, fileTime) {
  const windows = sessionStoreToWindows(state);
  const createdAt = Number(state?.session?.lastUpdate) || fileTime || Date.now();
  const name = `Firefox session file — ${fileName}`;
  return [{
    name,
    createdAt,
    windows,
    originKey: `sessionstore:${fileName}:${createdAt}`,
    fp: fingerprint(name, createdAt),
    origin: { type: 'sessionstore', file: fileName },
  }];
}

export const SESSION_MANAGER_MAGIC = '[SessionManager v2]';

/** @param {string} text */
export function looksLikeSessionManager(text) {
  return text.startsWith(SESSION_MANAGER_MAGIC);
}

/**
 * Session Manager *.session -> one session.
 * @param {string} text
 * @param {string} fileName
 * @param {number} fileTime
 * @returns {ParsedSession[]}
 */
export function parseSessionManager(text, fileName, fileTime) {
  // Header = the first four lines; everything after is JSON (which may itself
  // contain no raw newlines, but be liberal about it).
  let pos = 0;
  const header = [];
  for (let i = 0; i < 4; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) throw new Error('Session Manager file is truncated');
    header.push(text.slice(pos, nl).replace(/\r$/, ''));
    pos = nl + 1;
  }
  const body = text.slice(pos).trim();
  if (!body.startsWith('{')) {
    throw new Error('Session Manager file is encrypted or not in JSON form');
  }
  const state = JSON.parse(body);

  const fields = {};
  for (const line of header.slice(1)) {
    for (const part of line.split('\t')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  const name = fields.name || fileName.replace(/\.session$/i, '');
  const createdAt = Number(fields.timestamp) || Number(state?.session?.lastUpdate) || fileTime || Date.now();
  const origin = { type: 'sessionmanager', file: fileName };
  if (fields.group) origin.group = fields.group;
  return [{
    name,
    createdAt,
    windows: sessionStoreToWindows(state),
    originKey: `sessionmanager:${createdAt}:${name}`,
    fp: fingerprint(name, createdAt),
    origin,
  }];
}

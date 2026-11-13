// Import front door: sniff a file's format from its CONTENT (never its
// extension) and turn it into ParsedSession[] plus optional library state.
// Pure apart from DecompressionStream (present in Firefox and in Node).
import { decodeMozLz4, isMozLz4 } from './lz4.js';
import { looksLikeMySessionsArray, parseMySessionsArray, parseMySessionsBackup } from './mysessions.js';
import {
  looksLikeSessionManager, looksLikeSessionStore, parseSessionManager, parseSessionStore,
} from './sessionstore.js';
import { fingerprint } from '../model.js';

/**
 * @typedef {object} ParsedSession
 * @property {string} name
 * @property {number} createdAt
 * @property {{label?: string, groups?: any[], tabs: {url: string, title: string, pinned?: boolean, g?: string, t?: string}[]}[]} windows
 * @property {string} originKey
 * @property {string} fp
 * @property {{type: string, file?: string, group?: string}} origin
 * @property {string} [id]          only for Southpaw's own backups
 * @property {string} [kind]        only for Southpaw's own backups
 * @property {number} [updatedAt]
 * @property {number} [deletedAt]
 */

/**
 * @typedef {object} ParsedFile
 * @property {'mysessions' | 'mysessions-backup' | 'sessionmanager' | 'sessionstore' | 'southpaw' | 'analyzer-state'} type
 * @property {string} label          human name of the format
 * @property {ParsedSession[]} sessions
 * @property {{url: string, scope: 'global' | 'session', originKey?: string, createdAt?: number, title?: string, original?: string}[]} [tombstones]
 * @property {{url: string, status: string, httpCode?: number, detail?: string, checkedAt: number}[]} [checks]
 * @property {import('../db.js').UndoEntry[]} [removed]   log of removed links (own backups)
 * @property {Record<string, any>} [settings]
 */

export const SOUTHPAW_FORMAT = 'southpaw-sessions-backup';
export const ANALYZER_STATE_FORMAT = 'southpaw-analyzer-state';

const FORMAT_LABEL = {
  mysessions: 'MySessions backup (.mysessions)',
  'mysessions-backup': 'MySessions session export (.json)',
  sessionmanager: 'Session Manager (.session)',
  sessionstore: 'Firefox session file',
  southpaw: 'Southpaw Sessions backup',
  'analyzer-state': 'Session Analyzer state',
};

/** @param {Uint8Array} bytes */
export async function gunzip(bytes) {
  const stream = new Blob([/** @type {any} */ (bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeText(bytes) {
  // Drop a UTF-8 BOM if present; TextDecoder would otherwise keep U+FEFF.
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8').decode(start ? bytes.subarray(start) : bytes);
}

/**
 * Parse one import file.
 * @param {{name: string, bytes: Uint8Array, lastModified?: number}} file
 * @returns {Promise<ParsedFile>}
 */
export async function parseImportFile({ name, bytes, lastModified }) {
  const fileTime = lastModified || Date.now();

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return parseImportFile({ name: name.replace(/\.gz$/i, ''), bytes: await gunzip(bytes), lastModified });
  }

  if (isMozLz4(bytes)) {
    const state = JSON.parse(decodeText(decodeMozLz4(bytes)));
    if (!looksLikeSessionStore(state)) throw new Error('compressed file holds no session data');
    return wrap('sessionstore', parseSessionStore(state, name, fileTime));
  }

  const text = decodeText(bytes);
  if (looksLikeSessionManager(text)) {
    return wrap('sessionmanager', parseSessionManager(text, name, fileTime));
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`not a recognised session file (${/** @type {Error} */ (e).message})`);
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.format === SOUTHPAW_FORMAT) return parseSouthpawBackup(data, name);
    if (data.format === ANALYZER_STATE_FORMAT) return parseAnalyzerState(data);
    if (data.format === 'MySessions-Backup') {
      return wrap('mysessions-backup', parseMySessionsBackup(data, name, fileTime));
    }
    if (looksLikeSessionStore(data)) return wrap('sessionstore', parseSessionStore(data, name, fileTime));
  }
  if (looksLikeMySessionsArray(data)) {
    return wrap('mysessions', parseMySessionsArray(data, name, fileTime));
  }
  throw new Error('not a recognised session file');
}

/** @returns {ParsedFile} */
function wrap(type, sessions) {
  return { type, label: FORMAT_LABEL[type], sessions };
}

/** @returns {ParsedFile} */
function parseSouthpawBackup(data, fileName) {
  if (Number(data.version) > 1) {
    throw new Error(`backup was written by a newer Southpaw Sessions (format v${data.version})`);
  }
  /** @type {ParsedSession[]} */
  const sessions = [];
  for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.windows)) continue;
    const name = typeof s.name === 'string' && s.name ? s.name : '(untitled)';
    const createdAt = Number(s.createdAt) || Date.now();
    /** @type {ParsedSession} */
    const out = {
      id: s.id,
      kind: typeof s.kind === 'string' ? s.kind : 'saved',
      name,
      createdAt,
      updatedAt: Number(s.updatedAt) || createdAt,
      windows: s.windows,
      originKey: typeof s.originKey === 'string' && s.originKey ? s.originKey : `southpaw:${s.id}`,
      fp: fingerprint(name, createdAt),
      origin: s.origin && typeof s.origin === 'object' ? s.origin : { type: 'southpaw', file: fileName },
    };
    if (s.deletedAt) out.deletedAt = Number(s.deletedAt);
    sessions.push(out);
  }
  return {
    type: 'southpaw',
    label: FORMAT_LABEL.southpaw,
    sessions,
    tombstones: sanitizeTombstones(data.tombstones),
    checks: sanitizeChecks(data.checks),
    removed: sanitizeRemoved(data.removed),
    settings: data.settings && typeof data.settings === 'object' ? data.settings : undefined,
  };
}

/** Removal-log entries from a backup: keep only well-formed ones. */
function sanitizeRemoved(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || e.type !== 'removeTabs' || !Array.isArray(e.payload?.sessions)) continue;
    const sessions = [];
    for (const s of e.payload.sessions) {
      if (!s || typeof s.id !== 'string' || !Array.isArray(s.removed)) continue;
      const removed = s.removed.filter((r) => r && r.tab && typeof r.tab.url === 'string' && typeof r.tab.t === 'string')
        .map((r) => ({ w: Number(r.w) || 0, i: Number(r.i) || 0, tab: r.tab }));
      if (removed.length) sessions.push({ id: s.id, name: typeof s.name === 'string' ? s.name : '', removed });
    }
    if (!sessions.length) continue;
    const at = Number(e.at) || 0;
    const label = typeof e.label === 'string' ? e.label : 'Removed links';
    out.push({
      uid: typeof e.uid === 'string' && e.uid ? e.uid : `${at}:${label}`,
      at,
      type: 'removeTabs',
      label,
      payload: {
        count: sessions.reduce((n, s) => n + s.removed.length, 0),
        sessions,
        tombstoneKeys: Array.isArray(e.payload.tombstoneKeys) ? e.payload.tombstoneKeys.filter((k) => typeof k === 'string') : [],
      },
    });
  }
  return out;
}

/** @returns {ParsedFile} */
function parseAnalyzerState(data) {
  return {
    type: 'analyzer-state',
    label: FORMAT_LABEL['analyzer-state'],
    sessions: [],
    tombstones: sanitizeTombstones(data.tombstones),
    checks: sanitizeChecks(data.checks),
  };
}

function sanitizeTombstones(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t.url !== 'string' || !t.url) continue;
    const scope = t.scope === 'session' ? 'session' : 'global';
    if (scope === 'session' && typeof t.originKey !== 'string') continue;
    const o = { url: t.url, scope };
    if (scope === 'session') o.originKey = t.originKey;
    if (Number(t.createdAt)) o.createdAt = Number(t.createdAt);
    if (typeof t.title === 'string' && t.title) o.title = t.title;
    if (typeof t.original === 'string' && t.original) o.original = t.original;
    out.push(o);
  }
  return out;
}

const STATUSES = new Set(['alive', 'dead', 'paywalled', 'unknown', 'not_checkable']);

function sanitizeChecks(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c.url !== 'string' || !c.url || !STATUSES.has(c.status)) continue;
    const o = { url: c.url, status: c.status, checkedAt: Number(c.checkedAt) || 0 };
    if (Number.isFinite(c.httpCode)) o.httpCode = c.httpCode;
    if (typeof c.detail === 'string' && c.detail) o.detail = c.detail;
    out.push(o);
  }
  return out;
}

/** Hex SHA-1 of a buffer — used to skip byte-identical files within an import. */
export async function sha1Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  let s = '';
  for (const b of digest) s += b.toString(16).padStart(2, '0');
  return s;
}

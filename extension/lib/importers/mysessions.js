// Importers for the "MySessions" add-on.
//
// Two shapes exist in the wild:
//  1. *.mysessions — the full-library backup: a JSON array of
//       { title, date: "D/M/YYYY_H:mm", folderId, tabsCount, urls: [],
//         windows: { <winKey>: [{title, url}] }, labels: { <winKey>: "window 1" } }
//     `folderId` is the bookmark folder the add-on kept the session in — stable
//     across backups, so it is the session's identity.
//  2. mysessions-*.json — { format: "MySessions-Backup", version, createdAt,
//       sessions: [{ title: "<name> (<date>)--<n>tabs",
//                    children: [{ title: "window 1", children: [{title, url}] }] }] }
//     A dump of the bookmark tree; carries no folderId.
import { fingerprint } from '../model.js';

/** @typedef {import('./index.js').ParsedSession} ParsedSession */

/**
 * "D/M/YYYY_H:mm" (the add-on writes day first, local time) -> ms epoch.
 * @param {string | undefined} date
 * @returns {number | null}
 */
export function parseMySessionsDate(date) {
  if (!date) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})_(\d{1,2}):(\d{1,2})$/.exec(String(date).trim());
  if (!m) return null;
  const [, d, mo, y, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

// The add-on marks pinned tabs by appending "&&pinned" to the saved title.
const PINNED_SUFFIX = /&&pinned$/;
// Its auto-generated window labels carry no information worth keeping.
const DEFAULT_LABEL = /^window \d+$/i;

function toTab(raw) {
  if (!raw || typeof raw.url !== 'string' || !raw.url.trim()) return null;
  let title = typeof raw.title === 'string' ? raw.title : '';
  let pinned = !!raw.pinned;
  if (PINNED_SUFFIX.test(title)) {
    title = title.replace(PINNED_SUFFIX, '');
    pinned = true;
  }
  const tab = { url: raw.url.trim(), title };
  if (pinned) tab.pinned = true;
  return tab;
}

function cleanLabel(label) {
  if (typeof label !== 'string') return undefined;
  const l = label.trim();
  return l && !DEFAULT_LABEL.test(l) ? l : undefined;
}

/** @param {unknown} data */
export function looksLikeMySessionsArray(data) {
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return true;
  return data.some((s) => s && typeof s === 'object' && ('windows' in s || 'folderId' in s));
}

/**
 * @param {any[]} data       parsed *.mysessions content
 * @param {string} fileName
 * @param {number} fileTime  file's last-modified time (fallback session date)
 * @returns {ParsedSession[]}
 */
export function parseMySessionsArray(data, fileName, fileTime) {
  /** @type {ParsedSession[]} */
  const out = [];
  for (const s of data) {
    if (!s || typeof s !== 'object') continue;
    const windows = [];
    const wins = s.windows && typeof s.windows === 'object' ? s.windows : {};
    for (const key of Object.keys(wins)) {
      const rawTabs = Array.isArray(wins[key]) ? wins[key] : [];
      const tabs = rawTabs.map(toTab).filter(Boolean);
      if (!tabs.length) continue;
      const win = { tabs };
      const label = cleanLabel(s.labels?.[key]);
      if (label) win.label = label;
      windows.push(win);
    }
    // Very old exports kept a flat `urls` list instead of windows.
    if (!windows.length && Array.isArray(s.urls) && s.urls.length) {
      const tabs = s.urls.map(toTab).filter(Boolean);
      if (tabs.length) windows.push({ tabs });
    }
    const name = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : '(untitled)';
    const createdAt = parseMySessionsDate(s.date) ?? fileTime ?? Date.now();
    const fp = fingerprint(name, createdAt);
    out.push({
      name,
      createdAt,
      windows,
      originKey: s.folderId ? `mysessions:${s.folderId}` : `mysessions-fp:${fp}`,
      fp,
      origin: { type: 'mysessions', file: fileName },
    });
  }
  return out;
}

const BACKUP_TITLE = /^(.*) \((\d{1,2}\/\d{1,2}\/\d{4}_\d{1,2}:\d{1,2})\)--\d+tabs$/s;

/**
 * @param {any} data         parsed { format: "MySessions-Backup", ... }
 * @param {string} fileName
 * @param {number} fileTime
 * @returns {ParsedSession[]}
 */
export function parseMySessionsBackup(data, fileName, fileTime) {
  /** @type {ParsedSession[]} */
  const out = [];
  const fallbackTime = Date.parse(data?.createdAt) || fileTime || Date.now();
  for (const s of Array.isArray(data?.sessions) ? data.sessions : []) {
    if (!s || typeof s !== 'object') continue;
    const rawTitle = typeof s.title === 'string' ? s.title : '';
    const m = BACKUP_TITLE.exec(rawTitle);
    const name = (m ? m[1] : rawTitle).trim() || '(untitled)';
    const createdAt = (m && parseMySessionsDate(m[2])) ?? fallbackTime;

    const windows = [];
    const loose = [];
    for (const child of Array.isArray(s.children) ? s.children : []) {
      if (!child) continue;
      if (Array.isArray(child.children)) {
        const tabs = child.children.map(toTab).filter(Boolean);
        if (!tabs.length) continue;
        const win = { tabs };
        const label = cleanLabel(child.title);
        if (label) win.label = label;
        windows.push(win);
      } else {
        const tab = toTab(child);
        if (tab) loose.push(tab);
      }
    }
    if (loose.length) windows.push({ tabs: loose });

    const fp = fingerprint(name, createdAt);
    out.push({
      name,
      createdAt,
      windows,
      originKey: `mysessions-fp:${fp}`,
      fp,
      origin: { type: 'mysessions', file: fileName },
    });
  }
  return out;
}

// Session data model + small pure helpers. No browser APIs.
//
// A session is stored as two records that share an id:
//   meta  — everything the lists need (name, dates, counts)        [store: meta]
//   data  — the windows and tabs themselves                        [store: data]
// so the popup can list hundreds of sessions without loading megabytes of tabs.

/**
 * @typedef {object} Tab
 * @property {string} t        stable id of this tab inside its session
 * @property {string} url
 * @property {string} title
 * @property {boolean} [pinned]
 * @property {string} [g]      key of the tab group it belongs to (see Win.groups)
 */

/**
 * @typedef {object} TabGroup
 * @property {string} k
 * @property {string} [title]
 * @property {string} [color]
 * @property {boolean} [collapsed]
 */

/**
 * @typedef {object} Win
 * @property {string} [label]
 * @property {number} [winId]      live browser window id (autosave snapshots only)
 * @property {TabGroup[]} [groups]
 * @property {Tab[]} tabs
 */

/**
 * @typedef {'saved' | 'current' | 'checkpoint' | 'previous' | 'closed'} SessionKind
 *   saved      — a session the user saved or imported
 *   current    — the live autosave of the running browser (exactly one)
 *   checkpoint — periodic autosave history of the running/previous browser
 *   previous   — what the browser looked like the last time(s) it closed
 *   closed     — a window that was closed while the browser kept running
 */

/**
 * @typedef {object} SessionMeta
 * @property {string} id
 * @property {SessionKind} kind
 * @property {string} name
 * @property {number} createdAt    ms epoch — when the tabs were captured
 * @property {number} updatedAt
 * @property {number} tabCount
 * @property {number} windowCount
 * @property {string} [originKey]  identity in the system it was imported from
 * @property {string} [fp]         name+minute fingerprint (duplicate detection)
 * @property {{type: string, file?: string, group?: string}} [origin]
 * @property {number} [deletedAt]  set while the session sits in the trash
 */

/** @typedef {SessionMeta & {windows: Win[]}} Session */

export const KIND = Object.freeze({
  SAVED: 'saved',
  CURRENT: 'current',
  CHECKPOINT: 'checkpoint',
  PREVIOUS: 'previous',
  CLOSED: 'closed',
});

/** Fixed id of the single live-autosave record. */
export const CURRENT_ID = 'auto:current';

export function newId() {
  return crypto.randomUUID();
}

/** Short random id for a tab within a session. */
export function newTid() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0].toString(36) + a[1].toString(36)).slice(0, 10);
}

/**
 * Coerce loosely-shaped input into a clean Tab, or null when it has no URL.
 * @param {any} raw
 * @returns {Tab | null}
 */
export function normalizeTab(raw) {
  if (!raw || typeof raw.url !== 'string') return null;
  const url = raw.url.trim();
  if (!url) return null;
  /** @type {Tab} */
  const tab = {
    t: typeof raw.t === 'string' && raw.t ? raw.t : newTid(),
    url,
    title: typeof raw.title === 'string' ? raw.title : '',
  };
  if (raw.pinned) tab.pinned = true;
  if (typeof raw.g === 'string' && raw.g) tab.g = raw.g;
  return tab;
}

/**
 * Clean a windows array: drop tabs without URLs, give every tab an id, and
 * drop tab-group definitions nothing points at. Empty windows are kept so tab
 * positions stay stable for undo; readers skip them.
 * @param {any} windows
 * @returns {Win[]}
 */
export function normalizeWindows(windows) {
  /** @type {Win[]} */
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w) continue;
    const tabs = [];
    for (const rt of Array.isArray(w.tabs) ? w.tabs : []) {
      const tab = normalizeTab(rt);
      if (!tab) continue;
      while (seen.has(tab.t)) tab.t = newTid();
      seen.add(tab.t);
      tabs.push(tab);
    }
    /** @type {Win} */
    const win = { tabs };
    if (typeof w.label === 'string' && w.label.trim()) win.label = w.label.trim();
    if (typeof w.winId === 'number') win.winId = w.winId;
    if (Array.isArray(w.groups) && w.groups.length) {
      const used = new Set(tabs.map((t) => t.g).filter(Boolean));
      const groups = w.groups
        .filter((g) => g && typeof g.k === 'string' && used.has(g.k))
        .map((g) => {
          /** @type {TabGroup} */
          const o = { k: g.k };
          if (typeof g.title === 'string' && g.title) o.title = g.title;
          if (typeof g.color === 'string' && g.color) o.color = g.color;
          if (g.collapsed) o.collapsed = true;
          return o;
        });
      if (groups.length) win.groups = groups;
      const known = new Set(groups.map((g) => g.k));
      for (const t of tabs) if (t.g && !known.has(t.g)) delete t.g;
    } else {
      for (const t of tabs) delete t.g;
    }
    out.push(win);
  }
  return out;
}

/** @param {Win[]} windows */
export function countTabs(windows) {
  let n = 0;
  for (const w of windows ?? []) n += w.tabs?.length ?? 0;
  return n;
}

/** Number of windows that actually hold tabs. @param {Win[]} windows */
export function countWindows(windows) {
  let n = 0;
  for (const w of windows ?? []) if (w.tabs?.length) n++;
  return n;
}

/**
 * Fingerprint used to recognise "the same session" arriving through different
 * export formats that share no id: same name, captured in the same minute.
 * @param {string} name
 * @param {number} createdAt
 */
export function fingerprint(name, createdAt) {
  return `${String(name ?? '').trim().toLowerCase()}|${Math.floor((createdAt || 0) / 60000)}`;
}

/**
 * Order-sensitive signature of a session's tabs, for "did anything change?"
 * comparisons between autosave snapshots. Titles are ignored on purpose —
 * a page retitling itself is not a different browsing state.
 * @param {Win[]} windows
 */
export function contentSignature(windows) {
  const parts = [];
  for (const w of windows ?? []) {
    if (!w.tabs?.length) continue;
    parts.push(w.tabs.map((t) => (t.pinned ? '*' : '') + t.url).join('\n'));
  }
  return parts.join('\n\u0000\n');
}

/**
 * Order-insensitive signature: the multiset of URLs. Two snapshots with the
 * same value hold the same pages, whatever the window/tab arrangement.
 * @param {Win[]} windows
 */
export function urlBagSignature(windows) {
  const urls = [];
  for (const w of windows ?? []) for (const t of w.tabs ?? []) urls.push(t.url);
  return urls.sort().join('\n');
}

/** Deep-copy windows, issuing fresh tab ids (for duplicates / promoted copies). */
export function cloneWindows(windows, { freshIds = true } = {}) {
  return (windows ?? []).map((w) => {
    /** @type {Win} */
    const win = { tabs: w.tabs.map((t) => ({ ...t, t: freshIds ? newTid() : t.t })) };
    if (w.label) win.label = w.label;
    if (w.groups) win.groups = w.groups.map((g) => ({ ...g }));
    return win;
  });
}

/** Flat list of a session's tabs with their position. @param {Win[]} windows */
export function* iterTabs(windows) {
  for (let w = 0; w < (windows?.length ?? 0); w++) {
    const tabs = windows[w].tabs ?? [];
    for (let i = 0; i < tabs.length; i++) yield { w, i, tab: tabs[i] };
  }
}

/**
 * "Session — 12 Nov 2026, 21:40" style fallback name.
 * @param {number} [at]
 */
export function defaultSessionName(at = Date.now()) {
  return `Session — ${formatDateTime(at)}`;
}

/** Locale date + time, minute precision. @param {number} ms */
export function formatDateTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Locale date only. @param {number} ms */
export function formatDate(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** "3 min ago" / "2 h ago" / "5 d ago", falling back to a date for old stamps. */
export function formatAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  return formatDate(ms);
}

/** "1 tab" / "32 tabs". */
export function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

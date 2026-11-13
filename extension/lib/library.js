// The link library: every saved session folded into one list of unique links.
// Pure — operates on data already loaded from the database.
import { KIND } from './model.js';
import { pickBestTitle } from './titles.js';
import { canonicalize, classify } from './url.js';

/** @typedef {import('./url.js').LinkKind} LinkKind */

/**
 * One row of a link table. In the "all links" view a row is a unique link and
 * `refs` lists every saved tab that points at it; in a session view a row is
 * exactly one tab.
 * @typedef {object} LinkRow
 * @property {string} key                      unique within the view
 * @property {string} canonical
 * @property {string} url                      an original (un-normalized) URL
 * @property {string} title
 * @property {LinkKind} kind
 * @property {string | null} status            dead-link verdict, if any
 * @property {number} date                     ms — (earliest) session date
 * @property {{sessionId: string, t: string}[]} refs
 * @property {number} sessionCount             distinct sessions holding it
 * @property {number} [w]                      window index (session view)
 * @property {number} [order]                  saved position (session view)
 * @property {boolean} [pinned]
 * @property {string} [titleLc]                lowercase caches for search/sort
 * @property {string} [urlLc]
 */

// canonicalize()/classify() parse URLs; cache them — the library asks for the
// same tens of thousands of URLs on every rebuild.
/** @type {Map<string, {canonical: string, kind: LinkKind}>} */
const urlCache = new Map();
const URL_CACHE_MAX = 200_000;

/** @param {string} url */
export function urlInfo(url) {
  let info = urlCache.get(url);
  if (!info) {
    if (urlCache.size >= URL_CACHE_MAX) urlCache.clear();
    info = { canonical: canonicalize(url), kind: classify(url) };
    urlCache.set(url, info);
  }
  return info;
}

/**
 * The verdict to show for a link. Search pages are permanently "n/a" without
 * ever being stored.
 * @param {LinkKind} kind
 * @param {import('./db.js').Check | undefined} check
 */
export function statusOf(kind, check) {
  if (check) return check.status;
  return kind === 'youtube_search' ? 'not_checkable' : null;
}

/** Sessions that make up the library: saved, and not in the trash. */
export function isLibrarySession(meta) {
  return meta.kind === KIND.SAVED && !meta.deletedAt;
}

/**
 * Fold all library sessions into unique links.
 * @param {import('./model.js').SessionMeta[]} metas
 * @param {Map<string, import('./model.js').Win[]>} dataById
 * @param {Map<string, import('./db.js').Check>} checks
 * @returns {LinkRow[]}
 */
export function buildLibrary(metas, dataById, checks) {
  /** @type {Map<string, LinkRow & {_sessions: Set<string>}>} */
  const rows = new Map();
  for (const meta of metas) {
    if (!isLibrarySession(meta)) continue;
    for (const win of dataById.get(meta.id) ?? []) {
      for (const tab of win.tabs) {
        const { canonical, kind } = urlInfo(tab.url);
        let row = rows.get(canonical);
        if (!row) {
          row = {
            key: canonical,
            canonical,
            url: tab.url,
            title: tab.title ?? '',
            kind,
            status: null,
            date: meta.createdAt,
            refs: [],
            sessionCount: 0,
            _sessions: new Set(),
          };
          rows.set(canonical, row);
        } else {
          row.title = pickBestTitle(row.title, tab.title) ?? '';
          if (meta.createdAt < row.date) row.date = meta.createdAt;
        }
        row.refs.push({ sessionId: meta.id, t: tab.t });
        row._sessions.add(meta.id);
      }
    }
  }
  const out = [];
  for (const row of rows.values()) {
    row.sessionCount = row._sessions.size;
    delete row._sessions;
    row.status = statusOf(row.kind, checks.get(row.canonical));
    row.titleLc = row.title.toLowerCase();
    row.urlLc = row.url.toLowerCase();
    out.push(row);
  }
  return out;
}

/**
 * One row per tab of a single session, in saved order.
 * @param {import('./model.js').Session} session
 * @param {Map<string, import('./db.js').Check>} checks
 * @returns {LinkRow[]}
 */
export function buildSessionRows(session, checks) {
  /** @type {LinkRow[]} */
  const out = [];
  let order = 0;
  session.windows.forEach((win, w) => {
    for (const tab of win.tabs) {
      const { canonical, kind } = urlInfo(tab.url);
      const title = tab.title ?? '';
      out.push({
        key: tab.t,
        canonical,
        url: tab.url,
        title,
        kind,
        status: statusOf(kind, checks.get(canonical)),
        date: session.createdAt,
        refs: [{ sessionId: session.id, t: tab.t }],
        sessionCount: 1,
        w,
        order: order++,
        pinned: !!tab.pinned,
        titleLc: title.toLowerCase(),
        urlLc: tab.url.toLowerCase(),
      });
    }
  });
  return out;
}

/** @typedef {'order' | 'title' | 'url' | 'kind' | 'date' | 'status' | 'sessions'} SortKey */

/**
 * Sorted copy of rows. Rows without a date/status sink to the bottom in
 * either direction.
 * @param {LinkRow[]} rows
 * @param {SortKey} key
 * @param {'asc' | 'desc'} dir
 */
export function sortRows(rows, key, dir) {
  const d = dir === 'asc' ? 1 : -1;
  const val = (r) =>
    key === 'title' ? r.titleLc
    : key === 'url' ? r.urlLc
    : key === 'kind' ? r.kind
    : key === 'date' ? r.date || 0
    : key === 'status' ? r.status ?? ''
    : key === 'sessions' ? r.sessionCount
    : r.order ?? 0;
  const sinkEmpty = key === 'date' || key === 'status';
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (sinkEmpty && (!x || !y)) return !x && !y ? 0 : !x ? 1 : -1;
    return x < y ? -d : x > y ? d : 0;
  });
}

/**
 * @param {LinkRow[]} rows
 * @param {{q?: string, kinds?: Set<string>, status?: string}} f
 *   status: 'all' | 'unchecked' | a verdict
 */
export function filterRows(rows, { q = '', kinds, status = 'all' }) {
  const needle = q.trim().toLowerCase();
  // Space-separated terms must all match (title or URL).
  const terms = needle ? needle.split(/\s+/) : [];
  return rows.filter((r) => {
    if (kinds?.size && !kinds.has(r.kind)) return false;
    if (status !== 'all') {
      if (status === 'unchecked' ? r.status !== null : r.status !== status) return false;
    }
    for (const term of terms) {
      if (!r.titleLc.includes(term) && !r.urlLc.includes(term)) return false;
    }
    return true;
  });
}

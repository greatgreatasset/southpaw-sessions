// URL canonicalization + classification. Pure — no browser APIs.
//
// Link identity across the whole library is `canonicalize(url)`. The rules are
// kept compatible with the retired firefox-session-analyzer so its cached
// dead-link verdicts and delete tombstones still match after migration.

/** @typedef {'youtube_video' | 'youtube_search' | 'imgur' | 'other'} LinkKind */

// Tracking params that never change page identity — stripped during canonicalize.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid',
]);

/**
 * Normalize a URL so duplicates collapse:
 *  - lowercase scheme + host, drop default port
 *  - strip tracking params, sort remaining params (order-insensitive)
 *  - drop the fragment, UNLESS it is a route/payload fragment (`#!…` or `#/…`):
 *    hashbang links such as `mega.nz/#!id!key` differ only in the fragment, and
 *    collapsing them would merge unrelated links into one
 *  - strip a trailing slash on the path
 * Non-http(s) schemes (file:, about:, moz-extension:) are returned trimmed as-is.
 * Unparseable input falls back to the trimmed original.
 * @param {string} url
 * @returns {string}
 */
export function canonicalize(url) {
  const raw = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (!/^#[!/]/.test(u.hash)) u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Classify a URL for the dead-link checker.
 * youtube.com/results?search_query=... is 'youtube_search' (never dies).
 * Only watch?v= / youtu.be / shorts / embed are 'youtube_video'.
 * @param {string} url
 * @returns {LinkKind}
 */
export function classify(url) {
  let host, path, params;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    path = u.pathname;
    params = u.searchParams;
  } catch {
    return 'other';
  }
  if (host === 'youtu.be') return 'youtube_video';
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (path === '/results') return 'youtube_search';
    if (path === '/watch' && params.has('v')) return 'youtube_video';
    if (path.startsWith('/shorts/') || path.startsWith('/embed/')) return 'youtube_video';
    return 'other';
  }
  if (host === 'imgur.com' || host.endsWith('.imgur.com')) return 'imgur';
  return 'other';
}

/** True for http(s) URLs — the only ones a network liveness check can apply to. */
export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url ?? ''));
}

/**
 * True when the URL is worth keeping in a crash-recovery snapshot — i.e. it is
 * a real page rather than a blank/new-tab placeholder.
 */
export function isMeaningfulUrl(url) {
  const u = String(url ?? '').trim().toLowerCase();
  if (!u) return false;
  return !/^about:(blank|newtab|home|privatebrowsing|sessionrestore|welcome)\b/.test(u);
}

/**
 * Firefox refuses to let extensions open privileged addresses (tabs.create
 * throws). Those are restored through a placeholder page instead.
 * @param {string} url
 */
export function isOpenableUrl(url) {
  const u = String(url ?? '').trim();
  if (/^(https?|ftp|wss?|view-source|moz-extension|blob):/i.test(u)) {
    return !/^view-source:(?!https?:)/i.test(u);
  }
  return /^about:(blank|reader)\b/i.test(u);
}

/** Hostname without a leading `www.`, or '' when the URL has none. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

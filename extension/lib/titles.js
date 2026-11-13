// "Richest title wins": when the same link appears in several sessions, the
// library shows the most informative cached title, so the description of a
// link survives even after the page itself is gone.

const PLACEHOLDER_TITLES = new Set(['', 'imgur', 'youtube', '- imgur', 'new tab']);

/** @param {string | null | undefined} t */
export function titleScore(t) {
  if (!t) return -1;
  const norm = t.trim().toLowerCase();
  if (PLACEHOLDER_TITLES.has(norm)) return 0;
  if (/^https?:\/\//.test(norm)) return 1; // a bare URL is barely a title
  return t.trim().length; // longer = richer
}

/**
 * Pick the better of two cached titles for the same URL. Ties keep `a`.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function pickBestTitle(a, b) {
  return titleScore(b) > titleScore(a) ? b : a;
}

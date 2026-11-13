// Imgur liveness.
// Calibrated against real responses (session analyzer, 2026-07): the page URL
// imgur.com/<id> returns 200 even when removed (it is an SPA), so it is useless.
// The DIRECT image i.imgur.com/<id>.png redirects to .../removed.png when gone.
// Albums/galleries (/a/<id>, /gallery/<id>) ARE existence-checked server-side:
// a live album serves 200 (even hidden/unlisted ones, which the oEmbed API 403s
// on), while a gone or never-existing one redirects to the imgur homepage.
//
// A browser cannot read the Location header of a redirect (redirect:"manual"
// yields an opaque response), so redirects are followed and the verdict is
// read from where the request ENDED UP — equivalent signal, same thresholds.
import { discard, fetchx } from './fetchx.js';

/** @typedef {import('./youtube.js').CheckResult} CheckResult */

/**
 * Extract the imgur id + type. Handles slugs (some-title-AbCdEfG), albums (/a/),
 * galleries (/gallery/), and direct files (i.imgur.com/<id>.png).
 * @param {string} url
 * @returns {{type: 'image' | 'album' | 'gallery', id: string} | null}
 */
export function parseImgur(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (parts[0] === 'a') return { type: 'album', id: parts[1] ?? '' };
    if (parts[0] === 'gallery') return { type: 'gallery', id: parts[1] ?? '' };
    let last = parts[parts.length - 1];
    last = last.replace(/\.[a-z0-9]+$/i, ''); // strip file extension
    const id = last.includes('-') ? last.split('-').pop() : last;
    return { type: 'image', id };
  } catch {
    return null;
  }
}

const isHomepage = (u) => /^https?:\/\/(www\.)?imgur\.com\/?(\?.*)?$/i.test(u);

/**
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<CheckResult>}
 */
export async function checkImgur(url, signal) {
  const ref = parseImgur(url);
  if (!ref || !ref.id) return { status: 'unknown' };
  if (ref.type !== 'image') return checkImgurAlbum(url, signal);

  try {
    const r = await fetchx(`https://i.imgur.com/${ref.id}.png`, { headers: { accept: 'image/*,*/*;q=0.5' } }, 10000, signal);
    discard(r);
    if (/\/removed\.[a-z]+/i.test(r.url)) return { status: 'dead', httpCode: 302 };
    if (r.status === 200) return { status: 'alive', httpCode: 200 };
    if (r.status === 404) return { status: 'dead', httpCode: 404 };
    return { status: 'unknown', httpCode: r.status };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Album/gallery pages: 200 = alive, redirected to the imgur homepage = gone.
 * @returns {Promise<CheckResult>}
 */
async function checkImgurAlbum(url, signal) {
  try {
    const r = await fetchx(url, {}, 10000, signal);
    discard(r);
    if (r.redirected && isHomepage(r.url)) return { status: 'dead', httpCode: 301 };
    if (r.status === 404) return { status: 'dead', httpCode: 404 };
    if (r.status === 200) {
      // A redirect that stays on an album/gallery page is just a canonical
      // URL fix-up; anything else is inconclusive.
      const stillAlbum = /\/(a|gallery)\//.test(new URL(r.url).pathname);
      return !r.redirected || stillAlbum ? { status: 'alive', httpCode: 200 } : { status: 'unknown', httpCode: 200 };
    }
    return { status: 'unknown', httpCode: r.status };
  } catch {
    return { status: 'unknown' };
  }
}

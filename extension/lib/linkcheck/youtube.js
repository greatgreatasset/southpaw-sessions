// YouTube liveness via oEmbed, with a watch-page fallback for 401s.
// Calibrated against real responses (re-verified 2026-07 in the session
// analyzer): 200 -> alive, 404 -> dead (removed), 400 -> malformed id (unknown).
// 401 does NOT mean dead — oEmbed 401s any non-embeddable video, most often a
// public video whose owner disabled embedding. Disambiguate via the watch page
// (always HTTP 200; liveness lives in its embedded "playabilityStatus" JSON):
//   OK -> alive · ERROR -> dead (removed) · LOGIN_REQUIRED -> dead (private)
//   UNPLAYABLE + members-only reason -> paywalled (exists, channel members only)
// Thumbnails (i.ytimg.com) are useless as a signal — 200 even for members-only.
import { discard, fetchx } from './fetchx.js';

/** @typedef {{status: 'alive' | 'dead' | 'paywalled' | 'unknown' | 'not_checkable', httpCode?: number, detail?: string}} CheckResult */

/**
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<CheckResult>}
 */
export async function checkYouTube(url, signal) {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  try {
    const r = await fetchx(oembed, {}, 10000, signal);
    discard(r);
    if (r.status === 200) return { status: 'alive', httpCode: 200 };
    if (r.status === 404) return { status: 'dead', httpCode: 404 };
    if (r.status === 401) return checkWatchPage(url, signal);
    return { status: 'unknown', httpCode: r.status };
  } catch {
    return { status: 'unknown' };
  }
}

/** @returns {Promise<CheckResult>} */
async function checkWatchPage(url, signal) {
  // Normalize to a bare watch URL: strips playlist/timestamp params and turns
  // /shorts/<id>, /embed/<id> and youtu.be/<id> into /watch?v=<id>.
  const id = url.match(/(?:[?&]v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/)?.[1];
  const watchUrl = id ? `https://www.youtube.com/watch?v=${id}` : url;
  try {
    const r = await fetchx(watchUrl, {}, 15000, signal);
    if (r.status !== 200) {
      discard(r);
      return { status: 'unknown', httpCode: r.status, detail: 'watch page not 200' };
    }
    const html = await r.text();
    const m = html.match(/"playabilityStatus":\{"status":"([A-Z_]+)"(?:,"reason":"((?:[^"\\]|\\.)*)")?/);
    if (!m) return { status: 'unknown', httpCode: 200, detail: 'no playabilityStatus' };
    const [, st, reason = ''] = m;
    if (st === 'OK') return { status: 'alive', httpCode: 200, detail: 'embed disabled' };
    if (st === 'ERROR') return { status: 'dead', httpCode: 200, detail: 'playability:ERROR' };
    if (st === 'LOGIN_REQUIRED') return { status: 'dead', httpCode: 200, detail: 'private' };
    if (st === 'UNPLAYABLE' && /members[- ]only/i.test(reason)) {
      return { status: 'paywalled', httpCode: 200, detail: 'members-only' };
    }
    return { status: 'unknown', httpCode: 200, detail: `playability:${st}` };
  } catch {
    return { status: 'unknown', detail: 'watch page fetch failed' };
  }
}

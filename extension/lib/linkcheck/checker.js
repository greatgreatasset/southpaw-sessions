// Orchestrates dead-link checking: route each link by kind -> youtube / imgur /
// generic, cache every verdict by canonical URL. Concurrency-capped and
// resumable: links with a settled verdict are skipped, but 'unknown' (timeouts,
// rate limits, network blips) is retried on every run so a transient failure
// never sticks. Runs inside the manager page; closing the page just pauses it.
import { isHttpUrl } from '../url.js';
import { discard, fetchx } from './fetchx.js';
import { checkImgur } from './imgur.js';
import { checkYouTube } from './youtube.js';

/** @typedef {import('./youtube.js').CheckResult} CheckResult */
/** @typedef {import('../db.js').Check} Check */

export const DEFAULT_CONCURRENCY = 6;

/**
 * Any other website (opt-in). Deliberately conservative: only an explicit
 * 404/410 counts as dead and only a 2xx counts as alive. Bot walls (403/429),
 * server errors and unreachable hosts stay 'unknown' — a site being down today
 * is not proof the link is gone.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<CheckResult>}
 */
export async function checkGeneric(url, signal) {
  try {
    const r = await fetchx(url, { headers: { accept: 'text/html,*/*;q=0.8' } }, 12000, signal);
    discard(r);
    if (r.status === 404 || r.status === 410) return { status: 'dead', httpCode: r.status };
    if (r.ok) return { status: 'alive', httpCode: r.status };
    return { status: 'unknown', httpCode: r.status };
  } catch {
    return { status: 'unknown', detail: 'unreachable' };
  }
}

/**
 * Whether a link of this kind can be checked at all.
 * @param {string} kind
 * @param {string} url
 * @param {boolean} otherSites  the opt-in generic checker is enabled
 */
export function isCheckable(kind, url, otherSites) {
  if (kind === 'youtube_video' || kind === 'imgur') return true;
  if (kind === 'youtube_search') return false;
  return otherSites && isHttpUrl(url);
}

/**
 * Whether a link still needs a network check.
 * Two legacy verdicts imported from the session analyzer are retried until
 * they heal: imgur 'not_checkable' (albums, before they became checkable) and
 * youtube 'dead' with http 401 (the pre-2026-07 misreading of oEmbed 401).
 * @param {string} kind
 * @param {Check | undefined} check
 */
export function needsCheck(kind, check) {
  if (!check) return true;
  if (check.status === 'unknown') return true;
  if (kind === 'imgur' && check.status === 'not_checkable') return true;
  if (kind === 'youtube_video' && check.status === 'dead' && check.httpCode === 401) return true;
  return false;
}

/**
 * @param {string} kind
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<CheckResult>}
 */
export function checkOne(kind, url, signal) {
  if (kind === 'youtube_video') return checkYouTube(url, signal);
  if (kind === 'imgur') return checkImgur(url, signal);
  if (kind === 'other' && isHttpUrl(url)) return checkGeneric(url, signal);
  return Promise.resolve({ status: 'not_checkable' });
}

/**
 * @typedef {object} CheckJob
 * @property {boolean} running
 * @property {number} total
 * @property {number} checked
 * @property {number} alive
 * @property {number} dead
 * @property {number} paywalled
 * @property {number} unknown
 * @property {number} notCheckable
 * @property {number | null} startedAt
 * @property {number | null} finishedAt
 * @property {boolean} stopped
 */

/** @returns {CheckJob} */
export function newJob() {
  return {
    running: false, total: 0, checked: 0, alive: 0, dead: 0, paywalled: 0, unknown: 0,
    notCheckable: 0, startedAt: null, finishedAt: null, stopped: false,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check every link that needs it.
 *
 * @param {object} opts
 * @param {{canonical: string, url: string, kind: string}[]} opts.links
 * @param {Map<string, Check>} opts.checks           current verdict cache
 * @param {CheckJob} opts.job                        mutated in place (progress)
 * @param {(batch: Check[]) => Promise<void>} opts.save   persist a batch of verdicts
 * @param {boolean} [opts.otherSites]
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 * @param {() => void} [opts.onProgress]
 * @param {typeof checkOne} [opts.check]             injectable for tests
 */
export async function runChecks({
  links, checks, job, save, otherSites = false, concurrency = DEFAULT_CONCURRENCY,
  signal, onProgress, check = checkOne,
}) {
  if (job.running) return;
  const seen = new Set();
  const pending = [];
  for (const l of links) {
    if (seen.has(l.canonical)) continue;
    seen.add(l.canonical);
    if (isCheckable(l.kind, l.url, otherSites) && needsCheck(l.kind, checks.get(l.canonical))) pending.push(l);
  }
  Object.assign(job, newJob(), { running: true, total: pending.length, startedAt: Date.now() });
  onProgress?.();

  /** @type {Check[]} */
  let buffer = [];
  let lastFlush = Date.now();
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    lastFlush = Date.now();
    await save(batch);
  };

  // Arbitrary sites get one request at a time per host, spaced out, so a
  // session full of links to one forum is not a burst against that forum.
  /** @type {Map<string, Promise<void>>} */
  const hostQueue = new Map();
  const politely = (url, fn) => {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return fn();
    }
    const prev = hostQueue.get(host) ?? Promise.resolve();
    const run = prev.then(fn);
    hostQueue.set(host, run.then(() => sleep(400), () => sleep(400)));
    return run;
  };

  let next = 0;
  const worker = async () => {
    while (next < pending.length && !signal?.aborted) {
      const link = pending[next++];
      /** @type {CheckResult} */
      let res;
      try {
        res = link.kind === 'other'
          ? await politely(link.url, () => check(link.kind, link.url, signal))
          : await check(link.kind, link.url, signal);
      } catch {
        res = { status: 'unknown' };
      }
      // A request cut short by Stop is not a verdict — leave the link unchecked.
      if (signal?.aborted) break;

      /** @type {Check} */
      const rec = { url: link.canonical, status: res.status, checkedAt: Date.now() };
      if (res.httpCode != null) rec.httpCode = res.httpCode;
      if (res.detail) rec.detail = res.detail;
      checks.set(link.canonical, rec);
      buffer.push(rec);

      job.checked++;
      if (res.status === 'alive') job.alive++;
      else if (res.status === 'dead') job.dead++;
      else if (res.status === 'paywalled') job.paywalled++;
      else if (res.status === 'not_checkable') job.notCheckable++;
      else job.unknown++;
      onProgress?.();

      if (buffer.length >= 25 || Date.now() - lastFlush > 3000) await flush();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, worker));
  } finally {
    await flush();
    job.running = false;
    job.stopped = !!signal?.aborted;
    job.finishedAt = Date.now();
    onProgress?.();
  }
}

/**
 * Coverage numbers for a set of links.
 * @param {{canonical: string, url: string, kind: string}[]} links
 * @param {Map<string, Check>} checks
 * @param {boolean} otherSites
 */
export function coverage(links, checks, otherSites) {
  let checkable = 0, checked = 0, dead = 0, alive = 0;
  const seen = new Set();
  for (const l of links) {
    if (seen.has(l.canonical)) continue;
    seen.add(l.canonical);
    if (!isCheckable(l.kind, l.url, otherSites)) continue;
    checkable++;
    const c = checks.get(l.canonical);
    if (!c) continue;
    checked++;
    if (c.status === 'dead') dead++;
    else if (c.status === 'alive') alive++;
  }
  return { checkable, checked, dead, alive };
}

// fetch with a per-request timeout (a hung socket must not stall a long batch),
// no cookies, no cache. Works in extension pages and in Node (tests).

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @param {AbortSignal} [outer]  cancels the request when the whole run is stopped
 */
export async function fetchx(url, init = {}, timeoutMs = 10000, outer) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...init,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** Stop downloading a response body we only needed the headers of. */
export function discard(response) {
  try {
    response.body?.cancel()?.catch?.(() => {});
  } catch {
    // Body already consumed or not cancellable — nothing to free.
  }
}

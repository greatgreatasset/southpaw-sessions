// Call a command in the background script (see `handlers` in background.js).
// Window/tab work lives there because a popup dies as soon as it loses focus.

/**
 * @param {string} cmd
 * @param {Record<string, any>} [args]
 * @returns {Promise<any>} the command's result; rejects with its error message
 */
export async function call(cmd, args = {}) {
  const res = await browser.runtime.sendMessage({ cmd, ...args });
  if (!res) throw new Error('The extension did not respond. Try again.');
  if (!res.ok) throw new Error(res.error || 'Something went wrong.');
  return res.result;
}

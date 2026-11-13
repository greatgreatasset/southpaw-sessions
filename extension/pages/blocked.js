// Placeholder shown in place of a saved tab whose address (file:, about:config,
// …) Firefox refuses to open on an extension's behalf.
const params = new URLSearchParams(location.search);
const url = params.get('u') ?? '';
const title = params.get('t') || url || 'Saved address';

document.title = title;
document.getElementById('title').textContent = title;
const input = /** @type {HTMLInputElement} */ (document.getElementById('url'));
input.value = url;
input.addEventListener('focus', () => input.select());

const button = document.getElementById('copy');
button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  button.textContent = 'Copied';
  setTimeout(() => {
    button.textContent = 'Copy';
  }, 1500);
});

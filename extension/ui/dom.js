// Tiny DOM toolkit shared by the popup and the manager page: element builder,
// icons, toast, dialogs and popup menus. No framework, no innerHTML.

const BOOLEAN_PROPS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readOnly', 'multiple', 'open', 'indeterminate']);

/**
 * Create an element.
 *   h('button', { class: 'btn', onclick: fn, disabled: true }, 'Save')
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children  nodes, strings, numbers, arrays; null/false are skipped
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (BOOLEAN_PROPS.has(key) || key === 'value') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.append(child instanceof Node ? child : String(child));
  }
}

/** Remove all children. @param {Element} el */
export function clear(el) {
  el.replaceChildren();
  return el;
}

/**
 * Append children, skipping null/false and flattening arrays. Use this rather
 * than the native `el.append()`, which renders null as the text "null".
 * @template {Element} T
 * @param {T} el
 * @param {...any} children
 * @returns {T}
 */
export function add(el, ...children) {
  append(el, children);
  return el;
}

/**
 * Replace an element's children (same child rules as `add`).
 * @template {Element} T
 * @param {T} el
 * @param {...any} children
 * @returns {T}
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// 24x24, stroke-drawn.
const ICONS = {
  open: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6L6 18',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M20 20l-3.6-3.6',
  settings: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M16 4v4 M10 10v4 M18 16v4',
  import: 'M12 4v11 M7 10l5 5 5-5 M4 20h16',
  export: 'M12 15V4 M7 9l5-5 5 5 M4 20h16',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  undo: 'M8 8L4 12l4 4 M4 12h11a5 5 0 0 1 0 10h-3',
  check: 'M5 12l5 5L20 7',
  window: 'M3 5h18v14H3z M3 9h18',
  layers: 'M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5 M3 17.5l9 5 9-5',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 7v5l3 2',
  down: 'M6 9l6 6 6-6',
  right: 'M9 6l6 6-6 6',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  stop: 'M7 7h10v10H7z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6z M12 13v7',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof typeof ICONS} name
 * @param {number} [size]
 */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** An icon-only button with an accessible label. */
export function iconButton(name, label, onclick, extraClass = '') {
  return h('button', { class: `icon-btn ${extraClass}`.trim(), type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

// ---- toast ---------------------------------------------------------------------

let toastTimer = null;

/**
 * Show a message at the bottom of the page, optionally with one action.
 * @param {string} message
 * @param {{action?: string, onAction?: () => void, ms?: number, kind?: 'info' | 'error'}} [opts]
 */
export function toast(message, { action, onAction, ms = 7000, kind = 'info' } = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const close = () => {
    clearTimeout(toastTimer);
    el.remove();
  };
  const el = h('div', { class: `toast ${kind}`, role: 'status' },
    h('span', { class: 'toast-msg' }, message),
    action && h('button', { class: 'btn small primary', type: 'button', onclick: () => { close(); onAction?.(); } }, action),
    iconButton('x', 'Dismiss', close, 'ghost'),
  );
  document.body.append(el);
  toastTimer = setTimeout(close, ms);
}

// ---- dialogs -------------------------------------------------------------------

/**
 * Open a modal dialog. `build(close)` returns the dialog's content; call
 * `close(value)` to dismiss. Resolves with that value (undefined on Escape).
 * @template T
 * @param {(close: (value?: T) => void) => Node | Node[]} build
 * @param {{class?: string}} [opts]
 * @returns {Promise<T | undefined>}
 */
export function openDialog(build, opts = {}) {
  return new Promise((resolve) => {
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: `dialog ${opts.class ?? ''}`.trim() }));
    let result;
    const close = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    // Click on the backdrop (the dialog element itself) dismisses.
    dialog.addEventListener('mousedown', (e) => {
      if (e.target === dialog) close(undefined);
    });
    const content = build(close);
    append(dialog, [content]);
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * @param {{title: string, message?: string | Node, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} o
 * @returns {Promise<boolean>}
 */
export async function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const ok = await openDialog((close) => [
    h('h2', null, title),
    message && h('div', { class: 'dialog-body' }, message),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, cancelLabel),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', autofocus: true, onclick: () => close(true) }, confirmLabel),
    ),
  ], { class: 'small' });
  return ok === true;
}

/**
 * Ask for one line of text.
 * @param {{title: string, label?: string, value?: string, placeholder?: string, confirmLabel?: string}} o
 * @returns {Promise<string | null>} null when cancelled
 */
export async function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  const result = await openDialog((close) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', class: 'input', value, placeholder, autofocus: true }));
    queueMicrotask(() => input.select());
    return h('form', { onsubmit: (e) => { e.preventDefault(); close(input.value); } },
      h('h2', null, title),
      h('label', { class: 'field' }, label && h('span', null, label), input),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, confirmLabel),
      ),
    );
  }, { class: 'small' });
  return typeof result === 'string' ? result : null;
}

// ---- popup menu -----------------------------------------------------------------

/**
 * @typedef {{label: string, icon?: string, onSelect?: () => void, danger?: boolean, disabled?: boolean, hint?: string}
 *           | {heading: string} | {separator: true} | {node: Node}} MenuItem
 */

/**
 * Show a menu anchored below an element. Closes on selection, outside click
 * or Escape.
 * @param {Element} anchor
 * @param {MenuItem[]} items
 * @param {{align?: 'left' | 'right'}} [opts]
 */
export function openMenu(anchor, items, { align = 'left' } = {}) {
  document.querySelector('.menu')?.remove();
  const menu = h('div', { class: 'menu', role: 'menu' });
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    for (const type of ['blur', 'resize', 'hashchange']) window.removeEventListener(type, close);
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  for (const item of items) {
    if (!item) continue;
    if ('separator' in item) menu.append(h('div', { class: 'menu-sep' }));
    else if ('heading' in item) menu.append(h('div', { class: 'menu-head' }, item.heading));
    else if ('node' in item) menu.append(item.node);
    else {
      menu.append(h('button', {
        class: `menu-item ${item.danger ? 'danger' : ''}`.trim(),
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled,
        onclick: () => { close(); item.onSelect?.(); },
      }, item.icon && icon(/** @type {any} */ (item.icon)), h('span', { class: 'menu-label' }, item.label), item.hint && h('span', { class: 'menu-hint' }, item.hint)));
    }
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // Armed right away, not from a timer: timers are throttled to a second in
  // background tabs. The click that opened the menu cannot close it — its
  // mousedown has already been dispatched by the time `click` runs.
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  // A menu must not outlive the view it was opened from.
  for (const type of ['blur', 'resize', 'hashchange']) window.addEventListener(type, close);
  return close;
}

/** Offer a generated file to the user as a download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Debounce: run `fn` once `ms` after the last call. */
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

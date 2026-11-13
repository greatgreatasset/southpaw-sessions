// Toolbar popup: save the current tabs, reopen a saved session.
import { isSavableTab } from '../lib/capture.js';
import * as db from '../lib/db.js';
import { KIND, formatAgo, formatDateTime, plural } from '../lib/model.js';
import { call } from '../lib/rpc.js';
import { restoreSessions, trashSessions } from '../lib/sessions.js';
import { getSettings } from '../lib/settings.js';
import { add, clear, fill, h, icon, iconButton } from '../ui/dom.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 60;

const state = {
  /** @type {import('../lib/model.js').SessionMeta[]} */
  metas: [],
  /** @type {import('../lib/settings.js').Settings | null} */
  settings: null,
  filter: '',
  shown: PAGE_SIZE,
  scope: 'all',
  windowId: /** @type {number | undefined} */ (undefined),
  highlighted: /** @type {number[]} */ ([]),
  confirmId: /** @type {string | null} */ (null),
};

init().catch((e) => notice(String(e?.message ?? e), 'error'));

async function init() {
  $('manage').append('Manage sessions & links', icon('open', 13));
  $('manage').addEventListener('click', () => openManager());
  $('save-form').addEventListener('submit', onSave);
  $('filter').addEventListener('input', (e) => {
    state.filter = /** @type {HTMLInputElement} */ (e.target).value;
    state.shown = PAGE_SIZE;
    renderList();
  });
  $('sessions').addEventListener('scroll', () => {
    const el = $('sessions');
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 80 && state.shown < filtered().length) {
      state.shown += PAGE_SIZE;
      renderList();
    }
  });

  const [win, tabs, settings] = await Promise.all([
    browser.windows.getCurrent(),
    browser.tabs.query({}),
    getSettings(),
  ]);
  state.windowId = win.id;
  state.settings = settings;
  renderScope(win, tabs);

  await reload();
  db.onChange(() => reload());
}

async function reload() {
  state.metas = await db.listMeta();
  renderRecover();
  renderList();
  renderFooter();
}

// ---- save ---------------------------------------------------------------------

function renderScope(win, tabs) {
  // Count what a save would actually capture: no blank tabs, no pages of
  // this extension, no private tabs unless enabled.
  const mine = (t) => (state.settings.savePrivate || !t.incognito) && isSavableTab(t);
  const all = tabs.filter(mine).length;
  const here = tabs.filter((t) => t.windowId === win.id && mine(t)).length;
  const picked = tabs.filter((t) => t.windowId === win.id && t.highlighted && mine(t));
  state.highlighted = picked.map((t) => t.id);

  const options = [['all', 'All windows', all], ['window', 'This window', here]];
  if (picked.length > 1) options.push(['tabs', 'Selected tabs', picked.length]);
  // One window: "all" and "this window" are the same thing — offer it once.
  const single = new Set(tabs.filter(mine).map((t) => t.windowId)).size <= 1;
  const shownOptions = single ? options.filter(([v]) => v !== 'window') : options;
  if (single) shownOptions[0][1] = 'All tabs';

  fill($('scope'), ...shownOptions.map(([value, label, n]) =>
    h('label', null,
      h('input', {
        type: 'radio', name: 'scope', value, checked: value === state.scope,
        onchange: () => { state.scope = /** @type {string} */ (value); },
      }),
      label, h('span', { class: 'n' }, n),
    )));
}

async function onSave(e) {
  e.preventDefault();
  const button = /** @type {HTMLButtonElement} */ ($('save'));
  const input = /** @type {HTMLInputElement} */ ($('name'));
  const closeAfter = /** @type {HTMLInputElement} */ ($('close-after')).checked;
  button.disabled = true;
  try {
    const res = await call('save', {
      name: input.value,
      scope: state.scope,
      windowId: state.windowId,
      tabIds: state.scope === 'tabs' ? state.highlighted : undefined,
      closeAfter,
    });
    input.value = '';
    notice(`Saved “${res.name}” — ${plural(res.tabCount, 'tab')}`);
    await reload();
  } catch (err) {
    notice(String(err?.message ?? err), 'error');
  } finally {
    button.disabled = false;
  }
}

function notice(text, kind = 'info', action) {
  const el = $('notice');
  el.className = `notice ${kind === 'error' ? 'error' : ''}`.trim();
  fill(el, h('span', null, text));
  if (action) add(el, h('button', { class: 'btn small', type: 'button', onclick: action.run }, action.label));
  el.hidden = false;
}

// ---- crash recovery strip --------------------------------------------------------

async function renderRecover() {
  const el = $('recover');
  const previous = state.metas.filter((m) => m.kind === KIND.PREVIOUS).sort((a, b) => b.createdAt - a.createdAt)[0];
  const { recoverDismissed } = await browser.storage.local.get('recoverDismissed');
  if (!previous || recoverDismissed === previous.id) {
    el.hidden = true;
    return;
  }
  const dismiss = async () => {
    await browser.storage.local.set({ recoverDismissed: previous.id });
    el.hidden = true;
  };
  fill(el,
    h('div', { class: 'txt' },
      h('div', { class: 't' }, 'Previous browser session'),
      h('div', { class: 's' }, `${plural(previous.tabCount, 'tab')} · closed ${formatAgo(previous.createdAt)}`),
    ),
    h('button', { class: 'btn small primary', type: 'button', onclick: async () => { await dismiss(); open(previous.id, 'new-window'); } }, 'Restore'),
    iconButton('x', 'Hide (it stays available in the manager)', dismiss),
  );
  el.hidden = false;
}

// ---- session list ------------------------------------------------------------------

function filtered() {
  const needle = state.filter.trim().toLowerCase();
  return state.metas
    .filter((m) => m.kind === KIND.SAVED && !m.deletedAt && (!needle || m.name.toLowerCase().includes(needle)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function renderList() {
  const list = filtered();
  const ul = clear($('sessions'));
  for (const m of list.slice(0, state.shown)) add(ul, state.confirmId === m.id ? confirmRow(m) : sessionRow(m));

  const empty = $('empty');
  const savedCount = state.metas.filter((m) => m.kind === KIND.SAVED && !m.deletedAt).length;
  empty.hidden = list.length > 0;
  if (!list.length) {
    fill(empty, savedCount
      ? `No session matches “${state.filter.trim()}”.`
      : h('div', null,
        h('div', null, 'No saved sessions yet. Save your tabs above, or bring in sessions from another session manager.'),
        h('button', { class: 'btn small', type: 'button', onclick: () => openManager('#import') }, icon('import', 14), 'Import sessions…')));
  }
}

function sessionRow(m) {
  const sub = [formatDateTime(m.createdAt), plural(m.tabCount, 'tab')];
  if (m.windowCount > 1) sub.push(`${m.windowCount} windows`);
  return h('li', { class: 'row' },
    h('button', { class: 'row-main', type: 'button', title: 'Open in a new window', onclick: () => requestOpen(m) },
      h('span', { class: 'name' }, m.name),
      h('span', { class: 'sub' }, sub.join(' · ')),
    ),
    h('span', { class: 'row-actions' },
      iconButton('plus', 'Add its tabs to this window', () => open(m.id, 'current-window')),
      iconButton('edit', 'View and edit', () => openManager(`#s/${m.id}`)),
      iconButton('trash', 'Move to trash', () => trash(m), 'danger'),
    ),
  );
}

function confirmRow(m) {
  const cancel = () => { state.confirmId = null; renderList(); };
  return h('li', { class: 'row confirm' },
    h('span', { class: 'q' }, `Open ${plural(m.tabCount, 'tab')}?`),
    h('button', { class: 'btn small primary', type: 'button', autofocus: true, onclick: () => open(m.id, 'new-window') }, 'Open'),
    h('button', { class: 'btn small', type: 'button', onclick: cancel }, 'Cancel'),
  );
}

function requestOpen(m) {
  const limit = state.settings.confirmOpenOver;
  if (limit > 0 && m.tabCount > limit && state.confirmId !== m.id) {
    state.confirmId = m.id;
    renderList();
    return;
  }
  open(m.id, 'new-window');
}

function open(sessionId, mode) {
  // Fire and close: the background script does the work, and a new window
  // taking focus would close this popup mid-way anyway.
  browser.runtime.sendMessage({ cmd: 'open', sessionId, mode, windowId: state.windowId }).catch(() => {});
  setTimeout(() => window.close(), 60);
}

async function trash(m) {
  await trashSessions([m.id]);
  await reload();
  notice(`Moved “${m.name}” to the trash.`, 'info', {
    label: 'Undo',
    run: async () => {
      await restoreSessions([m.id]);
      $('notice').hidden = true;
      await reload();
    },
  });
}

function renderFooter() {
  const saved = state.metas.filter((m) => m.kind === KIND.SAVED && !m.deletedAt);
  const tabs = saved.reduce((n, m) => n + m.tabCount, 0);
  const closed = state.metas.filter((m) => m.kind === KIND.CLOSED).length;
  fill($('footer'),
    h('span', null, `${plural(saved.length, 'session')} · ${plural(tabs, 'tab')}`),
    h('span', { class: 'grow' }),
    h('button', { type: 'button', onclick: () => openManager('#auto') },
      closed ? `Closed windows (${closed}) & autosaves` : 'Autosaves'),
  );
}

// ---- manager page ----------------------------------------------------------------

async function openManager(hash = '') {
  const base = browser.runtime.getURL('pages/manager.html');
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(base));
  if (existing) {
    await browser.tabs.update(existing.id, hash ? { active: true, url: base + hash } : { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: base + hash });
  }
  window.close();
}

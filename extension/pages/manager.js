// The manager page: every session in the sidebar, and one link table that
// shows either a single session or all links of all sessions folded together.
import { dismissBackupWarning, getBackupState } from '../lib/backup.js';
import { isSavableTab } from '../lib/capture.js';
import * as db from '../lib/db.js';
import { buildExport, toUrlList } from '../lib/export.js';
import { buildLibrary, buildSessionRows, filterRows, isLibrarySession, sortRows } from '../lib/library.js';
import { coverage, newJob, runChecks } from '../lib/linkcheck/checker.js';
import { KIND, defaultSessionName, formatAgo, formatDate, formatDateTime, plural } from '../lib/model.js';
import { call } from '../lib/rpc.js';
import * as sessions from '../lib/sessions.js';
import { getSettings, onSettingsChanged } from '../lib/settings.js';
import { add, clear, confirmDialog, debounce, downloadBlob, fill, h, icon, iconButton, openDialog, openMenu, promptDialog, toast } from '../ui/dom.js';
import { KIND_LABEL, LinkTable } from '../ui/link-table.js';
import { openImportDialog } from './import-dialog.js';
import { openSettingsDialog } from './settings-dialog.js';
import { renderTrash } from './trash-view.js';

/** @typedef {import('../lib/library.js').LinkRow} LinkRow */
/** @typedef {import('../lib/model.js').SessionMeta} SessionMeta */

const $ = (id) => document.getElementById(id);
const CHECK_ORIGINS = ['https://www.youtube.com/*', 'https://i.imgur.com/*', 'https://imgur.com/*'];
const AUTO_LABEL = { current: 'Live autosave', previous: 'Previous browser session', closed: 'Closed window', checkpoint: 'Autosave checkpoint' };

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(`southpaw.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`southpaw.${key}`, value);
    } catch {
      // Preference just won't persist.
    }
  },
};

const state = {
  /** @type {SessionMeta[]} */
  metas: [],
  /** @type {Map<string, import('../lib/model.js').Win[]>} */
  dataById: new Map(),
  /** @type {Map<string, import('../lib/db.js').Check>} */
  checks: new Map(),
  /** @type {import('../lib/settings.js').Settings} */
  settings: /** @type {any} */ (null),
  /** @type {{type: 'all'} | {type: 'session', id: string} | {type: 'trash'}} */
  view: { type: 'all' },
  /** @type {import('../lib/model.js').Session | null} */
  session: null,
  side: { q: '', sort: store.get('sideSort', 'date-desc'), autoOpen: store.get('autoOpen', '0') === '1' },
  filters: { q: '', kinds: /** @type {Set<string>} */ (new Set()), status: 'all' },
  sortAll: { key: 'title', dir: 'asc' },
  sortSession: { key: 'order', dir: 'asc' },
  /** @type {LinkRow[]} */ rows: [],
  /** @type {LinkRow[]} */ sorted: [],
  /** @type {LinkRow[]} */ filtered: [],
  libraryCount: 0,
  job: newJob(),
  /** @type {AbortController | null} */ abort: null,
  excludeDead: false,
  windowId: /** @type {number | undefined} */ (undefined),
};

const sortState = () => (state.view.type === 'session' ? state.sortSession : state.sortAll);

const table = new LinkTable({
  onRemove: (row) => removeRows([row], state.view.type === 'session' ? 'session' : 'everywhere'),
  onOpen: (row) => run(() => call('openLinks', { links: [{ url: row.url, title: row.title }], mode: 'current-window', windowId: state.windowId })),
  onSelectionChange: () => renderBar(),
  onSort: (key) => {
    const s = sortState();
    if (s.key === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
    else Object.assign(s, { key, dir: 'asc' });
    table.setSort(s.key, s.dir);
    syncSortControls();
    applyRows();
  },
  onShowSessions: (row, anchor) => showSessionsOf(row, anchor),
});

/** Run an async action, reporting failures instead of swallowing them. */
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(String(/** @type {any} */ (e)?.message ?? e), { kind: 'error' });
    return undefined;
  }
}

// ---- data ---------------------------------------------------------------------

async function loadAll() {
  const [metas, data, checks] = await Promise.all([db.listMeta(), db.getAllData(), db.getAllChecks()]);
  state.metas = metas;
  state.dataById = data;
  state.checks = checks;
}

const savedSessions = () => state.metas.filter(isLibrarySession);

/** Re-read sessions that a mutation touched, then redraw. */
async function refreshAfterMutation(ids) {
  state.metas = await db.listMeta();
  for (const id of ids) {
    const s = await db.getSession(id);
    if (s) state.dataById.set(id, s.windows);
    else state.dataById.delete(id);
  }
  await refreshView();
}

// ---- routing --------------------------------------------------------------------

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (raw.startsWith('s/')) return { view: /** @type {const} */ ({ type: 'session', id: raw.slice(2) }) };
  if (raw === 'trash') return { view: /** @type {const} */ ({ type: 'trash' }) };
  return { view: /** @type {const} */ ({ type: 'all' }), intent: raw };
}

function go(hash) {
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}

async function onRoute() {
  const { view, intent } = parseHash();
  state.view = view;
  if (intent === 'auto') {
    state.side.autoOpen = true;
    store.set('autoOpen', '1');
    const newest = state.metas.filter((m) => m.kind === KIND.PREVIOUS).sort((a, b) => b.createdAt - a.createdAt)[0]
      ?? state.metas.find((m) => m.kind === KIND.CURRENT);
    if (newest) {
      history.replaceState(null, '', `#s/${newest.id}`);
      state.view = { type: 'session', id: newest.id };
    }
  }
  if (intent === 'import' || intent === 'settings' || intent === 'welcome' || intent === 'auto') {
    if (state.view.type === 'all') history.replaceState(null, '', '#all');
  }
  await showView();
  if (intent === 'import') openImport();
  if (intent === 'settings') openSettings();
}

// ---- sidebar ---------------------------------------------------------------------

function renderSidebar() {
  const saved = savedSessions();
  const tabs = saved.reduce((n, m) => n + m.tabCount, 0);
  $('stats').textContent = `${plural(saved.length, 'session')} · ${plural(tabs, 'tab')}`;

  const navAll = $('nav-all');
  navAll.className = `nav ${state.view.type === 'all' ? 'active' : ''}`.trim();
  fill(navAll, icon('layers'), h('span', { class: 'grow' }, 'All links'),
    h('span', { class: 'count' }, state.libraryCount ? state.libraryCount.toLocaleString() : ''));

  const needle = state.side.q.trim().toLowerCase();
  const list = saved.filter((m) => !needle || m.name.toLowerCase().includes(needle));
  const sort = state.side.sort;
  list.sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : sort === 'size' ? b.tabCount - a.tabCount
    : sort === 'date-asc' ? a.createdAt - b.createdAt
    : b.createdAt - a.createdAt);

  const activeId = state.view.type === 'session' ? state.view.id : null;
  const item = (m, name, sub) =>
    h('button', {
      class: `sess ${m.id === activeId ? 'active' : ''}`.trim(), type: 'button', title: name,
      onclick: () => go(`#s/${m.id}`),
    },
    h('span', { class: 'sess-main' }, h('span', { class: 'sess-name' }, name), h('span', { class: 'sess-sub' }, sub)),
    h('span', { class: 'count' }, m.tabCount));

  const nodes = [h('div', { class: 'sec' }, h('span', { class: 'grow' }, 'Saved sessions'), h('span', null, list.length))];
  if (!list.length) {
    nodes.push(h('div', { class: 'side-empty' }, saved.length ? 'No session matches.' : 'Nothing saved yet.'));
  }
  for (const m of list) nodes.push(item(m, m.name, formatDateTime(m.createdAt)));

  // Automatic snapshots: live autosave, previous browser sessions, closed windows, checkpoints.
  /** @type {string[]} */
  const order = [KIND.CURRENT, KIND.PREVIOUS, KIND.CLOSED, KIND.CHECKPOINT];
  const auto = state.metas
    .filter((m) => m.kind !== KIND.SAVED)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.createdAt - a.createdAt);
  if (auto.length) {
    nodes.push(h('button', {
      class: 'sec', type: 'button', title: 'Crash recovery: what the browser had open',
      onclick: () => {
        state.side.autoOpen = !state.side.autoOpen;
        store.set('autoOpen', state.side.autoOpen ? '1' : '0');
        renderSidebar();
      },
    }, icon(state.side.autoOpen ? 'down' : 'right', 12), h('span', { class: 'grow' }, 'Automatic'), h('span', null, auto.length)));
    if (state.side.autoOpen || (activeId && auto.some((m) => m.id === activeId))) {
      for (const m of auto) {
        const when = m.kind === KIND.CURRENT ? `saved ${formatAgo(m.updatedAt)}` : formatDateTime(m.createdAt);
        nodes.push(item(m, AUTO_LABEL[m.kind] ?? m.name, when));
      }
    }
  }

  const trashed = state.metas.filter((m) => m.kind === KIND.SAVED && m.deletedAt).length;
  nodes.push(h('div', { class: 'sec' }, ''));
  nodes.push(h('button', { class: `sess ${state.view.type === 'trash' ? 'active' : ''}`.trim(), type: 'button', onclick: () => go('#trash') },
    icon('trash'), h('span', { class: 'sess-main' }, h('span', { class: 'sess-name' }, 'Trash')),
    h('span', { class: 'count' }, trashed || '')));

  fill($('side-list'), ...nodes);
}

// ---- main view --------------------------------------------------------------------

/** Enter a view: reset per-view state and build everything. */
async function showView() {
  table.picked.clear();
  state.filters = { q: '', kinds: new Set(), status: 'all' };
  await refreshView({ rebuildToolbar: true, keepScroll: false });
}

/** Recompute and redraw the current view. */
async function refreshView({ rebuildToolbar = false, keepScroll = true } = {}) {
  const view = state.view;
  const content = $('content');
  const showTable = () => {
    if (table.el.parentElement !== content) fill(content, table.el);
  };

  if (view.type === 'trash') {
    state.session = null;
    state.rows = [];
    renderSidebar();
    fill($('head'), h('div', { class: 'head-main' },
      h('div', { class: 'head-title' }, h('h2', null, 'Trash')),
      h('div', { class: 'head-sub' }, `Deleted sessions are kept for ${state.settings.trashDays} days. Removed links are kept until you erase them, and can be put back.`)));
    $('toolbar').hidden = true;
    $('bar').hidden = true;
    const panel = h('div', { class: 'panel' });
    fill(content, panel);
    await renderTrash(panel, {
      metas: state.metas,
      onChanged: async () => {
        await loadAll();
        await refreshView();
      },
    });
    return;
  }

  if (view.type === 'session') {
    const s = await db.getSession(view.id);
    if (!s) {
      toast('That session no longer exists.');
      history.replaceState(null, '', '#all');
      state.view = { type: 'all' };
      return refreshView({ rebuildToolbar: true, keepScroll: false });
    }
    state.session = s;
    state.rows = buildSessionRows(s, state.checks);
    // The library count is shown in the sidebar even when a session is open.
    if (!state.libraryCount) state.libraryCount = buildLibrary(state.metas, state.dataById, state.checks).length;
  } else {
    state.session = null;
    state.rows = buildLibrary(state.metas, state.dataById, state.checks);
    state.libraryCount = state.rows.length;
  }

  renderSidebar();
  renderHead();

  const empty = view.type === 'all' && savedSessions().length === 0;
  $('toolbar').hidden = empty;
  $('bar').hidden = empty;
  if (empty) {
    fill(content, welcomePanel());
    return;
  }
  showTable();
  const s = sortState();
  table.setMode(view.type === 'session' ? 'session' : 'all', {
    removeLabel: view.type === 'session' ? 'Remove from this session' : 'Delete from all sessions',
  });
  table.setSort(s.key, s.dir);
  if (rebuildToolbar) renderToolbar();
  state.sorted = [];
  applyRows({ keepScroll });
}

/** Sort + filter the current rows and hand them to the table. */
function applyRows({ keepScroll = false, resort = true } = {}) {
  const s = sortState();
  if (resort || !state.sorted.length) state.sorted = sortRows(state.rows, /** @type {any} */ (s.key), /** @type {any} */ (s.dir));
  const f = state.filters;
  const filtering = !!f.q.trim() || f.kinds.size > 0 || f.status !== 'all';
  state.filtered = filtering ? filterRows(state.sorted, f) : state.sorted;

  /** @type {import('../ui/link-table.js').Item[]} */
  let items;
  const session = state.session;
  const wins = session ? session.windows.filter((w) => w.tabs.length) : [];
  if (session && s.key === 'order' && s.dir === 'asc' && !filtering && wins.length > 1) {
    // Saved order: show the session window by window.
    items = [];
    let n = 0;
    let last = -1;
    for (const row of state.filtered) {
      if (row.w !== last) {
        last = row.w;
        n++;
        const win = session.windows[row.w];
        items.push({ type: 'header', label: win.label || `Window ${n}`, count: win.tabs.length });
      }
      items.push({ type: 'row', row });
    }
  } else {
    items = state.filtered.map((row) => ({ type: /** @type {const} */ ('row'), row }));
  }
  table.setItems(items, {
    emptyText: filtering ? 'No link matches these filters.' : 'This session has no links left.',
    keepScroll,
  });
  renderBar();
}

function welcomePanel() {
  const card = (iconName, title, text, onclick) =>
    h('button', { class: 'card', type: 'button', onclick }, icon(/** @type {any} */ (iconName), 22), h('b', null, title), h('span', null, text));
  return h('div', { class: 'panel' }, h('div', { class: 'welcome' },
    h('h2', null, 'Welcome to Southpaw Sessions'),
    h('p', null, 'Save every open tab as a named session, close them, and bring them back whenever you want. '
      + 'Everything you save also lands in one searchable list of links that you can prune and check for dead pages.'),
    h('div', { class: 'cards' },
      card('save', 'Save your current tabs', 'Store what is open right now as your first session.', () => saveDialog()),
      card('import', 'Import existing sessions', 'MySessions backups, Session Manager files, Firefox session files, or a Southpaw backup.', () => openImport()),
      card('settings', 'Check the settings', 'Autosave, crash recovery and automatic file backups are on by default.', () => openSettings()),
    ),
    h('p', { class: 'muted', style: { marginTop: '18px' } },
      'Tip: the toolbar button saves and reopens sessions without opening this page. Alt+Shift+S opens it from the keyboard.'),
  ));
}

// ---- header ------------------------------------------------------------------------

function renderHead() {
  const head = clear($('head'));
  const s = state.session;
  if (!s) {
    const n = savedSessions().length;
    add(head,
      h('div', { class: 'head-main' },
        h('div', { class: 'head-title' }, h('h2', null, 'All links')),
        h('div', { class: 'head-sub' }, n
          ? `${plural(state.rows.length, 'unique link')} across ${plural(n, 'saved session')}`
          : 'Nothing saved yet')),
      n ? h('div', { class: 'head-actions' }, h('span', { id: 'check-ui', class: 'head-actions' }), exportButton()) : null,
    );
    renderCheckUi();
    return;
  }

  const auto = s.kind !== KIND.SAVED;
  const title = auto ? AUTO_LABEL[s.kind] ?? s.name : s.name;
  const sub = [formatDateTime(s.createdAt), plural(s.tabCount, 'tab')];
  if (s.windowCount > 1) sub.push(`${s.windowCount} windows`);
  if (s.kind === KIND.CURRENT) sub[0] = `autosaved ${formatAgo(s.updatedAt)}`;
  if (s.deletedAt) sub.push('in the trash');
  else if (s.origin?.type && s.origin.type !== 'southpaw') {
    const from = { mysessions: 'MySessions', sessionmanager: 'Session Manager', sessionstore: 'a Firefox session file' }[s.origin.type];
    if (from) sub.push(`imported from ${from}`);
  }

  const openBtn = h('span', { class: 'split' },
    h('button', { class: 'btn primary', type: 'button', onclick: () => openSession('new-window') }, icon('open'), 'Open'),
    h('button', {
      class: 'btn primary', type: 'button', title: 'More ways to open', 'aria-label': 'More ways to open',
      onclick: (e) => openMenu(/** @type {Element} */ (e.currentTarget), [
        { label: s.windowCount > 1 ? `Open in ${s.windowCount} new windows` : 'Open in a new window', icon: 'window', onSelect: () => openSession('new-window') },
        { label: 'Add its tabs to this window', icon: 'plus', onSelect: () => openSession('current-window') },
      ]),
    }, icon('down', 14)),
  );

  /** @type {import('../ui/dom.js').MenuItem[]} */
  const more = auto
    ? [{ label: 'Delete this snapshot', icon: 'trash', danger: true, onSelect: () => deleteSnapshot(s) }]
    : [
      { label: 'Rename…', icon: 'edit', onSelect: () => renameSession(s) },
      { label: 'Save a copy', icon: 'copy', onSelect: () => copySession(s) },
      { label: 'Replace with the tabs open now…', icon: 'refresh', onSelect: () => replaceSession(s) },
      { separator: true },
      s.deletedAt
        ? { label: 'Restore from trash', icon: 'undo', onSelect: () => run(async () => { await sessions.restoreSessions([s.id]); await refreshAfterMutation([s.id]); }) }
        : { label: 'Move to trash', icon: 'trash', danger: true, onSelect: () => trashSession(s) },
    ];

  add(head,
    h('div', { class: 'head-main' },
      h('div', { class: 'head-title' },
        h('h2', { title }, title),
        !auto && iconButton('edit', 'Rename', () => renameSession(s))),
      h('div', { class: 'head-sub' }, sub.join(' · '))),
    h('div', { class: 'head-actions' },
      openBtn,
      auto && h('button', { class: 'btn', type: 'button', title: 'Keep this snapshot as a regular saved session', onclick: () => keepSnapshot(s) }, icon('save'), 'Save as session'),
      h('span', { id: 'check-ui', class: 'head-actions' }),
      exportButton(),
      h('button', {
        class: 'btn', type: 'button', title: 'More actions', 'aria-label': 'More actions',
        onclick: (e) => openMenu(/** @type {Element} */ (e.currentTarget), more, { align: 'right' }),
      }, icon('more')),
    ),
  );
  renderCheckUi();
}

// ---- toolbar + bar -------------------------------------------------------------------

function renderToolbar() {
  const f = state.filters;
  const session = state.view.type === 'session';
  const search = /** @type {HTMLInputElement} */ (h('input', {
    class: 'input', type: 'search', placeholder: session ? 'Search this session…' : 'Search every saved link — title or URL…',
    value: f.q, autocomplete: 'off',
    oninput: debounce(() => {
      f.q = search.value;
      applyRows({ resort: false });
    }, 110),
  }));

  const chips = h('div', { class: 'chips' }, Object.entries(KIND_LABEL).map(([kind, label]) =>
    h('button', {
      class: `chip ${f.kinds.has(kind) ? 'on' : ''}`.trim(), type: 'button', 'aria-pressed': String(f.kinds.has(kind)),
      onclick: (e) => {
        if (f.kinds.has(kind)) f.kinds.delete(kind);
        else f.kinds.add(kind);
        /** @type {HTMLElement} */ (e.currentTarget).classList.toggle('on', f.kinds.has(kind));
        applyRows({ resort: false });
      },
    }, label)));

  const status = h('select', {
    class: 'select', title: 'Filter by dead-link status', 'aria-label': 'Filter by status',
    onchange: (e) => {
      f.status = /** @type {HTMLSelectElement} */ (e.target).value;
      applyRows({ resort: false });
    },
  }, [['all', 'Any status'], ['dead', 'Dead'], ['alive', 'Alive'], ['paywalled', 'Members-only'], ['unknown', 'Unknown (?)'], ['unchecked', 'Unchecked'], ['not_checkable', 'Not checkable']]
    .map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)));

  const options = [['title', 'Title'], ['url', 'URL'], ['kind', 'Type'], ['date', 'Saved date'], ['status', 'Status']];
  if (session) options.unshift(['order', 'Saved order']);
  else options.push(['sessions', 'Sessions']);
  const s = sortState();
  const sortSel = h('select', {
    id: 'sort-key', class: 'select', title: 'Sort', 'aria-label': 'Sort by',
    onchange: (e) => {
      Object.assign(sortState(), { key: /** @type {HTMLSelectElement} */ (e.target).value, dir: 'asc' });
      table.setSort(sortState().key, sortState().dir);
      syncSortControls();
      applyRows();
    },
  }, options.map(([v, l]) => h('option', { value: v, selected: v === s.key }, `Sort: ${l}`)));
  const dirBtn = h('button', {
    id: 'sort-dir', class: 'btn', type: 'button', title: 'Reverse the order',
    onclick: () => {
      const st = sortState();
      st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      table.setSort(st.key, st.dir);
      syncSortControls();
      applyRows();
    },
  });

  fill($('toolbar'), h('div', { class: 'search' }, icon('search'), search), chips, status, sortSel, dirBtn);
  syncSortControls();
}

function syncSortControls() {
  const s = sortState();
  const sel = /** @type {HTMLSelectElement | null} */ ($('sort-key'));
  if (sel && sel.value !== s.key) sel.value = s.key;
  const dir = $('sort-dir');
  if (dir) dir.textContent = s.dir === 'asc' ? '↑ Ascending' : '↓ Descending';
}

function renderBar() {
  const bar = clear($('bar'));
  const picked = table.pickedRows();
  if (!picked.length) {
    bar.className = 'bar';
    const total = state.rows.length;
    const shown = state.filtered.length;
    add(bar, shown === total ? plural(total, 'link') : `${shown.toLocaleString()} of ${plural(total, 'link')}`);
    return;
  }
  bar.className = 'bar selecting';
  const inSession = state.view.type === 'session';
  const saved = !state.session || state.session.kind === KIND.SAVED;
  add(bar,
    h('span', null, h('strong', null, picked.length.toLocaleString()), ' selected'),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: (e) => openMenu(/** @type {Element} */ (e.currentTarget), [
        { label: 'Open in a new window', icon: 'window', onSelect: () => openRows(picked, 'new-window') },
        { label: 'Open in this window', icon: 'plus', onSelect: () => openRows(picked, 'current-window') },
      ]),
    }, icon('open', 14), 'Open', icon('down', 12)),
    h('button', { class: 'btn small', type: 'button', onclick: () => copyUrls(picked) }, icon('copy', 14), 'Copy URLs'),
    h('button', { class: 'btn small', type: 'button', onclick: () => newSessionFrom(picked) }, icon('save', 14), 'New session from selection'),
    h('span', { class: 'grow' }),
    inSession && h('button', { class: 'btn small', type: 'button', onclick: () => removeRows(picked, 'session') }, 'Remove from this session'),
    saved && h('button', {
      class: 'btn small danger', type: 'button', title: 'Remove these links from every saved session',
      onclick: () => removeRows(picked, 'everywhere'),
    }, 'Delete from all sessions'),
    h('button', { class: 'btn small subtle', type: 'button', onclick: () => table.clearSelection() }, 'Clear'),
  );
}

// ---- link actions ----------------------------------------------------------------------

/**
 * @param {LinkRow[]} rows
 * @param {'session' | 'everywhere'} scope
 */
async function removeRows(rows, scope) {
  if (!rows.length) return;
  await run(async () => {
    let refs;
    /** @type {{tombstone: 'none' | 'session' | 'global', label: string}} */
    let opts;
    if (scope === 'everywhere') {
      // Every saved tab pointing at these links, in whichever session it sits.
      const wanted = new Set(rows.map((r) => r.canonical));
      const library = state.view.type === 'all' ? state.rows : buildLibrary(state.metas, state.dataById, state.checks);
      refs = library.filter((r) => wanted.has(r.canonical)).flatMap((r) => r.refs);
      // A snapshot's own tabs are not in the library; include what was picked.
      if (state.session && state.session.kind !== KIND.SAVED) refs.push(...rows.flatMap((r) => r.refs));
      opts = { tombstone: 'global', label: `Deleted ${plural(wanted.size, 'link')} from all sessions` };
    } else {
      refs = rows.flatMap((r) => r.refs);
      const saved = state.session?.kind === KIND.SAVED;
      opts = {
        tombstone: saved ? 'session' : 'none',
        label: `Removed ${plural(rows.length, 'link')} from “${state.session?.name ?? 'session'}”`,
      };
    }
    const res = await sessions.removeTabs(refs, opts);
    if (!res.removed) return;
    table.picked.clear();
    await refreshAfterMutation([...new Set(refs.map((r) => r.sessionId))]);
    const msg = scope === 'everywhere'
      ? `Deleted ${plural(rows.length, 'link')} from all sessions (${plural(res.removed, 'tab')} in ${plural(res.sessions, 'session')}).`
      : `Removed ${plural(res.removed, 'link')} from this session.`;
    toast(msg, { action: 'Undo', onAction: () => undoRemoval(res.undoId) });
  });
}

async function undoRemoval(undoId) {
  await run(async () => {
    const res = await sessions.undo(undoId);
    await loadAll();
    await refreshView();
    if (res) toast(res.lost ? `Put back ${plural(res.restored, 'link')}; ${res.lost} belonged to sessions that no longer exist.` : `Put back ${plural(res.restored, 'link')}.`);
  });
}

async function confirmBigOpen(count) {
  const limit = state.settings.confirmOpenOver;
  if (!limit || count <= limit) return true;
  return confirmDialog({
    title: `Open ${plural(count, 'tab')}?`,
    message: state.settings.lazyRestore
      ? 'The tabs are created unloaded, so they use almost no memory until you click them.'
      : 'Every tab will start loading at once.',
    confirmLabel: 'Open',
  });
}

function reportOpened(res) {
  if (!res) return;
  toast(res.failed ? `Opened ${plural(res.opened, 'tab')}; ${res.failed} could not be opened.` : `Opened ${plural(res.opened, 'tab')}.`, { ms: 4000 });
}

async function openSession(mode) {
  const s = state.session;
  if (!s || !(await confirmBigOpen(s.tabCount))) return;
  reportOpened(await run(() => call('open', { sessionId: s.id, mode, windowId: state.windowId })));
}

/** @param {LinkRow[]} rows */
async function openRows(rows, mode) {
  if (!(await confirmBigOpen(rows.length))) return;
  const res = await run(() => (state.session
    ? call('open', { sessionId: state.session.id, tids: rows.flatMap((r) => r.refs.map((x) => x.t)), mode, windowId: state.windowId })
    : call('openLinks', { links: rows.map((r) => ({ url: r.url, title: r.title })), mode, windowId: state.windowId })));
  reportOpened(res);
}

async function copyUrls(rows) {
  await run(async () => {
    await navigator.clipboard.writeText(toUrlList(rows));
    toast(`Copied ${plural(rows.length, 'URL')}.`, { ms: 3000 });
  });
}

async function newSessionFrom(rows) {
  const name = await promptDialog({ title: 'New session from selection', label: `Name for the session (${plural(rows.length, 'link')})`, placeholder: 'Session name', confirmLabel: 'Create' });
  if (name === null) return;
  await run(async () => {
    const meta = await sessions.createFromLinks(name.trim() || defaultSessionName(), rows);
    if (!meta) return;
    table.clearSelection();
    await loadAll();
    await refreshView();
    toast(`Created “${meta.name}”.`, { action: 'View', onAction: () => go(`#s/${meta.id}`) });
  });
}

function showSessionsOf(row, anchor) {
  const ids = [...new Set(row.refs.map((r) => r.sessionId))];
  const byId = new Map(state.metas.map((m) => [m.id, m]));
  const list = ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  openMenu(anchor, [
    { heading: `In ${plural(list.length, 'session')}` },
    ...list.map((m) => ({ label: m.name, hint: formatDate(m.createdAt), onSelect: () => go(`#s/${m.id}`) })),
  ], { align: 'right' });
}

// ---- session actions -----------------------------------------------------------------------

async function renameSession(s) {
  const name = await promptDialog({ title: 'Rename session', value: s.name, confirmLabel: 'Rename' });
  if (!name?.trim()) return;
  await run(async () => {
    await sessions.renameSession(s.id, name);
    await refreshAfterMutation([s.id]);
  });
}

async function copySession(s) {
  await run(async () => {
    const meta = await sessions.saveCopy(s.id);
    await loadAll();
    if (meta) go(`#s/${meta.id}`);
  });
}

async function keepSnapshot(s) {
  const name = await promptDialog({
    title: 'Save as session', label: 'Name', confirmLabel: 'Save',
    value: s.kind === KIND.CLOSED ? `Closed window — ${formatDateTime(s.createdAt)}` : `Browser session — ${formatDateTime(s.createdAt)}`,
  });
  if (name === null) return;
  await run(async () => {
    const meta = await sessions.saveCopy(s.id, name.trim() || defaultSessionName(s.createdAt));
    await loadAll();
    if (meta) {
      go(`#s/${meta.id}`);
      toast(`Saved “${meta.name}”.`, { ms: 4000 });
    }
  });
}

async function replaceSession(s) {
  const ok = await confirmDialog({
    title: 'Replace this session?',
    message: `“${s.name}” will hold the tabs that are open right now (all windows) instead of its ${plural(s.tabCount, 'saved tab')}. This cannot be undone.`,
    confirmLabel: 'Replace', danger: true,
  });
  if (!ok) return;
  await run(async () => {
    await call('replace', { sessionId: s.id, scope: 'all' });
    await refreshAfterMutation([s.id]);
    toast('Session replaced with the current tabs.', { ms: 4000 });
  });
}

async function trashSession(s) {
  await run(async () => {
    await sessions.trashSessions([s.id]);
    await loadAll();
    go('#all');
    toast(`Moved “${s.name}” to the trash.`, {
      action: 'Undo',
      onAction: () => run(async () => {
        await sessions.restoreSessions([s.id]);
        await loadAll();
        go(`#s/${s.id}`);
      }),
    });
  });
}

async function deleteSnapshot(s) {
  const ok = await confirmDialog({ title: 'Delete this snapshot?', message: 'Automatic snapshots are not moved to the trash.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  await run(async () => {
    await db.deleteSessions([s.id], { auto: true });
    await loadAll();
    go('#all');
  });
}

async function saveDialog() {
  const [win, tabs] = await Promise.all([browser.windows.getCurrent(), browser.tabs.query({})]);
  const real = tabs.filter((t) => isSavableTab(t) && (state.settings.savePrivate || !t.incognito));
  const all = real.length;
  const here = real.filter((t) => t.windowId === win.id).length;
  const several = new Set(real.map((t) => t.windowId)).size > 1;

  const result = await openDialog((close) => {
    const name = /** @type {HTMLInputElement} */ (h('input', { class: 'input', type: 'text', placeholder: defaultSessionName(), autofocus: true }));
    const scope = (value, label, n, checked) =>
      h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'scope', value, checked }), h('span', null, label, h('small', null, plural(n, 'tab'))));
    const closeAfter = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
    const form = h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const picked = /** @type {HTMLInputElement | null} */ (form.querySelector('input[name=scope]:checked'));
        close({ name: name.value, scope: picked?.value ?? 'all', closeAfter: closeAfter.checked });
      },
    },
    h('h2', null, 'Save current tabs'),
    h('label', { class: 'field' }, h('span', null, 'Session name'), name),
    several
      ? [scope('all', 'All windows', all, true), scope('window', 'Only this window', here, false)]
      : h('div', { class: 'hint' }, `${plural(all, 'tab')} will be saved.`),
    h('label', { class: 'opt' }, closeAfter, h('span', null, 'Close the saved tabs afterwards', h('small', null, 'Frees their memory. This page stays open.'))),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit', disabled: all === 0 }, 'Save')),
    );
    return form;
  }, { class: 'small' });
  if (!result) return;
  await run(async () => {
    const res = await call('save', { ...result, windowId: win.id });
    await loadAll();
    go(`#s/${res.id}`);
    toast(`Saved “${res.name}” — ${plural(res.tabCount, 'tab')}.`, { ms: 4000 });
  });
}

// ---- dead-link check ---------------------------------------------------------------------------

const linksOf = (rows) => rows.map((r) => ({ canonical: r.canonical, url: r.url, kind: r.kind }));

function renderCheckUi() {
  const el = $('check-ui');
  if (!el) return;
  const job = state.job;
  if (job.running) {
    fill(el,
      h('span', { class: 'coverage' }, `Checking ${job.checked.toLocaleString()} / ${job.total.toLocaleString()}…`,
        job.dead ? h('span', { class: 'dead' }, ` · ${job.dead} dead`) : null),
      h('button', { class: 'btn', type: 'button', onclick: () => state.abort?.abort() }, icon('stop', 14), 'Stop'),
    );
    return;
  }
  const cov = coverage(linksOf(state.rows), state.checks, state.settings.checkOtherSites);
  fill(el,
    cov.checkable ? h('span', { class: 'coverage', title: 'Links with a cached verdict / links that can be checked' },
      `${cov.checked.toLocaleString()} / ${cov.checkable.toLocaleString()} checked`,
      cov.dead ? h('span', { class: 'dead' }, ` · ${cov.dead.toLocaleString()} dead`) : null) : null,
    h('button', {
      class: 'btn', type: 'button', disabled: !cov.checkable,
      title: state.settings.checkOtherSites
        ? 'Check YouTube, Imgur and other sites. Settled verdicts are kept; only new and uncertain links are checked.'
        : 'Check YouTube and Imgur links. Settled verdicts are kept; only new and uncertain links are checked.',
      onclick: startCheck,
    }, icon('shield', 14), 'Check dead links'),
  );
}

async function startCheck() {
  if (state.job.running) return;
  // Must be the first await of the click handler: Firefox only lets a
  // permission prompt open directly from user input.
  const origins = state.settings.checkOtherSites ? ['<all_urls>'] : CHECK_ORIGINS;
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins });
  } catch {
    granted = await browser.permissions.contains({ origins }).catch(() => false);
  }
  if (!granted) {
    toast('Checking links needs permission to contact those sites.', { kind: 'error' });
    return;
  }

  state.abort = new AbortController();
  const redraw = debounce(() => {
    // Show verdicts as they arrive.
    for (const r of state.rows) {
      const c = state.checks.get(r.canonical);
      if (c) r.status = c.status;
    }
    table.refresh();
  }, 1500);
  let lastUi = 0;
  await run(() => runChecks({
    links: linksOf(state.rows),
    checks: state.checks,
    job: state.job,
    save: async (batch) => { await db.putChecks(batch); },
    otherSites: state.settings.checkOtherSites,
    concurrency: state.settings.checkConcurrency,
    signal: state.abort.signal,
    onProgress: () => {
      const now = Date.now();
      if (now - lastUi > 250 || !state.job.running) {
        lastUi = now;
        renderCheckUi();
      }
      redraw();
    },
  }));
  state.abort = null;
  const job = state.job;
  await refreshView();
  toast(job.stopped
    ? `Stopped after ${job.checked.toLocaleString()} links. Run it again to continue where it left off.`
    : job.total
      ? `Checked ${plural(job.total, 'link')}: ${job.dead} dead, ${job.alive} alive${job.unknown ? `, ${job.unknown} uncertain` : ''}.`
      : 'Every checkable link already has a verdict.');
}

// ---- export -----------------------------------------------------------------------------------------

function exportButton() {
  return h('button', {
    class: 'btn', type: 'button',
    onclick: (e) => {
      const label = state.session ? state.session.name : 'all links';
      const rows = state.filtered;
      const save = (format, dead) => {
        const out = buildExport(rows, { format, dead, label });
        if (!out.count) {
          toast(dead === 'only' ? 'No dead links here. Run “Check dead links” first if you have not yet.' : 'Nothing to export.');
          return;
        }
        downloadBlob(new Blob([out.body], { type: out.mime }), out.filename);
      };
      const toggle = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: state.excludeDead, onchange: () => { state.excludeDead = toggle.checked; } }));
      openMenu(/** @type {Element} */ (e.currentTarget), [
        { heading: `${plural(rows.length, 'link')} shown` },
        { node: h('label', { class: 'menu-item' }, toggle, h('span', { class: 'menu-label' }, 'Leave out dead links')) },
        { label: 'Links as a web page (HTML)', icon: 'export', onSelect: () => save('html', state.excludeDead ? 'exclude' : 'include') },
        { label: 'Links as data (JSON)', icon: 'export', onSelect: () => save('json', state.excludeDead ? 'exclude' : 'include') },
        { separator: true },
        { heading: 'Dead-link report' },
        { label: 'Dead links (HTML)', icon: 'export', onSelect: () => save('html', 'only') },
        { label: 'Dead links (JSON)', icon: 'export', onSelect: () => save('json', 'only') },
      ], { align: 'right' });
    },
  }, icon('export', 14), 'Export', icon('down', 12));
}

// ---- dialogs ----------------------------------------------------------------------------------------

async function openImport() {
  const done = await openImportDialog();
  if (done) {
    await loadAll();
    await refreshView();
  }
}

async function openSettings() {
  await openSettingsDialog({ onImport: () => openImport() });
  state.settings = await getSettings();
  await renderBanner();
  await refreshView();
}

async function renderBanner() {
  const el = $('banner');
  const st = await getBackupState();
  if (st.warning) {
    fill(el,
      h('span', { class: 'grow' }, `Your library went from ${st.warning.from} to ${st.warning.to} sessions between two backups. `
        + `In case that was not intended, the earlier backup files were left untouched and this state was written to ${st.warning.file}.`),
      h('button', { class: 'btn small', type: 'button', onclick: () => openSettings() }, 'Backups…'),
      h('button', { class: 'btn small subtle', type: 'button', onclick: async () => { await dismissBackupWarning(); renderBanner(); } }, 'Dismiss'),
    );
    el.hidden = false;
  } else if (st.lastError && state.settings.backupEnabled) {
    fill(el,
      h('span', { class: 'grow' }, `The last automatic backup failed — ${st.lastError}`),
      h('button', { class: 'btn small', type: 'button', onclick: () => openSettings() }, 'Backups…'),
    );
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ---- start ------------------------------------------------------------------------------------------

async function init() {
  $('btn-save').append(icon('save'), 'Save current tabs…');
  $('btn-save').addEventListener('click', () => saveDialog());
  $('btn-import').append(icon('import'));
  $('btn-import').addEventListener('click', () => openImport());
  $('btn-settings').append(icon('settings'));
  $('btn-settings').addEventListener('click', () => openSettings());
  $('nav-all').addEventListener('click', () => go('#all'));
  /** @type {HTMLSelectElement} */ ($('side-sort')).value = state.side.sort;
  $('side-sort').addEventListener('change', (e) => {
    state.side.sort = /** @type {HTMLSelectElement} */ (e.target).value;
    store.set('sideSort', state.side.sort);
    renderSidebar();
  });
  $('side-q').addEventListener('input', (e) => {
    state.side.q = /** @type {HTMLInputElement} */ (e.target).value;
    renderSidebar();
  });

  const [settings, win] = await Promise.all([getSettings(), browser.windows.getCurrent()]);
  state.settings = settings;
  state.windowId = win.id;
  await loadAll();

  window.addEventListener('hashchange', () => onRoute());
  onSettingsChanged((s) => {
    state.settings = s;
    renderCheckUi();
  });

  // Changes made elsewhere (popup, background autosave, another manager tab).
  const reloadLibrary = debounce(async () => {
    if (state.job.running) return; // verdicts being written by this page
    await loadAll();
    await refreshView();
  }, 300);
  const reloadAuto = debounce(async () => {
    state.metas = await db.listMeta();
    if (state.session && state.session.kind !== KIND.SAVED) await refreshView();
    else renderSidebar();
  }, 500);
  db.onChange((what) => (what === 'auto' ? reloadAuto() : what === 'undo' ? null : reloadLibrary()));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.backupState) renderBanner();
  });

  // Ask the browser not to evict this data under storage pressure.
  navigator.storage?.persist?.().catch(() => {});

  await renderBanner();
  await onRoute();
}

init().catch((e) => {
  console.error(e);
  document.body.append(h('div', { class: 'toast error' }, `Southpaw Sessions could not start: ${e?.message ?? e}`));
});

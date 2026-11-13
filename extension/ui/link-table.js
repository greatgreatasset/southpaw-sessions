// Virtualized link table: renders only the rows in view, so the "all links"
// list (tens of thousands of rows) scrolls and filters instantly.
import { formatDate } from '../lib/model.js';
import { add, clear, fill, h, icon, iconButton } from './dom.js';

/** @typedef {import('../lib/library.js').LinkRow} LinkRow */
/** @typedef {{type: 'row', row: LinkRow} | {type: 'header', label: string, count: number}} Item */

const ROW_H = 38;
const OVERSCAN = 10;
const WIDTHS_KEY = 'southpaw.columnWidths';

// Layout constants, mirrored by .lt-grid in manager.css.
const PICK_W = 34;
const ACTIONS_W = 40;
const GAP = 12;
const PAD_X = 20;

// `flex` columns share whatever width is left, so by default the table fits
// its container exactly (no sideways scrolling to reach the ✕). Dragging a
// column border pins that column to an explicit width.
const COLUMNS = [
  { key: 'title', label: 'Title', width: 420, min: 160, flex: 1.15 },
  { key: 'url', label: 'URL', width: 380, min: 160, flex: 1 },
  { key: 'date', label: 'Saved', width: 104, min: 76 },
  { key: 'status', label: 'Status', width: 84, min: 60 },
  { key: 'kind', label: 'Type', width: 92, min: 64 },
  { key: 'sessions', label: 'In', width: 58, min: 46, allOnly: true, title: 'Number of sessions that contain the link' },
];

export const STATUS_LABEL = {
  dead: 'dead',
  alive: 'alive',
  paywalled: 'members',
  unknown: '?',
  not_checkable: 'n/a',
};
const STATUS_TITLE = {
  dead: 'The page is gone',
  alive: 'The page is still there',
  paywalled: 'Exists, but for channel members only',
  unknown: 'Could not tell — will be retried on the next check',
  not_checkable: 'This kind of link cannot be checked',
};
export const KIND_LABEL = {
  youtube_video: 'YT video',
  youtube_search: 'YT search',
  imgur: 'Imgur',
  other: 'Other',
};

function loadWidths() {
  try {
    return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

export class LinkTable {
  /**
   * @param {object} cb
   * @param {(row: LinkRow) => void} cb.onRemove        ✕ on a row
   * @param {(row: LinkRow) => void} cb.onOpen          a link the browser can't follow natively
   * @param {() => void} cb.onSelectionChange
   * @param {(key: string) => void} cb.onSort           header click
   * @param {(row: LinkRow, anchor: Element) => void} cb.onShowSessions
   */
  constructor(cb) {
    this.cb = cb;
    /** @type {'all' | 'session'} */
    this.mode = 'all';
    /** @type {Item[]} */
    this.items = [];
    /** @type {LinkRow[]} */
    this.rows = [];
    /** @type {Set<string>} */
    this.picked = new Set();
    this.sortKey = 'title';
    this.sortDir = 'asc';
    this.removeLabel = 'Remove';
    this.emptyText = 'Nothing here.';
    this.widths = loadWidths();
    this.lastPickIndex = -1;
    this.range = [-1, -1];

    this.headCheck = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox', title: 'Select all shown', 'aria-label': 'Select all shown',
      onchange: () => this.toggleAll(),
    }));
    this.head = h('div', { class: 'lt-head lt-grid' });
    this.slice = h('div', { class: 'lt-slice' });
    this.body = h('div', { class: 'lt-body' }, this.slice);
    this.empty = h('div', { class: 'lt-empty', hidden: true });
    this.scroller = h('div', { class: 'lt-scroll', tabindex: '0' }, this.head, this.body, this.empty);
    this.el = h('div', { class: 'lt' }, this.scroller);

    this.scroller.addEventListener('scroll', () => this.renderSlice(), { passive: true });
    new ResizeObserver(() => {
      this.applyTemplate();
      this.renderSlice();
    }).observe(this.scroller);
    this.slice.addEventListener('click', (e) => this.onClick(e));
    this.applyColumns();
  }

  /** @param {'all' | 'session'} mode */
  setMode(mode, { removeLabel }) {
    this.mode = mode;
    this.removeLabel = removeLabel;
    this.applyColumns();
  }

  columns() {
    return COLUMNS.filter((c) => !c.allOnly || this.mode === 'all');
  }

  /** Current pixel width of every visible column. */
  columnWidths() {
    const cols = this.columns();
    const avail = this.scroller.clientWidth || 1100;
    let used = PICK_W + ACTIONS_W + 2 * PAD_X + GAP * (cols.length + 1);
    let flexTotal = 0;
    for (const c of cols) {
      if (this.widths[c.key] != null) used += Math.max(c.min, this.widths[c.key]);
      else if (c.flex) flexTotal += c.flex;
      else used += c.width;
    }
    const spare = Math.max(0, avail - used);
    return cols.map((c) => {
      if (this.widths[c.key] != null) return Math.max(c.min, this.widths[c.key]);
      if (c.flex) return Math.max(c.min, Math.floor((spare * c.flex) / flexTotal));
      return c.width;
    });
  }

  applyTemplate() {
    const template = [`${PICK_W}px`, ...this.columnWidths().map((w) => `${w}px`), `${ACTIONS_W}px`].join(' ');
    this.el.style.setProperty('--lt-cols', template);
  }

  applyColumns() {
    const cols = this.columns();
    this.applyTemplate();

    fill(this.head, h('div', { class: 'c-pick' }, this.headCheck));
    for (const col of cols) {
      const active = this.sortKey === col.key;
      add(this.head, h('div', { class: `lt-hc c-${col.key}` },
        h('button', {
          class: `lt-sort ${active ? 'active' : ''}`.trim(), type: 'button',
          title: col.title ?? `Sort by ${col.label.toLowerCase()}`,
          onclick: () => this.cb.onSort(col.key),
        }, col.label, active && h('span', { class: 'arrow' }, this.sortDir === 'asc' ? '▲' : '▼')),
        h('span', {
          class: 'lt-resizer', title: 'Drag to resize · double-click to reset',
          onmousedown: (e) => this.startResize(col, e),
          ondblclick: () => this.resetWidth(col),
        }),
      ));
    }
    add(this.head, h('div', { class: 'c-actions' }));
  }

  startResize(col, e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.columnWidths()[this.columns().indexOf(col)];
    const onMove = (ev) => {
      this.widths[col.key] = Math.max(col.min, Math.round(startW + ev.clientX - startX));
      this.applyTemplate();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this.saveWidths();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** Back to the automatic width. */
  resetWidth(col) {
    delete this.widths[col.key];
    this.applyTemplate();
    this.saveWidths();
  }

  saveWidths() {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(this.widths));
    } catch {
      // Storage unavailable: the width just won't persist.
    }
  }

  setSort(key, dir) {
    this.sortKey = key;
    this.sortDir = dir;
    this.applyColumns();
  }

  /**
   * @param {Item[]} items
   * @param {{emptyText?: string, keepScroll?: boolean}} [opts]
   */
  setItems(items, { emptyText, keepScroll = false } = {}) {
    this.items = items;
    this.rows = /** @type {any} */ (items.filter((it) => it.type === 'row').map((it) => /** @type {any} */ (it).row));
    if (emptyText) this.emptyText = emptyText;
    // Drop selections that are no longer in view.
    const keys = new Set(this.rows.map((r) => r.key));
    let changed = false;
    for (const k of this.picked) {
      if (!keys.has(k)) {
        this.picked.delete(k);
        changed = true;
      }
    }
    this.lastPickIndex = -1;
    this.body.style.height = `${items.length * ROW_H}px`;
    this.empty.hidden = items.length > 0;
    this.empty.textContent = this.emptyText;
    if (!keepScroll) this.scroller.scrollTo(0, 0);
    this.range = [-1, -1];
    this.renderSlice();
    this.syncHeadCheck();
    if (changed) this.cb.onSelectionChange();
  }

  /** @returns {LinkRow[]} */
  pickedRows() {
    return this.rows.filter((r) => this.picked.has(r.key));
  }

  clearSelection() {
    if (!this.picked.size) return;
    this.picked.clear();
    this.refresh();
    this.cb.onSelectionChange();
  }

  toggleAll() {
    const all = this.rows.length > 0 && this.rows.every((r) => this.picked.has(r.key));
    this.picked = all ? new Set() : new Set(this.rows.map((r) => r.key));
    this.refresh();
    this.cb.onSelectionChange();
  }

  syncHeadCheck() {
    const n = this.picked.size;
    this.headCheck.checked = n > 0 && n >= this.rows.length;
    this.headCheck.indeterminate = n > 0 && n < this.rows.length;
  }

  /** Re-render the visible rows in place. */
  refresh() {
    this.range = [-1, -1];
    this.renderSlice();
    this.syncHeadCheck();
  }

  renderSlice() {
    const total = this.items.length;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    if (start === this.range[0] && end === this.range[1]) return;
    this.range = [start, end];
    this.slice.style.transform = `translateY(${start * ROW_H}px)`;
    const nodes = [];
    for (let i = start; i < end; i++) nodes.push(this.renderItem(this.items[i], i));
    this.slice.replaceChildren(...nodes);
  }

  renderItem(item, index) {
    if (item.type === 'header') {
      return h('div', { class: 'lt-group' }, icon('window', 14), h('span', null, item.label),
        h('span', { class: 'muted' }, `${item.count} tab${item.count === 1 ? '' : 's'}`));
    }
    const r = item.row;
    const picked = this.picked.has(r.key);
    const linkable = /^(https?|ftp):/i.test(r.url);
    const cols = this.columns();
    const cells = [
      h('div', { class: 'c-pick' }, h('input', { type: 'checkbox', checked: picked, dataset: { act: 'pick' }, 'aria-label': 'Select' })),
    ];
    for (const col of cols) {
      if (col.key === 'title') {
        cells.push(h('div', { class: 'c-title', title: r.title || r.url },
          r.pinned && h('span', { class: 'pin', title: 'Pinned tab' }, icon('pin', 12)),
          r.title || h('span', { class: 'muted' }, '(no title)')));
      } else if (col.key === 'url') {
        cells.push(h('div', { class: 'c-url' },
          h('a', {
            href: linkable ? r.url : '#', target: '_blank', rel: 'noreferrer noopener', title: r.url,
            dataset: linkable ? {} : { act: 'open' },
          }, r.url)));
      } else if (col.key === 'date') {
        cells.push(h('div', { class: 'c-date' }, r.date ? formatDate(r.date) : h('span', { class: 'muted' }, '–')));
      } else if (col.key === 'status') {
        cells.push(h('div', { class: 'c-status' }, r.status
          ? h('span', { class: `badge ${r.status}`, title: STATUS_TITLE[r.status] ?? '' }, STATUS_LABEL[r.status] ?? r.status)
          : h('span', { class: 'muted' }, '–')));
      } else if (col.key === 'kind') {
        cells.push(h('div', { class: 'c-kind' }, h('span', { class: 'tag' }, KIND_LABEL[r.kind] ?? r.kind)));
      } else if (col.key === 'sessions') {
        cells.push(h('div', { class: 'c-sessions' },
          h('button', { class: 'count', type: 'button', dataset: { act: 'sessions' }, title: 'Show the sessions containing this link' }, r.sessionCount)));
      }
    }
    cells.push(h('div', { class: 'c-actions' },
      iconButton('x', this.removeLabel, null, 'danger'),
    ));
    cells.at(-1).querySelector('button').dataset.act = 'remove';
    return h('div', {
      class: `lt-row lt-grid ${picked ? 'picked' : ''} ${r.status === 'dead' ? 'is-dead' : ''}`.trim(),
      dataset: { i: String(index) },
    }, cells);
  }

  onClick(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const actEl = /** @type {HTMLElement | null} */ (target.closest('[data-act]'));
    const rowEl = /** @type {HTMLElement | null} */ (target.closest('.lt-row'));
    if (!actEl || !rowEl) return;
    const index = Number(rowEl.dataset.i);
    const item = this.items[index];
    if (!item || item.type !== 'row') return;
    const row = item.row;
    switch (actEl.dataset.act) {
      case 'pick': {
        const on = /** @type {HTMLInputElement} */ (actEl).checked;
        // Shift-click extends the selection from the last clicked row.
        if (e.shiftKey && this.lastPickIndex >= 0) {
          const [a, b] = [Math.min(index, this.lastPickIndex), Math.max(index, this.lastPickIndex)];
          for (let i = a; i <= b; i++) {
            const it = this.items[i];
            if (it.type !== 'row') continue;
            if (on) this.picked.add(it.row.key);
            else this.picked.delete(it.row.key);
          }
        } else if (on) this.picked.add(row.key);
        else this.picked.delete(row.key);
        this.lastPickIndex = index;
        this.refresh();
        this.cb.onSelectionChange();
        break;
      }
      case 'open':
        e.preventDefault();
        this.cb.onOpen(row);
        break;
      case 'remove':
        this.cb.onRemove(row);
        break;
      case 'sessions':
        this.cb.onShowSessions(row, actEl);
        break;
      default:
    }
  }
}

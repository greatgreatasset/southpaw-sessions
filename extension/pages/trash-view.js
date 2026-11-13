// Trash: deleted sessions, and the permanent record of removed links — every
// link ever taken out of a session, with its title, which can be looked through
// or put back.
import * as db from '../lib/db.js';
import { KIND, formatAgo, formatDate, formatDateTime, plural } from '../lib/model.js';
import * as sessions from '../lib/sessions.js';
import { pickBestTitle } from '../lib/titles.js';
import { confirmDialog, debounce, fill, h, icon, toast } from '../ui/dom.js';

const MAX_SHOWN = 300;
const isWebUrl = (url) => /^https?:/i.test(url);

/**
 * The distinct links of one log entry (a "delete from all sessions" removes the
 * same link from several sessions; show it once).
 * @param {import('../lib/db.js').UndoEntry} entry
 * @returns {{url: string, title: string, sessions: string[]}[]}
 */
function linksOf(entry) {
  /** @type {Map<string, {url: string, title: string, sessions: string[]}>} */
  const byUrl = new Map();
  for (const s of entry.payload?.sessions ?? []) {
    for (const { tab } of s.removed ?? []) {
      let link = byUrl.get(tab.url);
      if (!link) byUrl.set(tab.url, (link = { url: tab.url, title: tab.title ?? '', sessions: [] }));
      else link.title = pickBestTitle(link.title, tab.title) ?? '';
      if (s.name && !link.sessions.includes(s.name)) link.sessions.push(s.name);
    }
  }
  return [...byUrl.values()];
}

function linkItem({ url, title, note }) {
  const text = title || '(no title saved)';
  return h('li', { class: 'rl' },
    h('div', { class: 'rl-title' }, isWebUrl(url)
      ? h('a', { href: url, target: '_blank', rel: 'noreferrer noopener' }, text)
      : text),
    h('div', { class: 'rl-url' }, url),
    note && h('div', { class: 'rl-note' }, note));
}

function linkList(links) {
  return h('ul', { class: 'rl-list' },
    links.slice(0, MAX_SHOWN).map(linkItem),
    links.length > MAX_SHOWN && h('li', { class: 'rl rl-note' }, `…and ${(links.length - MAX_SHOWN).toLocaleString()} more. Use the search box to find a specific one.`));
}

/**
 * @param {HTMLElement} panel
 * @param {{metas: import('../lib/model.js').SessionMeta[], onChanged: () => Promise<void>}} ctx
 */
export async function renderTrash(panel, { metas, onChanged }) {
  const trashed = metas.filter((m) => m.kind === KIND.SAVED && m.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  const [log, tombstones] = await Promise.all([db.listUndo(), db.listTombstones()]);
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toast(String(/** @type {any} */ (e)?.message ?? e), { kind: 'error' });
    }
    await onChanged();
  };

  // ---- deleted sessions ----
  const sessionList = trashed.length
    ? h('ul', { class: 'list-plain' }, trashed.map((m) =>
      h('li', null,
        h('div', { class: 'li-main' },
          h('div', { class: 'li-name' }, m.name),
          h('div', { class: 'li-sub' }, `${formatDateTime(m.createdAt)} · ${plural(m.tabCount, 'tab')} · deleted ${formatAgo(m.deletedAt)}`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => { location.hash = `#s/${m.id}`; } }, 'View'),
        h('button', { class: 'btn small', type: 'button', onclick: () => act(() => sessions.restoreSessions([m.id])) }, 'Restore'),
        h('button', {
          class: 'btn small subtle', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Delete for good?', message: `“${m.name}” and its ${plural(m.tabCount, 'tab')} cannot be recovered afterwards.`, confirmLabel: 'Delete', danger: true });
            if (ok) await act(() => sessions.purgeSessions([m.id]));
          },
        }, 'Delete forever'))))
    : h('p', null, 'No deleted sessions.');

  // ---- removed links ----
  const entries = log.map((entry) => ({ entry, links: linksOf(entry) }));
  // Deletions that have no log entry: made in Session Analyzer, or their entry
  // was erased. Only what the import blocklist remembers is left of them.
  const logged = new Set(log.flatMap((e) => e.payload?.tombstoneKeys ?? []));
  const earlier = tombstones
    .filter((t) => !logged.has(t.key))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({ url: t.original || t.url, title: t.title ?? '', note: t.createdAt ? `deleted ${formatDate(t.createdAt)}` : '' }));
  const totalLinks = entries.reduce((n, e) => n + e.links.length, 0) + earlier.length;

  const open = new Set();
  let needle = '';
  const matches = (link) => !needle || link.title.toLowerCase().includes(needle) || link.url.toLowerCase().includes(needle);
  const listBox = h('div');

  const renderLists = () => {
    const nodes = [];
    for (const { entry, links } of entries) {
      const shown = needle ? links.filter(matches) : links;
      if (needle && !shown.length) continue;
      const names = (entry.payload?.sessions ?? []).map((s) => s.name);
      const where = names.length === 1 ? names[0] : `${names.length} sessions`;
      const expanded = !!needle || open.has(entry.id);
      const several = names.length > 1;
      nodes.push(h('li', null,
        h('div', { class: 'li-main' },
          h('div', { class: 'li-name' }, entry.label),
          h('div', { class: 'li-sub' }, `${formatDateTime(entry.at)} · ${where}`)),
        h('button', {
          class: 'btn small subtle', type: 'button', 'aria-expanded': String(expanded),
          onclick: () => {
            if (open.has(entry.id)) open.delete(entry.id);
            else open.add(entry.id);
            renderLists();
          },
        }, icon(expanded ? 'down' : 'right', 12), expanded ? 'Hide links' : `Show ${plural(links.length, 'link')}`),
        h('button', {
          class: 'btn small', type: 'button', title: 'Put these links back where they were',
          onclick: () => act(async () => {
            const res = await sessions.undo(entry.id);
            if (res) toast(res.lost ? `Put back ${plural(res.restored, 'link')}; ${res.lost} belonged to sessions that no longer exist.` : `Put back ${plural(res.restored, 'link')}.`);
          }),
        }, 'Put back'),
        h('button', {
          class: 'btn small subtle', type: 'button', title: 'Erase this record for good',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Erase this record?',
              message: `The titles and positions of ${plural(links.length, 'link')} are erased and can no longer be put back. `
                + 'Their bare addresses stay on the import blocklist (Settings → Housekeeping clears that).',
              confirmLabel: 'Erase', danger: true,
            });
            if (ok) await act(() => sessions.forgetRemovals([entry.id]));
          },
        }, 'Erase'),
        expanded && linkList(shown.map((l) => ({ ...l, note: several && l.sessions.length ? `was in: ${l.sessions.slice(0, 3).join(', ')}${l.sessions.length > 3 ? ` +${l.sessions.length - 3} more` : ''}` : '' }))),
      ));
    }

    const earlierShown = needle ? earlier.filter(matches) : earlier;
    if (earlierShown.length) {
      const expanded = !!needle || open.has('earlier');
      nodes.push(h('li', null,
        h('div', { class: 'li-main' },
          h('div', { class: 'li-name' }, 'Earlier deletions'),
          h('div', { class: 'li-sub' }, 'Deleted in Session Analyzer, or their record here was erased. They cannot be put back into a session.')),
        h('button', {
          class: 'btn small subtle', type: 'button', 'aria-expanded': String(expanded),
          onclick: () => {
            if (open.has('earlier')) open.delete('earlier');
            else open.add('earlier');
            renderLists();
          },
        }, icon(expanded ? 'down' : 'right', 12), expanded ? 'Hide links' : `Show ${plural(earlier.length, 'link')}`),
        expanded && linkList(earlierShown),
      ));
    }

    fill(listBox, nodes.length
      ? h('ul', { class: 'list-plain' }, nodes)
      : h('p', null, needle ? 'No removed link matches.' : 'No links have been removed yet.'));
  };
  renderLists();

  const search = /** @type {HTMLInputElement} */ (h('input', {
    class: 'input', type: 'search', placeholder: 'Search removed links — title or URL…', autocomplete: 'off',
    oninput: debounce(() => {
      needle = search.value.trim().toLowerCase();
      renderLists();
    }, 120),
  }));

  fill(panel,
    h('div', { class: 'row-inline' },
      h('h3', { style: { margin: '0' } }, `Deleted sessions (${trashed.length})`),
      trashed.length ? h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Empty the trash?', message: `${plural(trashed.length, 'session')} will be deleted for good.`, confirmLabel: 'Empty trash', danger: true });
          if (ok) await act(() => sessions.purgeSessions(trashed.map((m) => m.id)));
        },
      }, 'Empty trash') : null),
    sessionList,
    h('h3', null, `Removed links (${log.length})`),
    h('p', null, 'Every link you remove from a session, or delete from all sessions, is recorded here with its title — and stays until you erase the record. '
      + 'Putting links back restores their original positions and lets them be imported again.'),
    totalLinks ? h('div', { class: 'row-inline rl-search' }, search, h('span', { class: 'muted' }, plural(totalLinks, 'removed link'))) : null,
    listBox,
  );
}

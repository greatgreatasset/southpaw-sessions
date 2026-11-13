// Import dialog: pick files or a whole folder, see what would change, confirm.
import { addParsed, applyImport, createBatch, planImport } from '../lib/importer.js';
import { parseImportFile, sha1Hex } from '../lib/importers/index.js';
import { countTabs, plural } from '../lib/model.js';
import { setSettings } from '../lib/settings.js';
import { add, clear, fill, h, icon, openDialog } from '../ui/dom.js';

/** Files inside dropped folders, recursively. */
async function filesFromDrop(dt) {
  const entries = [...(dt.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files ?? [])];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/**
 * @returns {Promise<boolean>} true when the library was changed
 */
export async function openImportDialog() {
  // Tracked out here so an import followed by Escape still counts as a change.
  let changed = false;
  await openDialog((close) => {
    const body = h('div');
    let cancelled = false;

    const actions = (...buttons) => h('div', { class: 'dialog-actions' }, buttons);
    const closeBtn = (label = 'Cancel') => h('button', { class: 'btn', type: 'button', onclick: () => { cancelled = true; close(changed); } }, label);

    // ---- step 1: choose ----
    const showChoose = (note) => {
      const pickFiles = /** @type {HTMLInputElement} */ (h('input', { type: 'file', multiple: true, hidden: true, onchange: () => read([...pickFiles.files]) }));
      const pickDir = /** @type {HTMLInputElement} */ (h('input', { type: 'file', hidden: true, onchange: () => read([...pickDir.files]) }));
      pickDir.setAttribute('webkitdirectory', '');
      const drop = h('div', {
        class: 'drop',
        ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
        ondragleave: () => drop.classList.remove('over'),
        ondrop: async (e) => {
          e.preventDefault();
          drop.classList.remove('over');
          read(await filesFromDrop(e.dataTransfer));
        },
      },
      icon('import', 26),
      h('div', null, 'Drop session files or a folder here'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => pickFiles.click() }, 'Choose files…'),
        h('button', { class: 'btn', type: 'button', onclick: () => pickDir.click() }, 'Choose a folder…')),
      pickFiles, pickDir);
      fill(body,
        note && h('div', { class: 'errors' }, note),
        drop,
        h('ul', { class: 'formats' },
          h('li', null, h('b', null, 'MySessions'), ' — .mysessions backups and its .json session exports. Pick the whole backup folder: identical copies are skipped and the newest version of each session wins.'),
          h('li', null, h('b', null, 'Session Manager'), ' — .session files.'),
          h('li', null, h('b', null, 'Firefox'), ' — sessionstore.jsonlz4 and the files in your profile’s sessionstore-backups folder.'),
          h('li', null, h('b', null, 'Southpaw Sessions'), ' — its own backups (.json / .json.gz), and the state file exported from Session Analyzer.')),
        actions(closeBtn('Close')),
      );
    };

    // ---- step 2: read ----
    const read = async (files) => {
      files = files.filter((f) => f && f.size > 0);
      if (!files.length) return showChoose('No readable files were selected.');
      cancelled = false;
      const bar = h('div');
      const label = h('div', { class: 'hint' });
      fill(body, h('div', null, `Reading ${plural(files.length, 'file')}…`), h('div', { class: 'progress' }, bar), label, actions(closeBtn()));

      const batch = createBatch();
      for (let i = 0; i < files.length; i++) {
        if (cancelled) return undefined;
        const file = files[i];
        label.textContent = `${i + 1} / ${files.length} — ${file.name}`;
        bar.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const hash = await sha1Hex(bytes);
          if (batch.hashes.has(hash)) {
            batch.identical++;
            continue;
          }
          batch.hashes.add(hash);
          const parsed = await parseImportFile({ name: file.name, bytes, lastModified: file.lastModified });
          addParsed(batch, parsed, { name: file.name, lastModified: file.lastModified });
        } catch (e) {
          batch.failed.push({ name: file.name, error: String(/** @type {any} */ (e)?.message ?? e) });
        }
      }
      if (cancelled) return undefined;
      return showPlan(batch, await planImport(batch));
    };

    // ---- step 3: review ----
    const showPlan = (batch, plan) => {
      const tabsIn = (items) => items.reduce((n, it) => n + countTabs(it.session.windows), 0);
      const older = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
      const overwrite = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
      const settings = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
      const go = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'button' }));
      const willAdd = () => plan.fresh.length + (older.checked ? plan.olderOnly.length : 0);
      const hasExtras = plan.tombstones > 0 || plan.checks > 0 || plan.removed > 0;
      const sync = () => {
        const n = willAdd() + (overwrite.checked ? plan.existing.length : 0);
        go.textContent = n ? `Import ${plural(n, 'session')}` : hasExtras || settings.checked ? 'Import' : 'Nothing to import';
        go.disabled = !n && !hasExtras && !settings.checked;
      };
      for (const box of [older, overwrite, settings]) box.addEventListener('change', sync);
      sync();

      const row = (label, value) => [h('dt', null, label), h('dd', null, value)];
      const filesLine = [`${batch.files} read`];
      if (batch.identical) filesLine.push(`${batch.identical} identical ${batch.identical === 1 ? 'copy' : 'copies'} skipped`);
      if (batch.failed.length) filesLine.push(`${batch.failed.length} not recognised`);

      fill(body,
        h('dl', { class: 'kv' },
          row('Files', filesLine.join(' · ')),
          Object.entries(batch.formats).map(([label, n]) => row(`  ${label}`, n)),
          // A state-only file (deletions + verdicts) has no sessions to count.
          batch.byKey.size ? row('New sessions', `${plan.fresh.length.toLocaleString()} (${plural(tabsIn(plan.fresh), 'tab')})`) : null,
          plan.existing.length ? row('Already in your library', plan.existing.length.toLocaleString()) : null,
          plan.olderOnly.length ? row('Only in older backups', plan.olderOnly.length.toLocaleString()) : null,
          plan.duplicates ? row('Duplicates within the selection', plan.duplicates.toLocaleString()) : null,
          plan.tombstones ? row('Deleted-link records', plan.tombstones.toLocaleString()) : null,
          plan.checks ? row('Dead-link verdicts', plan.checks.toLocaleString()) : null,
          plan.removed ? row('Removed-links log entries', plan.removed.toLocaleString()) : null),
        !batch.byKey.size && hasExtras ? h('div', { class: 'hint' },
          'This file contains no sessions — only the links you deleted and the dead-link verdicts. '
          + 'Import your session backups separately (before or after; the order does not matter).') : null,
        plan.olderOnly.length ? h('label', { class: 'opt' }, older,
          h('span', null, `Also import the ${plural(plan.olderOnly.length, 'session')} found only in older backups`,
            h('small', null, `They are missing from the newest backup (${plan.newestLibraryFile}), which means they were deleted after the older backups were made.`))) : null,
        plan.existing.length ? h('label', { class: 'opt' }, overwrite,
          h('span', null, `Overwrite the ${plural(plan.existing.length, 'session')} already in the library`,
            h('small', null, 'Leave this off to keep the library copies, including any links you removed from them.'))) : null,
        plan.hasSettings ? h('label', { class: 'opt' }, settings, h('span', null, 'Restore the settings stored in the backup')) : null,
        batch.failed.length ? h('div', { class: 'errors' }, batch.failed.slice(0, 50).map((f) => h('div', null, `${f.name}: ${f.error}`)),
          batch.failed.length > 50 ? h('div', null, `…and ${batch.failed.length - 50} more`) : null) : null,
        actions(closeBtn(), go),
      );
      go.addEventListener('click', () => apply(batch, plan, {
        includeOlderOnly: older.checked,
        overwriteExisting: overwrite.checked,
        applySettings: settings.checked ? async (s) => { await setSettings(s); } : undefined,
      }));
    };

    // ---- step 4: write ----
    const apply = async (batch, plan, opts) => {
      const bar = h('div');
      fill(body, h('div', null, 'Importing…'), h('div', { class: 'progress' }, bar));
      try {
        const s = await applyImport(batch, plan, {
          ...opts,
          onProgress: (doneCount, total) => { bar.style.width = `${Math.round((doneCount / Math.max(1, total)) * 100)}%`; },
        });
        changed = true;
        const row = (label, value) => (value ? [h('dt', null, label), h('dd', null, value.toLocaleString())] : null);
        fill(body,
          h('dl', { class: 'kv' },
            [h('dt', null, 'Sessions added'), h('dd', null, s.added.toLocaleString())],
            row('Sessions overwritten', s.overwritten),
            row('Already in the library (kept)', s.skippedExisting),
            row('Only in older backups (not imported)', s.skippedOlderOnly),
            row('Links withheld because you deleted them before', s.blockedTabs),
            row('Sessions skipped (all their links were deleted before)', s.emptyAfterFilter),
            row('Deleted-link records added', s.tombstonesAdded),
            row('Links removed from existing sessions', s.tabsRemoved),
            row('Dead-link verdicts added', s.checksAdded),
            row('Removed-links log entries restored', s.removedLogAdded)),
          s.tabsRemoved ? h('div', { class: 'hint' }, 'The removal is listed in the trash, where it can be undone.') : null,
          actions(h('button', { class: 'btn primary', type: 'button', autofocus: true, onclick: () => close(true) }, 'Done')),
        );
      } catch (e) {
        fill(body, h('div', { class: 'errors' }, `Import failed: ${/** @type {any} */ (e)?.message ?? e}`), actions(closeBtn('Close')));
      }
    };

    showChoose();
    return [h('h2', null, 'Import sessions'), body];
  }, { class: 'wide' });
  return changed;
}

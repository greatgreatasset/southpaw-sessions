// Settings dialog. Every control saves immediately.
import { buildBackup, getBackupState, serializeBackup } from '../lib/backup.js';
import * as db from '../lib/db.js';
import { formatDateTime, plural } from '../lib/model.js';
import { call } from '../lib/rpc.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { add, clear, confirmDialog, downloadBlob, fill, h, openDialog, toast } from '../ui/dom.js';

const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * @param {{onImport: () => void}} opts
 */
export async function openSettingsDialog({ onImport }) {
  let settings = await getSettings();
  const save = async (patch) => {
    settings = await setSettings(patch);
  };

  await openDialog((close) => {
    const toggle = (key, label, hint, onChange) => {
      const box = /** @type {HTMLInputElement} */ (h('input', {
        type: 'checkbox', checked: settings[key],
        onchange: async () => {
          if (onChange && !(await onChange(box.checked))) {
            box.checked = !box.checked;
            return;
          }
          await save({ [key]: box.checked });
        },
      }));
      return h('label', { class: 'opt' }, box, h('span', null, label, hint && h('small', null, hint)));
    };
    const number = (key, label, { min = 0, max = 100000, unit = '' } = {}) => {
      const input = /** @type {HTMLInputElement} */ (h('input', {
        class: 'input', type: 'number', min: String(min), max: String(max), value: String(settings[key]),
        onchange: async () => {
          await save({ [key]: input.value });
          input.value = String(settings[key]); // show the clamped value
        },
      }));
      return h('div', { class: 'set-row' }, h('span', { class: 'lbl' }, label), input, unit && h('span', { class: 'muted' }, unit));
    };

    // ---- backups ----
    const backupStatus = h('div', { class: 'set-status' });
    const refreshBackupStatus = async () => {
      const st = await getBackupState();
      const last = st.files[0];
      clear(backupStatus);
      backupStatus.className = 'set-status';
      if (last) {
        add(backupStatus, `Last backup: ${formatDateTime(last.at)} — Downloads/${last.filename} `
          + `(${plural(last.sessions, 'session')}, ${formatBytes(last.bytes)}). ${plural(st.files.length, 'file')} kept.`);
      } else {
        add(backupStatus, 'No backup has been written yet. The first one follows shortly after you save or import a session.');
      }
      if (st.lastError) add(backupStatus, h('div', { class: 'set-status err' }, `Last attempt failed — ${st.lastError}`));
    };
    refreshBackupStatus();

    const folder = /** @type {HTMLInputElement} */ (h('input', {
      class: 'input text', type: 'text', value: settings.backupFolder, spellcheck: 'false',
      onchange: async () => {
        await save({ backupFolder: folder.value });
        folder.value = settings.backupFolder;
      },
    }));
    const backupNow = /** @type {HTMLButtonElement} */ (h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        backupNow.disabled = true;
        try {
          const res = await call('backupNow');
          if (res.ok) toast(`Backup written to Downloads/${res.file.filename}`, { ms: 5000 });
          else toast(res.error ? `Backup failed: ${res.error}` : 'There is nothing to back up yet.', { kind: res.error ? 'error' : 'info' });
        } catch (e) {
          toast(String(/** @type {any} */ (e)?.message ?? e), { kind: 'error' });
        }
        backupNow.disabled = false;
        refreshBackupStatus();
      },
    }, 'Back up now'));
    const download = h('button', {
      class: 'btn', type: 'button', title: 'Save a backup file wherever you choose',
      onclick: async () => {
        const { blob, ext } = await serializeBackup(await buildBackup(), settings.backupCompress);
        downloadBlob(blob, `southpaw-backup-${new Date().toISOString().slice(0, 10)}.${ext}`);
      },
    }, 'Download a copy…');

    // ---- housekeeping ----
    const tombInfo = h('span', { class: 'lbl' });
    const forget = /** @type {HTMLButtonElement} */ (h('button', {
      class: 'btn small', type: 'button',
      onclick: async () => {
        const ok = await confirmDialog({
          title: 'Forget deleted links?',
          message: 'Links you deleted will no longer be held back when you import old backups. Nothing is added to your sessions now.',
          confirmLabel: 'Forget',
        });
        if (!ok) return;
        await db.clearTombstones();
        refreshCounts();
      },
    }, 'Forget them'));
    const about = h('div', { class: 'set-status' });
    const refreshCounts = async () => {
      const c = await db.storeCounts();
      tombInfo.textContent = c.tombstones
        ? `${plural(c.tombstones, 'deleted link')} ${c.tombstones === 1 ? 'is' : 'are'} remembered, so importing an old backup never brings ${c.tombstones === 1 ? 'it' : 'them'} back.`
        : 'No deleted links are being remembered.';
      forget.disabled = !c.tombstones;
      const est = await navigator.storage?.estimate?.().catch(() => null);
      about.textContent = `Southpaw Sessions ${browser.runtime.getManifest().version} · ${plural(c.checks, 'dead-link verdict')} cached`
        + (est?.usage ? ` · ${formatBytes(est.usage)} stored in this browser profile` : '');
    };
    refreshCounts();

    return h('div', { class: 'settings' },
      h('h2', null, 'Settings'),

      h('section', null,
        h('h3', null, 'Autosave and crash recovery'),
        toggle('autosave', 'Keep an automatic record of the open tabs',
          'After a crash or a restart, the previous browser session can be restored from the toolbar button or from “Automatic” in the sidebar.'),
        number('checkpointMinutes', 'Keep a history checkpoint every', { min: 1, max: 1440, unit: 'minutes' }),
        number('keepCheckpoints', 'Checkpoints to keep', { min: 0, max: 100 }),
        number('keepPrevious', 'Previous browser sessions to keep', { min: 1, max: 100 }),
        number('keepClosed', 'Closed windows to keep', { min: 0, max: 100 })),

      h('section', null,
        h('h3', null, 'Opening and saving'),
        toggle('lazyRestore', 'Load a tab only when it is clicked',
          'Opened sessions use almost no memory until you visit their tabs. Pinned tabs always load.'),
        number('confirmOpenOver', 'Ask before opening more than', { min: 0, max: 100000, unit: 'tabs (0 = never ask)' }),
        toggle('savePrivate', 'Include tabs from private windows',
          'Also requires “Run in Private Windows” to be allowed for this extension in about:addons.')),

      h('section', null,
        h('h3', null, 'File backups'),
        toggle('backupEnabled', 'Back up the library to a file automatically',
          'A backup is written only after the library changed — one file per day, older files are removed. Each file contains everything: sessions, deleted-link records, dead-link verdicts, settings.'),
        h('div', { class: 'set-row' }, h('span', { class: 'lbl' }, 'Folder inside Downloads'), folder),
        number('backupMinIntervalMin', 'Write at most one backup every', { min: 5, max: 10080, unit: 'minutes' }),
        number('backupKeepDays', 'Daily backup files to keep', { min: 1, max: 3650 }),
        toggle('backupCompress', 'Compress backups (.json.gz)', 'About five times smaller. Both forms can be imported.'),
        backupStatus,
        h('div', { class: 'row-inline' }, backupNow, download,
          h('button', { class: 'btn', type: 'button', onclick: () => { close(); onImport(); } }, 'Restore from a backup…'))),

      h('section', null,
        h('h3', null, 'Dead-link checking'),
        toggle('checkOtherSites', 'Also check websites other than YouTube and Imgur',
          'Only a clear “not found” (404/410) counts as dead; anything uncertain stays marked “?”. Firefox will ask for permission to contact all websites.',
          async (on) => {
            if (!on) return true;
            try {
              return await browser.permissions.request({ origins: ['<all_urls>'] });
            } catch {
              return false;
            }
          }),
        number('checkConcurrency', 'Simultaneous checks', { min: 1, max: 16 })),

      h('section', null,
        h('h3', null, 'Housekeeping'),
        number('trashDays', 'Empty the trash after', { min: 1, max: 3650, unit: 'days' }),
        h('div', { class: 'set-row' }, tombInfo, forget),
        about),

      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => close() }, 'Done')),
    );
  }, { class: 'wide' });
}

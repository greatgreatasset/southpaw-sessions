// File backups of the whole library into Downloads/<folder>/.
//
// Lessons from the add-on this replaces, which wrote a full backup every time
// its background page loaded and filled a folder with thousands of identical
// files:
//   - A backup is written only when the library CHANGED since the last one.
//   - Never more often than the configured interval.
//   - One file per day (the day's file is overwritten as the day goes on),
//     and only the newest N day-files are kept. Disk use is bounded.
//   - A library that suddenly shrank is written to a separate file instead of
//     overwriting the good backup, and an empty library is never backed up.
import * as db from './db.js';
import { SOUTHPAW_FORMAT } from './importers/index.js';
import { KIND, countTabs } from './model.js';
import { getSettings } from './settings.js';

const STATE_KEY = 'backupState';

/**
 * @typedef {object} BackupFile
 * @property {number} id        downloads id
 * @property {string} filename  path relative to Downloads
 * @property {number} at
 * @property {number} sessions
 * @property {number} tabs
 * @property {number} bytes
 */

/**
 * @typedef {object} BackupState
 * @property {number} lastAt
 * @property {number} lastChangedAt   library stamp covered by the last backup
 * @property {number} lastSessions
 * @property {number} lastTabs
 * @property {BackupFile[]} files     newest first
 * @property {string | null} lastError
 * @property {{at: number, from: number, to: number, file: string} | null} warning
 */

/** @returns {Promise<BackupState>} */
export async function getBackupState() {
  const stored = (await browser.storage.local.get(STATE_KEY))[STATE_KEY] ?? {};
  return {
    lastAt: stored.lastAt ?? 0,
    lastChangedAt: stored.lastChangedAt ?? 0,
    lastSessions: stored.lastSessions ?? 0,
    lastTabs: stored.lastTabs ?? 0,
    files: Array.isArray(stored.files) ? stored.files : [],
    lastError: stored.lastError ?? null,
    warning: stored.warning ?? null,
  };
}

async function setBackupState(state) {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

export async function dismissBackupWarning() {
  const state = await getBackupState();
  state.warning = null;
  await setBackupState(state);
}

/**
 * Everything worth restoring: saved sessions (including the trash), recent
 * automatic snapshots, dead-link verdicts, deletion tombstones, the log of
 * removed links, settings. The live autosave and its checkpoints are left
 * out — they describe a browser run, not the library.
 */
export async function buildBackup() {
  const [metas, data, checks, tombstones, removed, settings] = await Promise.all([
    db.listMeta(), db.getAllData(), db.getAllChecks(), db.listTombstones(), db.listUndo(), getSettings(),
  ]);
  const sessions = metas
    .filter((m) => m.kind !== KIND.CURRENT && m.kind !== KIND.CHECKPOINT)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({ ...m, windows: data.get(m.id) ?? [] }));
  const saved = sessions.filter((s) => s.kind === KIND.SAVED && !s.deletedAt);
  const manifest = browser.runtime.getManifest();
  return {
    format: SOUTHPAW_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    app: { name: manifest.name, version: manifest.version },
    counts: {
      sessions: saved.length,
      tabs: saved.reduce((n, s) => n + countTabs(s.windows), 0),
      checks: checks.size,
      tombstones: tombstones.length,
      removed: removed.length,
    },
    sessions,
    checks: [...checks.values()],
    tombstones: tombstones.map(({ key: _key, ...rest }) => rest),
    // The auto-increment `id` is local to a profile; `uid` identifies an entry.
    removed: removed.map(({ id: _id, ...rest }) => ({ ...rest, uid: db.undoUid(rest) })),
    settings,
  };
}

/**
 * @param {object} backup
 * @param {boolean} compress
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function serializeBackup(backup, compress) {
  const json = JSON.stringify(backup);
  if (!compress) return { blob: new Blob([json], { type: 'application/json' }), ext: 'json' };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  return { blob: new Blob([blob], { type: 'application/gzip' }), ext: 'json.gz' };
}

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Wait until a download finishes; resolves with its final size. */
async function waitForDownload(id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await browser.downloads.search({ id });
    if (!item) throw new Error('download disappeared');
    if (item.state === 'complete') return item.fileSize ?? item.totalBytes ?? 0;
    if (item.state === 'interrupted') throw new Error(`download failed (${item.error ?? 'interrupted'})`);
    if (Date.now() > deadline) throw new Error('download timed out');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** @type {Promise<any> | null} */
let running = null;

/**
 * Write a backup file if one is due.
 * @param {{force?: boolean}} [opts]  force: the user asked for it — ignore the
 *                                    "unchanged" and interval checks
 * @returns {Promise<{ok: true, file: BackupFile, shrunk: boolean}
 *                 | {ok: false, skipped: 'disabled' | 'unchanged' | 'too-soon' | 'empty', retryAt?: number}
 *                 | {ok: false, error: string}>}
 */
export function runBackup(opts = {}) {
  if (running) return running;
  running = doBackup(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doBackup({ force = false }) {
  const settings = await getSettings();
  const state = await getBackupState();
  const { libraryChangedAt = 0 } = await browser.storage.local.get('libraryChangedAt');
  const now = Date.now();

  if (!force) {
    if (!settings.backupEnabled) return { ok: false, skipped: 'disabled' };
    if (libraryChangedAt <= state.lastChangedAt) return { ok: false, skipped: 'unchanged' };
    const retryAt = state.lastAt + settings.backupMinIntervalMin * 60000;
    if (now < retryAt) return { ok: false, skipped: 'too-soon', retryAt };
  }

  let url = null;
  try {
    const backup = await buildBackup();
    const { sessions, tabs } = backup.counts;
    if (sessions === 0) return { ok: false, skipped: 'empty' };

    // Losing most of the library between two backups smells like a browser
    // malfunction, not like tidying up: keep the earlier file intact.
    const shrunk = state.lastSessions >= 10 && sessions < state.lastSessions * 0.5;
    const d = new Date(now);
    const { blob, ext } = await serializeBackup(backup, settings.backupCompress);
    const suffix = shrunk ? `-shrunk-${pad(d.getHours())}${pad(d.getMinutes())}` : '';
    const filename = `${settings.backupFolder}/southpaw-backup-${dayStamp(d)}${suffix}.${ext}`;

    url = URL.createObjectURL(blob);
    const id = await browser.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    const bytes = (await waitForDownload(id)) || blob.size;

    /** @type {BackupFile} */
    const file = { id, filename, at: now, sessions, tabs, bytes };
    // The same day's file was overwritten: drop the stale history entry.
    const replaced = state.files.filter((f) => f.filename === filename);
    for (const f of replaced) await browser.downloads.erase({ id: f.id }).catch(() => {});
    let files = [file, ...state.files.filter((f) => f.filename !== filename)];

    // Rotation: keep the newest N files, delete the rest from disk.
    for (const old of files.slice(settings.backupKeepDays)) {
      await browser.downloads.removeFile(old.id).catch(() => {});
      await browser.downloads.erase({ id: old.id }).catch(() => {});
    }
    files = files.slice(0, settings.backupKeepDays);

    await setBackupState({
      lastAt: now,
      lastChangedAt: Math.max(libraryChangedAt, state.lastChangedAt),
      lastSessions: sessions,
      lastTabs: tabs,
      files,
      lastError: null,
      warning: shrunk ? { at: now, from: state.lastSessions, to: sessions, file: filename } : state.warning,
    });
    return { ok: true, file, shrunk };
  } catch (e) {
    const error = String(/** @type {any} */ (e)?.message ?? e);
    await setBackupState({ ...state, lastError: `${new Date(now).toLocaleString()}: ${error}` });
    return { ok: false, error };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

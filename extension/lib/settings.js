// User settings, kept in browser.storage.local under one key.

/**
 * @typedef {object} Settings
 * @property {boolean} autosave
 * @property {number} checkpointMinutes
 * @property {number} keepCheckpoints
 * @property {number} keepPrevious
 * @property {number} keepClosed
 * @property {boolean} lazyRestore
 * @property {number} confirmOpenOver
 * @property {boolean} savePrivate
 * @property {boolean} backupEnabled
 * @property {string} backupFolder
 * @property {number} backupMinIntervalMin
 * @property {number} backupKeepDays
 * @property {boolean} backupCompress
 * @property {number} trashDays
 * @property {boolean} checkOtherSites
 * @property {number} checkConcurrency
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  // Autosave / crash recovery
  autosave: true,
  checkpointMinutes: 15, // how often a history checkpoint of the live browser is kept
  keepCheckpoints: 8,
  keepPrevious: 10, // "browser as it was when it last closed" snapshots to keep
  keepClosed: 15, // recently closed windows to keep

  // Opening sessions
  lazyRestore: true, // create tabs unloaded; a tab loads when you click it
  confirmOpenOver: 100, // ask before opening sessions bigger than this (0 = never)

  // Saving
  savePrivate: false, // include tabs from private windows

  // File backups (Downloads/<backupFolder>/)
  backupEnabled: true,
  backupFolder: 'SouthpawSessions',
  backupMinIntervalMin: 60, // never write more often than this
  backupKeepDays: 30, // one file per day with changes; keep the newest N
  backupCompress: true,

  // Housekeeping
  trashDays: 30,

  // Dead-link checker
  checkOtherSites: false, // opt-in: check arbitrary sites (404/410 only)
  checkConcurrency: 6,
});

const KEY = 'settings';

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Coerce arbitrary stored/imported values into a valid settings object.
 * @param {Record<string, any> | null | undefined} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  const s = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return s;
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw)) continue;
    const def = DEFAULTS[key];
    const v = raw[key];
    if (typeof def === 'boolean') s[key] = !!v;
    else if (typeof def === 'string') s[key] = typeof v === 'string' ? v : def;
  }
  s.checkpointMinutes = clampInt(raw.checkpointMinutes, 1, 1440, DEFAULTS.checkpointMinutes);
  s.keepCheckpoints = clampInt(raw.keepCheckpoints, 0, 100, DEFAULTS.keepCheckpoints);
  s.keepPrevious = clampInt(raw.keepPrevious, 1, 100, DEFAULTS.keepPrevious);
  s.keepClosed = clampInt(raw.keepClosed, 0, 100, DEFAULTS.keepClosed);
  s.confirmOpenOver = clampInt(raw.confirmOpenOver, 0, 100000, DEFAULTS.confirmOpenOver);
  s.backupMinIntervalMin = clampInt(raw.backupMinIntervalMin, 5, 10080, DEFAULTS.backupMinIntervalMin);
  s.backupKeepDays = clampInt(raw.backupKeepDays, 1, 3650, DEFAULTS.backupKeepDays);
  s.trashDays = clampInt(raw.trashDays, 1, 3650, DEFAULTS.trashDays);
  s.checkConcurrency = clampInt(raw.checkConcurrency, 1, 16, DEFAULTS.checkConcurrency);
  s.backupFolder = sanitizeFolder(s.backupFolder);
  return s;
}

/**
 * A folder path relative to the Downloads directory. The downloads API rejects
 * absolute paths and "..", and Windows rejects a handful of characters.
 * @param {string} name
 */
export function sanitizeFolder(name) {
  const parts = String(name ?? '')
    .split(/[\\/]+/)
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '').replace(/^\.+/, '').replace(/[. ]+$/, '').trim())
    .filter(Boolean);
  return parts.join('/') || DEFAULTS.backupFolder;
}

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const stored = await browser.storage.local.get(KEY);
  return sanitizeSettings(stored[KEY]);
}

/** @param {Partial<Settings>} patch @returns {Promise<Settings>} */
export async function setSettings(patch) {
  const next = sanitizeSettings({ ...(await getSettings()), ...patch });
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

/** @param {(s: Settings) => void} listener */
export function onSettingsChanged(listener) {
  const handler = (changes, area) => {
    if (area === 'local' && changes[KEY]) listener(sanitizeSettings(changes[KEY].newValue));
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}

// Import pipeline: collect parsed files into a batch, compare the batch with
// the library, then write.
//
// Rules (carried over from the retired session analyzer, tightened):
//  - A session's identity is its originKey; the same session exported twice
//    under different ids is caught by its name+minute fingerprint.
//  - When several backups contain the same session, the NEWEST FILE's copy
//    wins — it reflects the edits made after the older backups were written.
//  - Sessions already in the library are left alone unless asked otherwise:
//    the library copy is the one the user has been pruning.
//  - Tombstoned links are never re-added.
//  - Importing is idempotent — running it twice changes nothing.
import * as db from './db.js';
import { KIND, countTabs, newId } from './model.js';
import { removeTabs } from './sessions.js';
import { canonicalize } from './url.js';

/** @typedef {import('./importers/index.js').ParsedFile} ParsedFile */
/** @typedef {import('./importers/index.js').ParsedSession} ParsedSession */

/**
 * @typedef {object} Batch
 * @property {number} files                 files parsed successfully
 * @property {number} identical             byte-identical files skipped
 * @property {{name: string, error: string}[]} failed
 * @property {Record<string, number>} formats   label -> file count
 * @property {Map<string, {session: ParsedSession, fileTime: number, type: string}>} byKey
 * @property {{time: number, name: string, keys: Set<string>}[]} libraryFiles  full-library backups seen
 * @property {NonNullable<ParsedFile['tombstones']>} tombstones
 * @property {NonNullable<ParsedFile['checks']>} checks
 * @property {import('./db.js').UndoEntry[]} removed   removed-links log entries (own backups)
 * @property {Record<string, any> | null} settings
 * @property {Set<string>} hashes
 */

/** @returns {Batch} */
export function createBatch() {
  return {
    files: 0,
    identical: 0,
    failed: [],
    formats: {},
    byKey: new Map(),
    libraryFiles: [],
    tombstones: [],
    checks: [],
    removed: [],
    settings: null,
    hashes: new Set(),
  };
}

/**
 * Fold one parsed file into the batch.
 * @param {Batch} batch
 * @param {ParsedFile} parsed
 * @param {{name: string, lastModified: number}} file
 */
export function addParsed(batch, parsed, file) {
  batch.files++;
  batch.formats[parsed.label] = (batch.formats[parsed.label] ?? 0) + 1;
  const time = file.lastModified || 0;
  for (const s of parsed.sessions) {
    const prev = batch.byKey.get(s.originKey);
    if (!prev || time >= prev.fileTime) batch.byKey.set(s.originKey, { session: s, fileTime: time, type: parsed.type });
  }
  // A *.mysessions file is a snapshot of the add-on's WHOLE library, so a
  // session missing from the newest one was deleted by the user later on.
  if (parsed.type === 'mysessions') {
    batch.libraryFiles.push({ time, name: file.name, keys: new Set(parsed.sessions.map((s) => s.originKey)) });
  }
  if (parsed.tombstones?.length) batch.tombstones.push(...parsed.tombstones);
  if (parsed.checks?.length) batch.checks.push(...parsed.checks);
  if (parsed.removed?.length) batch.removed.push(...parsed.removed);
  if (parsed.settings) batch.settings = parsed.settings;
}

/**
 * @typedef {object} PlanItem
 * @property {ParsedSession} session
 * @property {import('./model.js').SessionMeta} [match]  library session it duplicates
 */

/**
 * @typedef {object} Plan
 * @property {PlanItem[]} fresh       not in the library — will be added
 * @property {PlanItem[]} existing    already in the library
 * @property {PlanItem[]} olderOnly   only present in older full backups
 * @property {number} duplicates      same session seen twice within the batch
 * @property {number} empty           sessions without any tab
 * @property {number} tombstones
 * @property {number} checks
 * @property {number} removed         removed-links log entries in the selection
 * @property {boolean} hasSettings
 * @property {string | null} newestLibraryFile
 */

/**
 * Compare a batch with what the library already holds.
 * @param {Batch} batch
 * @returns {Promise<Plan>}
 */
export async function planImport(batch) {
  const metas = await db.listMeta();
  const byId = new Map();
  const byOrigin = new Map();
  const byFp = new Map();
  for (const m of metas) {
    if (m.kind === KIND.CURRENT || m.kind === KIND.CHECKPOINT) continue;
    byId.set(m.id, m);
    if (m.originKey) byOrigin.set(m.originKey, m);
    if (m.kind === KIND.SAVED && m.fp) byFp.set(m.fp, m);
  }

  const libraryFiles = [...batch.libraryFiles].sort((a, b) => b.time - a.time);
  const newest = libraryFiles[0] ?? null;
  const severalLibraryFiles = libraryFiles.length > 1;

  // Sessions that carry a real id go first so a fingerprint-only duplicate of
  // the same session loses to them.
  const rank = (c) => (c.type === 'southpaw' ? 0 : c.type === 'mysessions' ? 1 : 2);
  const candidates = [...batch.byKey.values()].sort(
    (a, b) => rank(a) - rank(b) || a.session.createdAt - b.session.createdAt,
  );

  /** @type {Plan} */
  const plan = {
    fresh: [],
    existing: [],
    olderOnly: [],
    duplicates: 0,
    empty: 0,
    tombstones: batch.tombstones.length,
    checks: batch.checks.length,
    removed: batch.removed.length,
    hasSettings: !!batch.settings,
    newestLibraryFile: newest?.name ?? null,
  };
  const fpTaken = new Set();
  for (const c of candidates) {
    const s = c.session;
    if (s.kind === KIND.CURRENT || s.kind === KIND.CHECKPOINT) continue;
    if (fpTaken.has(s.fp)) {
      plan.duplicates++;
      continue;
    }
    fpTaken.add(s.fp);
    if (countTabs(/** @type {any} */ (s.windows)) === 0) {
      plan.empty++;
      continue;
    }
    const match = (s.id && byId.get(s.id)) || byOrigin.get(s.originKey) || byFp.get(s.fp);
    if (match) plan.existing.push({ session: s, match });
    else if (c.type === 'mysessions' && severalLibraryFiles && !newest.keys.has(s.originKey)) {
      plan.olderOnly.push({ session: s });
    } else plan.fresh.push({ session: s });
  }
  return plan;
}

/**
 * @typedef {object} ImportSummary
 * @property {number} added
 * @property {number} overwritten
 * @property {number} skippedExisting
 * @property {number} skippedOlderOnly
 * @property {number} blockedTabs        tabs withheld because they were deleted before
 * @property {number} emptyAfterFilter   sessions dropped because every tab was withheld
 * @property {number} tombstonesAdded
 * @property {number} tabsRemoved        tabs removed from existing sessions by imported deletions
 * @property {number} checksAdded
 * @property {number} removedLogAdded    removed-links log entries restored
 * @property {boolean} settingsRestored
 */

/**
 * Write a planned import.
 * @param {Batch} batch
 * @param {Plan} plan
 * @param {{includeOlderOnly?: boolean, overwriteExisting?: boolean,
 *          applySettings?: (settings: Record<string, any>) => Promise<void>,
 *          onProgress?: (done: number, total: number) => void}} [opts]
 * @returns {Promise<ImportSummary>}
 */
export async function applyImport(batch, plan, opts = {}) {
  const { includeOlderOnly = false, overwriteExisting = false, applySettings, onProgress } = opts;
  /** @type {ImportSummary} */
  const summary = {
    added: 0,
    overwritten: 0,
    skippedExisting: overwriteExisting ? 0 : plan.existing.length,
    skippedOlderOnly: includeOlderOnly ? 0 : plan.olderOnly.length,
    blockedTabs: 0,
    emptyAfterFilter: 0,
    tombstonesAdded: 0,
    tabsRemoved: 0,
    checksAdded: 0,
    removedLogAdded: 0,
    settingsRestored: false,
  };

  // 1. Deletions first, so they apply to everything written below.
  const addedKeys = new Set(await db.addTombstones(batch.tombstones));
  summary.tombstonesAdded = addedKeys.size;
  const tomb = await db.getTombstoneIndex();

  const filterWindows = (windows, originKey) => {
    const scoped = tomb.perOrigin.get(originKey);
    if (!tomb.global.size && !scoped) return windows;
    return windows.map((w) => {
      const tabs = w.tabs.filter((t) => {
        const c = canonicalize(t.url);
        const blocked = tomb.global.has(c) || scoped?.has(c);
        if (blocked) summary.blockedTabs++;
        return !blocked;
      });
      return tabs.length === w.tabs.length ? w : { ...w, tabs };
    });
  };

  // 2. Sessions.
  const todo = [
    ...plan.fresh.map((item) => ({ item, overwrite: false })),
    ...(includeOlderOnly ? plan.olderOnly.map((item) => ({ item, overwrite: false })) : []),
    ...(overwriteExisting ? plan.existing.map((item) => ({ item, overwrite: true })) : []),
  ];
  const CHUNK = 40;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const records = [];
    for (const { item, overwrite } of todo.slice(i, i + CHUNK)) {
      const s = item.session;
      const windows = filterWindows(s.windows, s.originKey);
      if (countTabs(/** @type {any} */ (windows)) === 0) {
        summary.emptyAfterFilter++;
        continue;
      }
      const kind = s.kind === KIND.PREVIOUS || s.kind === KIND.CLOSED ? s.kind : KIND.SAVED;
      /** @type {any} */
      const rec = {
        id: overwrite ? item.match.id : s.id ?? newId(),
        kind: overwrite ? item.match.kind : kind,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt ?? Date.now(),
        windows,
        originKey: s.originKey,
        origin: s.origin,
      };
      const deletedAt = overwrite ? item.match.deletedAt : s.deletedAt;
      if (deletedAt) rec.deletedAt = deletedAt;
      records.push(rec);
      if (overwrite) summary.overwritten++;
      else summary.added++;
    }
    await db.putSessions(records, { touch: false });
    onProgress?.(Math.min(i + CHUNK, todo.length), todo.length);
  }

  // 3. Deletions that arrived with this import also apply to sessions that
  //    were already here (logged, so they can be undone).
  if (addedKeys.size) {
    const newGlobal = new Set();
    /** @type {Map<string, Set<string>>} */
    const newScoped = new Map();
    for (const t of batch.tombstones) {
      if (!addedKeys.has(db.tombstoneKey(t.scope, t.url, t.originKey))) continue;
      if (t.scope === 'global') newGlobal.add(t.url);
      else {
        let set = newScoped.get(t.originKey);
        if (!set) newScoped.set(t.originKey, (set = new Set()));
        set.add(t.url);
      }
    }
    const [metas, data] = await Promise.all([db.listMeta(), db.getAllData()]);
    const refs = [];
    // The imported tombstones responsible for these removals: recorded with the
    // log entry, so "put back" also lets the links be imported again.
    const usedKeys = new Set();
    for (const m of metas) {
      if (m.kind !== KIND.SAVED) continue;
      const scoped = m.originKey ? newScoped.get(m.originKey) : undefined;
      if (!newGlobal.size && !scoped) continue;
      for (const w of data.get(m.id) ?? []) {
        for (const t of w.tabs) {
          const c = canonicalize(t.url);
          const isGlobal = newGlobal.has(c);
          if (!isGlobal && !scoped?.has(c)) continue;
          refs.push({ sessionId: m.id, t: t.t });
          usedKeys.add(isGlobal ? db.tombstoneKey('global', c) : db.tombstoneKey('session', c, m.originKey));
        }
      }
    }
    if (refs.length) {
      const res = await removeTabs(refs, {
        label: `Applied imported deletions (${refs.length} links)`,
        recordKeys: [...usedKeys],
      });
      summary.tabsRemoved = res.removed;
    }
  }

  // 4. Dead-link verdicts: keep whichever is more recent.
  if (batch.checks.length) {
    summary.checksAdded = await db.putChecks(/** @type {any} */ (batch.checks), { onlyIfNewer: true });
  }

  // 5. The log of removed links (own backups): what was deleted, and from where.
  if (batch.removed.length) summary.removedLogAdded = await db.addUndoEntries(batch.removed);

  // 6. Settings (own backups only, and only when the caller wants them).
  if (batch.settings && applySettings) {
    await applySettings(batch.settings);
    summary.settingsRestored = true;
  }
  return summary;
}

#!/usr/bin/env node
// One-time migration helper for the retired firefox-session-analyzer.
//
// The sessions themselves are imported straight from the MySessions backup
// files. What only lives in the analyzer's SQLite database is the work done
// *in* the analyzer:
//   - tombstones  — links you deleted there
//   - link checks — cached dead-link verdicts
// This script writes both to a JSON file that Southpaw Sessions imports
// (Import → choose the file). The database is opened read-only.
//
//   node tools/export-analyzer-state.mjs [analyzer-repo-or-db] [output.json]
//
// Defaults: ../firefox-session-analyzer  ->  migration/analyzer-state.json
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../extension/lib/url.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(process.argv[2] ?? join(root, '..', 'firefox-session-analyzer'));
const outFile = resolve(process.argv[3] ?? join(root, 'migration', 'analyzer-state.json'));
const dbPath = existsSync(source) && statSync(source).isDirectory() ? join(source, 'data', 'sessions.db') : source;

if (!existsSync(dbPath)) {
  console.error(`No analyzer database at ${dbPath}`);
  process.exit(1);
}

/** Open the database read-only with whichever SQLite binding is available. */
async function openReadOnly(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
  } catch (builtinError) {
    // Older Node: borrow the analyzer's own better-sqlite3.
    try {
      const require = createRequire(join(dirname(dirname(path)), 'package.json'));
      const Database = require('better-sqlite3');
      const db = new Database(path, { readonly: true, fileMustExist: true });
      return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
    } catch {
      throw builtinError;
    }
  }
}

// SQLite datetime('now') is UTC, "YYYY-MM-DD HH:MM:SS".
const toMs = (stamp) => (stamp ? Date.parse(`${String(stamp).replace(' ', 'T')}Z`) || 0 : 0);

const db = await openReadOnly(dbPath);
try {
  // Southpaw keeps route fragments (#!…, #/…) that the analyzer dropped, so
  // re-derive each tombstone from the link's original URL where it is known.
  const tombRows = db.all(`
    SELECT t.url_canonical AS canonical, t.scope AS scope, t.folder_id AS folderId, t.created_at AS createdAt,
           l.url_original AS original, l.best_title AS title
    FROM tombstones t LEFT JOIN links l ON l.url_canonical = t.url_canonical
  `);
  const tombstones = tombRows.map((r) => {
    const t = { url: r.original ? canonicalize(r.original) : r.canonical, scope: r.scope, createdAt: toMs(r.createdAt) };
    if (r.scope === 'session' && r.folderId) t.originKey = `mysessions:${r.folderId}`;
    // Keep what the link was called, so it can still be recognised after deletion.
    if (r.title) t.title = r.title;
    if (r.original) t.original = r.original;
    return t;
  }).filter((t) => t.scope === 'global' || t.originKey);

  const checkRows = db.all(`
    SELECT l.url_original AS original, l.url_canonical AS canonical, lc.status AS status,
           lc.http_code AS httpCode, lc.detail AS detail, lc.checked_at AS checkedAt
    FROM link_checks lc JOIN links l ON l.id = lc.link_id
  `);
  const checks = checkRows.map((r) => {
    const c = { url: r.original ? canonicalize(r.original) : r.canonical, status: r.status, checkedAt: toMs(r.checkedAt) };
    if (r.httpCode != null) c.httpCode = r.httpCode;
    if (r.detail) c.detail = r.detail;
    return c;
  });

  const byStatus = {};
  for (const c of checks) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({
    format: 'southpaw-analyzer-state',
    version: 1,
    exportedAt: new Date().toISOString(),
    tombstones,
    checks,
  }));

  console.log(`Read   ${dbPath}`);
  console.log(`Wrote  ${outFile}`);
  console.log(`  ${tombstones.length} deleted-link record(s), ${tombstones.filter((t) => t.title).length} with their title`);
  console.log(`  ${checks.length} dead-link verdict(s): ${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  console.log('\nIn Southpaw Sessions: Import → Choose files… → pick this file');
  console.log('(before or after importing your sessions — the order does not matter).');
} finally {
  db.close();
}

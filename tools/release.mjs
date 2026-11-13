#!/usr/bin/env node
// Publish a signed .xpi (made by sign.bat) as a GitHub release and add it to
// updates.json, so installed copies of the extension update themselves.
//
//   node tools/release.mjs [--dry-run]
//
// Steps: find dist/*-<version>.xpi for the version in extension/manifest.json,
// copy it to dist/southpaw-sessions-<version>.xpi, create GitHub release
// v<version> with it attached (gh CLI), add the version to updates.json, commit
// only updates.json and push. Firefox checks updates.json (the manifest's
// update_url) about once a day.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = 'greatgreatasset/southpaw-sessions';
export const SLUG = 'southpaw-sessions';
const BRANCH = 'master';

/**
 * Work out what a release of the current manifest version consists of. Pure —
 * no file or network access.
 * @param {{manifest: any, updates: any, distFiles: string[]}} input
 * @returns {{version: string, tag: string, addonId: string, source: string | null,
 *            xpiName: string, link: string, updates: any, alreadyListed: boolean}}
 */
export function planRelease({ manifest, updates, distFiles }) {
  const version = manifest.version;
  const addonId = manifest.browser_specific_settings.gecko.id;
  const xpiName = `${SLUG}-${version}.xpi`;
  const tag = `v${version}`;
  const link = `https://github.com/${REPO}/releases/download/${tag}/${xpiName}`;

  // web-ext names the signed file "<something>-<version>.xpi"; prefer that over
  // a copy made by an earlier run of this script.
  const signed = distFiles.filter((f) => f.endsWith(`-${version}.xpi`)).sort();
  const source = signed.find((f) => f !== xpiName) ?? signed[0] ?? null;

  const next = JSON.parse(JSON.stringify(updates ?? {}));
  next.addons ??= {};
  next.addons[addonId] ??= {};
  const entries = (next.addons[addonId].updates ??= []);
  const alreadyListed = entries.some((e) => e.version === version);
  if (!alreadyListed) entries.push({ version, update_link: link });
  return { version, tag, addonId, source, xpiName, link, updates: next, alreadyListed };
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const dryRun = process.argv.includes('--dry-run');
  const run = (cmd, args, { check = true } = {}) => {
    try {
      execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      return true;
    } catch (e) {
      if (!check) return false;
      console.error(`!! ${cmd} ${args.slice(0, 2).join(' ')} failed:\n${String(e.stderr ?? e.message).trim()}`);
      process.exit(1);
    }
  };

  const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  const updatesPath = join(root, 'updates.json');
  const updates = existsSync(updatesPath) ? JSON.parse(readFileSync(updatesPath, 'utf8')) : { addons: {} };
  const dist = join(root, 'dist');
  const distFiles = existsSync(dist) ? readdirSync(dist) : [];
  const plan = planRelease({ manifest, updates, distFiles });

  if (!plan.source) {
    console.error(`!! No signed .xpi for version ${plan.version} in dist\\ - run sign.bat first.`);
    process.exit(1);
  }
  const xpi = join(dist, plan.xpiName);
  if (plan.source !== plan.xpiName) copyFileSync(join(dist, plan.source), xpi);

  if (plan.alreadyListed) console.log(`updates.json already lists ${plan.version}.`);
  writeFileSync(updatesPath, `${JSON.stringify(plan.updates, null, 1)}\n`);
  if (dryRun) {
    console.log(`[dry run] ${plan.xpiName} -> ${plan.link}`);
    return;
  }

  if (run('gh', ['release', 'view', plan.tag, '-R', REPO], { check: false })) {
    console.log(`Release ${plan.tag} already exists; not uploading again.`);
  } else {
    run('gh', ['release', 'create', plan.tag, xpi, '-R', REPO, '--title', `Southpaw Sessions ${plan.version}`,
      '--notes', 'Signed Firefox add-on. Open the .xpi in Firefox to install; installed copies update automatically.']);
    console.log(`Created release ${plan.tag} with ${plan.xpiName}`);
  }

  run('git', ['add', '--', 'updates.json']);
  // `git diff --cached --quiet` exits non-zero when there is something to commit.
  if (!run('git', ['diff', '--cached', '--quiet', '--', 'updates.json'], { check: false })) {
    run('git', ['commit', '-q', '-m', `updates.json: extension ${plan.version}`, '--', 'updates.json']);
  }
  if (!run('git', ['push', '-q', 'origin', BRANCH], { check: false })) {
    console.error('!! Push failed (updates.json is committed locally). Run "git push origin master" and installed copies will see the update.');
    process.exit(1);
  }
  console.log(`Published: https://github.com/${REPO}/releases/tag/${plan.tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

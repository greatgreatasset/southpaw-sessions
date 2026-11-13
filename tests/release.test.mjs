// The release planner behind tools/release.mjs (no git, gh or network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPO, planRelease } from '../tools/release.mjs';

const manifest = { version: '1.2.0', browser_specific_settings: { gecko: { id: 'addon@example.test' } } };

test('plans a first release', () => {
  const plan = planRelease({ manifest, updates: { addons: {} }, distFiles: ['a1b2c3-1.2.0.xpi', 'southpaw_sessions-1.2.0.zip', 'old-1.1.0.xpi'] });
  assert.equal(plan.tag, 'v1.2.0');
  assert.equal(plan.source, 'a1b2c3-1.2.0.xpi', 'picks the signed file for this version, not the zip or an older xpi');
  assert.equal(plan.xpiName, 'southpaw-sessions-1.2.0.xpi');
  assert.equal(plan.link, `https://github.com/${REPO}/releases/download/v1.2.0/southpaw-sessions-1.2.0.xpi`);
  assert.equal(plan.alreadyListed, false);
  assert.deepEqual(plan.updates, { addons: { 'addon@example.test': { updates: [{ version: '1.2.0', update_link: plan.link }] } } });
});

test('keeps earlier versions and never lists one twice', () => {
  const updates = { addons: { 'addon@example.test': { updates: [{ version: '1.1.0', update_link: 'x' }] } } };
  const first = planRelease({ manifest, updates, distFiles: ['southpaw-sessions-1.2.0.xpi', 'zz-1.2.0.xpi'] });
  assert.equal(first.source, 'zz-1.2.0.xpi', 'prefers the freshly signed file over an earlier copy');
  assert.deepEqual(first.updates.addons['addon@example.test'].updates.map((e) => e.version), ['1.1.0', '1.2.0']);
  assert.deepEqual(updates.addons['addon@example.test'].updates.length, 1, 'the input is not modified');

  const again = planRelease({ manifest, updates: first.updates, distFiles: ['southpaw-sessions-1.2.0.xpi'] });
  assert.equal(again.alreadyListed, true);
  assert.equal(again.source, 'southpaw-sessions-1.2.0.xpi');
  assert.equal(again.updates.addons['addon@example.test'].updates.length, 2);
});

test('reports a missing signed file', () => {
  assert.equal(planRelease({ manifest, updates: null, distFiles: ['other-1.1.0.xpi'] }).source, null);
});

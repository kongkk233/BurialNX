import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { acceptHost } from '../tools/accept-host.mjs';
import { acceptPackage } from '../tools/accept-package.mjs';
import { validateProfileFile } from '../tools/validate-profile.mjs';
import { checkPort, safeRelative } from '../tools/check-port.mjs';
import { profileApi } from '../tools/validate-profile.mjs';

const fixture = resolve('tests/fixtures/neutral-mv/www');
const modFixture = resolve('tests/fixtures/neutral-mv/mod');
const genericFixture = resolve('tests/fixtures/generic-mv/www');

test('port checker validates the neutral fixture and records ordered scripts', async () => {
  const result = await checkPort({ gameRoot: fixture, modRoot: null, profile: null, manifest: null });
  assert.equal(result.status, 'pass');
  assert.equal(result.profile.id, 'neutral-mv');
  assert.deepEqual(result.scriptGraph.paths, ['js/rpg_core.js', 'js/main.js']);
  assert.equal(result.contracts.entryScript.status, 'pass');
});

test('generic package acceptance does not execute game scripts or require neutral markers', async () => {
  const result = await acceptPackage({ gameRoot: genericFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, false);
  assert.equal(result.runtimeBehavior, 'not-observed');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/main.js']);
  assert.match(result.evidence.save.roundTrip, /profile-saves\/file1\.generic$/);
});

test('host acceptance executes media, save, and rollback behavior', async () => {
  const result = await acceptHost({ gameRoot: fixture });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.checks, {
    profile: 'pass',
    entry: 'pass',
    scriptGraph: 'pass',
    assetPaths: 'pass',
    mediaPolicy: 'pass',
    saveContract: 'pass',
    lifecycle: 'pass',
    rollback: 'pass',
  });
  assert.match(result.evidence.media.extensionFallback, /fallback\.webm/);
  assert.match(result.evidence.save.roundTrip, new RegExp(`file1\\${result.evidence.save.contract.extension} `));
});

test('host acceptance proves mod-first profile, asset, media, and script overlay', async () => {
  const result = await acceptHost({ gameRoot: fixture, modRoot: modFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.evidence.profileId, 'neutral-mv-mod');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/mod.js', 'js/main.js']);
  assert.equal(result.evidence.overlay.profile, 'mod-first');
  assert.match(result.evidence.overlay.media, /variant-mod\.webm/);
  assert.match(result.evidence.save.roundTrip, /file1\.modsave/);
});

test('port checker path helper rejects traversal and external URLs', () => {
  assert.equal(safeRelative('data/Map001.json'), 'data/Map001.json');
  assert.equal(safeRelative('img/README%2Etxt'), 'img/README.txt');
  assert.equal(safeRelative('../outside'), null);
  assert.equal(safeRelative('https://example.invalid/file'), null);
  assert.equal(safeRelative('/absolute/file'), null);
});

test('profile CLI applies the canonical JSON Schema and production parser', async () => {
  const result = await validateProfileFile(resolve('profiles/examples/minimal-mv.json'));
  assert.equal(result.profile.id, 'minimal-mv');
  assert.equal(result.profile.entry.script, 'js/main.js');
});

test('profile CLI uses the production parser for invalid profiles', async () => {
  const { defaultPortProfile, parsePortProfile } = await profileApi();
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, entry: { html: '../outside' } }), /relative path/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, entry: undefined }), /\$\.entry/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acceptHost } from '../tools/accept-host.mjs';
import { verifyRuntimeProvenance } from '../tools/verify-runtime-provenance.mjs';
import { validateBrowserReport } from '../tools/browser-report.mjs';
import { validateProfileDocument } from '../tools/profile-schema.mjs';
import { acceptPackage } from '../tools/accept-package.mjs';
import { acceptPackageRuntime } from '../tools/accept-package-runtime.mjs';
import { validateProfileFile } from '../tools/validate-profile.mjs';
import { checkPort, safeRelative } from '../tools/check-port.mjs';
import { profileApi } from '../tools/validate-profile.mjs';

const fixture = resolve('tests/fixtures/neutral-mv/www');
const modFixture = resolve('tests/fixtures/neutral-mv/mod');
const genericFixture = resolve('tests/fixtures/generic-mv/www');
const genericModFixture = resolve('tests/fixtures/generic-mv/mod');

test('port checker validates the neutral fixture and records ordered scripts', async () => {
  const result = await checkPort({ gameRoot: fixture, modRoot: null, profile: null, manifest: null });
  assert.equal(result.status, 'pass');
  assert.equal(result.profile.id, 'neutral-mv');
  assert.deepEqual(result.scriptGraph.paths, ['js/rpg_core.js', 'js/main.js']);
  assert.equal(result.contracts.entryScript.status, 'pass');
  assert.deepEqual(result.contracts.classification, {
    enforced: ['entry.html', 'scriptGraph', 'asset.pathSafety', 'media.policy', 'save.contract'],
    validatedOnly: ['entry.script'],
    metadataOnly: ['runtime.version', 'compat.mv', 'compat.nwjs', 'package.name', 'package.version'],
    notObserved: ['targetGameRuntime', 'nativeDecoder', 'switchHardware'],
  });
});

test('generic package acceptance does not execute game scripts or require neutral markers', async () => {
  const result = await acceptPackage({ gameRoot: genericFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, false);
  assert.equal(result.runtimeBehavior, 'not-observed');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/main.js']);
  assert.match(result.evidence.save.roundTrip, /profile-saves\/file1\.generic$/);
});

test('generic package runtime acceptance executes scripts without neutral markers', async () => {
  const result = await acceptPackageRuntime({ gameRoot: genericFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, true);
  assert.equal(result.runtimeBehavior, 'observed');
  assert.equal(result.evidence.neutralMarkerRequired, false);
  assert.equal(result.evidence.startup, 'scene-boot');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/main.js']);
});

test('generic package acceptance keeps mod-first profile precedence without executing scripts', async () => {
  const result = await acceptPackage({ gameRoot: genericFixture, modRoot: genericModFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, false);
  assert.equal(result.runtimeBehavior, 'not-observed');
  assert.equal(result.evidence.profileId, 'generic-mv-mod');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/mod.js', 'js/main.js']);
  assert.match(result.evidence.save.roundTrip, /profile-saves\/file1\.modgeneric$/);
});

test('runtime provenance recomputes repository file claims and exposes external boundaries', async () => {
  const result = await verifyRuntimeProvenance({ project: resolve('.') });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.verified.map(claim => claim.claim), [
    'runtime.patchSha256',
    'runtime.timelinePatchSha256',
    'runtime.prerollGzipSha256',
  ]);
  assert.ok(result.verified.every(claim => claim.status === 'pass'));
  assert.ok(result.unverified.length > 0);
  assert.ok(result.unverified.every(claim => claim.status === 'not-verified'));
});

test('runtime provenance rejects a tampered claim without changing the repository', async () => {
  const temporary = await mkdtemp(resolve('.test-provenance-'));
  try {
    await mkdir(join(temporary, 'runtime'), { recursive: true });
    await mkdir(join(temporary, 'patches'), { recursive: true });
    for (const file of [
      'runtime/manifest.json',
      'runtime/nxjs-preroll.nro-code.gz',
      'patches/nxjs-video-audio-preroll.patch',
      'patches/nxjs-video-track-timeline.patch',
    ]) {
      const destination = join(temporary, file);
      await cp(resolve(file), destination);
    }
    const manifestPath = join(temporary, 'runtime/manifest.json');
    const manifest = JSON.parse((await readFile(manifestPath)).toString('utf8'));
    manifest.patchSha256 = '0'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      verifyRuntimeProvenance({ project: temporary }),
      /runtime\.patchSha256 mismatch/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('browser report validation binds desktop media evidence to a clean commit', () => {
  const result = file => ({
    file,
    callbacks: { ready: 1, ends: 1 },
    sampledFrames: 240,
    distinctFrames: 70,
    peakPcmRms: 0.14,
    flashCount: 4,
    toneCount: 4,
    pulseOffsetsMs: [12, 20, 39],
  });
  const report = {
    schema: 1,
    status: 'pass',
    tool: 'test:movie:browser',
    scope: 'desktop-browser-media',
    gitCommit: 'a'.repeat(40),
    gitDirty: false,
    environment: { mode: 'desktop-browser', browser: 'Chromium test', switch: 'not-available', hardware: 'not-verified' },
    fixtures: ['tests/fixtures/cg/www/movies/sync.mp4', 'tests/fixtures/cg/www/movies/sync.webm'],
    results: [result('sync.mp4'), result('sync.webm')],
  };
  assert.equal(validateBrowserReport(report, { expectedCommit: 'a'.repeat(40), requirePass: true }), report);
  assert.throws(() => validateBrowserReport({ ...report, gitCommit: 'b'.repeat(40) }, { expectedCommit: 'a'.repeat(40), requirePass: true }), /gitCommit/);
  assert.throws(() => validateBrowserReport({ ...report, results: [result('sync.mp4'), { ...result('sync.webm'), pulseOffsetsMs: [200, 0, 0] }] }, { requirePass: true }), /pulse offset/);
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

test('port checker rejects package files that escape through symlinks', async () => {
  const temporary = await mkdtemp(resolve('.test-symlink-'));
  try {
    const game = join(temporary, 'www');
    await cp(genericFixture, game, { recursive: true });
    const outside = join(temporary, 'outside.js');
    await writeFile(outside, '/* outside */\n');
    await rm(join(game, 'js/main.js'));
    await symlink(outside, join(game, 'js/main.js'));
    await assert.rejects(
      checkPort({ gameRoot: game, modRoot: null, profile: null, manifest: null }),
      /symlink/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('profile CLI applies the canonical JSON Schema and production parser', async () => {
  const result = await validateProfileFile(resolve('profiles/examples/minimal-mv.json'));
  assert.equal(result.profile.id, 'minimal-mv');
  assert.equal(result.profile.entry.script, 'js/main.js');
});

test('profile schema validation rejects cross-field envelope offsets', async () => {
  const valid = JSON.parse((await readFile(resolve('profiles/examples/minimal-mv.json'))).toString('utf8'));
  valid.assets = { hashedLookup: false, envelope: { magic: 'BNXENC', headerBytes: 7, lengthByteOffset: 7, algorithm: 'basename-xor-v1' } };
  assert.throws(() => validateProfileDocument(valid), /lengthByteOffset.*smaller than headerBytes/);
});

test('profile CLI uses the production parser for invalid profiles', async () => {
  const { defaultPortProfile, parsePortProfile } = await profileApi();
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, entry: { html: '../outside' } }), /relative path/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, entry: undefined }), /\$\.entry/);
});

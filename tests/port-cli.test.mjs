import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { cp, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptExternalRuntime, parseArgs, versionMatches } from '../tools/accept-external-runtime.mjs';
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
  assert.deepEqual(result.contracts.compatibility, { status: 'pass', mv: true, node: true, nwjs: true, appliedAt: 'game-launch' });
  assert.deepEqual(result.contracts.classification, {
    enforced: ['entry.html', 'scriptGraph', 'asset.pathSafety', 'media.policy', 'save.contract', 'compatibility.flags'],
    validatedOnly: ['entry.script'],
    metadataOnly: ['runtime.kind', 'runtime.version', 'package.name', 'package.version'],
    notObserved: ['targetGameRuntime', 'nativeDecoder', 'switchHardware'],
  });
});

test('port checker verifies an explicitly declared package manifest identity', async () => {
  const temporary = await mkdtemp(resolve('.test-package-manifest-'));
  try {
    const gameRoot = join(temporary, 'www');
    await cp(genericFixture, gameRoot, { recursive: true });
    const profile = JSON.parse((await readFile(join(gameRoot, 'burialnx.port.json'))).toString('utf8'));
    profile.package.manifest = 'package.json';
    const profilePath = join(temporary, 'profile.json');
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    await writeFile(join(gameRoot, 'package.json'), `${JSON.stringify({ name: profile.package.name, version: profile.package.version })}\n`);

    const result = await checkPort({ gameRoot, modRoot: null, profile: profilePath, manifest: null });
    assert.equal(result.contracts.package.status, 'pass');
    assert.equal(result.contracts.package.identity, 'verified');
    assert.equal(result.contracts.package.manifest.path, 'package.json');
    assert.equal(result.contracts.package.manifest.root, 'game');
    assert.equal(result.contracts.package.manifest.bytes, Buffer.byteLength(JSON.stringify({ name: profile.package.name, version: profile.package.version }) + '\n'));
    assert.match(result.contracts.package.manifest.sha256, /^[0-9a-f]{64}$/);
    assert.equal(result.contracts.package.manifest.name, profile.package.name);
    assert.equal(result.contracts.package.manifest.version, profile.package.version);
    assert.deepEqual(result.contracts.classification, {
      enforced: ['entry.html', 'scriptGraph', 'asset.pathSafety', 'media.policy', 'save.contract', 'compatibility.flags', 'package.manifest', 'package.name', 'package.version'],
      validatedOnly: ['entry.script'],
      metadataOnly: ['runtime.kind', 'runtime.version'],
      notObserved: ['targetGameRuntime', 'nativeDecoder', 'switchHardware'],
    });

    await writeFile(join(gameRoot, 'package.json'), JSON.stringify({ name: profile.package.name, version: '9.9.9' }));
    await assert.rejects(
      checkPort({ gameRoot, modRoot: null, profile: profilePath, manifest: null }),
      /package manifest version mismatch/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('generic package acceptance does not execute game scripts or require neutral markers', async () => {
  const result = await acceptPackage({ gameRoot: genericFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, false);
  assert.equal(result.runtimeBehavior, 'not-observed');
  assert.equal(result.checks.entryScript, 'validated-only');
  assert.equal(result.checks.sessionCleanup, 'pass');
  assert.equal(result.checks.lifecycle, 'pass');
  assert.deepEqual(result.evidence.lifecycle, {
    status: 'pass',
    scope: 'host-lifecycle-control-flow',
    execution: 'synthetic-switch-control-flow',
    wake: { gameLive: true, saveAttempted: true, saveSucceeded: true, markerAttempted: true, markerWritten: true, chainReload: 'launched' },
    teardown: { hadSession: true, trackedTimeouts: 1, trackedIntervals: 1, timeoutCancelFailures: 0, intervalCancelFailures: 0, patchRestoreFailures: 0 },
    switchHardware: 'not-verified',
    externalRuntime: 'not-verified',
  });
  assert.equal(result.checks.nodeCompat, 'pass');
  assert.deepEqual(result.evidence.nodeCompat, {
    status: 'pass',
    scope: 'host-shim-contract',
    execution: 'shim-probe-only',
    appRootBoundary: { status: 'enforced', outsidePath: 'EPERM' },
    overlay: { write: 'overlay-only', rename: 'native-overlay-only', replacement: 'overlay-only', packagedSource: 'EPERM' },
    nativeRename: { required: true, unavailable: 'ENOSYS', failedRenamePreservesSource: true },
    switchHardware: 'not-verified',
    externalRuntime: 'not-verified',
  });
  assert.deepEqual(result.evidence.sessionCleanup, {
    trackedTimeouts: 1,
    trackedIntervals: 1,
    timeoutCancelAttempts: 1,
    intervalCancelAttempts: 1,
    timeoutCancelFailures: 0,
    intervalCancelFailures: 0,
    patchRestoreFailures: 0,
  });
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/main.js']);
  assert.deepEqual(result.evidence.entryScript, {
    declared: 'js/main.js',
    graph: { status: 'pass', path: 'js/main.js', index: 1 },
    execution: { status: 'not-observed', observed: false, index: null },
  });
  assert.match(result.evidence.save.roundTrip, /profile-saves\/file1\.generic$/);
});

test('generic package runtime acceptance executes scripts without neutral markers', async () => {
  const result = await acceptPackageRuntime({ gameRoot: genericFixture });
  assert.equal(result.status, 'pass');
  assert.equal(result.executedGameScripts, true);
  assert.equal(result.runtimeBehavior, 'observed');
  assert.equal(result.checks.entryScript, 'pass');
  assert.deepEqual(result.declaredRuntime, { kind: 'nwjs', version: 'fixture' });
  assert.equal(result.actualExecution.mode, 'host-runtime');
  assert.equal(result.actualExecution.engine, 'vm-host-fixture');
  assert.equal(result.actualExecution.version, process.version);
  assert.equal(result.actualExecution.status, 'observed');
  assert.equal(result.actualExecution.externalRuntime.kind, 'nwjs');
  assert.equal(result.actualExecution.externalRuntime.version, 'fixture');
  assert.equal(result.actualExecution.externalRuntime.status, 'not-verified');
  assert.match(result.actualExecution.externalRuntime.reason, /no external runtime process was launched or version-verified/);
  assert.notEqual(result.actualExecution.externalRuntime.status, 'verified');
  assert.deepEqual(result.evidence.entryScript, {
    declared: 'js/main.js',
    graph: { status: 'pass', path: 'js/main.js', index: 1 },
    execution: { status: 'observed', observed: true, index: 1 },
  });
  assert.equal(result.evidence.neutralMarkerRequired, false);
  assert.equal(result.evidence.startup, 'scene-boot');
  assert.deepEqual(result.evidence.scripts, ['js/rpg_core.js', 'js/main.js']);
});

test('external runtime acceptance stays not-verified without an explicit executable', async () => {
  const before = await readFile(join(genericFixture, 'index.html'));
  const result = await acceptExternalRuntime({ gameRoot: genericFixture });
  assert.equal(result.status, 'not-verified');
  assert.equal(result.scope, 'external-runtime-identity');
  assert.equal(result.execution, 'not-run');
  assert.equal(result.reason, 'no external runtime executable was supplied');
  assert.equal(result.declaredRuntime.kind, 'nwjs');
  assert.equal(result.package.gameScriptsExecuted, false);
  assert.equal(result.package.bindingSource, 'host-port-check');
  assert.equal(result.package.probeBinding, 'not-run');
  assert.equal(result.switchRuntime, 'not-verified');
  assert.equal(result.hardware, 'not-verified');
  assert.deepEqual(await readFile(join(genericFixture, 'index.html')), before);
});

test('external runtime acceptance validates a nonce-bound external process handshake', async () => {
  const temporary = await mkdtemp(resolve('.test-external-runtime-'));
  try {
    const sentinelBefore = await readFile(join(genericFixture, 'js/rpg_core.js'));
    const runtime = join(temporary, 'synthetic-nwjs-runtime');
    writeFileSync(runtime, '# synthetic executable\n');
    await chmod(runtime, 0o755);
    const runtimeSha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
    const result = await acceptExternalRuntime({
      runtime,
      gameRoot: genericFixture,
      spawnImpl(command, args) {
        const child = new EventEmitter();
        const config = JSON.parse(readFileSync(join(args[0], 'burialnx-external-runtime-probe.json'), 'utf8'));
        setImmediate(() => {
          writeFileSync(config.resultPath, `${JSON.stringify({
            schema: 1,
            nonce: config.nonce,
            probeLoaded: true,
            observedRuntime: {
              kind: 'nwjs',
              version: 'fixture',
              processVersions: { nw: 'fixture', node: 'synthetic' },
              execPath: command,
              executableSha256: runtimeSha256,
              nwGlobal: true,
            },
            packageBindingSha256: config.packageBindingSha256,
            gameScriptsExecuted: false,
          })}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.execution, 'injected-process-test');
    assert.equal(result.scope, 'external-runtime-identity');
    assert.equal(result.observedRuntime.kind, 'nwjs');
    assert.equal(result.observedRuntime.version, 'fixture');
    assert.equal(result.observedRuntime.versionMatch, 'exact');
    assert.equal(result.package.gameScriptsExecuted, false);
    assert.equal(result.package.bindingSource, 'host-port-check');
    assert.equal(result.package.probeBinding, 'host-provided-echo');
    assert.equal(result.hardware, 'not-verified');
    assert.equal(result.commercialGame, 'not-verified');
    assert.match(result.probe.nonce, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await readFile(join(genericFixture, 'js/rpg_core.js')), sentinelBefore);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('external runtime acceptance fails closed on nonce, kind, version, and timeout failures', async () => {
  const temporary = await mkdtemp(resolve('.test-external-runtime-'));
  try {
    const runtime = join(temporary, 'synthetic-nwjs-runtime');
    writeFileSync(runtime, '# synthetic executable\n');
    await chmod(runtime, 0o755);
    const runtimeSha256 = createHash('sha256').update(readFileSync(runtime)).digest('hex');
    const runWith = async (mode, expected) => {
      await assert.rejects(
        acceptExternalRuntime({
          runtime,
          gameRoot: genericFixture,
          timeoutMs: 100,
          spawnImpl(command, args) {
            const child = new EventEmitter();
            const config = JSON.parse(readFileSync(join(args[0], 'burialnx-external-runtime-probe.json'), 'utf8'));
            if (mode === 'timeout') return child;
            setImmediate(() => {
              writeFileSync(config.resultPath, `${JSON.stringify({
                schema: 1,
                nonce: mode === 'nonce' ? 'wrong-nonce' : config.nonce,
                probeLoaded: true,
                observedRuntime: {
                  kind: mode === 'kind' ? 'browser' : 'nwjs',
                  version: mode === 'version' ? '0.29.7' : 'fixture',
                  processVersions: { nw: mode === 'process-version' || mode === 'version' ? '0.29.7' : 'fixture' },
                  execPath: command,
                  executableSha256: runtimeSha256,
                  nwGlobal: true,
                },
                packageBindingSha256: config.packageBindingSha256,
                gameScriptsExecuted: false,
              })}\n`);
              if (mode === 'exit-close') {
                child.emit('exit', 0, null);
                setTimeout(() => child.emit('close', 1, null), 0);
              } else child.emit('close', 0, null);
            });
            return child;
          },
        }),
        expected,
      );
    };
    await runWith('nonce', /nonce mismatch/);
    await runWith('kind', /did not identify itself as NW\.js/);
    await runWith('process-version', /process\.versions\.nw/);
    await runWith('version', /version mismatch/);
    await runWith('exit-close', /exited unsuccessfully/);
    await runWith('timeout', /timed out/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('external runtime CLI rejects missing option values instead of downgrading them to not-verified', () => {
  assert.throws(() => parseArgs(['--runtime']), /--runtime requires a value/);
  assert.throws(() => parseArgs(['--timeout-ms', '--report', 'out.json']), /--timeout-ms requires a value/);
});

test('external runtime acceptance rejects unavailable executables and ambiguous versions', async () => {
  await assert.rejects(
    acceptExternalRuntime({ gameRoot: genericFixture, runtime: resolve('.test-external-runtime-missing') }),
    /not accessible/,
  );
  assert.deepEqual(versionMatches('0.29.x', '0.29.7'), { matched: true, mode: 'explicit-pattern' });
  assert.deepEqual(versionMatches('0.29', '0.29.7'), { matched: false, mode: 'mismatch' });
  assert.deepEqual(versionMatches('0.29.7', '0.29.7'), { matched: true, mode: 'exact' });
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
    'runtime.fixedExecutableSha256',
    'runtime.armElfBuildId',
    'runtime.distributedArtifactGitBlobSha1',
  ]);
  assert.equal(result.verified.find(claim => claim.claim === 'runtime.fixedExecutableSha256').actualSha256, 'd19416181cc10974ac8b44f902fb0232f032f78e38021f7dbce1dcc3c2834cb6');
  assert.equal(result.verified.find(claim => claim.claim === 'runtime.armElfBuildId').actualBuildId, 'a7fa807f9fe38328a28c9573fc1d7ddb530c5fc1');
  assert.equal(result.verified.at(-1).actualSha1, 'd58651b6478db5ab4a90a2b8c3482b0efdc26102');
  assert.ok(result.unverified.some(claim => claim.claim === 'runtime.historicalPackageEvidence'));
  assert.ok(result.unverified.some(claim => claim.claim === 'runtime.distributedArtifactSourceCommit'));
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPortProfile, loadPortProfile, loadPortProfileFromRoots, loadPortProfileFromRootsSync, mediaPolicyFromProfile, parsePortProfile } from '../src/port-profile';
import { PatchRegistry } from '../src/patch-registry';
import { atomicWrite, atomicWriteSync, atomicWriteSyncIfSupported } from '../src/atomic-persistence';
import { beginGameSession, currentGamePatches, endGameSession, patchSessionMethod, snapshotSessionObject } from '../src/game-session';
import { teardownGame } from '../src/game-lifecycle';
import { handleWake, getLastSleepRecoveryReport, installSleepAutoload, SLEEP_MARKER_PATH, SLEEP_SAVE_PATH } from '../src/sleep-recovery';
import { S } from '../src/state';
import { createMovieResolver } from '../src/video-source';
import { gameAssetNames, gameAssets, unpackGameAsset } from '../src/game-assets';
import { saveLibrary } from '../src/game-library';
import { DEFAULT_KEYMAP, saveKeyMap } from '../src/keymap';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

test('port profile validates, defaults media policy, and gives readable errors', () => {
  const profile = parsePortProfile(defaultPortProfile);
  assert.deepEqual(profile.media.variantFallback, ['-l']);
  assert.equal(profile.assets.hashedLookup, true);
  assert.equal(profile.entry.html, 'index.html');
  const envelope = parsePortProfile({ ...defaultPortProfile, assets: { hashedLookup: false, envelope: { magic: 'BNXENC', headerBytes: 7, lengthByteOffset: 6, algorithm: 'basename-xor-v1' } } });
  assert.equal(envelope.assets.hashedLookup, false);
  assert.equal(envelope.assets.envelope?.algorithm, 'basename-xor-v1');
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, assets: { envelope: { magic: 'BNXENC', headerBytes: 7, lengthByteOffset: 7, algorithm: 'basename-xor-v1' } } }), /lengthByteOffset/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, version: 2 }), /\$\.version/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, media: { variantFallback: ['../x'] } }), /safe filename variants/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, entry: { html: '../outside.html' } }), /relative path/);
  assert.throws(() => parsePortProfile({ ...defaultPortProfile, save: { directory: 'save', extension: '/tmp' } }), /safe file extensions/);
});

test('profile-controlled asset lookup and envelopes stay generic and in-memory', async () => {
  const policy = { magic: 'BNXENC', headerBytes: 7, lengthByteOffset: 6, algorithm: 'basename-xor-v1' as const };
  const path = 'img/picture.png';
  const plain = Uint8Array.from([9, 8, 7, 6]);
  const wrap = (keyPath: string) => {
    const encoded = new Uint8Array(plain.length);
    let key = 0;
    for (const c of keyPath.split('/').pop()!.toUpperCase()) key = ((key << 1) ^ c.charCodeAt(0)) & 255;
    key = (key + 1) & 255;
    for (let i = 0; i < plain.length; i++) { encoded[i] = plain[i] ^ key; key = ((key << 1) ^ encoded[i]) & 255; }
    const wrapped = new Uint8Array(7 + encoded.length);
    wrapped.set(new TextEncoder().encode('BNXENC'));
    wrapped[6] = encoded.length;
    wrapped.set(encoded, 7);
    return wrapped.buffer;
  };
  const wrapped = wrap(path);
  assert.deepEqual([...new Uint8Array(unpackGameAsset(wrapped, path, policy))], [...plain]);
  const hashed = (await gameAssetNames(path)).at(-1)!;
  const files = new Map([[`sdmc:/game/${hashed}`, wrap(hashed)]]);
  const disk = { read: async (name: string) => files.get(name) ?? null };
  assert.equal(await gameAssets('sdmc:/game', null, disk, 1024, { hashedLookup: false, envelope: policy }).read(path), null);
  assert.deepEqual([...new Uint8Array((await gameAssets('sdmc:/game', null, disk, 1024, { hashedLookup: true, envelope: policy }).read(path))!)], [...plain]);
});

test('port profile loading keeps the default when optional file is absent', async () => {
  const missing = await loadPortProfile({ async read() { return null; } });
  assert.equal(missing.source, 'default');
  assert.equal(missing.profile.entry.html, 'index.html');
  const loaded = await loadPortProfile({ async read(path) {
    assert.equal(path, 'burialnx.port.json');
    return json({ ...defaultPortProfile, id: 'fixture-port', entry: { html: 'game.html' } });
  } });
  assert.equal(loaded.source, 'burialnx.port.json');
  assert.equal(loaded.profile.id, 'fixture-port');
  assert.equal(loaded.profile.entry.html, 'game.html');
  await assert.rejects(loadPortProfile({ async read() { return new TextEncoder().encode('{bad').buffer; } }), /Invalid port profile/);
});

test('profile control files use mod-first overlay precedence without asset probing', async () => {
  const reads: string[] = [];
  const mod = { ...defaultPortProfile, id: 'mod-profile', entry: { html: 'mod-entry.html' } };
  const game = { ...defaultPortProfile, id: 'game-profile', entry: { html: 'game-entry.html' } };
  const files = new Map([
    ['sdmc:/game/burialnx.port.json', json(game)],
    ['sdmc:/mod/burialnx.port.json', json(mod)],
  ]);
  const loaded = await loadPortProfileFromRoots(['sdmc:/mod/', 'sdmc:/game/'], (path) => {
    reads.push(path);
    return files.get(path) ?? null;
  });
  assert.equal(loaded.profile.id, 'mod-profile');
  assert.deepEqual(reads, ['sdmc:/mod/burialnx.port.json']);
  const syncLoaded = loadPortProfileFromRootsSync(['sdmc:/mod/', 'sdmc:/game/'], (path) => files.get(path) ?? null);
  assert.equal(syncLoaded.profile.id, 'mod-profile');
});

test('profile-selected entry HTML is read as a normal safe asset path', async () => {
  const profile = parsePortProfile({ ...defaultPortProfile, entry: { html: 'boot/main.html' } });
  const expected = new TextEncoder().encode('<script src="js/main.js"></script>').buffer;
  const disk = { async read(path: string) { return path === `sdmc:/game/${profile.entry.html}` ? expected : null; } };
  const assets = gameAssets('sdmc:/game', null, disk, 1024, { hashedLookup: false });
  assert.deepEqual(new Uint8Array((await assets.read(profile.entry.html))!), new Uint8Array(expected));
  assert.equal(await assets.read('index.html'), null);
});

test('patch registry replaces and restores session patches', () => {
  const registry = new PatchRegistry(); let value = 0;
  registry.replace('counter', () => { value = 1; return () => { value = 0; }; });
  registry.replace('counter', () => { value = 2; return () => { value = 0; }; });
  assert.equal(registry.activeCount, 1); assert.equal(value, 2);
  assert.equal(registry.restoreAll(), 1); assert.equal(registry.activeCount, 0); assert.equal(value, 0);
});

test('patch registry preserves a replacement installed during restore', () => {
  const registry = new PatchRegistry();
  registry.replace('reentrant', () => () => {
    registry.replace('reentrant', () => () => {});
  });
  assert.equal(registry.restore('reentrant'), true);
  assert.equal(registry.activeCount, 1);
  assert.equal(registry.restoreAll(), 1);
});

test('patch registry leaves no active patch when a replacement fails', () => {
  const registry = new PatchRegistry();
  registry.replace('failing', () => () => {});
  assert.throws(() => registry.replace('failing', () => { throw new Error('apply failed'); }), /apply failed/);
  assert.equal(registry.activeCount, 0);
});

test('game session restores nested runtime patches and removes newly-added globals', () => {
  const target = { value: 1, read() { return this.value; } };
  const globalKey = '__burialnx_session_fixture__';
  delete (globalThis as any)[globalKey];
  beginGameSession();
  snapshotSessionObject('fixture.target', target);
  patchSessionMethod('fixture.read', target, 'read', (original) => function() { return original.call(this) + 1; });
  (globalThis as any)[globalKey] = { retired: true };
  const timeout = (globalThis as any).setTimeout(() => {}, 60_000);
  const interval = (globalThis as any).setInterval(() => {}, 60_000);
  timeout?.unref?.();
  interval?.unref?.();
  assert.equal(target.read(), 2);
  assert.equal(currentGamePatches()?.activeCount, 2);
  const cleanup = endGameSession();
  assert.equal(cleanup.trackedTimeouts, 1);
  assert.equal(cleanup.trackedIntervals, 1);
  assert.equal(cleanup.timeoutCancelAttempts, 1);
  assert.equal(cleanup.intervalCancelAttempts, 1);
  assert.equal(cleanup.timeoutCancelFailures, 0);
  assert.equal(cleanup.intervalCancelFailures, 0);
  assert.equal(cleanup.patchRestoreFailures, 0);
  assert.equal(target.read(), 1);
  assert.equal(currentGamePatches(), null);
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, globalKey), false);
});

test('sleep autoload hook is session-scoped and resets its pending state on teardown', () => {
  const runtime = globalThis as any;
  const oldSceneManager = runtime.SceneManager;
  const oldSceneBoot = runtime.Scene_Boot;
  const sceneManager = { goto() { return 'original'; }, _scene: null };
  const originalGoto = sceneManager.goto;
  function SceneBoot() {}
  runtime.SceneManager = sceneManager;
  runtime.Scene_Boot = SceneBoot;
  S.sleepAutoloadArmed = false;
  S.sleepAutoloadPending = true;
  S.sleepAutoloadGameId = 'fixture';
  S.sleepAutoloadBgm = { name: 'fixture' };
  S.sleepAutoloadBgs = { name: 'fixture-bgs' };
  try {
    beginGameSession();
    installSleepAutoload();
    assert.notEqual(sceneManager.goto, originalGoto);
    assert.equal(S.sleepAutoloadArmed, true);
    endGameSession();
    assert.equal(sceneManager.goto(), 'original');
    assert.equal(S.sleepAutoloadArmed, false);
    assert.equal(S.sleepAutoloadPending, false);
    assert.equal(S.sleepAutoloadGameId, null);
    assert.equal(S.sleepAutoloadBgm, null);
    assert.equal(S.sleepAutoloadBgs, null);
  } finally {
    endGameSession();
    if (oldSceneManager === undefined) delete runtime.SceneManager;
    else runtime.SceneManager = oldSceneManager;
    if (oldSceneBoot === undefined) delete runtime.Scene_Boot;
    else runtime.Scene_Boot = oldSceneBoot;
  }
});

test('production teardown returns session cleanup evidence instead of discarding it', () => {
  const oldRuntime = S.runtime;
  const oldHost = S.host;
  const oldMapPrefetch = S.mapPrefetch;
  const oldGameStopped = S.gameStopped;
  const manager: any = { _scene: { name: 'fixture' }, update() { return 'game'; }, updateMain() { return 'game'; } };
  const disposed: string[] = [];
  S.runtime = {
    SceneManager: manager,
    AudioManager: { stopBgm() {}, stopBgs() {}, stopMe() {}, stopSe() {} },
    ImageManager: { _imageCache: { clear() {} }, _cache: { clear() {} }, clear() {} },
  };
  S.host = { dispose() { disposed.push('host'); } } as any;
  S.mapPrefetch = { dispose() { disposed.push('prefetch'); } } as any;
  beginGameSession();
  const timeout = (globalThis as any).setTimeout(() => {}, 60_000);
  const interval = (globalThis as any).setInterval(() => {}, 60_000);
  timeout?.unref?.(); interval?.unref?.();
  try {
    const cleanup = teardownGame();
    assert.ok(cleanup, 'production teardown returned a cleanup report');
    assert.equal(cleanup!.hadSession, true);
    assert.equal(cleanup!.trackedTimeouts, 1);
    assert.equal(cleanup!.trackedIntervals, 1);
    assert.equal(cleanup!.timeoutCancelFailures, 0);
    assert.equal(cleanup!.intervalCancelFailures, 0);
    assert.equal(cleanup!.patchRestoreFailures, 0);
    assert.deepEqual(disposed, ['host', 'prefetch']);
    assert.equal(manager._stopped, true);
    assert.equal(manager._scene, null);
    assert.equal(S.host, undefined);
    assert.equal(S.mapPrefetch, undefined);
  } finally {
    if (currentGamePatches()) endGameSession();
    S.runtime = oldRuntime;
    S.host = oldHost;
    S.mapPrefetch = oldMapPrefetch;
    S.gameStopped = oldGameStopped;
  }
});

test('sleep wake report links autosave, marker, production teardown, and chain reload', () => {
  const g = globalThis as any;
  const hadSwitch = Object.prototype.hasOwnProperty.call(g, 'Switch');
  const oldSwitch = g.Switch;
  const oldRuntime = S.runtime;
  const oldHost = S.host;
  const oldMapPrefetch = S.mapPrefetch;
  const oldSelectedGame = S.selectedGame;
  const oldCurrentEntry = S.currentEntry;
  const oldPhase = S.phase;
  const oldAllowExit = S.allowExit;
  const oldGameStopped = S.gameStopped;
  const files = new Map<string, ArrayBuffer>();
  const launches: string[] = [];
  const encode = (value: string | ArrayBuffer) => typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
  class Application {
    constructor(public path: string) {}
    launch(path: string) { launches.push(path); }
  }
  const sw: any = {
    argv: ['sdmc:/switch/burialnx/burialnx.nro'],
    Application,
    mkdirSync() {},
    writeFileSync(path: string, value: string | ArrayBuffer) { files.set(path, encode(value)); },
    readFileSync(path: string) { return files.get(path) ?? null; },
    removeSync(path: string) { files.delete(path); },
    unlinkSync(path: string) { files.delete(path); },
  };
  const manager: any = { _scene: { name: 'map' }, update() {}, updateMain() {}, requestUpdate() {} };
  g.Switch = sw;
  S.runtime = {
    SceneManager: manager,
    AudioManager: {
      saveBgm: () => ({ name: 'theme', volume: 90, pitch: 100, pos: 12 }),
      saveBgs: () => ({ name: 'rain', volume: 70, pitch: 100, pos: 3 }),
      stopBgm() {}, stopBgs() {}, stopMe() {}, stopSe() {},
    },
    DataManager: { makeSaveContents: () => ({ mapId: 7, party: ['hero'] }) },
    JsonEx: { stringify: (value: unknown) => JSON.stringify(value), parse: (value: string) => JSON.parse(value) },
    LZString: { compressToBase64: (value: string) => value, decompressFromBase64: (value: string) => value },
    ImageManager: { _imageCache: { clear() {} }, _cache: { clear() {} }, clear() {} },
    $gameSystem: { saveBgm() {}, saveBgs() {} },
  };
  S.host = { dispose() {} } as any;
  S.mapPrefetch = { dispose() {} } as any;
  S.selectedGame = 'sdmc:/switch/burialnx/Games/Fixture/www';
  S.currentEntry = { id: 'fixture', name: 'Fixture', root: S.selectedGame, sharedSaves: false };
  S.phase = 'game';
  S.allowExit = false;
  S.gameStopped = false;
  beginGameSession();
  const timeout = (globalThis as any).setTimeout(() => {}, 60_000);
  const interval = (globalThis as any).setInterval(() => {}, 60_000);
  timeout?.unref?.(); interval?.unref?.();
  try {
    const report = handleWake(true);
    assert.equal(report.schema, 1);
    assert.equal(report.gameLive, true);
    assert.equal(report.saveAttempted, true);
    assert.equal(report.saveSucceeded, true);
    assert.equal(report.markerAttempted, true);
    assert.equal(report.markerWritten, true);
    assert.equal(report.chainReload, 'launched');
    assert.ok(report.teardown, 'wake path returned production teardown evidence');
    assert.equal(report.teardown!.hadSession, true);
    assert.equal(report.teardown!.trackedTimeouts, 1);
    assert.equal(report.teardown!.trackedIntervals, 1);
    assert.equal(report.teardown!.timeoutCancelFailures, 0);
    assert.equal(report.teardown!.intervalCancelFailures, 0);
    assert.equal(files.has(SLEEP_SAVE_PATH), true);
    assert.equal(files.has(SLEEP_MARKER_PATH), true);
    assert.deepEqual(launches, ['sdmc:/switch/burialnx/burialnx.nro']);
    assert.deepEqual(getLastSleepRecoveryReport(), report);
  } finally {
    if (currentGamePatches()) endGameSession();
    S.runtime = oldRuntime;
    S.host = oldHost;
    S.mapPrefetch = oldMapPrefetch;
    S.selectedGame = oldSelectedGame;
    S.currentEntry = oldCurrentEntry;
    S.phase = oldPhase;
    S.allowExit = oldAllowExit;
    S.gameStopped = oldGameStopped;
    if (hadSwitch) g.Switch = oldSwitch; else delete g.Switch;
  }
});

test('sleep wake failure paths preserve cleanup and fail closed to exit', () => {
  const g = globalThis as any;
  const hadSwitch = Object.prototype.hasOwnProperty.call(g, 'Switch');
  const oldSwitch = g.Switch;
  const oldRuntime = S.runtime;
  const oldPhase = S.phase;
  const oldAllowExit = S.allowExit;
  const exits: number[] = [];
  g.Switch = {
    argv: ['sdmc:/switch/burialnx/burialnx.nro'],
    Application: class {
      constructor() { throw new Error('chain launch unavailable'); }
    },
    exit(code = 0) { exits.push(code); },
  };
  S.runtime = {};
  S.phase = 'game';
  S.allowExit = false;
  try {
    const report = handleWake(false);
    assert.equal(report.gameLive, false);
    assert.equal(report.saveAttempted, false);
    assert.equal(report.markerWritten, false);
    assert.equal(report.chainReload, 'fallback-exit');
    assert.deepEqual(exits, [0]);
  } finally {
    S.runtime = oldRuntime;
    S.phase = oldPhase;
    S.allowExit = oldAllowExit;
    if (hadSwitch) g.Switch = oldSwitch; else delete g.Switch;
  }
});

test('sleep wake marker failure still tears down before reloading', () => {
  const g = globalThis as any;
  const hadSwitch = Object.prototype.hasOwnProperty.call(g, 'Switch');
  const oldSwitch = g.Switch;
  const oldRuntime = S.runtime;
  const oldHost = S.host;
  const oldMapPrefetch = S.mapPrefetch;
  const oldSelectedGame = S.selectedGame;
  const oldCurrentEntry = S.currentEntry;
  const oldPhase = S.phase;
  const oldAllowExit = S.allowExit;
  const oldGameStopped = S.gameStopped;
  const files = new Map<string, ArrayBuffer>();
  const launches: string[] = [];
  const encode = (value: string | ArrayBuffer) => typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
  class Application {
    constructor(public path: string) {}
    launch(path: string) { launches.push(path); }
  }
  g.Switch = {
    argv: ['sdmc:/switch/burialnx/burialnx.nro'], Application,
    mkdirSync() {},
    writeFileSync(path: string, value: string | ArrayBuffer) {
      if (path === SLEEP_MARKER_PATH) throw new Error('marker full');
      files.set(path, encode(value));
    },
    readFileSync(path: string) { return files.get(path) ?? null; },
    removeSync(path: string) { files.delete(path); },
    unlinkSync(path: string) { files.delete(path); },
  };
  const manager: any = { _scene: { name: 'map' }, update() {}, updateMain() {} };
  S.runtime = {
    SceneManager: manager,
    AudioManager: { saveBgm: () => null, saveBgs: () => null, stopBgm() {}, stopBgs() {}, stopMe() {}, stopSe() {} },
    DataManager: { makeSaveContents: () => ({ mapId: 1 }) },
    JsonEx: { stringify: (value: unknown) => JSON.stringify(value) },
    LZString: { compressToBase64: (value: string) => value },
    ImageManager: { _imageCache: { clear() {} }, _cache: { clear() {} }, clear() {} },
  };
  S.host = { dispose() {} } as any;
  S.mapPrefetch = { dispose() {} } as any;
  S.selectedGame = 'sdmc:/switch/burialnx/Games/Fixture/www';
  S.currentEntry = { id: 'fixture', name: 'Fixture', root: S.selectedGame, sharedSaves: false };
  S.phase = 'game';
  S.allowExit = false;
  S.gameStopped = false;
  beginGameSession();
  try {
    const report = handleWake(true);
    assert.equal(report.saveSucceeded, true);
    assert.equal(report.markerAttempted, true);
    assert.equal(report.markerWritten, false);
    assert.equal(report.chainReload, 'launched');
    assert.ok(report.teardown);
    assert.equal(report.teardown!.hadSession, true);
    assert.equal(report.teardown!.timeoutCancelFailures, 0);
    assert.equal(files.has(SLEEP_SAVE_PATH), true);
    assert.equal(files.has(SLEEP_MARKER_PATH), false);
    assert.deepEqual(launches, ['sdmc:/switch/burialnx/burialnx.nro']);
  } finally {
    if (currentGamePatches()) endGameSession();
    S.runtime = oldRuntime;
    S.host = oldHost;
    S.mapPrefetch = oldMapPrefetch;
    S.selectedGame = oldSelectedGame;
    S.currentEntry = oldCurrentEntry;
    S.phase = oldPhase;
    S.allowExit = oldAllowExit;
    S.gameStopped = oldGameStopped;
    if (hadSwitch) g.Switch = oldSwitch; else delete g.Switch;
  }
});

test('atomic persistence sync path commits with rename and cleans failures', () => {
  const files = new Map<string, string>();
  const fs = {
    writeFileSync(path: string, data: string) { files.set(path, data); },
    renameSync(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from); },
    removeSync(path: string) { files.delete(path); },
  };
  atomicWriteSync(fs, 'settings.json', 'ok', { tempSuffix: '.part' });
  assert.deepEqual([...files], [['settings.json', 'ok']]);
  const failFs = { ...fs, renameSync() { throw new Error('rename failed'); } };
  assert.throws(() => atomicWriteSync(failFs, 'settings.json', 'new', { tempSuffix: '.part' }), /rename failed/);
  assert.deepEqual([...files], [['settings.json', 'ok']]);
});

test('atomic persistence reports unsupported Switch filesystems instead of claiming atomicity', () => {
  const writes: string[] = [];
  const fs = { writeFileSync(path: string) { writes.push(path); } };
  assert.equal(atomicWriteSyncIfSupported(fs, 'settings.json', 'x'), false);
  assert.deepEqual(writes, []);
});

test('library and keymap writers use atomic replacement when Switch exposes renameSync', () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const fs = {
    readFileSync() { return null; },
    writeFileSync(path: string, data: string | ArrayBuffer) {
      writes.push(path);
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    renameSync(from: string, to: string) {
      const data = files.get(from);
      if (data === undefined) throw new Error('missing temp');
      files.set(to, data); files.delete(from);
    },
    removeSync(path: string) { files.delete(path); },
    statSync() { return null; },
    mkdirSync() {},
  };
  assert.equal(saveLibrary(fs, { version: 1, games: [] }), true);
  assert.equal(saveKeyMap(fs, DEFAULT_KEYMAP), true);
  assert.ok(writes.some((path) => path.includes('library.json.part-')));
  assert.ok(writes.some((path) => path.includes('keymap.json.part-')));
  assert.ok(files.has('sdmc:/switch/burialnx/library.json'));
  assert.ok(files.has('sdmc:/switch/burialnx/keymap.json'));
  assert.equal([...files.keys()].some((path) => path.includes('.part-')), false);
});

test('atomic persistence removes a failed temporary write', async () => {
  const files = new Map<string, string>();
  const fs = { writeFile(path: string, data: string) { files.set(path, data); if (path.endsWith('.part')) throw new Error('full'); }, rename() {}, remove(path: string) { files.delete(path); } };
  await assert.rejects(atomicWrite(fs, 'save.json', 'x', { tempSuffix: '.part' }), /full/);
  assert.deepEqual([...files], []);
});

test('atomic persistence removes the temporary file when rename fails', async () => {
  const files = new Map<string, string>();
  const fs = { writeFile(path: string, data: string) { files.set(path, data); }, rename() { throw new Error('rename failed'); }, remove(path: string) { files.delete(path); } };
  await assert.rejects(atomicWrite(fs, 'save.json', 'x', { tempSuffix: '.part' }), /rename failed/);
  assert.deepEqual([...files], []);
});

test('movie policy preserves sibling extension priority and adds configured variants', async () => {
  const requested: string[] = [];
  const profile = parsePortProfile({ ...defaultPortProfile, media: { extensionFallback: ['webm'], variantFallback: ['-low'] } });
  const resolver = createMovieResolver({ async read(path) { requested.push(path); return null; } }, [], undefined, false, mediaPolicyFromProfile(profile));
  await assert.rejects(resolver('movies/intro.mp4'), /movies\/intro\.mp4 or movies\/intro\.webm or movies\/intro-low\.mp4/);
  assert.deepEqual(requested.slice(0, 4), ['movies/intro.mp4', 'movies/intro.webm', 'movies/intro-low.mp4', 'movies/intro-low.webm']);
});

test('movie exact mode never adds sibling or variant candidates', async () => {
  const requested: string[] = [];
  const resolver = createMovieResolver({ async read(path) { requested.push(path); return null; } }, [], undefined, false, { extensionFallback: ['webm'], variantFallback: ['-low'] });
  await assert.rejects(resolver('movies/intro.mp4', true), /movies\/intro\.mp4$/);
  assert.deepEqual(requested, ['movies/intro.mp4']);
});

test('movie policy rejects unsafe values at the resolver boundary', () => {
  assert.throws(() => createMovieResolver({ async read() { return null; } }, [], undefined, false, { variantFallback: ['../x'] }), /unsafe filename variant/);
  assert.throws(() => createMovieResolver({ async read() { return null; } }, [], undefined, false, { extensionFallback: ['../mp4'] }), /unsafe extension/);
});

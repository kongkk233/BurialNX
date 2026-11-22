import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPortProfile, loadPortProfile, loadPortProfileFromRoots, loadPortProfileFromRootsSync, mediaPolicyFromProfile, parsePortProfile } from '../src/port-profile';
import { PatchRegistry } from '../src/patch-registry';
import { atomicWrite, atomicWriteSync, atomicWriteSyncIfSupported } from '../src/atomic-persistence';
import { beginGameSession, currentGamePatches, endGameSession, patchSessionMethod, snapshotSessionObject } from '../src/game-session';
import { installSleepAutoload } from '../src/sleep-recovery';
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
  assert.equal(target.read(), 2);
  assert.equal(currentGamePatches()?.activeCount, 2);
  endGameSession();
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

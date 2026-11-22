import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPort } from './check-port.mjs';
import { loadBundledModule } from './ts-bundle.mjs';

const fixture = resolve('tests/fixtures/neutral-mv/www');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (pattern.test(String(error))) return;
    throw new Error(`unexpected rejection: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error('expected promise rejection');
}

export async function acceptHost({ gameRoot = fixture, modRoot = null } = {}) {
  const port = await checkPort({ gameRoot, modRoot, profile: null, manifest: null });
  const library = await loadBundledModule('src/library.ts');
  const sessions = await loadBundledModule('src/game-session.ts');
  const assetsApi = await loadBundledModule('src/game-assets.ts');
  const mediaApi = await loadBundledModule('src/video-source.ts');
  const savesApi = await loadBundledModule('src/saves.ts');

  const paths = {
    safe: library.assetPath('data/Map001.json'),
    encoded: library.assetPath('img/README%2Etxt'),
    traversal: library.assetPath('../outside'),
    external: library.assetPath('https://example.invalid/asset'),
  };
  assert(paths.safe === 'data/Map001.json', 'safe asset path was not accepted');
  assert(paths.encoded === 'img/README.txt', 'encoded safe asset path was not decoded');
  assert(paths.traversal === null && paths.external === null, 'unsafe asset path was accepted');

  const sandbox = { console };
  sandbox.globalThis = sandbox;
  for (const file of port.scriptGraph.files) {
    const root = port.roots[file.root];
    const source = await readFile(resolve(root, file.path), 'utf8');
    vm.runInNewContext(source, sandbox, { filename: `${file.root}/${file.path}` });
  }
  assert(Array.isArray(sandbox.__neutralMvFixture?.scripts), 'neutral fixture scripts did not run');
  assert(sandbox.__neutralMvFixture.scripts.join(',') === 'rpg_core,main', 'script order was not preserved');
  assert(typeof sandbox.onload === 'function', 'neutral fixture did not expose onload');
  sandbox.onload();
  assert(sandbox.__neutralMvFixture.booted === true, 'neutral fixture onload did not boot');

  const reads = [];
  const diskReader = {
    async read(path) {
      assert(path.startsWith('game/'), `asset reader escaped game root: ${path}`);
      const relative = path.slice('game/'.length);
      reads.push(relative);
      try {
        const bytes = await readFile(resolve(gameRoot, relative));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
  };
  const assets = assetsApi.gameAssets('game', null, diskReader, 1024 * 1024, { hashedLookup: false });
  const resolver = mediaApi.createMovieResolver(assets, [], undefined, true, {
    extensionFallback: port.contracts.media.extensionFallback,
    variantFallback: port.contracts.media.variantFallback,
    hashedLookup: false,
  });
  const extensionSource = await resolver('movies/fallback.mp4');
  assert(extensionSource.url.startsWith('blob:'), 'extension fallback did not create an owned Blob URL');
  extensionSource.release();
  const variantSource = await resolver('movies/variant.mp4');
  assert(variantSource.url.startsWith('blob:'), 'variant fallback did not create an owned Blob URL');
  variantSource.release();
  await assertRejects(resolver('movies/corrupt.mp4', false, 'video/mp4'), /ISO MP4 container/);
  assert(reads.includes('movies/fallback.webm') && reads.includes('movies/variant-l.webm'), 'media fallback candidates were not read');

  const saveFiles = new Map([['game/save', { mode: 0o040000 }]]);
  const saveFs = {
    readFileSync(path) {
      const value = saveFiles.get(path);
      return value?.bytes ? value.bytes.slice().buffer : null;
    },
    writeFileSync(path, value) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      saveFiles.set(path, { mode: 0o100000, bytes });
    },
    removeSync(path) { saveFiles.delete(path); },
    statSync(path) { return saveFiles.get(path) ?? null; },
    readDirSync(path) {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      return [...saveFiles.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
    },
  };
  const saveRuntime = {
    StorageManager: {},
    LZString: { compressToBase64: (value) => value, decompressFromBase64: (value) => value },
    DataManager: { maxSavefiles: () => 3 },
  };
  savesApi.installSdSaves(saveRuntime, saveFs, `game/${port.contracts.save.directory}`);
  saveRuntime.StorageManager.save(1, 'neutral-save-round-trip');
  assert(saveRuntime.StorageManager.exists(1), 'save backend did not index the written slot');
  assert(saveRuntime.StorageManager.load(1) === 'neutral-save-round-trip', 'save backend did not round-trip data');
  assert(saveFiles.has(`game/${port.contracts.save.directory}/file1${port.contracts.save.extension}`), 'save backend used an unexpected extension');
  saveRuntime.StorageManager.remove(1);
  assert(!saveRuntime.StorageManager.exists(1), 'save backend did not remove the slot');

  const rollbackTarget = { run() { return 'original'; } };
  const globalKey = '__burialnxAcceptHostTemporaryGlobal';
  sessions.beginGameSession();
  try {
    sessions.patchSessionMethod('accept-host.fixture-method', rollbackTarget, 'run', (original) => function () { return `${original.call(this)}-patched`; });
    globalThis[globalKey] = true;
    assert(rollbackTarget.run() === 'original-patched', 'session patch did not install');
    assert(sessions.currentGamePatches()?.activeCount === 1, 'session patch was not registered');
  } finally {
    sessions.endGameSession();
  }
  assert(rollbackTarget.run() === 'original', 'session patch was not restored');
  assert(!Object.prototype.hasOwnProperty.call(globalThis, globalKey), 'session global was not removed');

  return {
    schema: 1,
    status: 'pass',
    tool: 'accept:host',
    environment: { mode: 'host-only', switch: 'not-available', hardware: 'not-verified' },
    fixture: gameRoot,
    checks: {
      profile: 'pass',
      entry: 'pass',
      scriptGraph: 'pass',
      assetPaths: 'pass',
      mediaPolicy: 'pass',
      saveContract: 'pass',
      rollback: 'pass',
    },
    evidence: {
      profileId: port.profile.id,
      entry: port.entry.path,
      scripts: port.scriptGraph.paths,
      bootMarker: sandbox.__neutralMvFixture,
      media: {
        policy: port.contracts.media,
        extensionFallback: 'movies/fallback.mp4 -> movies/fallback.webm',
        variantFallback: 'movies/variant.mp4 -> movies/variant-l.webm',
        corruptCandidate: 'movies/corrupt.mp4 rejected as an invalid MP4 container',
      },
      save: {
        contract: port.contracts.save,
        roundTrip: 'game/save/file1.rpgsave write/read/remove passed',
      },
      rollback: 'prototype/method restored and temporary global removed',
    },
  };
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    console.log(JSON.stringify(await acceptHost(), null, 2));
  } catch (error) {
    console.error(`host acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

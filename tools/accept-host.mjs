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

export async function acceptHost({ gameRoot = fixture, modRoot = null } = {}) {
  const port = await checkPort({ gameRoot, modRoot, profile: null, manifest: null });
  const library = await loadBundledModule('src/library.ts');
  const sessions = await loadBundledModule('src/game-session.ts');

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
      media: port.contracts.media,
      save: port.contracts.save,
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

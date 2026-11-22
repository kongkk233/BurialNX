import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPort, containedFile, safeRelative } from './check-port.mjs';
import { loadBundledModule } from './ts-bundle.mjs';
import { entryScriptEvidence } from './entry-script-evidence.mjs';
import { nodeCompatEvidence } from './node-compat-evidence.mjs';

const fixture = resolve('tests/fixtures/generic-mv/www');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = { gameRoot: fixture, modRoot: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--game-root') options.gameRoot = argv[++i];
    else if (arg === '--mod-root') options.modRoot = argv[++i];
    else if (arg === '--profile') options.profile = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function checkedPort({ gameRoot, modRoot, profile }) {
  const port = await checkPort({ gameRoot, modRoot, profile: typeof profile === 'string' ? profile : null, manifest: null });
  if (profile && typeof profile === 'object') {
    const api = await loadBundledModule('src/port-profile.ts');
    const expected = api.parsePortProfile(profile);
    assert(JSON.stringify(port.profile.runtime) === JSON.stringify(expected.runtime), 'profile runtime does not match the package profile');
    assert(JSON.stringify(port.profile.entry) === JSON.stringify(expected.entry), 'profile entry does not match the package profile');
    assert(JSON.stringify(port.profile.media) === JSON.stringify(expected.media), 'profile media policy does not match the package profile');
    assert(JSON.stringify(port.profile.save) === JSON.stringify(expected.save), 'profile save policy does not match the package profile');
  }
  return port;
}

export async function acceptPackage({ gameRoot = fixture, modRoot = null, profile = null } = {}) {
  const port = await checkedPort({ gameRoot, modRoot, profile });
  const library = await loadBundledModule('src/library.ts');
  const mediaApi = await loadBundledModule('src/video-source.ts');
  const savesApi = await loadBundledModule('src/saves.ts');
  const sessions = await loadBundledModule('src/game-session.ts');
  const nodeCompat = await nodeCompatEvidence();

  const entryBytes = await containedFile(port.roots[port.entry.root], port.entry.path, 'entry HTML', false);
  const entry = new TextDecoder().decode(entryBytes);
  assert(entry.length > 0, 'entry HTML is empty');
  assert(port.scriptGraph.files.length === port.scriptGraph.paths.length, 'ordered script graph is incomplete');
  assert(port.scriptGraph.files.every((file, index) => file.path === port.scriptGraph.paths[index]), 'ordered script graph changed during acceptance');
  const entryScript = entryScriptEvidence({ profile: { entry: { script: port.contracts.entryScript.path } }, scriptGraph: port.scriptGraph.paths });
  for (const file of port.scriptGraph.files) {
    const root = port.roots[file.root];
    const bytes = await containedFile(root, file.path, `script ${file.path}`, false);
    assert(bytes.byteLength > 0, `script graph file is empty: ${file.path}`);
  }

  const safePaths = [
    ['data/Map001.json', 'data/Map001.json'],
    ['img/README%2Etxt', 'img/README.txt'],
  ];
  for (const [input, expected] of safePaths) assert(library.assetPath(input) === expected, `safe asset path was rejected: ${input}`);
  for (const input of ['../outside', '%2e%2e/outside', '/absolute', 'https://example.invalid/asset']) {
    assert(library.assetPath(input) === null && safeRelative(input) === null, `unsafe asset path was accepted: ${input}`);
  }

  const media = port.contracts.media;
  assert(Array.isArray(media.extensionFallback) && media.extensionFallback.length > 0, 'media extensionFallback must be a non-empty array');
  assert(Array.isArray(media.variantFallback) && media.variantFallback.length > 0, 'media variantFallback must be a non-empty array');
  assert(media.extensionFallback.every(value => /^\.?[a-z0-9][a-z0-9._-]*$/i.test(value)), 'media extensionFallback contains an unsafe extension');
  assert(media.variantFallback.every(value => typeof value === 'string' && value && !value.startsWith('.') && !/[\\/]/.test(value)), 'media variantFallback contains an unsafe variant');
  mediaApi.createMovieResolver({ async read() { return null; } }, [], undefined, true, media);

  const saveFolder = `package/${port.contracts.save.directory}`;
  const saveFiles = new Map([[saveFolder, { mode: 0o040000 }]]);
  const saveFs = {
    readFileSync(path) { return saveFiles.get(path)?.bytes?.slice().buffer ?? null; },
    writeFileSync(path, value) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      saveFiles.set(path, { mode: 0o100000, bytes });
    },
    removeSync(path) { saveFiles.delete(path); },
    statSync(path) { return saveFiles.get(path) ?? null; },
    readDirSync(path) {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      return [...saveFiles.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
    },
  };
  const runtime = {
    StorageManager: {},
    LZString: { compressToBase64: value => value, decompressFromBase64: value => value },
    DataManager: { maxSavefiles: () => 3 },
  };
  savesApi.installSdSaves(runtime, saveFs, saveFolder, port.contracts.save);
  const value = 'generic-package-save-round-trip';
  runtime.StorageManager.save(1, value);
  const expectedPath = `${saveFolder}/file1${port.contracts.save.extension}`;
  assert(saveFiles.has(expectedPath), 'save contract used an unexpected dynamic extension');
  assert(runtime.StorageManager.load(1) === value && runtime.StorageManager.exists(1), 'save contract did not round-trip');
  runtime.StorageManager.remove(1);
  assert(!runtime.StorageManager.exists(1), 'save contract did not remove the slot');

  const target = { run() { return 'original'; } };
  const original = target.run;
  let cleanup;
  sessions.beginGameSession();
  try {
    assert(sessions.patchSessionMethod('accept-package.rollback', target, 'run', previous => function () { return `${previous.call(this)}-patched`; }), 'session patch was not installed');
    assert(target.run() === 'original-patched', 'session patch behavior was not observed');
    const timeout = globalThis.setTimeout(() => {}, 60_000);
    const interval = globalThis.setInterval(() => {}, 60_000);
    timeout?.unref?.();
    interval?.unref?.();
  } finally {
    cleanup = sessions.endGameSession();
  }
  assert(target.run === original && target.run() === 'original', 'session patch did not roll back');
  assert(cleanup.hadSession === true, 'session cleanup report did not describe an active session');
  assert(cleanup.trackedTimeouts === 1 && cleanup.timeoutCancelAttempts === 1 && cleanup.timeoutCancelFailures === 0, 'session timeout cleanup was not verified');
  assert(cleanup.trackedIntervals === 1 && cleanup.intervalCancelAttempts === 1 && cleanup.intervalCancelFailures === 0, 'session interval cleanup was not verified');
  assert(cleanup.patchRestoreFailures === 0, 'session patch cleanup reported a failure');

  return {
    schema: 1,
    status: 'pass',
    tool: 'accept:package',
    environment: { mode: 'package-only', switch: 'not-available', hardware: 'not-verified' },
    fixture: gameRoot,
    executedGameScripts: false,
    runtimeBehavior: 'not-observed',
    checks: {
      profile: 'pass',
      entry: 'pass',
      scriptGraph: 'pass',
      entryScript: entryScript.declared === null ? 'not-declared' : 'validated-only',
      assetPaths: 'pass',
      mediaPolicy: 'pass',
      saveContract: 'pass',
      rollback: 'pass',
      sessionCleanup: 'pass',
      nodeCompat: nodeCompat.status,
    },
    evidence: {
      profileId: port.profile.id,
      entry: port.entry.path,
      scripts: port.scriptGraph.paths,
      entryScript,
      save: { directory: port.contracts.save.directory, extension: port.contracts.save.extension, roundTrip: expectedPath },
      media: port.contracts.media,
      nodeCompat,
      sessionCleanup: {
        trackedTimeouts: cleanup.trackedTimeouts,
        trackedIntervals: cleanup.trackedIntervals,
        timeoutCancelAttempts: cleanup.timeoutCancelAttempts,
        intervalCancelAttempts: cleanup.intervalCancelAttempts,
        timeoutCancelFailures: cleanup.timeoutCancelFailures,
        intervalCancelFailures: cleanup.intervalCancelFailures,
        patchRestoreFailures: cleanup.patchRestoreFailures,
      },
    },
  };
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node tools/accept-package.mjs [--game-root <www>] [--mod-root <dir>] [--profile <file>]');
    else console.log(JSON.stringify(await acceptPackage(options), null, 2));
  } catch (error) {
    console.error(`package acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { parseArgs };

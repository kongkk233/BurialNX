import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as NRO from '@tootallnate/nro';
import * as RomFS from '@tootallnate/romfs';

const REQUIRED_ROMFS_FILES = Object.freeze([
  'main.js',
  'nxjs.ini',
  'runtime.js.map',
  'GeistMono.ttf',
  'icons/add.png',
  'icons/exit.png',
  'icons/settings.png',
]);
const REQUIRED_STARTUP_LABELS = Object.freeze(['BurialNX Library', '+ Add Game']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const textDecoder = new TextDecoder();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDigest(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value), `${label} digest is invalid`);
}

async function blobBytes(blob, label) {
  assert(blob instanceof Blob, `${label} is not a RomFS file`);
  return Buffer.from(await blob.arrayBuffer());
}

function romfsFile(root, path) {
  let entry = root;
  for (const part of path.split('/')) {
    if (!entry || typeof entry !== 'object') return null;
    entry = entry[part];
  }
  return entry instanceof Blob ? entry : null;
}

function listRomfsFiles(root, prefix = '') {
  const files = [];
  for (const [name, entry] of Object.entries(root)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry instanceof Blob) files.push(path);
    else if (entry && typeof entry === 'object') files.push(...listRomfsFiles(entry, path));
  }
  return files.sort();
}

function makeGraphics(labels) {
  return {
    save() {}, restore() {}, setTransform() {}, fillRect() {}, strokeRect() {},
    fillText(value) { labels.push(String(value)); }, strokeText() {}, drawImage() {},
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, rect() {}, clip() {},
    closePath() {}, quadraticCurveTo() {}, fill() {}, stroke() {},
    measureText: () => ({ width: 0 }),
    createPattern: () => ({}),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
}

/**
 * Execute the final packaged main.js in a deliberately bounded host VM.
 * This is post-build package evidence, not a Switch or nx.js runtime test.
 */
async function executePackagedMain(source, { path, debug }) {
  const labels = [];
  const reads = [];
  const writes = [];
  const scheduled = [];
  const timers = new Map();
  const intervals = new Map();
  const listeners = new Map();
  let nextAnimationFrame = 1;
  let nextTimer = 1;
  let clock = 0;
  let fetchCalls = 0;
  const graphics = makeGraphics(labels);
  const screen = Object.assign(new EventTarget(), {
    width: 1280,
    height: 720,
    getContext: () => graphics,
  });
  const store = new Map();
  const asBuffer = value => typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  const switchFs = {
    argv: ['sdmc:/switch/burialnx/burialnx.nro'],
    mkdirSync() {},
    readDirSync(pathName) { reads.push({ operation: 'readDirSync', path: pathName }); return []; },
    statSync(pathName) { reads.push({ operation: 'statSync', path: pathName }); return null; },
    readFileSync(pathName) {
      reads.push({ operation: 'readFileSync', path: pathName });
      const value = store.get(pathName);
      return value === undefined ? null : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    },
    readFile(pathName) { return this.readFileSync(pathName); },
    writeFileSync(pathName, value) {
      const bytes = asBuffer(value);
      writes.push({ operation: 'writeFileSync', path: pathName, bytes: bytes.byteLength });
      store.set(pathName, bytes);
    },
    appendFileSync(pathName, value) {
      const bytes = Buffer.from(String(value));
      writes.push({ operation: 'appendFileSync', path: pathName, bytes: bytes.byteLength });
    },
    removeSync() {},
    unlinkSync() {},
    renameSync() {},
    memoryUsage: () => ({ heapSizeLimit: 512 * 1024 * 1024, nativeHeapTotal: 0 }),
    exit() { throw new Error('packaged startup attempted Switch.exit()'); },
  };
  const raf = callback => {
    const id = nextAnimationFrame++;
    scheduled.push({ id, callback });
    return id;
  };
  const cancelRaf = id => {
    const index = scheduled.findIndex(item => item.id === id);
    if (index >= 0) scheduled.splice(index, 1);
  };
  const setTimer = (callback, delay, ...args) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay, args });
    return id;
  };
  const clearTimer = id => timers.delete(id);
  const setIntervalHost = (callback, delay, ...args) => {
    const id = nextTimer++;
    intervals.set(id, { callback, delay, args });
    return id;
  };
  const clearIntervalHost = id => intervals.delete(id);
  const hostConsole = { debug() {}, log() {}, info() {}, warn() {}, error() {}, trace() {} };
  class HostImage extends EventTarget {
    width = 64;
    height = 64;
    complete = false;
    set src(value) { this._src = String(value); }
    get src() { return this._src || ''; }
  }
  class HostCanvas {
    constructor(width = 300, height = 150) { this.width = width; this.height = height; }
    getContext(kind) { return kind === '2d' ? graphics : null; }
  }
  class HostAudioContext {
    currentTime = 0;
    destination = {};
    state = 'running';
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
    createStereoPanner() { return { pan: { setValueAtTime() {} }, connect() {} }; }
  }
  const addEventListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
  };
  const removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
  const context = vm.createContext({
    Switch: switchFs,
    screen,
    OffscreenCanvas: HostCanvas,
    Image: HostImage,
    AudioContext: HostAudioContext,
    FontFace: class {},
    navigator: { platform: 'Nintendo Switch', userAgent: 'nx.js', getGamepads: () => [{ buttons: Array.from({ length: 16 }, () => ({ pressed: false })) }] },
    requestAnimationFrame: raf,
    cancelAnimationFrame: cancelRaf,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    setInterval: setIntervalHost,
    clearInterval: clearIntervalHost,
    requestIdleCallback: callback => setTimer(callback, 0),
    cancelIdleCallback: clearTimer,
    performance: { now: () => clock },
    addEventListener,
    removeEventListener,
    EventTarget,
    Event,
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    Response,
    Request,
    crypto: webcrypto,
    console: hostConsole,
    fetch: async () => {
      fetchCalls++;
      throw new Error('packaged no-game startup attempted network fetch');
    },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
  });
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  try {
    vm.runInContext(source, context, { timeout: 10_000, filename: `${path}:romfs:/main.js` });
    assert(context.S && context.S.phase === 'library', `${path} did not finish in the library phase`);
    assert(context.S.gameStopped === false, `${path} stopped during packaged startup`);
    for (let frame = 0; frame < 3; frame++) {
      const next = scheduled.shift();
      assert(next, `${path} did not schedule frame ${frame + 1}`);
      next.callback(clock += 17);
      await Promise.resolve();
      await Promise.resolve();
      assert(context.S.phase === 'library', `${path} left the library phase during no-game startup`);
      assert(context.S.gameStopped === false, `${path} stopped during no-game startup frame ${frame + 1}`);
    }
  } catch (error) {
    throw new Error(`packaged startup failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  for (const label of REQUIRED_STARTUP_LABELS) assert(labels.includes(label), `${path} did not render startup label: ${label}`);
  assert(fetchCalls === 0, `${path} performed an unexpected network fetch during no-game startup`);
  return {
    status: 'pass',
    phase: context.S.phase,
    frames: 3,
    frameCallbacksRemaining: scheduled.length,
    labels: [...new Set(labels)].filter(label => REQUIRED_STARTUP_LABELS.includes(label)),
    switchReads: reads.length,
    switchWrites: writes.length,
    debug,
  };
}

export async function inspectPackagedNro({ buffer, path, kind, expectedArtifact = null }) {
  assert(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array, `${path} buffer is missing`);
  assert(typeof path === 'string' && path.length > 0, 'packaged NRO path is missing');
  assert(kind === 'release' || kind === 'debug', `packaged NRO kind is invalid: ${kind}`);
  const bytes = Buffer.from(buffer);
  if (expectedArtifact) {
    assert(bytes.byteLength === expectedArtifact.bytes, `${path} package size does not match artifact attestation`);
    assert(digest(bytes) === expectedArtifact.sha256, `${path} package hash does not match artifact attestation`);
  }
  const decoded = await NRO.decode(new Blob([bytes]));
  assert(decoded.romfs, `${path} has no RomFS section`);
  const romfs = await RomFS.decode(decoded.romfs);
  const files = listRomfsFiles(romfs);
  const missing = REQUIRED_ROMFS_FILES.filter(file => !files.includes(file));
  assert(missing.length === 0, `${path} is missing required RomFS files: ${missing.join(', ')}`);
  const mainBytes = await blobBytes(romfsFile(romfs, 'main.js'), `${path} main.js`);
  const iniBytes = await blobBytes(romfsFile(romfs, 'nxjs.ini'), `${path} nxjs.ini`);
  const runtimeMapBytes = await blobBytes(romfsFile(romfs, 'runtime.js.map'), `${path} runtime.js.map`);
  let runtimeMap;
  try { runtimeMap = JSON.parse(textDecoder.decode(runtimeMapBytes)); }
  catch (error) { throw new Error(`${path} runtime.js.map is not valid JSON`, { cause: error }); }
  assert(Number.isInteger(runtimeMap.version), `${path} runtime.js.map has no source-map version`);
  const ini = textDecoder.decode(iniBytes);
  for (const section of ['[v8]', '[memory]', '[renderer]', '[threadpool]']) {
    assert(new RegExp(`^${section.replace(/[\[\]]/g, '\\$&')}`, 'm').test(ini), `${path} nxjs.ini is missing ${section}`);
  }
  const startup = await executePackagedMain(textDecoder.decode(mainBytes), { path, debug: kind === 'debug' });
  return {
    path,
    kind,
    sha256: digest(bytes),
    bytes: bytes.byteLength,
    nacp: expectedArtifact?.nacp || null,
    romfs: {
      status: 'pass',
      fileCount: files.length,
      files,
      requiredFiles: [...REQUIRED_ROMFS_FILES],
      runtimeConfig: {
        path: 'nxjs.ini',
        sha256: digest(iniBytes),
        sections: ['v8', 'memory', 'renderer', 'threadpool'],
      },
      runtimeSourceMap: {
        path: 'runtime.js.map',
        sha256: digest(runtimeMapBytes),
        version: runtimeMap.version,
      },
    },
    entry: {
      path: 'main.js',
      sha256: digest(mainBytes),
      bytes: mainBytes.byteLength,
      status: 'pass',
    },
    startup,
  };
}

export async function acceptPackagedArtifactSet({
  release,
  debug = null,
  requireDebugArtifact = false,
}) {
  assert(release && release.buffer, 'release packaged artifact is missing');
  if (requireDebugArtifact) assert(debug && debug.buffer, 'release packaged artifact set requires debug NRO');
  const artifacts = [await inspectPackagedNro(release)];
  if (debug?.buffer) artifacts.push(await inspectPackagedNro(debug));
  return {
    schema: 1,
    tool: 'accept:packaged-nro',
    status: 'pass',
    scope: 'post-build-packaged-bundle',
    execution: 'host-vm-packaged-bundle',
    artifactSet: {
      debugRequired: requireDebugArtifact,
      artifacts: artifacts.map(artifact => artifact.kind === 'debug' ? 'debugNro' : 'nro'),
    },
    artifacts,
    environment: {
      mode: 'host-vm-packaged-bundle',
      switch: 'not-available',
      hardware: 'not-verified',
    },
    boundaries: {
      switchRuntime: 'not-verified',
      externalRuntime: 'not-verified',
      hardware: 'not-verified',
      commercialGame: 'not-verified',
    },
  };
}

export function validatePackagedAcceptance(report, { artifacts, requireDebugArtifact = false, label = 'packaged NRO acceptance' } = {}) {
  assert(report && typeof report === 'object' && !Array.isArray(report), `${label} is missing`);
  assert(report.schema === 1 && report.tool === 'accept:packaged-nro', `${label} identity is invalid`);
  assert(report.status === 'pass', `${label} did not pass`);
  assert(report.scope === 'post-build-packaged-bundle' && report.execution === 'host-vm-packaged-bundle', `${label} execution boundary is invalid`);
  assert(report.environment?.switch === 'not-available' && report.environment?.hardware === 'not-verified', `${label} overclaims Switch or hardware evidence`);
  for (const key of ['switchRuntime', 'externalRuntime', 'hardware', 'commercialGame']) {
    assert(report.boundaries?.[key] === 'not-verified', `${label} boundary ${key} is not explicit`);
  }
  const expectedKeys = requireDebugArtifact ? ['nro', 'debugNro'] : ['nro'];
  assert(JSON.stringify(report.artifactSet) === JSON.stringify({ debugRequired: requireDebugArtifact, artifacts: expectedKeys }), `${label} artifact-set descriptor is stale`);
  assert(Array.isArray(report.artifacts) && report.artifacts.length === expectedKeys.length, `${label} artifact count is invalid`);
  for (const key of expectedKeys) {
    const item = report.artifacts.find(artifact => artifact.kind === (key === 'nro' ? 'release' : 'debug'));
    const expected = artifacts?.[key];
    assert(item && expected, `${label} is missing ${key}`);
    assert(item.path === expected.path && item.sha256 === expected.sha256 && item.bytes === expected.bytes, `${label}.${key} is not bound to the artifact attestation`);
    validateDigest(item.sha256, `${label}.${key}`);
    assert(item.romfs?.status === 'pass', `${label}.${key} RomFS validation did not pass`);
    for (const file of REQUIRED_ROMFS_FILES) assert(item.romfs.requiredFiles.includes(file), `${label}.${key} required file list is incomplete`);
    assert(item.entry?.path === 'main.js' && item.entry.status === 'pass', `${label}.${key} entry evidence did not pass`);
    validateDigest(item.entry.sha256, `${label}.${key}.entry`);
    assert(Number.isInteger(item.entry.bytes) && item.entry.bytes > 0, `${label}.${key}.entry byte size is invalid`);
    assert(item.startup?.status === 'pass' && item.startup.phase === 'library', `${label}.${key} packaged startup did not pass`);
    for (const startupLabel of REQUIRED_STARTUP_LABELS) assert(item.startup.labels.includes(startupLabel), `${label}.${key} startup label is missing: ${startupLabel}`);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const project = resolve('.');
  const releasePath = process.argv.includes('--release') ? process.argv[process.argv.indexOf('--release') + 1] : 'burialnx.nro';
  const debugPath = process.argv.includes('--debug') ? process.argv[process.argv.indexOf('--debug') + 1] : 'burialnx-debug.nro';
  const requireDebugArtifact = process.env.BURIALNX_REQUIRE_DEBUG_ARTIFACT === '1';
  const release = { path: releasePath, kind: 'release', buffer: await readFile(resolve(project, releasePath)) };
  let debug = null;
  try { debug = { path: debugPath, kind: 'debug', buffer: await readFile(resolve(project, debugPath)) }; }
  catch (error) { if (error?.code !== 'ENOENT' || requireDebugArtifact) throw error; }
  console.log(JSON.stringify(await acceptPackagedArtifactSet({ release, debug, requireDebugArtifact }), null, 2));
}

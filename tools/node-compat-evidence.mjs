import { loadBundledModule } from './ts-bundle.mjs';

const GAME_ROOT = 'sdmc:/burialnx-acceptance/game/www';
const APP_ROOT = 'sdmc:/burialnx-acceptance/game';
const OUTSIDE_FILE = 'sdmc:/burialnx-acceptance/private.json';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function bytes(value) {
  return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
}

function switchFixture({ rename = true } = {}) {
  const files = new Map([
    [`${APP_ROOT}/packaged.json`, bytes('{"packaged":true}')],
    [OUTSIDE_FILE, bytes('{"private":true}')],
  ]);
  const dirs = new Set();
  const writes = [];
  const renames = [];
  const statSync = path => files.has(path)
    ? { mode: 0o100000 }
    : dirs.has(path) ? { mode: 0o040000 } : null;
  const fixture = {
    readFileSync(path) { return files.get(path) ?? null; },
    writeFileSync(path, value) { files.set(path, bytes(value)); writes.push(path); },
    removeSync(path) { files.delete(path); },
    unlinkSync(path) { files.delete(path); },
    mkdirSync(path) { dirs.add(path); },
    statSync,
    readDirSync(path) {
      const prefix = `${path.replace(/\/+$/, '')}/`;
      const entries = new Set();
      for (const candidate of [...files.keys(), ...dirs]) {
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length).split('/')[0];
        if (rest) entries.add(rest);
      }
      return [...entries];
    },
    readFile: async path => files.get(path) ?? null,
    appendFileSync(path, value) {
      const previous = files.get(path) ?? new ArrayBuffer(0);
      const a = new Uint8Array(previous);
      const b = new Uint8Array(bytes(value));
      const merged = new Uint8Array(a.byteLength + b.byteLength);
      merged.set(a);
      merged.set(b, a.byteLength);
      files.set(path, merged.buffer);
      writes.push(path);
    },
    files,
    writes,
    renames,
  };
  if (rename) {
    fixture.renameSync = (from, to) => {
      if (!files.has(from)) throw new Error(`missing source: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
      renames.push([from, to]);
    };
  }
  return fixture;
}

function codeOf(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
}

/**
 * Exercise the Node/NW fs shim with a synthetic Switch fs. This is a host
 * contract probe, not game execution and not evidence of a real Switch fs.
 */
export async function nodeCompatEvidence() {
  const api = await loadBundledModule('src/node-compat.ts');
  const switchFs = switchFixture();
  const runtime = {};
  api.installNodeCompat(runtime, switchFs, { gameRoot: GAME_ROOT, node: true, nwjs: true });
  const fs = runtime.require('fs');
  const overlayBase = api.overlayBaseFor(GAME_ROOT);

  fs.writeFileSync('atomic.json', 'old');
  fs.writeFileSync('atomic.json.part', 'new');
  fs.renameSync('atomic.json.part', 'atomic.json');
  assert(fs.readFileSync('atomic.json', 'utf8') === 'new', 'overlay rename did not replace the overlay target');
  assert(switchFs.files.has(`${overlayBase}/atomic.json`), 'rename target was not kept in the overlay');
  assert(!switchFs.files.has(`${APP_ROOT}/atomic.json`), 'rename touched the packaged app root');
  assert(switchFs.renames.length === 1, 'native rename was not used exactly once');

  let outsideCode = '';
  try { fs.readFileSync(OUTSIDE_FILE); } catch (error) { outsideCode = codeOf(error); }
  assert(outsideCode === 'EPERM', `outside app-root access was not rejected: ${outsideCode}`);

  let packagedCode = '';
  try { fs.renameSync('packaged.json', 'moved.json'); } catch (error) { packagedCode = codeOf(error); }
  assert(packagedCode === 'EPERM', `packaged rename was not rejected: ${packagedCode}`);
  assert(switchFs.files.has(`${APP_ROOT}/packaged.json`), 'packaged file was modified by rename');

  const noRenameFs = switchFixture({ rename: false });
  const noRenameRuntime = {};
  api.installNodeCompat(noRenameRuntime, noRenameFs, { gameRoot: GAME_ROOT, node: true, nwjs: true });
  const noRename = noRenameRuntime.require('fs');
  noRename.writeFileSync('pending.part', 'x');
  let unavailableCode = '';
  try { noRename.renameSync('pending.part', 'final.json'); } catch (error) { unavailableCode = codeOf(error); }
  assert(unavailableCode === 'ENOSYS', `missing native rename was not fail-closed: ${unavailableCode}`);
  assert(noRename.readFileSync('pending.part', 'utf8') === 'x', 'failed rename did not preserve the source');

  return {
    status: 'pass',
    scope: 'host-shim-contract',
    execution: 'shim-probe-only',
    appRootBoundary: { status: 'enforced', outsidePath: 'EPERM' },
    overlay: {
      write: 'overlay-only',
      rename: 'native-overlay-only',
      replacement: 'overlay-only',
      packagedSource: 'EPERM',
    },
    nativeRename: { required: true, unavailable: 'ENOSYS', failedRenamePreservesSource: true },
    switchHardware: 'not-verified',
    externalRuntime: 'not-verified',
  };
}

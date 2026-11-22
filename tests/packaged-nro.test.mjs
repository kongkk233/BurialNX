import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as NRO from '@tootallnate/nro';
import * as RomFS from '@tootallnate/romfs';
import { acceptPackagedArtifactSet, inspectPackagedNro, validatePackagedAcceptance } from '../tools/accept-packaged-nro.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function syntheticNro(files) {
  const code = Buffer.alloc(0x1000);
  code.write('NRO0', 0x10, 'ascii');
  code.writeUInt32LE(code.byteLength, 0x18);
  const tree = Object.create(null);
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split('/');
    const name = parts.pop();
    let directory = tree;
    for (const part of parts) directory = directory[part] ||= Object.create(null);
    directory[name] = new Blob([value]);
  }
  const romfs = await RomFS.encode(tree);
  const blob = await NRO.encode({
    data: new Blob([code]),
    icon: new Blob([Buffer.from([0])]),
    nacp: new Blob([Buffer.alloc(0x4000)]),
    romfs,
  });
  return Buffer.from(await blob.arrayBuffer());
}

const startup = `
globalThis.S = { phase: 'library', gameStopped: false };
const ctx = screen.getContext('2d');
ctx.fillText('BurialNX Library', 0, 0);
ctx.fillText('+ Add Game', 0, 0);
function frame() { requestAnimationFrame(frame); }
requestAnimationFrame(frame);
`;

const requiredFiles = {
  'main.js': startup,
  'nxjs.ini': '[v8]\n[memory]\n[renderer]\n[threadpool]\n',
  'runtime.js.map': JSON.stringify({ version: 3, sources: [] }),
  'GeistMono.ttf': 'font',
  'icons/add.png': 'add',
  'icons/exit.png': 'exit',
  'icons/settings.png': 'settings',
};

test('packaged NRO acceptance executes the final RomFS main.js in a bounded host VM', async () => {
  const releaseBuffer = await syntheticNro(requiredFiles);
  const debugBuffer = await syntheticNro({ ...requiredFiles, 'main.js': startup.replace("'+ Add Game'", "'+ Add Game'") });
  const release = { path: 'burialnx.nro', kind: 'release', buffer: releaseBuffer };
  const debug = { path: 'burialnx-debug.nro', kind: 'debug', buffer: debugBuffer };
  const report = await acceptPackagedArtifactSet({ release, debug, requireDebugArtifact: true });
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.artifactSet, { debugRequired: true, artifacts: ['nro', 'debugNro'] });
  assert.equal(report.artifacts[0].startup.phase, 'library');
  assert.equal(report.artifacts[1].startup.phase, 'library');
  assert.deepEqual(report.artifacts[0].entry.path, 'main.js');
  validatePackagedAcceptance(report, {
    requireDebugArtifact: true,
    artifacts: {
      nro: { path: release.path, sha256: sha256(releaseBuffer), bytes: releaseBuffer.byteLength },
      debugNro: { path: debug.path, sha256: sha256(debugBuffer), bytes: debugBuffer.byteLength },
    },
  });
});

test('packaged NRO acceptance fails closed when a required RomFS file is missing', async () => {
  const files = { ...requiredFiles };
  delete files['runtime.js.map'];
  const buffer = await syntheticNro(files);
  await assert.rejects(
    () => inspectPackagedNro({ buffer, path: 'burialnx.nro', kind: 'release' }),
    /missing required RomFS files: runtime\.js\.map/,
  );
});

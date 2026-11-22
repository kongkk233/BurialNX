import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const project = resolve('.');
const reportPath = resolve(project, 'reproducibility.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: project, encoding: 'utf8' }).trim();
if (sourceStatus) throw new Error(`reproducibility gate requires a clean worktree:\n${sourceStatus}`);

async function buildOnce() {
  execFileSync(process.execPath, ['tools/build.mjs'], { cwd: project, stdio: 'inherit' });
  const bytes = await readFile(resolve(project, 'burialnx.nro'));
  return { sha256: digest(bytes), bytes: bytes.byteLength };
}

const temporary = await mkdtemp(join(tmpdir(), 'burialnx-repro-'));
try {
  const first = await buildOnce();
  await copyFile(resolve(project, 'burialnx.nro'), join(temporary, 'first.nro'));
  const second = await buildOnce();
  const report = {
    schema: 1,
    status: first.sha256 === second.sha256 && first.bytes === second.bytes ? 'pass' : 'fail',
    method: 'two independent host NRO builds from the same clean checkout',
    byteIdentical: first.sha256 === second.sha256 && first.bytes === second.bytes,
    builds: [first, second],
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
} catch (error) {
  const report = { schema: 1, status: 'fail', method: 'two independent host NRO builds from the same clean checkout', byteIdentical: false, error: error instanceof Error ? error.message : String(error) };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

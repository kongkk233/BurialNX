// Cross-platform entrypoint for the repository's neutral Port Kit contract.
// Keep the game root explicit rather than making the general smoke command
// silently choose a fixture or accidentally execute an untrusted package.
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { acceptHost } from './accept-host.mjs';

const project = resolve('.');
const gameRoot = resolve(project, 'tests/fixtures/neutral-mv/www');
const reportPath = resolve(project, 'neutral-smoke.json');

function reportFor(result) {
  return {
    schema: 1,
    status: result.status,
    tool: 'smoke',
    smokeMode: 'neutral-port-contract',
    environment: result.environment,
    fixture: relative(project, gameRoot),
    checks: result.checks,
    evidence: result.evidence,
  };
}

try {
  const report = reportFor(await acceptHost({ gameRoot }));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
} catch (error) {
  const report = {
    schema: 1,
    status: 'fail',
    tool: 'smoke',
    smokeMode: 'neutral-port-contract',
    environment: { mode: 'host-only', switch: 'not-available', hardware: 'not-verified' },
    fixture: relative(project, gameRoot),
    error: error instanceof Error ? error.message : String(error),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

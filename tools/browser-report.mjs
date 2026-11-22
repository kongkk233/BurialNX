import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const BROWSER_REPORT_PATH = 'browser-validation.json';

const COMMIT = /^[0-9a-f]{40}$/i;
const EXPECTED_FILES = ['sync.mp4', 'sync.webm'];

function fail(message) {
  throw new Error(`invalid browser validation report: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function validateResult(result, expectedFile) {
  assert(result && typeof result === 'object', `${expectedFile} result is missing`);
  assert(result.file === expectedFile, `expected result for ${expectedFile}`);
  assert(result.callbacks?.ready === 1 && result.callbacks?.ends === 1, `${expectedFile} callbacks did not complete once`);
  assert(Number.isInteger(result.sampledFrames) && result.sampledFrames >= 30, `${expectedFile} has too few sampled frames`);
  assert(Number.isInteger(result.distinctFrames) && result.distinctFrames >= 20, `${expectedFile} has too few distinct frames`);
  assert(typeof result.peakPcmRms === 'number' && result.peakPcmRms > 0.06, `${expectedFile} decoded audio is silent`);
  assert(result.flashCount === 4 && result.toneCount === 4, `${expectedFile} pulse counts are incomplete`);
  assert(Array.isArray(result.pulseOffsetsMs) && result.pulseOffsetsMs.length === 3, `${expectedFile} pulse offsets are incomplete`);
  assert(result.pulseOffsetsMs.every(value => typeof value === 'number' && value >= 0 && value <= 150), `${expectedFile} pulse offset exceeded 150 ms`);
}

export function validateBrowserReport(report, { expectedCommit = null, requirePass = false } = {}) {
  assert(report && typeof report === 'object', 'report is not an object');
  assert(report.schema === 1, `schema must be 1, got ${report.schema}`);
  assert(report.tool === 'test:movie:browser', 'tool identity is not test:movie:browser');
  assert(report.scope === 'desktop-browser-media', 'scope identity is not desktop-browser-media');
  assert(report.status === 'pass' || report.status === 'not-run', `unsupported status: ${report.status}`);
  assert(typeof report.gitCommit === 'string' && COMMIT.test(report.gitCommit), 'gitCommit is not a full commit SHA');
  assert(typeof report.gitDirty === 'boolean', 'gitDirty is not boolean');
  assert(report.environment?.mode === 'desktop-browser', 'environment mode is not desktop-browser');
  assert(report.environment?.switch === 'not-available', 'Switch boundary is missing');
  assert(report.environment?.hardware === 'not-verified', 'hardware boundary is missing');
  assert(Array.isArray(report.fixtures) && report.fixtures.length === 2, 'fixture list is incomplete');
  assert(report.fixtures.every(path => typeof path === 'string' && path.startsWith('tests/fixtures/cg/www/movies/')), 'fixture path escaped the synthetic media fixture');
  if (report.status === 'pass') {
    assert(Array.isArray(report.results) && report.results.length === EXPECTED_FILES.length, 'results list is incomplete');
    for (const [index, file] of EXPECTED_FILES.entries()) validateResult(report.results[index], file);
  }
  if (expectedCommit !== null) assert(report.gitCommit === expectedCommit, `gitCommit ${report.gitCommit} does not match ${expectedCommit}`);
  if (requirePass) {
    assert(report.status === 'pass', `status is ${report.status}`);
    assert(report.gitDirty === false, 'report was generated from a dirty worktree');
  }
  return report;
}

export async function readBrowserValidationReport(project = resolve('.')) {
  const path = resolve(project, BROWSER_REPORT_PATH);
  try {
    const report = JSON.parse(await readFile(path, 'utf8'));
    return validateBrowserReport(report);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        schema: 1,
        status: 'not-run',
        tool: 'test:movie:browser',
        scope: 'desktop-browser-media',
        gitCommit: '0000000000000000000000000000000000000000',
        gitDirty: true,
        environment: { mode: 'desktop-browser', browser: 'not-available', switch: 'not-available', hardware: 'not-verified' },
        fixtures: EXPECTED_FILES.map(file => `tests/fixtures/cg/www/movies/${file}`),
        results: [],
      };
    }
    throw error;
  }
}

export { EXPECTED_FILES };

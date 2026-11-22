import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkVideoRuntime, pinnedCode } from './check-video-runtime.mjs';
import { acceptHost } from './accept-host.mjs';
import { acceptPackage } from './accept-package.mjs';
import { acceptPackageRuntime } from './accept-package-runtime.mjs';
import { verifyRuntimeProvenance } from './verify-runtime-provenance.mjs';
import { BROWSER_REPORT_PATH, readBrowserValidationReport } from './browser-report.mjs';

const ASSET_HEADER_SIZE = 0x38;
const NACP_TITLE_SIZE = 0x200;
const NACP_AUTHOR_OFFSET = 0x200;
const NACP_AUTHOR_SIZE = 0x100;
const NACP_PRESENCE_GROUP_ID_OFFSET = 0x3038;
const NACP_STARTUP_USER_ACCOUNT_OFFSET = 0x3025;
const NACP_SAVE_DATA_SIZE_OFFSET = 0x3080;
const NACP_JOURNAL_SIZE_OFFSET = 0x3088;

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = (bytes, start, length) => new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/, '');

export function inspectNro(buffer) {
  if (buffer.length < 0x20 + ASSET_HEADER_SIZE) throw new Error('NRO is too small for its header and asset header');
  if (buffer.toString('ascii', 0x10, 0x14) !== 'NRO0') throw new Error('NRO magic is missing');
  const nroSize = buffer.readUInt32LE(0x18);
  if (nroSize < 0x20 || nroSize > buffer.length) throw new Error(`NRO executable size is out of bounds: ${nroSize}`);
  if (buffer.toString('ascii', nroSize, nroSize + 4) !== 'ASET') throw new Error('NRO ASET magic is missing');
  const assetBase = nroSize;
  const sections = {};
  for (const [name, relOffset, sizeOffset] of [['icon', 0x08, 0x10], ['nacp', 0x18, 0x20], ['romfs', 0x28, 0x30]]) {
    const rel = buffer.readUInt32LE(assetBase + relOffset);
    const size = buffer.readUInt32LE(assetBase + sizeOffset);
    if (rel < ASSET_HEADER_SIZE || size === 0 || assetBase + rel + size > buffer.length) {
      throw new Error(`NRO ${name} section is out of bounds`);
    }
    sections[name] = { offset: assetBase + rel, size };
  }
  return { nroSize, assetBase, sections };
}

function nacpSummary(buffer, layout) {
  const start = layout.sections.nacp.offset;
  const end = start + layout.sections.nacp.size;
  if (end - start < NACP_JOURNAL_SIZE_OFFSET + 8) throw new Error('NACP section is too small');
  const bytes = buffer.subarray(start, end);
  return {
    title: text(bytes, 0, NACP_TITLE_SIZE),
    author: text(bytes, NACP_AUTHOR_OFFSET, NACP_AUTHOR_SIZE),
    id: bytes.readBigUInt64LE(NACP_PRESENCE_GROUP_ID_OFFSET).toString(16).padStart(16, '0'),
    startupUserAccount: bytes.readUInt8(NACP_STARTUP_USER_ACCOUNT_OFFSET),
    saveDataSize: bytes.readBigUInt64LE(NACP_SAVE_DATA_SIZE_OFFSET).toString(),
    journalSize: bytes.readBigUInt64LE(NACP_JOURNAL_SIZE_OFFSET).toString(),
  };
}

function command(name, args, cwd) {
  return execFileSync(name, args, { cwd, encoding: 'utf8' }).trim();
}

async function sourceTreeSha256(project) {
  const listing = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: project });
  const paths = listing.toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(resolve(project, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function nativeRebuildReport(project) {
  try {
    const report = JSON.parse(await readFile(resolve(project, 'native-rebuild-report.json'), 'utf8'));
    if (report.schema !== 1 || report.tool !== 'rebuild-preroll-runtime' || !['pass', 'mismatch'].includes(report.status)) {
      throw new Error('native-rebuild-report.json has an invalid report identity');
    }
    if (typeof report.projectCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(report.projectCommit)) {
      throw new Error('native-rebuild-report.json is not bound to a release commit');
    }
    if (report.expectedExecutableSha256 !== pinnedCode) throw new Error('native-rebuild-report.json expected executable digest is not the distributed digest');
    if (report.status === 'pass' && report.rebuiltExecutableSha256 !== report.expectedExecutableSha256) throw new Error('native-rebuild-report.json pass status has a mismatched executable digest');
    if (report.status === 'mismatch' && report.rebuiltExecutableSha256 === report.expectedExecutableSha256) throw new Error('native-rebuild-report.json mismatch status has the expected executable digest');
    return report;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { schema: 1, tool: 'rebuild-preroll-runtime', status: 'not-run', reason: 'native-rebuild-report.json was not provided' };
  }
}

async function reproducibilityReport(project) {
  try {
    return JSON.parse(await readFile(resolve(project, 'reproducibility.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { schema: 2, status: 'not-run', gitDirty: true, byteIdentical: false, method: 'two independent host NRO builds from the same clean checkout' };
  }
}

async function neutralSmokeReport(project) {
  try {
    const report = JSON.parse(await readFile(resolve(project, 'neutral-smoke.json'), 'utf8'));
    if (report.schema !== 2 || report.tool !== 'smoke' || report.smokeMode !== 'neutral-port-contract') {
      throw new Error('neutral-smoke.json has an invalid report identity');
    }
    return report;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { schema: 2, status: 'not-run', gitDirty: true, tool: 'smoke', smokeMode: 'neutral-port-contract', fixture: 'tests/fixtures/neutral-mv/www' };
  }
}

export async function generateManifest(nroPath = 'burialnx.nro', { project = resolve('.'), write = true } = {}) {
  const absoluteNro = resolve(project, nroPath);
  const buffer = await readFile(absoluteNro);
  const layout = inspectNro(buffer);
  await checkVideoRuntime(buffer);
  const packageJson = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
  const runtimeManifest = JSON.parse(await readFile(resolve(project, 'runtime/manifest.json'), 'utf8'));
  const runtimeProvenance = await verifyRuntimeProvenance({ project, manifest: runtimeManifest });
  const nacp = nacpSummary(buffer, layout);
  const neutralFixture = resolve(project, 'tests/fixtures/neutral-mv/www');
  const modFixture = resolve(project, 'tests/fixtures/neutral-mv/mod');
  const packageFixture = resolve(project, 'tests/fixtures/generic-mv/www');
  const packageAcceptance = await acceptPackage({ gameRoot: packageFixture });
  const packageRuntimeAcceptance = await acceptPackageRuntime({ gameRoot: packageFixture });
  const hostAcceptance = await acceptHost({ gameRoot: neutralFixture });
  const overlayAcceptance = await acceptHost({ gameRoot: neutralFixture, modRoot: modFixture });
  const neutralSmoke = await neutralSmokeReport(project);
  const reproducibility = await reproducibilityReport(project);
  const browserValidation = await readBrowserValidationReport(project);
  const nativeRebuild = await nativeRebuildReport(project);
  const lockfile = await readFile(resolve(project, 'package-lock.json'));
  const gitCommit = command('git', ['rev-parse', 'HEAD'], project);
  if (nativeRebuild.projectCommit && nativeRebuild.projectCommit !== gitCommit) throw new Error('native rebuild report project commit does not match the release commit');
  const gitStatus = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], project);
  const sourceTree = await sourceTreeSha256(project);
  const expectedId = String(packageJson.nacp?.id ?? '').toLowerCase().replace(/^0x/, '').padStart(16, '0');
  if (packageJson.nacp?.title && nacp.title !== packageJson.nacp.title) throw new Error(`NACP title mismatch: ${nacp.title} != ${packageJson.nacp.title}`);
  if (expectedId && nacp.id !== expectedId) throw new Error(`NACP application id mismatch: ${nacp.id} != ${expectedId}`);
  const manifest = {
    schema: 2,
    package: { name: packageJson.name, version: packageJson.version },
    gitCommit,
    gitDirty: gitStatus.length > 0,
    sourceTreeSha256: sourceTree,
    toolchain: { node: process.version, npm: command('npm', ['--version'], project), lockfileSha256: digest(lockfile) },
    runtimeProvenance,
    browserValidation: { ...browserValidation, reportPath: BROWSER_REPORT_PATH },
    nativeRebuild,
    artifacts: {
      nro: { path: relative(project, absoluteNro), kind: 'release', sha256: digest(buffer), bytes: buffer.byteLength, executableSha256: digest(buffer.subarray(0, layout.nroSize)) },
      runtimeExecutable: { sha256: digest(buffer.subarray(0, layout.nroSize)), expectedSha256: pinnedCode, source: 'computed from final NRO executable section' },
    },
    nacp,
    packageAcceptance: {
      ...packageAcceptance,
      fixture: relative(project, packageFixture),
    },
    packageRuntimeAcceptance: {
      ...packageRuntimeAcceptance,
      fixture: relative(project, packageFixture),
    },
    hostAcceptance: {
      status: hostAcceptance.status,
      environment: hostAcceptance.environment,
      checks: hostAcceptance.checks,
      evidence: hostAcceptance.evidence,
      fixture: relative(project, neutralFixture),
    },
    overlayAcceptance: {
      status: overlayAcceptance.status,
      environment: overlayAcceptance.environment,
      checks: overlayAcceptance.checks,
      evidence: overlayAcceptance.evidence,
      fixture: relative(project, neutralFixture),
      modFixture: relative(project, modFixture),
    },
    neutralSmoke,
    reproducibility,
    validation: {
      structural: 'pass',
      runtime: 'pass',
      runtimeProvenance: runtimeProvenance.status,
      profile: hostAcceptance.checks.profile,
      packageAcceptance: packageAcceptance.status,
      packageRuntimeAcceptance: packageRuntimeAcceptance.status,
      portCheck: hostAcceptance.checks.entry === 'pass' && hostAcceptance.checks.scriptGraph === 'pass' ? 'pass' : 'fail',
      acceptHost: hostAcceptance.status,
      overlayAcceptance: overlayAcceptance.status,
      reproducibility: reproducibility.status,
      npmTest: 'run by verify:release',
      typecheck: 'run by verify:release',
      smoke: neutralSmoke.status === 'pass' ? 'neutral-port-contract: pass' : neutralSmoke.status,
      browser: browserValidation.status === 'pass' ? 'desktop-browser: pass' : browserValidation.status,
      native: nativeRebuild.status === 'pass' ? 'source-to-runtime: pass' : nativeRebuild.status === 'mismatch' ? 'not verified (executable digest mismatch)' : 'not run',
      hardware: runtimeManifest.hardwarePlaybackObserved === true ? 'observed in runtime manifest' : 'not verified',
    },
  };
  if (write) await writeFile(resolve(project, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--nro');
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('--nro requires a path');
  const nroPath = index >= 0 ? process.argv[index + 1] : 'burialnx.nro';
  const manifest = await generateManifest(nroPath);
  console.log(JSON.stringify(manifest, null, 2));
}

import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkVideoRuntime, pinnedCode } from './check-video-runtime.mjs';
import { acceptHost } from './accept-host.mjs';
import { acceptPackage } from './accept-package.mjs';
import { acceptPackageRuntime } from './accept-package-runtime.mjs';
import { validateExternalRuntimeReport } from './accept-external-runtime.mjs';
import { verifyRuntimeProvenance } from './verify-runtime-provenance.mjs';
import { BROWSER_REPORT_PATH, readBrowserValidationReport } from './browser-report.mjs';
import { acceptPackagedArtifactSet, validatePackagedAcceptance } from './accept-packaged-nro.mjs';

const ASSET_HEADER_SIZE = 0x38;
const NACP_TITLE_SIZE = 0x200;
const NACP_AUTHOR_OFFSET = 0x200;
const NACP_AUTHOR_SIZE = 0x100;
const NACP_PRESENCE_GROUP_ID_OFFSET = 0x3038;
const NACP_STARTUP_USER_ACCOUNT_OFFSET = 0x3025;
const NACP_SAVE_DATA_SIZE_OFFSET = 0x3080;
const NACP_JOURNAL_SIZE_OFFSET = 0x3088;
const NACP_BCAT_SIZE_OFFSET = 0x3090;

export const RELEASE_NACP_POLICY = Object.freeze({
  startupUserAccount: 0,
  saveDataSize: '32768',
  journalSize: '32768',
  bcatDeliveryCacheStorageSize: '0',
});

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
  if (end - start < NACP_BCAT_SIZE_OFFSET + 8) throw new Error('NACP section is too small');
  const bytes = buffer.subarray(start, end);
  return {
    title: text(bytes, 0, NACP_TITLE_SIZE),
    author: text(bytes, NACP_AUTHOR_OFFSET, NACP_AUTHOR_SIZE),
    id: bytes.readBigUInt64LE(NACP_PRESENCE_GROUP_ID_OFFSET).toString(16).padStart(16, '0'),
    startupUserAccount: bytes.readUInt8(NACP_STARTUP_USER_ACCOUNT_OFFSET),
    saveDataSize: bytes.readBigUInt64LE(NACP_SAVE_DATA_SIZE_OFFSET).toString(),
    journalSize: bytes.readBigUInt64LE(NACP_JOURNAL_SIZE_OFFSET).toString(),
    bcatDeliveryCacheStorageSize: bytes.readBigUInt64LE(NACP_BCAT_SIZE_OFFSET).toString(),
  };
}

export function validateArtifactPath(path, expected = null) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\') || path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    throw new Error(`release artifact path is unsafe: ${path}`);
  }
  if (expected !== null && path !== expected) throw new Error(`release artifact path mismatch: ${path} != ${expected}`);
  return path;
}

export function validateNacpPolicy(nacp, { label = 'NRO', expectedTitle, expectedId, expectedAuthor } = {}) {
  if (!nacp || typeof nacp !== 'object' || Array.isArray(nacp)) throw new Error(`NACP summary is missing for ${label}`);
  if (expectedTitle !== undefined && nacp.title !== expectedTitle) throw new Error(`NACP title mismatch for ${label}: ${nacp.title} != ${expectedTitle}`);
  if (expectedId !== undefined && nacp.id !== expectedId) throw new Error(`NACP application id mismatch for ${label}: ${nacp.id} != ${expectedId}`);
  if (expectedAuthor !== undefined && nacp.author !== expectedAuthor) throw new Error(`NACP author mismatch for ${label}: ${nacp.author} != ${expectedAuthor}`);
  for (const [key, expected] of Object.entries(RELEASE_NACP_POLICY)) {
    if (String(nacp[key]) !== String(expected)) throw new Error(`NACP ${key} policy mismatch for ${label}: ${nacp[key]} != ${expected}`);
  }
  return nacp;
}

export function inspectNroArtifact(buffer, { path, kind, expectedTitle, expectedId, expectedAuthor } = {}) {
  validateArtifactPath(path);
  if (typeof kind !== 'string' || !['release', 'debug'].includes(kind)) throw new Error(`release artifact kind is invalid: ${kind}`);
  const layout = inspectNro(buffer);
  const nacp = validateNacpPolicy(nacpSummary(buffer, layout), { label: path, expectedTitle, expectedId, expectedAuthor });
  return {
    path,
    kind,
    sha256: digest(buffer),
    bytes: buffer.byteLength,
    executableSha256: digest(buffer.subarray(0, layout.nroSize)),
    nacp,
  };
}

function validateDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} digest is invalid`);
}

export function validateArtifactSet(artifacts, { requireDebugArtifact = false, label = 'release artifact set' } = {}) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) throw new Error(`${label} is missing`);
  const release = artifacts.nro;
  if (!release || release.kind !== 'release') throw new Error(`${label} is missing a release NRO`);
  validateArtifactPath(release.path, 'burialnx.nro');
  if (!Number.isInteger(release.bytes) || release.bytes <= 0) throw new Error(`${label}.nro byte size is invalid`);
  validateDigest(release.sha256, `${label}.nro`);
  validateDigest(release.executableSha256, `${label}.nro executable`);
  validateNacpPolicy(release.nacp, { label: `${label}.nro` });
  const runtimeExecutable = artifacts.runtimeExecutable;
  if (!runtimeExecutable || runtimeExecutable.sha256 !== release.executableSha256 || runtimeExecutable.expectedSha256 !== pinnedCode) {
    throw new Error(`${label}.runtimeExecutable is not bound to the release executable`);
  }
  const debug = artifacts.debugNro;
  if (requireDebugArtifact && !debug) throw new Error(`${label} requires burialnx-debug.nro`);
  if (debug) {
    validateArtifactPath(debug.path, 'burialnx-debug.nro');
    if (debug.kind !== 'debug') throw new Error(`${label}.debugNro kind is invalid`);
    if (!Number.isInteger(debug.bytes) || debug.bytes <= 0) throw new Error(`${label}.debugNro byte size is invalid`);
    validateDigest(debug.sha256, `${label}.debugNro`);
    validateDigest(debug.executableSha256, `${label}.debugNro executable`);
    validateNacpPolicy(debug.nacp, {
      label: `${label}.debugNro`,
      expectedTitle: `${release.nacp.title}-Debug`,
      expectedId: release.nacp.id,
      expectedAuthor: release.nacp.author,
    });
  }
  return artifacts;
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

export function externalRuntimeNotRunReport() {
  return {
    schema: 1,
    tool: 'accept:external-runtime',
    status: 'not-run',
    scope: 'external-runtime-identity',
    execution: 'not-run',
    reason: 'no external runtime report was supplied',
    reportPath: null,
    environment: { mode: 'external-runtime', switch: 'not-available', hardware: 'not-verified' },
    declaredRuntime: null,
    observedRuntime: null,
    package: null,
    probe: null,
    switchRuntime: 'not-verified',
    nativeSourceRebuild: 'not-verified',
    hardware: 'not-verified',
    commercialGame: 'not-verified',
  };
}

export async function loadExternalRuntimeReport(project) {
  const suppliedPath = process.env.BURIALNX_EXTERNAL_RUNTIME_REPORT?.trim();
  if (!suppliedPath) return externalRuntimeNotRunReport();
  const absolute = resolve(project, suppliedPath);
  let report;
  try {
    report = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`external runtime report could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateExternalRuntimeReport(report, { requireExternalProcess: true });
  let executablePath;
  try { executablePath = await realpath(report.observedRuntime.execPath); }
  catch (error) { throw new Error(`external runtime executable could not be resolved: ${error instanceof Error ? error.message : String(error)}`); }
  if (executablePath !== report.observedRuntime.execPath) throw new Error('external runtime report execPath is not canonical');
  const executableInfo = await stat(executablePath);
  if (!executableInfo.isFile()) throw new Error('external runtime report execPath is not a regular file');
  try { await access(executablePath, constants.R_OK | constants.X_OK); }
  catch (error) { throw new Error(`external runtime report execPath is not executable: ${error instanceof Error ? error.message : String(error)}`); }
  const executableSha256 = digest(await readFile(executablePath));
  if (executableSha256 !== report.observedRuntime.executableSha256.toLowerCase()) throw new Error('external runtime report executable digest is stale or tampered');
  return { ...report, reportPath: relative(project, absolute) || absolute };
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

export async function generateManifest(nroPath = 'burialnx.nro', { project = resolve('.'), write = true, requireDebugArtifact = process.env.BURIALNX_REQUIRE_DEBUG_ARTIFACT === '1' } = {}) {
  const absoluteNro = resolve(project, nroPath);
  const releasePath = validateArtifactPath(relative(project, absoluteNro));
  const buffer = await readFile(absoluteNro);
  const packageJson = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
  const expectedTitle = packageJson.nacp?.title || 'BurialNX';
  const expectedId = String(packageJson.nacp?.id ?? '').toLowerCase().replace(/^0x/, '').padStart(16, '0');
  const expectedAuthor = packageJson.nacp?.author;
  const releaseArtifact = inspectNroArtifact(buffer, {
    path: releasePath,
    kind: 'release',
    expectedTitle,
    expectedId: expectedId || undefined,
    expectedAuthor,
  });
  await checkVideoRuntime(buffer);
  const runtimeManifest = JSON.parse(await readFile(resolve(project, 'runtime/manifest.json'), 'utf8'));
  const runtimeProvenance = await verifyRuntimeProvenance({ project, manifest: runtimeManifest });
  const nacp = releaseArtifact.nacp;
  const debugAbsolute = resolve(project, 'burialnx-debug.nro');
  let debugArtifact = null;
  let debugBuffer = null;
  try {
    debugBuffer = await readFile(debugAbsolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (debugBuffer) {
    debugArtifact = inspectNroArtifact(debugBuffer, {
      path: 'burialnx-debug.nro',
      kind: 'debug',
      expectedTitle: `${expectedTitle}-Debug`,
      expectedId: expectedId || undefined,
      expectedAuthor,
    });
    await checkVideoRuntime(debugBuffer);
  } else if (requireDebugArtifact) {
    throw new Error('release artifact set requires burialnx-debug.nro');
  }
  const packagedAcceptance = await acceptPackagedArtifactSet({
    release: { path: releasePath, kind: 'release', buffer, expectedArtifact: releaseArtifact },
    debug: debugBuffer ? { path: 'burialnx-debug.nro', kind: 'debug', buffer: debugBuffer, expectedArtifact: debugArtifact } : null,
    requireDebugArtifact,
  });
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
  const externalRuntime = await loadExternalRuntimeReport(project);
  const lockfile = await readFile(resolve(project, 'package-lock.json'));
  const gitCommit = command('git', ['rev-parse', 'HEAD'], project);
  if (nativeRebuild.projectCommit && nativeRebuild.projectCommit !== gitCommit) throw new Error('native rebuild report project commit does not match the release commit');
  const gitStatus = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], project);
  const sourceTree = await sourceTreeSha256(project);
  const artifacts = {
    nro: releaseArtifact,
    runtimeExecutable: { sha256: releaseArtifact.executableSha256, expectedSha256: pinnedCode, source: 'computed from final NRO executable section' },
  };
  if (debugArtifact) artifacts.debugNro = debugArtifact;
  validateArtifactSet(artifacts, { requireDebugArtifact, label: 'release artifact set' });
  validatePackagedAcceptance(packagedAcceptance, { artifacts, requireDebugArtifact });
  const manifest = {
    schema: 5,
    package: { name: packageJson.name, version: packageJson.version },
    gitCommit,
    gitDirty: gitStatus.length > 0,
    sourceTreeSha256: sourceTree,
    toolchain: { node: process.version, npm: command('npm', ['--version'], project), lockfileSha256: digest(lockfile) },
    runtimeProvenance,
    browserValidation: { ...browserValidation, reportPath: BROWSER_REPORT_PATH },
    nativeRebuild,
    externalRuntime,
    artifactSet: {
      schema: 1,
      debugRequired: requireDebugArtifact,
      artifacts: debugArtifact ? ['nro', 'debugNro'] : ['nro'],
    },
    packagedAcceptance,
    artifacts,
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
      lifecycle: packageAcceptance.checks.lifecycle,
      nodeCompat: packageAcceptance.checks.nodeCompat,
      portCheck: hostAcceptance.checks.entry === 'pass' && hostAcceptance.checks.scriptGraph === 'pass' ? 'pass' : 'fail',
      acceptHost: hostAcceptance.status,
      overlayAcceptance: overlayAcceptance.status,
      reproducibility: reproducibility.status,
      npmTest: 'run by verify:release',
      typecheck: 'run by verify:release',
      smoke: neutralSmoke.status === 'pass' ? 'neutral-port-contract: pass' : neutralSmoke.status,
      browser: browserValidation.status === 'pass' ? 'desktop-browser: pass' : browserValidation.status,
      native: nativeRebuild.status === 'pass' ? 'source-to-runtime: pass' : nativeRebuild.status === 'mismatch' ? 'not verified (executable digest mismatch)' : 'not run',
      externalRuntime: externalRuntime.status === 'pass' ? 'external-runtime-identity: pass' : 'not run',
      artifacts: 'release-artifact-set: pass',
      packaged: 'packaged-nro: pass',
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

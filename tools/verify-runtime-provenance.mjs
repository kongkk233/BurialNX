import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SHA256 = /^[a-f0-9]{64}$/i;
const SHA1 = /^[a-f0-9]{40}$/i;
const BUILD_ID = /^(?:[a-f0-9]{2}){2,32}$/i;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobDigest(bytes) {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function projectPath(project, value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) {
    throw new Error(`${label} must be a project-relative path`);
  }
  const root = resolve(project);
  const candidate = resolve(root, value);
  if (!inside(root, candidate)) throw new Error(`${label} escapes the project: ${value}`);
  return candidate;
}

function relativeProjectPath(project, candidate) {
  return relative(resolve(project), candidate).split(sep).join('/');
}

async function verifyGitBlobClaim({ project, claim, pathValue, expectedSha1 }) {
  if (!SHA1.test(String(expectedSha1 ?? ''))) {
    throw new Error(`${claim} has an invalid expected Git blob SHA-1`);
  }
  const candidate = projectPath(project, pathValue, `${claim} path`);
  let bytes;
  try {
    bytes = await readFile(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${claim} file is missing: ${pathValue}`);
    throw error;
  }
  const actualSha1 = gitBlobDigest(bytes);
  const result = {
    claim,
    path: relativeProjectPath(project, candidate),
    expectedSha1: String(expectedSha1).toLowerCase(),
    actualSha1,
    bytes: bytes.byteLength,
    status: actualSha1 === String(expectedSha1).toLowerCase() ? 'pass' : 'fail',
  };
  if (result.status !== 'pass') throw new Error(`${claim} mismatch: ${actualSha1} != ${result.expectedSha1}`);
  return result;
}

async function verifyCompressedProgramClaim({ project, claim, pathValue, expectedSha256, expectedBytes }) {
  if (!SHA256.test(String(expectedSha256 ?? ''))) {
    throw new Error(`${claim} has an invalid expected SHA-256`);
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`${claim} has an invalid expected byte count`);
  }
  const candidate = projectPath(project, pathValue, `${claim} path`);
  let compressed;
  try {
    compressed = await readFile(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${claim} file is missing: ${pathValue}`);
    throw error;
  }
  let program;
  try {
    program = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`${claim} is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actualSha256 = digest(program);
  if (program.byteLength !== expectedBytes) {
    throw new Error(`${claim} byte count mismatch: ${program.byteLength} != ${expectedBytes}`);
  }
  if (program.toString('ascii', 16, 20) !== 'NRO0' || program.readUInt32LE(24) !== program.byteLength) {
    throw new Error(`${claim} is not an exact NRO program section`);
  }
  const result = {
    claim,
    path: relativeProjectPath(project, candidate),
    expectedSha256: String(expectedSha256).toLowerCase(),
    actualSha256,
    bytes: program.byteLength,
    compressedBytes: compressed.byteLength,
    status: actualSha256 === String(expectedSha256).toLowerCase() ? 'pass' : 'fail',
  };
  if (result.status !== 'pass') throw new Error(`${claim} mismatch: ${actualSha256} != ${result.expectedSha256}`);
  return result;
}

async function verifyCompressedBuildIdClaim({ project, claim, pathValue, expectedBuildId }) {
  if (!BUILD_ID.test(String(expectedBuildId ?? ''))) {
    throw new Error(`${claim} has an invalid ELF BuildID`);
  }
  const candidate = projectPath(project, pathValue, `${claim} path`);
  let compressed;
  try {
    compressed = await readFile(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${claim} file is missing: ${pathValue}`);
    throw error;
  }
  let program;
  try {
    program = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`${claim} is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (program.toString('ascii', 16, 20) !== 'NRO0' || program.byteLength < 0x40 + String(expectedBuildId).length / 2) {
    throw new Error(`${claim} is missing the NRO header`);
  }
  const actualBuildId = program.subarray(0x40, 0x40 + String(expectedBuildId).length / 2).toString('hex');
  const result = {
    claim,
    path: relativeProjectPath(project, candidate),
    offset: 0x40,
    expectedBuildId: String(expectedBuildId).toLowerCase(),
    actualBuildId,
    bytes: String(expectedBuildId).length / 2,
    status: actualBuildId === String(expectedBuildId).toLowerCase() ? 'pass' : 'fail',
  };
  if (result.status !== 'pass') throw new Error(`${claim} mismatch: ${actualBuildId} != ${result.expectedBuildId}`);
  return result;
}

async function verifyFileClaim({ project, claim, pathValue, expectedSha256 }) {
  if (!SHA256.test(String(expectedSha256 ?? ''))) {
    throw new Error(`${claim} has an invalid expected SHA-256`);
  }
  const candidate = projectPath(project, pathValue, `${claim} path`);
  let bytes;
  try {
    bytes = await readFile(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${claim} file is missing: ${pathValue}`);
    throw error;
  }
  const actualSha256 = digest(bytes);
  const status = actualSha256 === String(expectedSha256).toLowerCase() ? 'pass' : 'fail';
  const result = {
    claim,
    path: relativeProjectPath(project, candidate),
    expectedSha256: String(expectedSha256).toLowerCase(),
    actualSha256,
    bytes: bytes.byteLength,
    status,
  };
  if (status !== 'pass') throw new Error(`${claim} mismatch: ${actualSha256} != ${result.expectedSha256}`);
  return result;
}

function unverifiedClaim(claim, value, reason) {
  return { claim, value, status: 'not-verified', reason };
}

/**
 * Verify the runtime provenance that can be recomputed from this repository.
 *
 * A pass means every locally verifiable file claim matches. The unverified list
 * is intentionally retained in the report so external source/toolchain/signing
 * claims cannot be mistaken for evidence produced by this checkout.
 */
export async function verifyRuntimeProvenance({ project = resolve('.'), manifestPath = 'runtime/manifest.json', manifest = null } = {}) {
  const root = resolve(project);
  const runtimeManifest = manifest ?? JSON.parse(await readFile(projectPath(root, manifestPath), 'utf8'));
  if (runtimeManifest.schema !== 1) throw new Error('runtime manifest schema must be 1');
  const distributed = runtimeManifest.distributedArtifactProvenance;
  if (!distributed || typeof distributed !== 'object' || Array.isArray(distributed)) {
    throw new Error('runtime distributed artifact provenance is missing');
  }
  if (typeof distributed.repository !== 'string' || !/^https:\/\//.test(distributed.repository)) {
    throw new Error('runtime distributed artifact provenance repository is invalid');
  }
  if (typeof distributed.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(distributed.commit)) {
    throw new Error('runtime distributed artifact provenance commit is invalid');
  }
  if (distributed.sourceCommitRole !== 'historical-distribution-commit' || distributed.exactRebuildStatus !== 'not-verified') {
    throw new Error('runtime distributed artifact provenance boundary is invalid');
  }
  const historical = runtimeManifest.historicalPackageEvidence;
  if (!historical || typeof historical !== 'object' || Array.isArray(historical)) {
    throw new Error('runtime historical package evidence is missing');
  }
  for (const [key, value] of Object.entries(historical)) {
    if (key.endsWith('Sha256') && !SHA256.test(String(value))) {
      throw new Error(`runtime historical package evidence ${key} is invalid`);
    }
  }
  if (historical.programBytes !== runtimeManifest.rawProgramBytes ||
      historical.regularNroExecutableSha256 !== runtimeManifest.fixedExeSha256 ||
      historical.debugNroExecutableSha256 !== runtimeManifest.fixedExeSha256 ||
      historical.packagesContainExactDistributedProgram !== true ||
      historical.physicalSwitchTestPerformed !== false ||
      historical.exactRebuildStatus !== 'not-verified') {
    throw new Error('runtime historical package evidence boundary is invalid');
  }
  const verified = [
    await verifyFileClaim({
      project: root,
      claim: 'runtime.patchSha256',
      pathValue: runtimeManifest.patch,
      expectedSha256: runtimeManifest.patchSha256,
    }),
    await verifyFileClaim({
      project: root,
      claim: 'runtime.timelinePatchSha256',
      pathValue: runtimeManifest.timelinePatch,
      expectedSha256: runtimeManifest.timelinePatchSha256,
    }),
    await verifyFileClaim({
      project: root,
      claim: 'runtime.prerollGzipSha256',
      pathValue: 'runtime/nxjs-preroll.nro-code.gz',
      expectedSha256: runtimeManifest.prerollGzipSha256,
    }),
    await verifyCompressedProgramClaim({
      project: root,
      claim: 'runtime.fixedExecutableSha256',
      pathValue: 'runtime/nxjs-preroll.nro-code.gz',
      expectedSha256: runtimeManifest.fixedExeSha256,
      expectedBytes: runtimeManifest.rawProgramBytes,
    }),
    await verifyCompressedBuildIdClaim({
      project: root,
      claim: 'runtime.armElfBuildId',
      pathValue: 'runtime/nxjs-preroll.nro-code.gz',
      expectedBuildId: runtimeManifest.armElfBuildId,
    }),
    await verifyGitBlobClaim({
      project: root,
      claim: 'runtime.distributedArtifactGitBlobSha1',
      pathValue: distributed.path,
      expectedSha1: distributed.gitBlobSha1,
    }),
  ];

  const unverified = [
    unverifiedClaim(
      'runtime.historicalPackageEvidence',
      historical,
      'historical NRO/evidence files are external to this repository; matching the distributed program proves package identity, not the original source-to-runtime build process',
    ),
    unverifiedClaim(
      'runtime.distributedArtifactSourceCommit',
      { repository: distributed.repository, commit: distributed.commit, path: distributed.path },
      'the historical distribution commit identifies the committed runtime blob, but it does not prove an exact source-to-runtime rebuild; retain native status as not-verified',
    ),
    unverifiedClaim(
      'runtime.patchedSourceSha256',
      runtimeManifest.patchedSourceSha256 ?? null,
      'patched nx.js source files are not vendored in this repository; verify them against an external NXJS_MEDIA_SOURCE checkout',
    ),
    unverifiedClaim(
      'runtime.standaloneRuntimeNroSha256',
      runtimeManifest.standaloneRuntimeNroSha256 ?? null,
      'the standalone runtime NRO is not committed as a separately addressable source artifact',
    ),
    unverifiedClaim(
      'runtime.upstreamPinnedSdkImage',
      runtimeManifest.upstreamPinnedSdkImage ?? null,
      'the SDK image digest is recorded, but this host verifier does not execute or attest the external image',
    ),
    unverifiedClaim(
      'runtime.macHostToolsVerifiedWithDkpReleaseSignatures',
      runtimeManifest.macHostToolsVerifiedWithDkpReleaseSignatures ?? null,
      'signature files and an independent verification transcript are not included in this repository',
    ),
    unverifiedClaim(
      'runtime.sourcePackage',
      runtimeManifest.sourcePackage ?? null,
      'external FFmpeg/nx.js source archives and recipe inputs are recorded but are not reconstructed by this host gate',
    ),
  ];

  return {
    schema: 1,
    status: 'pass',
    scope: 'repository-verifiable-runtime-inputs',
    runtimeManifest: relativeProjectPath(root, projectPath(root, manifestPath, 'runtime manifest')),
    verified,
    unverified,
  };
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    console.log(JSON.stringify(await verifyRuntimeProvenance(), null, 2));
  } catch (error) {
    console.error(`runtime provenance verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

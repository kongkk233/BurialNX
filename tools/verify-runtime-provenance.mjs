import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/i;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
  ];

  const unverified = [
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

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateManifest, inspectNro } from './release-manifest.mjs';

const project = resolve('.');
const manifestPath = resolve(project, 'release-manifest.json');
const actual = await generateManifest('burialnx.nro', { project, write: false });
const stored = JSON.parse(await readFile(manifestPath, 'utf8'));

if (stored.schema !== actual.schema) throw new Error(`release manifest schema mismatch: ${stored.schema} != ${actual.schema}`);
if (stored.package?.name !== actual.package.name || stored.package?.version !== actual.package.version) throw new Error('release manifest package metadata is stale');
if (stored.gitCommit !== actual.gitCommit) throw new Error('release manifest git commit is stale');
if (stored.gitDirty !== actual.gitDirty) throw new Error('release manifest git dirty state is stale');
if (actual.gitDirty) throw new Error('release verification requires a clean worktree');
if (stored.sourceTreeSha256 !== actual.sourceTreeSha256) throw new Error('release manifest source tree hash is stale');
if (stored.toolchain?.lockfileSha256 !== actual.toolchain.lockfileSha256) throw new Error('release manifest lockfile hash is stale');
if (stored.artifacts?.nro?.kind !== 'release') throw new Error('release manifest does not describe a release NRO');
if (stored.artifacts?.nro?.sha256 !== actual.artifacts.nro.sha256) throw new Error('release manifest NRO hash is stale');
if (stored.artifacts?.runtimeExecutable?.sha256 !== actual.artifacts.runtimeExecutable.sha256) throw new Error('release manifest executable hash is stale');
if (stored.artifacts?.runtimeExecutable?.expectedSha256 !== actual.artifacts.runtimeExecutable.expectedSha256) throw new Error('release manifest expected runtime hash is stale');
if (stored.nacp?.title !== actual.nacp.title || stored.nacp?.id !== actual.nacp.id) throw new Error('release manifest NACP summary is stale');
if (JSON.stringify(stored.hostAcceptance) !== JSON.stringify(actual.hostAcceptance)) throw new Error('release manifest host acceptance is stale');
if (JSON.stringify(stored.overlayAcceptance) !== JSON.stringify(actual.overlayAcceptance)) throw new Error('release manifest overlay acceptance is stale');
if (actual.overlayAcceptance.status !== 'pass' || actual.overlayAcceptance.evidence?.overlay?.profile !== 'mod-first') throw new Error('mod overlay acceptance gate did not pass');
if (JSON.stringify(stored.neutralSmoke) !== JSON.stringify(actual.neutralSmoke)) throw new Error('release manifest neutral smoke is stale');
if (actual.neutralSmoke.status !== 'pass' || actual.neutralSmoke.smokeMode !== 'neutral-port-contract') throw new Error('neutral smoke gate did not pass');
if (actual.neutralSmoke.gitCommit !== actual.gitCommit || actual.neutralSmoke.gitDirty !== false) throw new Error('neutral smoke provenance does not match the clean release commit');
if (actual.neutralSmoke.fixture !== 'tests/fixtures/neutral-mv/www') throw new Error('neutral smoke fixture is not the repository fixture');
if (JSON.stringify(actual.neutralSmoke.checks) !== JSON.stringify(actual.hostAcceptance.checks)) throw new Error('neutral smoke checks do not match fresh host acceptance');
if (JSON.stringify(actual.neutralSmoke.evidence) !== JSON.stringify(actual.hostAcceptance.evidence)) throw new Error('neutral smoke evidence does not match fresh host acceptance');
if (JSON.stringify(stored.reproducibility) !== JSON.stringify(actual.reproducibility)) throw new Error('release manifest reproducibility is stale');
if (actual.reproducibility.status !== 'pass' || actual.reproducibility.byteIdentical !== true) throw new Error('release reproducibility gate did not pass');
if (actual.reproducibility.gitCommit !== actual.gitCommit || actual.reproducibility.gitDirty !== false) throw new Error('reproducibility provenance does not match the clean release commit');
if (!Array.isArray(actual.reproducibility.builds) || actual.reproducibility.builds.length !== 2 || actual.reproducibility.builds.some((build) => build.sha256 !== actual.artifacts.nro.sha256 || build.bytes !== actual.artifacts.nro.bytes)) throw new Error('reproducibility report does not describe the release NRO twice');
for (const key of ['profile', 'portCheck', 'acceptHost', 'overlayAcceptance', 'reproducibility', 'npmTest', 'typecheck', 'structural', 'runtime', 'smoke', 'browser', 'native', 'hardware']) {
  if (stored.validation?.[key] !== actual.validation?.[key]) throw new Error(`release manifest validation.${key} is stale`);
}
inspectNro(await readFile(resolve(project, 'burialnx.nro')));
console.log(`release verification passed: ${actual.artifacts.nro.path} (${actual.artifacts.nro.sha256})`);

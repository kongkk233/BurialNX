import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { externalRuntimeNotRunReport, generateManifest, inspectNro, validateArtifactSet } from './release-manifest.mjs';
import { validateExternalRuntimeReport } from './accept-external-runtime.mjs';
import { validateBrowserReport } from './browser-report.mjs';

const project = resolve('.');
const manifestPath = resolve(project, 'release-manifest.json');

function verifyEntryScriptEvidence(report, label, expectedExecution) {
  const entry = report?.evidence?.entryScript;
  if (!entry || (typeof entry.declared !== 'string' && entry.declared !== null)) throw new Error(`${label}.evidence.entryScript.declared is invalid`);
  const graph = entry.graph;
  const execution = entry.execution;
  if (!graph || !execution) throw new Error(`${label}.evidence.entryScript is incomplete`);
  if (entry.declared === null) {
    if (graph.status !== 'not-declared' || graph.path !== null || graph.index !== null || execution.status !== 'not-declared' || execution.observed !== false || execution.index !== null) throw new Error(`${label}.evidence.entryScript has inconsistent undeclared state`);
    return;
  }
  if (graph.status !== 'pass' || graph.path !== entry.declared || !Number.isInteger(graph.index) || graph.index < 0) throw new Error(`${label}.evidence.entryScript graph evidence is invalid`);
  if (expectedExecution === 'not-observed') {
    if (execution.status !== 'not-observed' || execution.observed !== false || execution.index !== null) throw new Error(`${label}.evidence.entryScript must remain not-observed`);
  } else if (execution.status !== 'observed' || execution.observed !== true || execution.index !== graph.index) {
    throw new Error(`${label}.evidence.entryScript execution does not match the HTML graph`);
  }
}

function verifyNodeCompatEvidence(report, label) {
  const evidence = report?.evidence?.nodeCompat;
  if (!evidence || evidence.status !== 'pass' || evidence.scope !== 'host-shim-contract' || evidence.execution !== 'shim-probe-only') {
    throw new Error(`${label}.evidence.nodeCompat must describe a passing host shim contract probe`);
  }
  if (evidence.appRootBoundary?.status !== 'enforced' || evidence.appRootBoundary.outsidePath !== 'EPERM') {
    throw new Error(`${label}.evidence.nodeCompat app-root boundary is not fail-closed`);
  }
  if (evidence.overlay?.write !== 'overlay-only' || evidence.overlay?.rename !== 'native-overlay-only' || evidence.overlay?.replacement !== 'overlay-only' || evidence.overlay?.packagedSource !== 'EPERM') {
    throw new Error(`${label}.evidence.nodeCompat overlay contract is invalid`);
  }
  if (evidence.nativeRename?.required !== true || evidence.nativeRename?.unavailable !== 'ENOSYS' || evidence.nativeRename?.failedRenamePreservesSource !== true) {
    throw new Error(`${label}.evidence.nodeCompat native rename boundary is invalid`);
  }
  if (evidence.switchHardware !== 'not-verified' || evidence.externalRuntime !== 'not-verified') {
    throw new Error(`${label}.evidence.nodeCompat overclaims runtime or hardware evidence`);
  }
}

function verifyLifecycleEvidence(report, label) {
  const evidence = report?.evidence?.lifecycle;
  if (!evidence || evidence.status !== 'pass' || evidence.scope !== 'host-lifecycle-control-flow' || evidence.execution !== 'synthetic-switch-control-flow') {
    throw new Error(`${label}.evidence.lifecycle must describe a passing synthetic host lifecycle probe`);
  }
  const wake = evidence.wake;
  if (!wake || wake.gameLive !== true || wake.saveAttempted !== true || wake.saveSucceeded !== true || wake.markerAttempted !== true || wake.markerWritten !== true || wake.chainReload !== 'launched') {
    throw new Error(`${label}.evidence.lifecycle wake control flow is incomplete`);
  }
  const teardown = evidence.teardown;
  if (!teardown || teardown.hadSession !== true || teardown.trackedTimeouts !== 1 || teardown.trackedIntervals !== 1 || teardown.timeoutCancelFailures !== 0 || teardown.intervalCancelFailures !== 0 || teardown.patchRestoreFailures !== 0) {
    throw new Error(`${label}.evidence.lifecycle teardown cleanup is invalid`);
  }
  if (evidence.switchHardware !== 'not-verified' || evidence.externalRuntime !== 'not-verified') {
    throw new Error(`${label}.evidence.lifecycle overclaims hardware or external runtime evidence`);
  }
}

function verifyExternalRuntimeEvidence(report, label) {
  if (!report || typeof report !== 'object') throw new Error(`${label} is missing`);
  if (report.status === 'not-run') {
    if (JSON.stringify(report) !== JSON.stringify(externalRuntimeNotRunReport())) throw new Error(`${label} not-run report is not the explicit default boundary`);
    return;
  }
  try { validateExternalRuntimeReport(report, { requireExternalProcess: true }); }
  catch (error) { throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof report.reportPath !== 'string' || !report.reportPath) throw new Error(`${label}.reportPath is missing`);
}

function verifyPackageRuntimeEvidence(report, label) {
  if (!report || typeof report !== 'object') throw new Error(`${label} is missing`);
  const declared = report.declaredRuntime;
  if (!declared || typeof declared.kind !== 'string' || !['nwjs', 'browser'].includes(declared.kind)) {
    throw new Error(`${label}.declaredRuntime.kind is invalid`);
  }
  if (declared.version !== null && typeof declared.version !== 'string') {
    throw new Error(`${label}.declaredRuntime.version must be a string or null`);
  }
  const actual = report.actualExecution;
  if (!actual || actual.mode !== 'host-runtime' || actual.engine !== 'vm-host-fixture' || typeof actual.version !== 'string' || actual.version.length === 0 || actual.status !== 'observed' || typeof actual.reason !== 'string' || actual.reason.length === 0) {
    throw new Error(`${label}.actualExecution does not describe observed vm host execution`);
  }
  const external = actual.externalRuntime;
  if (!external || external.kind !== declared.kind || external.version !== declared.version || external.status !== 'not-verified' || typeof external.reason !== 'string' || external.reason.length === 0) {
    throw new Error(`${label}.actualExecution.externalRuntime must remain not-verified`);
  }
  if (external.status === 'verified' || actual.status === 'verified') throw new Error(`${label} contains an unearned verified runtime claim`);
}

const requireDebugArtifact = process.env.BURIALNX_REQUIRE_DEBUG_ARTIFACT === '1';
const actual = await generateManifest('burialnx.nro', { project, write: false, requireDebugArtifact });
const stored = JSON.parse(await readFile(manifestPath, 'utf8'));
validateArtifactSet(actual.artifacts, { requireDebugArtifact, label: 'actual release artifact set' });
validateArtifactSet(stored.artifacts, { requireDebugArtifact, label: 'stored release artifact set' });

if (stored.schema !== actual.schema) throw new Error(`release manifest schema mismatch: ${stored.schema} != ${actual.schema}`);
if (stored.package?.name !== actual.package.name || stored.package?.version !== actual.package.version) throw new Error('release manifest package metadata is stale');
if (stored.gitCommit !== actual.gitCommit) throw new Error('release manifest git commit is stale');
if (stored.gitDirty !== actual.gitDirty) throw new Error('release manifest git dirty state is stale');
if (actual.gitDirty) throw new Error('release verification requires a clean worktree');
if (stored.sourceTreeSha256 !== actual.sourceTreeSha256) throw new Error('release manifest source tree hash is stale');
if (stored.toolchain?.lockfileSha256 !== actual.toolchain.lockfileSha256) throw new Error('release manifest lockfile hash is stale');
if (JSON.stringify(stored.artifactSet) !== JSON.stringify(actual.artifactSet)) throw new Error('release manifest artifact-set descriptor is stale');
if (JSON.stringify(stored.artifacts) !== JSON.stringify(actual.artifacts)) throw new Error('release manifest artifact set is stale');
if (JSON.stringify(stored.runtimeProvenance) !== JSON.stringify(actual.runtimeProvenance)) throw new Error('release manifest runtime provenance is stale');
if (actual.runtimeProvenance.status !== 'pass' || actual.runtimeProvenance.verified.some((claim) => claim.status !== 'pass')) throw new Error('runtime provenance gate did not pass');
if (actual.runtimeProvenance.unverified.some((claim) => claim.status !== 'not-verified')) throw new Error('runtime provenance boundary is not explicit');
if (JSON.stringify(stored.browserValidation) !== JSON.stringify(actual.browserValidation)) throw new Error('release manifest browser validation is stale');
if (JSON.stringify(stored.nativeRebuild) !== JSON.stringify(actual.nativeRebuild)) throw new Error('release manifest native rebuild report is stale');
if (JSON.stringify(stored.externalRuntime) !== JSON.stringify(actual.externalRuntime)) throw new Error('release manifest external runtime report is stale');
verifyExternalRuntimeEvidence(stored.externalRuntime, 'stored.externalRuntime');
verifyExternalRuntimeEvidence(actual.externalRuntime, 'actual.externalRuntime');
if (actual.nativeRebuild.status !== 'not-run' && actual.nativeRebuild.projectCommit && actual.nativeRebuild.projectCommit !== actual.gitCommit) throw new Error('native rebuild report project commit does not match the release commit');
if (!['not-run', 'pass', 'mismatch'].includes(actual.nativeRebuild.status)) throw new Error('native rebuild report status is not explicit');
if (actual.nativeRebuild.status === 'mismatch' && actual.validation.native !== 'not verified (executable digest mismatch)') throw new Error('native digest mismatch was not preserved as not verified');
if (actual.nativeRebuild.status === 'pass' && actual.validation.native !== 'source-to-runtime: pass') throw new Error('native pass report was not represented as source-to-runtime pass');
if (actual.nativeRebuild.status === 'not-run' && actual.validation.native !== 'not run') throw new Error('missing native report was not represented as not run');
validateBrowserReport(actual.browserValidation, { expectedCommit: actual.gitCommit, requirePass: true });
if (stored.validation?.browser !== 'desktop-browser: pass' || actual.validation?.browser !== 'desktop-browser: pass') throw new Error('desktop browser validation gate did not pass');
if (stored.artifacts?.nro?.kind !== 'release') throw new Error('release manifest does not describe a release NRO');
if (stored.artifacts?.nro?.sha256 !== actual.artifacts.nro.sha256) throw new Error('release manifest NRO hash is stale');
if (stored.artifacts?.runtimeExecutable?.sha256 !== actual.artifacts.runtimeExecutable.sha256) throw new Error('release manifest executable hash is stale');
if (stored.artifacts?.runtimeExecutable?.expectedSha256 !== actual.artifacts.runtimeExecutable.expectedSha256) throw new Error('release manifest expected runtime hash is stale');
if (stored.nacp?.title !== actual.nacp.title || stored.nacp?.id !== actual.nacp.id) throw new Error('release manifest NACP summary is stale');
if (JSON.stringify(stored.packageAcceptance) !== JSON.stringify(actual.packageAcceptance)) throw new Error('release manifest package acceptance is stale');
if (actual.packageAcceptance.status !== 'pass' || actual.packageAcceptance.executedGameScripts !== false || actual.packageAcceptance.runtimeBehavior !== 'not-observed' || !['validated-only', 'not-declared'].includes(actual.packageAcceptance.checks?.entryScript) || actual.packageAcceptance.checks?.lifecycle !== 'pass' || actual.packageAcceptance.checks?.nodeCompat !== 'pass') throw new Error('generic package contract acceptance gate did not pass');
verifyLifecycleEvidence(stored.packageAcceptance, 'stored.packageAcceptance');
verifyLifecycleEvidence(actual.packageAcceptance, 'actual.packageAcceptance');
verifyNodeCompatEvidence(stored.packageAcceptance, 'stored.packageAcceptance');
verifyNodeCompatEvidence(actual.packageAcceptance, 'actual.packageAcceptance');
const cleanup = actual.packageAcceptance.evidence?.sessionCleanup;
if (!cleanup || cleanup.trackedTimeouts !== cleanup.timeoutCancelAttempts || cleanup.trackedIntervals !== cleanup.intervalCancelAttempts || cleanup.timeoutCancelFailures !== 0 || cleanup.intervalCancelFailures !== 0 || cleanup.patchRestoreFailures !== 0) throw new Error('generic package session cleanup evidence did not pass');
verifyEntryScriptEvidence(actual.packageAcceptance, 'actual.packageAcceptance', 'not-observed');
if (JSON.stringify(stored.packageRuntimeAcceptance) !== JSON.stringify(actual.packageRuntimeAcceptance)) throw new Error('release manifest package runtime acceptance is stale');
verifyPackageRuntimeEvidence(stored.packageRuntimeAcceptance, 'stored.packageRuntimeAcceptance');
verifyPackageRuntimeEvidence(actual.packageRuntimeAcceptance, 'actual.packageRuntimeAcceptance');
verifyEntryScriptEvidence(stored.packageRuntimeAcceptance, 'stored.packageRuntimeAcceptance', 'observed');
verifyEntryScriptEvidence(actual.packageRuntimeAcceptance, 'actual.packageRuntimeAcceptance', 'observed');
if (actual.packageRuntimeAcceptance.status !== 'pass' || actual.packageRuntimeAcceptance.executedGameScripts !== true || actual.packageRuntimeAcceptance.runtimeBehavior !== 'observed' || actual.packageRuntimeAcceptance.checks?.entryScript !== 'pass' || actual.packageRuntimeAcceptance.evidence?.neutralMarkerRequired !== false) throw new Error('generic package runtime acceptance gate did not pass');
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
if (actual.externalRuntime.status === 'not-run' && actual.validation.externalRuntime !== 'not run') throw new Error('missing external runtime report was not represented as not run');
if (actual.externalRuntime.status === 'pass' && actual.validation.externalRuntime !== 'external-runtime-identity: pass') throw new Error('external runtime identity pass was not represented explicitly');
if (stored.validation?.artifacts !== 'release-artifact-set: pass' || actual.validation?.artifacts !== 'release-artifact-set: pass') throw new Error('release artifact-set validation did not pass');
for (const key of ['profile', 'packageAcceptance', 'packageRuntimeAcceptance', 'lifecycle', 'nodeCompat', 'portCheck', 'acceptHost', 'overlayAcceptance', 'reproducibility', 'runtimeProvenance', 'npmTest', 'typecheck', 'structural', 'runtime', 'smoke', 'browser', 'native', 'externalRuntime', 'artifacts', 'hardware']) {
  if (stored.validation?.[key] !== actual.validation?.[key]) throw new Error(`release manifest validation.${key} is stale`);
}
inspectNro(await readFile(resolve(project, 'burialnx.nro')));
console.log(`release verification passed: ${actual.artifacts.nro.path} (${actual.artifacts.nro.sha256})`);

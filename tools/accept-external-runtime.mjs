import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn as defaultSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkPort } from './check-port.mjs';

const fixture = resolve('tests/fixtures/generic-mv/www');
const PROBE_DIR_PREFIX = '.external-runtime-probe-';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function argValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    runtime: null,
    gameRoot: fixture,
    modRoot: null,
    profile: null,
    timeoutMs: 15_000,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runtime') options.runtime = argValue(argv, i++, arg);
    else if (arg === '--game-root') options.gameRoot = argValue(argv, i++, arg);
    else if (arg === '--mod-root') options.modRoot = argValue(argv, i++, arg);
    else if (arg === '--profile') options.profile = argValue(argv, i++, arg);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argValue(argv, i++, arg));
    else if (arg === '--report') options.report = argValue(argv, i++, arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 300_000) {
    throw new Error('--timeout-ms must be an integer from 100 to 300000');
  }
  return options;
}

function versionMatches(declared, observed) {
  if (declared === undefined || declared === null || declared === '') return { matched: true, mode: 'not-declared' };
  if (declared === observed) return { matched: true, mode: 'exact' };
  // Profiles may use a deliberately explicit x/* wildcard, but never infer
  // compatibility from a partial prefix such as "0.29".
  const pattern = String(declared)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[xX]/g, '[^.]+')
    .replace(/\\\*/g, '.*');
  let matched = false;
  try { matched = new RegExp(`^${pattern}$`).test(String(observed)); } catch { matched = false; }
  return { matched, mode: matched ? 'explicit-pattern' : 'mismatch' };
}

function packageBinding(port) {
  const binding = {
    profile: {
      id: port.profile.id,
      sha256: port.profile.sha256,
      runtime: port.profile.runtime,
    },
    entry: {
      path: port.entry.path,
      bytes: port.entry.bytes,
      sha256: port.entry.sha256,
    },
    scripts: port.scriptGraph.files.map(file => ({ path: file.path, root: file.root, sha256: file.sha256 })),
    package: port.contracts.package,
  };
  return { ...binding, sha256: sha256(Buffer.from(JSON.stringify(binding))) };
}

function reportBase(port, reason) {
  return {
    schema: 1,
    tool: 'accept:external-runtime',
    status: 'not-verified',
    scope: 'external-runtime-identity',
    execution: 'not-run',
    reason,
    environment: { mode: 'external-runtime', switch: 'not-available', hardware: 'not-verified' },
    declaredRuntime: port.profile.runtime,
    package: {
      profileId: port.profile.id,
      entry: port.entry.path,
      packageBindingSha256: packageBinding(port).sha256,
      bindingSource: 'host-port-check',
      probeBinding: 'not-run',
      gameScriptsExecuted: false,
      compatibility: 'not-verified',
    },
    switchRuntime: 'not-verified',
    nativeSourceRebuild: 'not-verified',
    hardware: 'not-verified',
    commercialGame: 'not-verified',
  };
}

const probeScript = String.raw`(() => {
  const fs = require('fs');
  const crypto = require('crypto');
  const path = require('path');
  const configPath = process.env.BURIALNX_EXTERNAL_RUNTIME_CONFIG || path.join(process.cwd(), 'burialnx-external-runtime-probe.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const executable = fs.readFileSync(process.execPath);
  const result = {
    schema: 1,
    nonce: config.nonce,
    probeLoaded: true,
    observedRuntime: {
      kind: process.versions && process.versions.nw ? 'nwjs' : 'unknown',
      version: process.versions && process.versions.nw ? String(process.versions.nw) : null,
      processVersions: { ...(process.versions || {}) },
      execPath: process.execPath,
      executableSha256: crypto.createHash('sha256').update(executable).digest('hex'),
      nwGlobal: typeof nw === 'object' && nw !== null,
    },
    packageBindingSha256: config.packageBindingSha256,
    gameScriptsExecuted: false,
  };
  fs.writeFileSync(config.resultPath, JSON.stringify(result) + '\\n');
  try {
    if (globalThis.nw && nw.App && typeof nw.App.quit === 'function') nw.App.quit();
    else process.exit(0);
  } catch (_) {
    process.exit(0);
  }
})();`;

async function writeProbePackage(dir, config) {
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: 'burialnx-external-runtime-probe',
    version: '1.0.0',
    main: 'index.html',
    nodejs: true,
  }, null, 2)}\n`);
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><script src="probe.js"></script></body></html>\n');
  await writeFile(join(dir, 'probe.js'), `${probeScript}\n`);
  await writeFile(join(dir, 'burialnx-external-runtime-probe.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function collectOutput(stream) {
  if (!stream || typeof stream.on !== 'function') return () => '';
  let output = '';
  stream.on('data', chunk => { output += String(chunk); });
  return () => output;
}

function runExternal(runtimePath, probeDir, env, timeoutMs, spawnImpl = defaultSpawn) {
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let killGraceTimer;
    const child = spawnImpl(runtimePath, [probeDir], {
      cwd: probeDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const getStdout = collectOutput(child.stdout);
    const getStderr = collectOutput(child.stderr);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      if (error) rejectRun(error);
      else resolveRun({ ...value, stdout: getStdout(), stderr: getStderr() });
    };
    const onClose = (code, signal) => {
      if (timedOut) finish(new Error(`external runtime timed out after ${timeoutMs}ms`));
      else finish(null, { code, signal });
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill?.('SIGKILL'); } catch { /* best-effort */ }
      // A real ChildProcess emits close after SIGKILL. Keep a bounded grace
      // period for an adapter that does not emit close, then fail closed.
      killGraceTimer = setTimeout(() => finish(new Error(`external runtime timed out after ${timeoutMs}ms`)), 250);
    }, timeoutMs);
    child.once?.('error', error => finish(error));
    // `close` is the completion event: it follows process exit and stdio
    // shutdown. Do not accept an earlier `exit` event because diagnostics or
    // a later non-zero close status could still be pending.
    child.once?.('close', onClose);
  });
}

async function readJson(path, label) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { throw new Error(`${label} is missing: ${error instanceof Error ? error.message : String(error)}`); }
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

async function validateProbeResult(result, { nonce, runtimePath, runtimeSha256, packageSha256, declaredRuntime }) {
  assert(result && typeof result === 'object' && !Array.isArray(result), 'external runtime probe result must be an object');
  assert(result.schema === 1, 'external runtime probe result schema is invalid');
  assert(result.nonce === nonce, 'external runtime probe nonce mismatch');
  assert(result.probeLoaded === true, 'external runtime did not load the probe');
  const observed = result.observedRuntime;
  assert(observed && observed.kind === 'nwjs', 'external runtime did not identify itself as NW.js');
  assert(typeof observed.version === 'string' && observed.version.length > 0, 'external runtime version is missing');
  assert(observed.processVersions && typeof observed.processVersions === 'object' && !Array.isArray(observed.processVersions), 'external runtime process versions are missing');
  assert(typeof observed.processVersions.nw === 'string' && observed.processVersions.nw.length > 0, 'external runtime process.versions.nw is missing');
  assert(observed.processVersions.nw === observed.version, 'external runtime process.versions.nw does not match observed version');
  assert(observed.nwGlobal === true, 'NW.js global was not observed');
  assert(typeof observed.execPath === 'string' && observed.execPath.length > 0, 'external runtime execPath is missing');
  assert(typeof observed.executableSha256 === 'string' && /^[0-9a-f]{64}$/i.test(observed.executableSha256), 'external runtime executable digest is missing');
  assert(observed.executableSha256.toLowerCase() === runtimeSha256, 'external runtime executable digest mismatch');
  let observedPath;
  try { observedPath = await realpath(observed.execPath); }
  catch { observedPath = null; }
  assert(observedPath === runtimePath, 'external runtime execPath does not match the requested executable');
  assert(result.packageBindingSha256 === packageSha256, 'external runtime package binding mismatch');
  assert(result.gameScriptsExecuted === false, 'identity probe cannot claim game script execution');
  const version = versionMatches(declaredRuntime.version, observed.version);
  assert(version.matched, `external runtime version mismatch: ${observed.version} does not match ${declaredRuntime.version}`);
  return { observed, version };
}

export function validateExternalRuntimeReport(report, { requireExternalProcess = false } = {}) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'external runtime report must be an object');
  assert(report.schema === 1, 'external runtime report schema is invalid');
  assert(report.tool === 'accept:external-runtime', 'external runtime report tool is invalid');
  assert(report.status === 'pass', 'external runtime report must be a passing report');
  assert(report.scope === 'external-runtime-identity', 'external runtime report scope is invalid');
  assert(requireExternalProcess ? report.execution === 'external-process-probe' : ['external-process-probe', 'injected-process-test'].includes(report.execution), 'external runtime report execution mode is invalid');
  assert(report.environment?.mode === 'external-runtime' && report.environment?.switch === 'not-available' && report.environment?.hardware === 'not-verified', 'external runtime report environment boundary is invalid');
  assert(report.declaredRuntime?.kind === 'nwjs', 'external runtime declared kind is invalid');
  assert(report.declaredRuntime.version === null || typeof report.declaredRuntime.version === 'string', 'external runtime declared version is invalid');
  assert(report.observedRuntime?.kind === 'nwjs' && report.observedRuntime.status === 'observed', 'external runtime observed identity is invalid');
  assert(typeof report.observedRuntime.version === 'string' && report.observedRuntime.version.length > 0, 'external runtime observed version is missing');
  assert(report.observedRuntime.processVersions && typeof report.observedRuntime.processVersions === 'object' && !Array.isArray(report.observedRuntime.processVersions) && typeof report.observedRuntime.processVersions.nw === 'string' && report.observedRuntime.processVersions.nw === report.observedRuntime.version, 'external runtime process.versions.nw is inconsistent');
  const version = versionMatches(report.declaredRuntime.version, report.observedRuntime.version);
  assert(version.matched && version.mode === report.observedRuntime.versionMatch, 'external runtime declared/observed version match is inconsistent');
  assert(typeof report.observedRuntime.execPath === 'string' && report.observedRuntime.execPath.length > 0, 'external runtime execPath is missing');
  assert(typeof report.observedRuntime.executableSha256 === 'string' && /^[0-9a-f]{64}$/i.test(report.observedRuntime.executableSha256), 'external runtime executable digest is invalid');
  assert(typeof report.package?.profileId === 'string' && report.package.profileId.length > 0 && typeof report.package.entry === 'string' && report.package.entry.length > 0, 'external runtime package binding identity is invalid');
  assert(report.package.bindingSource === 'host-port-check' && report.package.probeBinding === 'host-provided-echo', 'external runtime package binding provenance is invalid');
  assert(typeof report.package.packageBindingSha256 === 'string' && /^[0-9a-f]{64}$/i.test(report.package.packageBindingSha256), 'external runtime package binding digest is invalid');
  assert(report.package.gameScriptsExecuted === false && report.package.compatibility === 'not-verified', 'external runtime report overclaims package execution or compatibility');
  assert(typeof report.probe?.nonce === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(report.probe.nonce), 'external runtime probe nonce is invalid');
  assert(report.probe.exited === true && report.probe.exitCode === 0 && report.probe.signal === null && Number.isInteger(report.probe.timeoutMs) && report.probe.timeoutMs >= 100, 'external runtime probe completion is invalid');
  for (const [key, expected] of [['switchRuntime', 'not-verified'], ['nativeSourceRebuild', 'not-verified'], ['hardware', 'not-verified'], ['commercialGame', 'not-verified']]) {
    assert(report[key] === expected, `external runtime report ${key} boundary is invalid`);
  }
  return report;
}

export async function acceptExternalRuntime({
  runtime = null,
  gameRoot = fixture,
  modRoot = null,
  profile = null,
  timeoutMs = 15_000,
  spawnImpl = defaultSpawn,
} = {}) {
  const port = await checkPort({ gameRoot, modRoot, profile, manifest: null });
  const base = reportBase(port, runtime ? null : 'no external runtime executable was supplied');
  if (!runtime) return base;
  if (port.profile.runtime.kind !== 'nwjs') {
    return { ...base, reason: `external runtime probe supports runtime.kind nwjs, got ${port.profile.runtime.kind}` };
  }

  const requestedRuntime = resolve(runtime);
  let runtimePath;
  try { runtimePath = await realpath(requestedRuntime); }
  catch (error) { throw new Error(`external runtime executable is not accessible: ${error instanceof Error ? error.message : String(error)}`); }
  await access(runtimePath, constants.R_OK | constants.X_OK);
  const runtimeInfo = await stat(runtimePath);
  assert(runtimeInfo.isFile(), `external runtime is not a regular executable: ${runtimePath}`);
  const runtimeBytes = await readFile(runtimePath);
  const runtimeSha256 = sha256(runtimeBytes);
  const binding = packageBinding(port);
  const nonce = randomUUID();
  const probeDir = await mkdtemp(join(resolve('.'), PROBE_DIR_PREFIX));
  const resultPath = join(probeDir, 'burialnx-external-runtime-result.json');
  try {
    await writeProbePackage(probeDir, {
      schema: 1,
      nonce,
      resultPath,
      packageBindingSha256: binding.sha256,
    });
    const run = await runExternal(runtimePath, probeDir, {
      BURIALNX_EXTERNAL_RUNTIME_NONCE: nonce,
      BURIALNX_EXTERNAL_RUNTIME_RESULT: resultPath,
      BURIALNX_EXTERNAL_RUNTIME_CONFIG: join(probeDir, 'burialnx-external-runtime-probe.json'),
    }, timeoutMs, spawnImpl);
    assert(run.code === 0, `external runtime exited unsuccessfully: code=${run.code} signal=${run.signal || 'none'}${run.stderr ? ` stderr=${run.stderr.trim()}` : ''}`);
    const result = await readJson(resultPath, 'external runtime probe result');
    const validated = await validateProbeResult(result, {
      nonce,
      runtimePath,
      runtimeSha256,
      packageSha256: binding.sha256,
      declaredRuntime: port.profile.runtime,
    });
    const freshPort = await checkPort({ gameRoot, modRoot, profile, manifest: null });
    assert(packageBinding(freshPort).sha256 === binding.sha256, 'game package changed during external runtime acceptance');
    return {
      schema: 1,
      tool: 'accept:external-runtime',
      status: 'pass',
      scope: 'external-runtime-identity',
      execution: spawnImpl === defaultSpawn ? 'external-process-probe' : 'injected-process-test',
      environment: { mode: 'external-runtime', switch: 'not-available', hardware: 'not-verified' },
      declaredRuntime: port.profile.runtime,
      observedRuntime: {
        kind: validated.observed.kind,
        version: validated.observed.version,
        versionMatch: validated.version.mode,
        processVersions: validated.observed.processVersions,
        execPath: runtimePath,
        executableSha256: runtimeSha256,
        status: 'observed',
      },
      package: {
        profileId: port.profile.id,
        entry: port.entry.path,
        packageBindingSha256: binding.sha256,
        bindingSource: 'host-port-check',
        probeBinding: 'host-provided-echo',
        gameScriptsExecuted: false,
        compatibility: 'not-verified',
      },
      probe: { nonce, exited: true, exitCode: run.code, signal: run.signal ?? null, timeoutMs },
      switchRuntime: 'not-verified',
      nativeSourceRebuild: 'not-verified',
      hardware: 'not-verified',
      commercialGame: 'not-verified',
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node tools/accept-external-runtime.mjs [--runtime <nwjs>] [--game-root <www>] [--mod-root <dir>] [--profile <file>] [--timeout-ms <ms>] [--report <file>]');
    } else {
      const report = await acceptExternalRuntime(options);
      if (options.report) await writeFile(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    console.error(`external runtime acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { parseArgs, versionMatches, packageBinding, validateProbeResult };

import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPort, containedFile } from './check-port.mjs';
import { loadBundledModule } from './ts-bundle.mjs';
import { entryScriptEvidence } from './entry-script-evidence.mjs';

const fixture = resolve('tests/fixtures/generic-mv/www');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = { gameRoot: fixture, modRoot: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--game-root') options.gameRoot = argv[++i];
    else if (argv[i] === '--mod-root') options.modRoot = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

export async function acceptPackageRuntime({ gameRoot = fixture, modRoot = null } = {}) {
  const port = await checkPort({ gameRoot, modRoot, profile: null, manifest: null });
  const runtimePlan = await loadBundledModule('src/runtime-plan.ts');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  const executedScripts = [];
  for (const file of port.scriptGraph.files) {
    const root = port.roots[file.root];
    const bytes = await containedFile(root, file.path, `script ${file.path}`, false);
    vm.runInNewContext(new TextDecoder().decode(bytes), sandbox, { filename: `${file.root}/${file.path}` });
    executedScripts.push(file.path);
  }
  const entryScript = entryScriptEvidence({ profile: { entry: { script: port.contracts.entryScript.path } }, scriptGraph: port.scriptGraph.paths, executedScripts });
  assert(sandbox.__genericRuntimeFixtureLoaded === true, 'generic entry script did not execute');
  const startup = runtimePlan.startGame(sandbox);
  assert(['onload', 'already-started', 'scene-boot'].includes(startup), `unsupported runtime start result: ${startup}`);
  if (startup === 'scene-boot') {
    assert(sandbox.SceneManager?.started === true, 'SceneManager did not observe the boot start');
    assert(sandbox.SceneManager?._scene?.constructor?.name === 'Scene_Boot', 'Scene_Boot was not instantiated');
  }
  return {
    schema: 1,
    status: 'pass',
    tool: 'accept:package:runtime',
    environment: { mode: 'host-runtime', switch: 'not-available', hardware: 'not-verified' },
    fixture: gameRoot,
    executedGameScripts: true,
    runtimeBehavior: 'observed',
    declaredRuntime: {
      kind: port.profile.runtime.kind,
      version: port.profile.runtime.version ?? null,
    },
    actualExecution: {
      mode: 'host-runtime',
      engine: 'vm-host-fixture',
      version: process.version,
      status: 'observed',
      reason: 'ordered game scripts executed in the Node vm host fixture',
      externalRuntime: {
        kind: port.profile.runtime.kind,
        version: port.profile.runtime.version ?? null,
        status: 'not-verified',
        reason: 'no external runtime process was launched or version-verified',
      },
    },
    checks: {
      profile: 'pass',
      entry: 'pass',
      scriptGraph: 'pass',
      entryScript: entryScript.execution.status === 'observed' ? 'pass' : 'not-declared',
      scriptExecution: 'pass',
      runtimeStart: 'pass',
    },
    evidence: {
      profileId: port.profile.id,
      entry: port.entry.path,
      scripts: executedScripts,
      entryScript,
      startup,
      scene: startup === 'scene-boot' ? 'Scene_Boot' : null,
      neutralMarkerRequired: false,
    },
  };
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node tools/accept-package-runtime.mjs [--game-root <www>] [--mod-root <dir>]');
    else console.log(JSON.stringify(await acceptPackageRuntime(options), null, 2));
  } catch (error) {
    console.error(`package runtime acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { parseArgs };

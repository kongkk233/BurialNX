import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBundledModule } from './ts-bundle.mjs';

const PROFILE_NAME = 'burialnx.port.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function safeRelative(value) {
  let path;
  try { path = decodeURIComponent(String(value)); } catch { return null; }
  if (!path || path.startsWith('/') || /[\\:\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function optionalBytes(path) {
  try { return await readFile(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function requiredBytes(path, label) {
  const bytes = await optionalBytes(path);
  if (!bytes) throw new Error(`${label} is missing: ${path}`);
  return bytes;
}

function parseArgs(argv) {
  const options = { gameRoot: null, modRoot: null, profile: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--game-root') options.gameRoot = argv[++i];
    else if (arg === '--mod-root') options.modRoot = argv[++i];
    else if (arg === '--profile') options.profile = argv[++i];
    else if (arg === '--manifest') options.manifest = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function loadProfile(api, gameRoot, modRoot, explicitPath) {
  if (explicitPath) {
    const path = resolve(explicitPath);
    const bytes = await requiredBytes(path, 'profile');
    return { profile: api.parsePortProfileBytes(bytes), source: path, bytes };
  }
  for (const [label, root] of [['mod', modRoot], ['game', gameRoot]]) {
    if (!root) continue;
    const path = resolve(root, PROFILE_NAME);
    const bytes = await optionalBytes(path);
    if (bytes) return { profile: api.parsePortProfileBytes(bytes), source: `${label}:${path}`, bytes };
  }
  const profile = api.defaultPortProfile;
  return { profile, source: 'default', bytes: Buffer.from(JSON.stringify(profile)) };
}

export async function checkPort(options) {
  const api = await loadBundledModule('src/port-profile.ts');
  const runtime = await loadBundledModule('src/runtime-plan.ts');
  const gameRoot = resolve(options.gameRoot);
  const modRoot = options.modRoot ? resolve(options.modRoot) : null;
  const roots = modRoot ? [['mod', modRoot], ['game', gameRoot]] : [['game', gameRoot]];
  for (const [, root] of roots) {
    await access(root, constants.R_OK);
  }
  const loaded = await loadProfile(api, gameRoot, modRoot, options.profile);
  const profile = loaded.profile;
  const readOverlay = async (relativePath, label) => {
    const safe = safeRelative(relativePath);
    if (!safe) throw new Error(`${label} is not a safe relative path: ${relativePath}`);
    for (const [rootLabel, root] of roots) {
      const candidate = resolve(root, safe);
      if (!inside(root, candidate)) throw new Error(`${label} escapes ${rootLabel} root: ${relativePath}`);
      const bytes = await optionalBytes(candidate);
      if (bytes) return { root: rootLabel, path: candidate, relative: safe, bytes };
    }
    return null;
  };

  const entry = await readOverlay(profile.entry.html, 'entry.html');
  if (!entry) throw new Error(`entry HTML is missing from game/mod roots: ${profile.entry.html}`);
  const html = new TextDecoder().decode(entry.bytes);
  const scripts = runtime.scriptPlan(html);
  if (profile.entry.script && !scripts.includes(profile.entry.script)) {
    throw new Error(`entry.script is not present in entry HTML script graph: ${profile.entry.script}`);
  }
  const scriptFiles = [];
  for (const script of scripts) {
    const file = await readOverlay(script, `script ${script}`);
    if (!file) throw new Error(`entry script is missing: ${script}`);
    scriptFiles.push({ path: script, root: file.root, bytes: file.bytes, sha256: sha256(file.bytes) });
  }
  const result = {
    schema: 1,
    status: 'pass',
    tool: 'port:check',
    environment: { mode: 'host-only', switch: 'not-available', hardware: 'not-verified' },
    roots: { game: gameRoot, mod: modRoot },
    profile: {
      source: loaded.source,
      sha256: sha256(loaded.bytes),
      id: profile.id,
      version: profile.version,
      runtime: profile.runtime,
      compat: profile.compat,
      package: profile.package,
    },
    entry: { path: profile.entry.html, root: entry.root, bytes: entry.bytes.byteLength, sha256: sha256(entry.bytes) },
    scriptGraph: { count: scripts.length, paths: scripts, files: scriptFiles.map(({ path, root, sha256: hash }) => ({ path, root, sha256: hash })) },
    contracts: {
      asset: { status: 'pass', hashedLookup: profile.assets.hashedLookup, envelope: profile.assets.envelope?.algorithm ?? null },
      media: { status: 'pass', extensionFallback: profile.media.extensionFallback, variantFallback: profile.media.variantFallback },
      save: { status: 'pass', directory: profile.save.directory, extension: profile.save.extension },
      entryScript: { status: profile.entry.script ? 'pass' : 'not-declared', path: profile.entry.script ?? null },
      metadataOnly: ['runtime.version', 'compat.mv', 'compat.nwjs', 'package.name', 'package.version'],
    },
  };
  if (options.manifest) {
    const output = resolve(options.manifest);
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    result.manifest = output;
  }
  return result;
}

function cliPath() {
  return process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
}

if (import.meta.url === cliPath()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.gameRoot) {
      console.log('Usage: npm run port:check -- --game-root <www> [--mod-root <dir>] [--profile <file>] [--manifest <file>]');
      if (!options.help) process.exitCode = 2;
    } else {
      console.log(JSON.stringify(await checkPort(options), null, 2));
    }
  } catch (error) {
    console.error(`port check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { parseArgs, safeRelative };

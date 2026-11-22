import { createHash } from 'node:crypto';
import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBundledModule } from './ts-bundle.mjs';
import { parseProfileBytes } from './profile-schema.mjs';

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

async function safeRegularFile(path, label, optional = true) {
  const absolute = resolve(path);
  try {
    const parent = resolve(dirname(absolute));
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== parent) throw new Error(`${label} parent resolves through a symlink: ${path}`);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
    if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    return await readFile(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' && optional) return null;
    throw error;
  }
}

async function containedFile(root, relativePath, label, optional = true) {
  const safe = safeRelative(relativePath);
  if (!safe) throw new Error(`${label} is not a safe relative path: ${relativePath}`);
  const base = resolve(root);
  const candidate = resolve(base, safe);
  if (!inside(base, candidate)) throw new Error(`${label} escapes package root: ${relativePath}`);
  try {
    const canonical = await realpath(candidate);
    if (canonical !== candidate) throw new Error(`${label} resolves through a symlink: ${relativePath}`);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${relativePath}`);
    if (!info.isFile()) throw new Error(`${label} is not a regular file: ${relativePath}`);
    return await readFile(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' && optional) return null;
    throw error;
  }
}

async function requiredBytes(path, label) {
  const bytes = await safeRegularFile(path, label, false);
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
    return { profile: api.parsePortProfile(parseProfileBytes(bytes, path)), source: path, bytes };
  }
  for (const [label, root] of [['mod', modRoot], ['game', gameRoot]]) {
    if (!root) continue;
    const path = resolve(root, PROFILE_NAME);
    const bytes = await containedFile(root, PROFILE_NAME, `${label} profile`);
    if (bytes) return { profile: api.parsePortProfile(parseProfileBytes(bytes, `${label}:${path}`)), source: `${label}:${path}`, bytes };
  }
  const profile = api.defaultPortProfile;
  return { profile, source: 'default', bytes: Buffer.from(JSON.stringify(profile)) };
}

export async function checkPort(options) {
  const api = await loadBundledModule('src/port-profile.ts');
  const runtime = await loadBundledModule('src/runtime-plan.ts');
  const gameRoot = await realpath(resolve(options.gameRoot));
  const modRoot = options.modRoot ? await realpath(resolve(options.modRoot)) : null;
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
      const bytes = await containedFile(root, safe, `${label} in ${rootLabel} root`);
      if (bytes) return { root: rootLabel, path: resolve(root, safe), relative: safe, bytes };
    }
    return null;
  };

  let packageManifest = null;
  let packageMetadata = null;
  if (profile.package.manifest) {
    packageManifest = await readOverlay(profile.package.manifest, 'package manifest');
    if (!packageManifest) throw new Error(`package manifest is missing: ${profile.package.manifest}`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(packageManifest.bytes)); }
    catch (error) { throw new Error(`package manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package manifest must be a JSON object');
    if (typeof parsed.name !== 'string' || parsed.name !== profile.package.name) {
      throw new Error(`package manifest name mismatch: ${String(parsed.name)} != ${profile.package.name}`);
    }
    if (typeof parsed.version !== 'string' || parsed.version !== profile.package.version) {
      throw new Error(`package manifest version mismatch: ${String(parsed.version)} != ${profile.package.version}`);
    }
    packageMetadata = { name: parsed.name, version: parsed.version };
  }

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
  const packageContract = packageManifest ? {
    status: 'pass',
    identity: 'verified',
    manifest: {
      path: profile.package.manifest,
      root: packageManifest.root,
      bytes: packageManifest.bytes.byteLength,
      sha256: sha256(packageManifest.bytes),
      ...packageMetadata,
    },
  } : {
    status: 'not-declared',
    identity: 'metadata-only',
    manifest: null,
  };
  const classification = {
    enforced: [
      'entry.html', 'scriptGraph', 'asset.pathSafety', 'media.policy', 'save.contract', 'compatibility.flags',
      ...(packageManifest ? ['package.manifest', 'package.name', 'package.version'] : []),
    ],
    validatedOnly: ['entry.script'],
    metadataOnly: [
      'runtime.kind', 'runtime.version',
      ...(packageManifest ? [] : ['package.name', 'package.version']),
    ],
    notObserved: ['targetGameRuntime', 'nativeDecoder', 'switchHardware'],
  };
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
      compatibility: { status: 'pass', mv: profile.compat.mv, node: profile.compat.node, nwjs: profile.compat.nwjs, appliedAt: 'game-launch' },
      package: packageContract,
      entryScript: { status: profile.entry.script ? 'pass' : 'not-declared', path: profile.entry.script ?? null },
      classification,
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

export { containedFile, parseArgs, safeRelative };

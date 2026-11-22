import type { Reader } from './library';

/** Portable contract for an RPG Maker MV/NW.js port. No game-specific assets are implied. */
export const PORT_PROFILE_VERSION = 1 as const;
export const PORT_PROFILE_FILENAME = 'burialnx.port.json' as const;

export interface AssetEnvelopeProfile {
  magic: string;
  headerBytes: number;
  lengthByteOffset: number;
  algorithm: 'basename-xor-v1';
}

export interface PortProfile {
  version: 1;
  id: string;
  runtime: { kind: 'nwjs' | 'browser'; version?: string };
  entry: { html: string; script?: string };
  compat: { mv: boolean; nwjs: boolean; node?: boolean };
  assets: { hashedLookup: boolean; envelope?: AssetEnvelopeProfile };
  media: {
    extensionFallback: string[];
    variantFallback: string[];
  };
  save: { directory: string; extension: string };
  package: { name: string; version: string };
}

/** JSON-facing input type. Values are intentionally unknown until validated. */
export interface PortProfileInput {
  version?: unknown;
  id?: unknown;
  runtime?: unknown;
  entry?: unknown;
  compat?: unknown;
  assets?: unknown;
  media?: unknown;
  save?: unknown;
  package?: unknown;
}

export interface LoadedPortProfile {
  profile: PortProfile;
  source: 'default' | typeof PORT_PROFILE_FILENAME;
}

export type ProfileRead = (path: string) => ArrayBuffer | Uint8Array | null | Promise<ArrayBuffer | Uint8Array | null>;
export type ProfileReadSync = (path: string) => ArrayBuffer | Uint8Array | null;

const DEFAULT_MEDIA = { extensionFallback: ['webm', 'mp4'], variantFallback: ['-l'] };
export const defaultPortProfile: PortProfile = {
  version: PORT_PROFILE_VERSION,
  id: 'minimal-mv',
  runtime: { kind: 'nwjs' },
  entry: { html: 'index.html' },
  compat: { mv: true, nwjs: true, node: true },
  assets: { hashedLookup: true },
  media: { ...DEFAULT_MEDIA },
  save: { directory: 'save', extension: '.rpgsave' },
  package: { name: 'rpg-maker-port', version: '0.0.0' },
};

function fail(path: string, message: string): never { throw new Error(`Invalid port profile at ${path}: ${message}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
}
function noUnknown(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) fail(`${path}.${key}`, 'unknown field');
}
function text(value: unknown, path: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected a non-empty string');
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) fail(path, 'must not contain control characters');
  return value;
}
function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}
function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value as number;
}
function list(value: unknown, path: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) fail(path, 'expected a string array');
  return [...value] as string[];
}
function relativePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.startsWith('/') || result.includes('\\') || result.includes(':') || result.split('/').some(part => part === '.' || part === '..' || !part)) {
    fail(path, 'must be a relative path without traversal');
  }
  return result;
}
function extension(value: string, path: string): string {
  const normalized = value.startsWith('.') ? value : `.${value}`;
  if (!/^\.[a-z0-9][a-z0-9._-]*$/i.test(normalized)) fail(path, 'entries must be safe file extensions');
  return normalized;
}
function variant(value: string, path: string): string {
  if (!value || value.startsWith('.') || /[/\\]/.test(value) || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) {
    fail(path, 'entries must be safe filename variants without path traversal');
  }
  return value;
}

/** Validate and normalize an untrusted JSON profile with stable, readable errors. */
export function parsePortProfile(input: unknown): PortProfile {
  const root = object(input, '$');
  noUnknown(root, '$', ['version', 'id', 'runtime', 'entry', 'compat', 'assets', 'media', 'save', 'package']);
  if (root.version !== PORT_PROFILE_VERSION) fail('$.version', `expected ${PORT_PROFILE_VERSION}`);
  const runtime = object(root.runtime, '$.runtime');
  noUnknown(runtime, '$.runtime', ['kind', 'version']);
  const runtimeKind = runtime.kind;
  if (runtimeKind !== 'nwjs' && runtimeKind !== 'browser') fail('$.runtime.kind', "expected 'nwjs' or 'browser'");
  const entry = object(root.entry, '$.entry');
  noUnknown(entry, '$.entry', ['html', 'script']);
  const compat = object(root.compat, '$.compat');
  noUnknown(compat, '$.compat', ['mv', 'nwjs', 'node']);
  const assets = root.assets === undefined ? {} : object(root.assets, '$.assets');
  noUnknown(assets, '$.assets', ['hashedLookup', 'envelope']);
  const media = root.media === undefined ? {} : object(root.media, '$.media');
  noUnknown(media, '$.media', ['extensionFallback', 'variantFallback']);
  const save = object(root.save, '$.save');
  noUnknown(save, '$.save', ['directory', 'extension']);
  const pkg = object(root.package, '$.package');
  noUnknown(pkg, '$.package', ['name', 'version']);
  const extensionFallback = list(media.extensionFallback, '$.media.extensionFallback', DEFAULT_MEDIA.extensionFallback).map((value, i) => extension(value, `$.media.extensionFallback[${i}]`));
  const variantFallback = list(media.variantFallback, '$.media.variantFallback', DEFAULT_MEDIA.variantFallback).map((value, i) => variant(value, `$.media.variantFallback[${i}]`));
  let envelope: AssetEnvelopeProfile | undefined;
  if (assets.envelope !== undefined) {
    const rawEnvelope = object(assets.envelope, '$.assets.envelope');
    noUnknown(rawEnvelope, '$.assets.envelope', ['magic', 'headerBytes', 'lengthByteOffset', 'algorithm']);
    const magic = text(rawEnvelope.magic, '$.assets.envelope.magic');
    if (magic.length > 64 || !/^[\x20-\x7e]+$/.test(magic)) fail('$.assets.envelope.magic', 'must contain at most 64 printable ASCII characters');
    const headerBytes = integer(rawEnvelope.headerBytes, '$.assets.envelope.headerBytes', magic.length, 4096);
    const lengthByteOffset = integer(rawEnvelope.lengthByteOffset, '$.assets.envelope.lengthByteOffset', 0, headerBytes - 1);
    if (rawEnvelope.algorithm !== 'basename-xor-v1') fail('$.assets.envelope.algorithm', "expected 'basename-xor-v1'");
    envelope = { magic, headerBytes, lengthByteOffset, algorithm: 'basename-xor-v1' };
  }
  return {
    version: PORT_PROFILE_VERSION,
    id: (() => {
      const id = text(root.id, '$.id');
      if (/[\u0000-\u001f\u007f\/:]/.test(id)) fail('$.id', 'must not contain control characters, slashes, or a colon');
      return id;
    })(),
    runtime: { kind: runtimeKind, ...(runtime.version === undefined ? {} : { version: text(runtime.version, '$.runtime.version') }) },
    entry: { html: relativePath(entry.html, '$.entry.html'), ...(entry.script === undefined ? {} : { script: relativePath(entry.script, '$.entry.script') }) },
    compat: { mv: bool(compat.mv, '$.compat.mv', true), nwjs: bool(compat.nwjs, '$.compat.nwjs', true), node: bool(compat.node, '$.compat.node', true) },
    assets: { hashedLookup: bool(assets.hashedLookup, '$.assets.hashedLookup', true), ...(envelope ? { envelope } : {}) },
    media: { extensionFallback, variantFallback },
    save: { directory: relativePath(save.directory, '$.save.directory'), extension: extension(text(save.extension, '$.save.extension'), '$.save.extension') },
    package: { name: text(pkg.name, '$.package.name'), version: text(pkg.version, '$.package.version') },
  };
}

/** Parse a profile file's bytes with a stable error prefix. */
export function parsePortProfileBytes(raw: ArrayBuffer | Uint8Array): PortProfile {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)); }
  catch (error) { throw new Error(`Invalid port profile at ${PORT_PROFILE_FILENAME}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
  return parsePortProfile(value);
}

/** Read the optional profile from the selected game/mod overlay. */
export async function loadPortProfile(reader: Reader): Promise<LoadedPortProfile> {
  const raw = await reader.read(PORT_PROFILE_FILENAME);
  if (raw === null) return { profile: defaultPortProfile, source: 'default' };
  return { profile: parsePortProfileBytes(raw), source: PORT_PROFILE_FILENAME };
}

/** Read profile control files with mod-first overlay precedence, without routing them through asset lookup. */
export async function loadPortProfileFromRoots(roots: readonly string[], read: ProfileRead): Promise<LoadedPortProfile> {
  for (const root of roots) {
    const clean = root.replace(/\/+$/, '');
    if (!clean) continue;
    const raw = await read(`${clean}/${PORT_PROFILE_FILENAME}`);
    if (raw !== null) return { profile: parsePortProfileBytes(raw), source: PORT_PROFILE_FILENAME };
  }
  return { profile: defaultPortProfile, source: 'default' };
}

/** Synchronous counterpart for pre-launch save discovery before the async loader starts. */
export function loadPortProfileFromRootsSync(roots: readonly string[], read: ProfileReadSync): LoadedPortProfile {
  for (const root of roots) {
    const clean = root.replace(/\/+$/, '');
    if (!clean) continue;
    const raw = read(`${clean}/${PORT_PROFILE_FILENAME}`);
    if (raw !== null) return { profile: parsePortProfileBytes(raw), source: PORT_PROFILE_FILENAME };
  }
  return { profile: defaultPortProfile, source: 'default' };
}

export function mediaPolicyFromProfile(profile: PortProfile): { extensionFallback: readonly string[]; variantFallback: readonly string[] } {
  return profile.media;
}

import { assetPath, type Reader } from './library';
import type { AssetEnvelopeProfile } from './port-profile';

export type AssetEnvelopePolicy = AssetEnvelopeProfile;

export interface AssetPolicy {
        hashedLookup?: boolean;
        envelope?: AssetEnvelopePolicy;
}

/** Resolve the on-disk path(s) for an asset, trying plain names first then the hashed name. */
export async function gameAssetNames(path: string): Promise<string[]> {
        const safe = assetPath(path);
        if (!safe) throw new Error('Unsafe asset path');
        return namesForSafePath(safe);
}

async function namesForSafePath(safe: string): Promise<string[]> {
        const withoutExtension = safe.replace(/\.[^/.]+$/, '');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(safe));
        const hash = Array.from(new Uint8Array(digest).slice(0, 8), (n) => n.toString(16).padStart(2, '0')).join('');
        const parts = safe.split('/');
        const filename = parts.pop()!;
        parts.push(`${filename.startsWith('!') ? '!' : ''}${hash}${filename.toUpperCase().includes('[BUST]') ? '[BUST]' : ''}`);
        return [...new Set([safe, withoutExtension, parts.join('/')])];
}

function hasMagic(input: Uint8Array, magic: string): boolean {
        const expected = new TextEncoder().encode(magic);
        if (input.length < expected.length) return false;
        for (let i = 0; i < expected.length; i++) if (input[i] !== expected[i]) return false;
        return true;
}

/**
 * Decode an optional profile-selected asset envelope in memory; never modify
 * the SD file. With no policy, bytes are returned unchanged for ordinary MV
 * packages. The algorithm is intentionally named and versioned so a profile
 * cannot silently select an arbitrary decoder.
 */
export function unpackGameAsset(buffer: ArrayBuffer, path: string, policy?: AssetEnvelopePolicy): ArrayBuffer {
        const input = new Uint8Array(buffer);
        if (!policy || policy.algorithm !== 'basename-xor-v1') return buffer;
        if (!policy.magic || policy.headerBytes < policy.magic.length || policy.headerBytes > input.length
                || !Number.isInteger(policy.lengthByteOffset) || policy.lengthByteOffset < 0
                || policy.lengthByteOffset >= policy.headerBytes || !hasMagic(input, policy.magic)) return buffer;
        const output = input.slice(policy.headerBytes);
        const limit = Math.min(input[policy.lengthByteOffset] || output.length, output.length);
        let key = 0;
        for (const c of path.split('/').pop()!.toUpperCase()) key = ((key << 1) ^ c.charCodeAt(0)) & 255;
        key = (key + 1) & 255;
        for (let i = 0; i < limit; i++) {
                const encoded = output[i];
                output[i] = encoded ^ key;
                key = ((key << 1) ^ encoded) & 255;
        }
        return output.buffer;
}

/** Small bounded cache for repeated images and map data, not large audio. */
export function gameAssets(game: string, mod: string | null, disk: Reader, budget = 16 * 1024 * 1024, policy: AssetPolicy = {}): Reader {
        const memory = new Map<string, ArrayBuffer>();
        const pending = new Map<string, { request: Promise<ArrayBuffer | null>; shared: boolean }>();
        const hashedLookup = policy.hashedLookup !== false;
        let size = 0;
        const roots = [mod, game].filter((root): root is string => !!root).map((root) => root.replace(/\/+$/, ''));
        async function resolve(safe: string): Promise<ArrayBuffer | null> {
                for (const root of roots) {
                        const candidates = [...new Set([safe, safe.replace(/\.[^/.]+$/, '')])];
                        for (let i = 0; i < candidates.length; i++) {
                                const name = candidates[i];
                                const bytes = await disk.read(`${root}/${name}`);
                                if (bytes !== null) {
                                        const result = unpackGameAsset(bytes, name, policy.envelope);
                                        if (/^(data|img)\//i.test(safe) && result.byteLength > 0 && result.byteLength <= Math.min(budget, 2 * 1024 * 1024)) {
                                                const previous = memory.get(safe);
                                                if (previous) { size -= previous.byteLength; memory.delete(safe); }
                                                while ((size + result.byteLength > budget || memory.size >= 512) && memory.size) {
                                                        const oldest = memory.keys().next().value!;
                                                        size -= memory.get(oldest)!.byteLength; memory.delete(oldest);
                                                }
                                                memory.set(safe, result.slice(0)); size += result.byteLength;
                                        }
                                        return result;
                                }
                                if (hashedLookup && i === candidates.length - 1) {
                                        const hashed = (await namesForSafePath(safe)).at(-1)!;
                                        if (!candidates.includes(hashed)) candidates.push(hashed);
                                }
                        }
                }
                return null;
        }
        return { async read(path) {
                const safe = assetPath(path);
                if (!safe) throw new Error('Unsafe asset path');
                const cached = memory.get(safe);
                if (cached) { memory.delete(safe); memory.set(safe, cached); return cached.slice(0); }
                if (!/^(data|img)\//i.test(safe)) return resolve(safe);
                const existing = pending.get(safe);
                if (existing) { existing.shared = true; const bytes = await existing.request; return bytes ? bytes.slice(0) : null; }
                const entry = { request: resolve(safe), shared: false };
                pending.set(safe, entry);
                try { const bytes = await entry.request; return bytes && entry.shared ? bytes.slice(0) : bytes; }
                finally { if (pending.get(safe) === entry) pending.delete(safe); }
        } };
}

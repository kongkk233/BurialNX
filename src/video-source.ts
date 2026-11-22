import { assetPath, type Reader } from './library';
import { gameAssetNames, type AssetEnvelopePolicy } from './game-assets';
import { safeSdPath } from './settings';

/** Ordinary SD movies stream without loading the whole file into the JS heap. */
export interface MovieSource { url: string; release(): void }
export type MovieResolver = (src: string, exact?: boolean, mime?: string) => Promise<MovieSource>;
interface MovieFs {
        statSync(path: string): { mode: number; size?: number | bigint } | null;
        readFile(path: string, range: { start: number; end: number }): Promise<ArrayBuffer | null>;
}
export interface MoviePolicy {
        extensionFallback?: readonly string[];
        variantFallback?: readonly string[];
        hashedLookup?: boolean;
        envelope?: AssetEnvelopePolicy;
}
const defaultMoviePolicy: Required<Pick<MoviePolicy, 'extensionFallback' | 'variantFallback'>> = { extensionFallback: ['webm', 'mp4'], variantFallback: ['-l'] };
const noop = () => {};
const limit = 64 * 1024 * 1024;

interface NormalizedMoviePolicy {
        extensionFallback: string[];
        variantFallback: string[];
        hashedLookup: boolean;
        envelope?: AssetEnvelopePolicy;
}

function normalizeMoviePolicy(policy: MoviePolicy | undefined): NormalizedMoviePolicy {
        const input = policy ?? {};
        const extensions = input.extensionFallback ?? defaultMoviePolicy.extensionFallback;
        const variants = input.variantFallback ?? defaultMoviePolicy.variantFallback;
        if (!Array.isArray(extensions) || extensions.some(value => typeof value !== 'string' || !value.trim())) {
                throw new TypeError('Movie policy extensionFallback must be a non-empty string array');
        }
        if (!Array.isArray(variants) || variants.some(value => typeof value !== 'string' || !value || value.startsWith('.') || /[/\\]/.test(value) || /[\u0000-\u001f\u007f]/.test(value))) {
                throw new TypeError('Movie policy variantFallback contains an unsafe filename variant');
        }
        const normalizedExtensions = [...new Set(extensions.map(value => value.replace(/^\./, '').toLowerCase()))];
        if (normalizedExtensions.some(value => !/^[a-z0-9][a-z0-9._-]*$/i.test(value))) {
                throw new TypeError('Movie policy extensionFallback contains an unsafe extension');
        }
        if (input.hashedLookup !== undefined && typeof input.hashedLookup !== 'boolean') {
                throw new TypeError('Movie policy hashedLookup must be a boolean');
        }
        let envelope: AssetEnvelopePolicy | undefined;
        if (input.envelope !== undefined) {
                const candidate = input.envelope as Partial<AssetEnvelopePolicy> | null;
                const magicBytes = typeof candidate?.magic === 'string' ? new TextEncoder().encode(candidate.magic) : null;
                if (!candidate || !magicBytes?.length || magicBytes.length > 4096 || !/^[\x20-\x7e]+$/.test(candidate.magic!)
                        || !Number.isInteger(candidate.headerBytes) || candidate.headerBytes < magicBytes.length || candidate.headerBytes > 4096
                        || !Number.isInteger(candidate.lengthByteOffset) || candidate.lengthByteOffset < 0 || candidate.lengthByteOffset >= candidate.headerBytes
                        || candidate.algorithm !== 'basename-xor-v1') {
                        throw new TypeError('Movie policy envelope is invalid');
                }
                envelope = { magic: candidate.magic!, headerBytes: candidate.headerBytes!, lengthByteOffset: candidate.lengthByteOffset!, algorithm: 'basename-xor-v1' };
        }
        return {
                extensionFallback: normalizedExtensions,
                variantFallback: [...new Set(variants)],
                hashedLookup: input.hashedLookup !== false,
                ...(envelope ? { envelope } : {}),
        };
}

function matchesEnvelope(prefix: Uint8Array, envelope: AssetEnvelopePolicy | undefined): boolean {
        if (!envelope) return false;
        const magic = new TextEncoder().encode(envelope.magic);
        if (prefix.length < magic.length) return false;
        for (let i = 0; i < magic.length; i++) if (prefix[i] !== magic[i]) return false;
        return true;
}

/** Only for typed <source> candidates, not legacy game resources: FFmpeg can
 * mistake arbitrary ASCII for a one-frame CD+G file. A MIME hint is a promise
 * about the container. Check its header before allowing it to mask a later movie. */
function checkContainer(b:Uint8Array, mime: string | undefined, size: number) {
        const type=mime?.split(';')[0].trim().toLowerCase();
        if(type==='audio/ogg'||type==='audio/opus'){
                if(b.length<4 || b[0]!==79 || b[1]!==103 || b[2]!==103 || b[3]!==83)throw new Error('Source is not an Ogg container');
        } else if (type==='video/webm' || type==='audio/webm') {
                if (b.length<4 || b[0]!==0x1a || b[1]!==0x45 || b[2]!==0xdf || b[3]!==0xa3)
                        throw new Error('Source is not a WebM/Matroska container');
        } else if (type==='video/mp4' || type==='video/x-m4v' || type==='audio/mp4' || type==='audio/m4a' || type==='audio/x-m4a') {
                if (b.length<8) throw new Error('Source has no ISO media box');
                const length=new DataView(b.buffer,b.byteOffset,8).getUint32(0);
                const printable=b.subarray(4,8).every(c=>c>=32 && c<=126);
                // Accept legacy moov/mdat/free-first files and 64-bit boxes too.
                if(!printable || (length!==0 && length!==1 && (length<8 || (size>0 && length>size))))
                        throw new Error('Source is not an ISO MP4 container');
        }
}

export function createMovieResolver(assets: Reader, roots: readonly string[] = [], fs: MovieFs | undefined = (globalThis as any).Switch, decodeFromBuffer = false, policy: MoviePolicy = {}): MovieResolver {
        const mediaPolicy = normalizeMoviePolicy(policy);
        return async (src, exact=false, mime) => {
                // Existing Blob URLs are owned by the caller, not by this layer.
                if (/^blob:/i.test(src)) return { url: src, release: noop };
                const relative = src.split(/[?#]/, 1)[0].replace(/^(?:game|romfs):\/(?!\/)/i, '').replace(/^\.\//, '');
                if (!assetPath(relative)) throw new Error('Invalid local movie path');
                const local = roots.filter(safeSdPath);
                // Preserve the original resolver contract: requested basename first,
                // then same-basename extension siblings. Configured filename variants
                // are additive fallback candidates and never outrank a sibling file.
                const candidates = [relative];
                if (!exact) {
                        const match = /^(.*?)(\.[^./]+)$/.exec(relative);
                        if (match) {
                                const stem = match[1];
                                const extension = match[2].slice(1).toLowerCase();
                                const extensions = [extension, ...mediaPolicy.extensionFallback].filter((value, index, all) => all.indexOf(value) === index);
                                for (const ext of extensions.slice(1)) candidates.push(`${stem}.${ext}`);
                                for (const variant of mediaPolicy.variantFallback) {
                                        for (const ext of extensions) {
                                                const candidate = `${stem}${variant}.${ext}`;
                                                if (!candidates.includes(candidate)) candidates.push(candidate);
                                        }
                                }
                        }
                }
                let readPaths = candidates;
                if (fs && local.length) {
                        const variants = mediaPolicy.hashedLookup
                                ? await Promise.all(candidates.map(gameAssetNames))
                                : candidates.map((candidate) => [candidate]);
                        outer: for (const root of local) for (const [i,names] of variants.entries()) for (const name of names) {
                                const path = `${root.replace(/\/+$/, '')}/${name}`;
                                const stat = fs.statSync(path);
                                if (!stat || (stat.mode & 0o170000) !== 0o100000) continue;
                                const headerEnd = mediaPolicy.envelope ? Math.max(7, mediaPolicy.envelope.headerBytes) : (mime ? 8 : 7);
                                const header = await fs.readFile(path, { start: 0, end: headerEnd });
                                if (!header?.byteLength) throw new Error(`Movie header is missing or empty: ${candidates[i]}`);
                                const prefix = new Uint8Array(header);
                                const wrapped = matchesEnvelope(prefix, mediaPolicy.envelope);
                                // beta.7 opens decodeURI(URL.href). If this does not round-trip
                                // (e.g. '#' in a file name), use the existing Reader instead.
                                if (!wrapped) checkContainer(prefix,mime,Number(stat.size ?? 0));
                                const url = 'sdmc:/' + path.slice(6).split('/').map(encodeURIComponent).join('/');
                                if (!decodeFromBuffer && !wrapped && decodeURI(url) === path) return { url, release: noop };
                                if (Number(stat.size ?? 0) > limit) throw new Error(decodeFromBuffer?'External soundtrack exceeds the 64 MiB input budget':'Packed/escaped movie exceeds 64 MiB; supply a plain movie with a simple name');
                                readPaths = [candidates[i]];
                                break outer; // never bypass a wrapped mod override
                        }
                }
                for (const p of readPaths) {
                        const bytes = await assets.read(p);
                        if (bytes === null) continue;
                        if (!bytes.byteLength) throw new Error(`Movie is empty: ${p}`);
                        if (bytes.byteLength > limit) throw new Error('In-memory movie exceeds 64 MiB; use a plain SD movie instead');
                        checkContainer(new Uint8Array(bytes,0,Math.min(bytes.byteLength,8)),mime,bytes.byteLength);
                        const url = URL.createObjectURL(new Blob([bytes]));
                        let active = true;
                        return { url, release() { if (active) { active = false; URL.revokeObjectURL(url); } } };
                }
                throw new Error(`Movie is missing: ${candidates.join(' or ')}`);
        };
}

/** Native Audio uses globalThis.fetch and decodes the whole compressed track.
 * Do not pass sdmc: to it: the game's resource bridge intentionally rejects
 * arbitrary schemes. Use our selected game/mod Reader, cap size, use an owned
 * Blob URL and revoke it as soon as the native decoder owns the PCM. */
export function createAudioResolver(assets:Reader, roots:readonly string[]=[], fs:MovieFs|undefined=(globalThis as any).Switch, policy: MoviePolicy = {}):MovieResolver {
        return createMovieResolver(assets,roots,fs,true,policy);
}

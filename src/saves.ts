import { gameSaveFolders, safeSdPath, type SaveLocation } from './settings';

export interface SaveFiles {
        readFileSync(path: string): ArrayBuffer | null;
        writeFileSync(path: string, value: string | ArrayBuffer): void;
        removeSync(path: string): void;
        statSync(path: string): { mode: number } | null;
        /** Optional dir listing for single-scan exists-cache. */
        readDirSync?(path: string): string[] | null;
}

/** Package-level save naming contract. The writable folder remains user-selected. */
export interface SaveFilePolicy {
        directory: string;
        extension: string;
}

export const DEFAULT_SAVE_FILE_POLICY: SaveFilePolicy = { directory: 'save', extension: '.rpgsave' };

function safeRelativeDirectory(value: string): boolean {
        return !!value && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
                !value.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f\u2028\u2029]/.test(part));
}

function safeExtension(value: string): boolean {
        return /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Normalize untrusted profile input before it reaches filesystem naming. */
export function normalizeSaveFilePolicy(policy?: Partial<SaveFilePolicy>): SaveFilePolicy {
        const directory = policy?.directory ?? DEFAULT_SAVE_FILE_POLICY.directory;
        const extension = policy?.extension ?? DEFAULT_SAVE_FILE_POLICY.extension;
        if (!safeRelativeDirectory(directory)) throw new Error('Invalid save profile directory');
        if (!safeExtension(extension)) throw new Error('Invalid save profile extension');
        return { directory, extension };
}

const name = (id: number, extension: string) => {
        if (!Number.isInteger(id) || id < -1 || id > 999) throw new Error('Invalid save slot');
        return id === -1 ? `config${extension}` : id === 0 ? `global${extension}` : `file${id}${extension}`;
};

const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (bytes: ArrayBuffer | null) => bytes === null ? null : new TextDecoder().decode(bytes);

/** Never put the writable save folder inside the game or mod directories. */
export function safeSaveFolder(folder: string, root: string, mod: string | null): boolean {
        if (!safeSdPath(folder) || !safeSdPath(root) || (mod !== null && !safeSdPath(mod))) return false;
        const normal = (p: string) => p.replace(/\/+$/, '').toLowerCase();
        const destination = normal(folder);
        const game = normal(root).endsWith('/www') ? normal(root).slice(0, -4) : normal(root);
        return ![game, ...(mod ? [normal(mod)] : [])].some((p) => destination === p || destination.startsWith(p + '/'));
}

/** Only an explicitly selected game save directory may overlap the game. */
export function safeGameSaveFolder(folder: string, root: string, mod: string | null): boolean {
        if (!safeSdPath(folder) || !safeSdPath(root) || (mod !== null && !safeSdPath(mod))) return false;
        const normal = (p: string) => p.replace(/\/+$/, '').toLowerCase();
        const destination = normal(folder);
        if (!gameSaveFolders(root).some((p) => normal(p) === destination)) return false;
        if (!mod) return true;
        const overlay = normal(mod);
        return destination !== overlay && !destination.startsWith(overlay + '/') && !overlay.startsWith(destination + '/');
}

/** Create the explicitly selected save directory only; do not touch saves. */
export function ensureGameSaveFolder(fs: Pick<SaveFiles, 'statSync'> & { mkdirSync(path: string): void }, folder: string, root: string, mod: string | null): void {
        if (!safeGameSaveFolder(folder, root, mod)) throw new Error('Invalid game save folder');
        const parent = folder.slice(0, folder.lastIndexOf('/'));
        const parentInfo = fs.statSync(parent);
        if (!parentInfo || (parentInfo.mode & 0o170000) !== 0o040000) throw new Error('Game save parent folder is unavailable');
        let info = fs.statSync(folder);
        if (!info) { fs.mkdirSync(folder); info = fs.statSync(folder); }
        if (!info || (info.mode & 0o170000) !== 0o040000) throw new Error('Game save path is not a directory');
}

/** MV uses the same LZString base64 format on disk and in localStorage. */
export function installSdSaves(runtime: any, fs: SaveFiles, folder: string, policy?: Partial<SaveFilePolicy>): void {
        const manager = runtime.StorageManager, codec = runtime.LZString;
        if (!manager || !codec) throw new Error('Save storage is unavailable');
        const savePolicy = normalizeSaveFilePolicy(policy);
        const path = (id: number) => `${folder}/${name(id, savePolicy.extension)}`;
        const read = (p: string) => text(fs.readFileSync(p));
        const exists = (p: string) => fs.statSync(p) !== null;
        const remove = (p: string) => {
                const entry = fs.statSync(p);
                if (entry && (entry.mode & 0o170000) !== 0o100000) throw new Error(`Not a regular save file: ${p}`);
                if (entry) fs.removeSync(p);
        };
        const write = (p: string, value: string) => {
                const journal = `${p}.burialnx-journal`;
                if (exists(journal)) throw new Error(`Recovery journal exists: ${journal}`);
                const old = read(p);
                if (old !== null) fs.writeFileSync(journal, old);
                fs.writeFileSync(p, value);
                if (old !== null) remove(journal);
        };

        const existsCache = new Map<number, boolean>();
        const suffix = regexEscape(savePolicy.extension);
        const scanEntrySlot = (entry: string): number | null => {
                if (new RegExp(`^config${suffix}$`, 'i').test(entry)) return -1;
                if (new RegExp(`^global${suffix}$`, 'i').test(entry)) return 0;
                const m = new RegExp(`^file([1-9]\\d{0,2})${suffix}$`, 'i').exec(entry);
                return m ? Number(m[1]) : null;
        };
        const refreshExistsCache = (): void => {
                existsCache.clear();
                if (typeof fs.readDirSync === 'function') {
                        let entries: string[] | null = null;
                        try { entries = fs.readDirSync(`${folder}/`); } catch { /* unreadable — fall through to statSync */ }
                        if (entries) {
                                for (const entry of entries) { const id = scanEntrySlot(entry); if (id !== null) existsCache.set(id, true); }
                                return;
                        }
                }
                const max = runtime.DataManager?.maxSavefiles?.() || 20;
                for (let id = -1; id <= max; id++) if (exists(path(id))) existsCache.set(id, true);
        };
        refreshExistsCache();

        let globalCache: string | null | undefined = undefined;

        for (let id = -1; id <= (runtime.DataManager?.maxSavefiles?.() || 20); id++) {
                const journal = `${path(id)}.burialnx-journal`;
                if (exists(journal)) throw new Error(`Interrupted save; recover ${journal} before starting`);
        }
        manager.save = (id: number, json: string) => {
                write(path(id), codec.compressToBase64(json));
                existsCache.set(id, true);
                if (id === 0) {
                        globalCache = json;
                }
        };
        manager.load = (id: number) => {
                if (id === 0) {
                        if (globalCache === undefined) {
                                const raw = read(path(0));
                                globalCache = raw === null ? null : codec.decompressFromBase64(raw);
                        }
                        return globalCache;
                }
                const value = read(path(id));
                return value === null ? null : codec.decompressFromBase64(value);
        };
        manager.exists = (id: number) => {
                const cached = existsCache.get(id);
                if (cached !== undefined) return cached;
                const result = exists(path(id));
                existsCache.set(id, result);
                return result;
        };
        manager.remove = (id: number) => {
                remove(path(id));
                existsCache.set(id, false);
                if (id === 0) {
                        globalCache = null;
                }
        };
        manager.backup = (id: number) => {
                const current = read(path(id)), backup = `${path(id)}.burialnx-backup`;
                if (exists(backup)) throw new Error(`Existing save backup requires recovery: ${backup}`);
                if (current !== null) {
                        fs.writeFileSync(backup, current);
                }
        };
        manager.backupExists = (id: number) => exists(`${path(id)}.burialnx-backup`);
        manager.cleanBackup = (id: number) => remove(`${path(id)}.burialnx-backup`);
        manager.restoreBackup = (id: number) => {
                const backup = `${path(id)}.burialnx-backup`, value = read(backup);
                if (value !== null) { write(path(id), value); remove(backup); existsCache.set(id, true); }
        };
        /** Rebuild the exists-cache; called by importSteamSaves after direct file copy. */
        manager.refreshSaveCache = (): void => { refreshExistsCache(); };
        if (runtime.DataManager?.saveGameWithoutRescue) runtime.DataManager.saveGame = function(id: number) {
                let backedUp = false;
                try {
                        manager.backup(id); backedUp = manager.backupExists(id);
                        return this.saveGameWithoutRescue(id);
                } catch (error) {
                        if (backedUp && !exists(`${path(id)}.burialnx-journal`)) {
                                try { manager.restoreBackup(id); } catch { /* keep backup for recovery */ }
                        }
                        console.error(error);
                        return false;
                }
        };
}

/** Locate possible Steam save indexes without changing the source folders. */
export function steamSaveSources(fs: Pick<SaveFiles, 'statSync'>, root: string, policy?: Partial<SaveFilePolicy>): string[] {
        const savePolicy = normalizeSaveFilePolicy(policy);
        return gameSaveFolders(root).filter((dir) => fs.statSync(`${dir}/global${savePolicy.extension}`) !== null);
}

/** A save index alone is not a saved game; don't prompt when no slots exist. */
export function hasSteamSaveData(fs: Pick<SaveFiles, 'statSync'> & { readDirSync(path: string): string[] | null }, root: string, policy?: Partial<SaveFilePolicy>): boolean {
        const savePolicy = normalizeSaveFilePolicy(policy);
        const suffix = regexEscape(savePolicy.extension);
        return steamSaveSources(fs, root, savePolicy).some((dir) => {
                const entries = fs.readDirSync(dir);
                return !entries || entries.some((entry) => new RegExp(`^file[1-9]\\d{0,2}${suffix}$`, 'i').test(entry));
        });
}

/** Copy only into an entirely empty destination; source files are never written. */
export function importSteamSaves(runtime: any, fs: SaveFiles, root: string, location: SaveLocation, policy?: Partial<SaveFilePolicy>): number {
        const savePolicy = normalizeSaveFilePolicy(policy);
        if (location.kind === 'game') throw new Error('Game-folder saves are already in use; no import is needed');
        if (location.kind === 'sd' && !safeSaveFolder(location.folder, root, null)) throw new Error('Save folder overlaps game folder');
        const candidates = steamSaveSources(fs, root, savePolicy);
        if (candidates.length !== 1) throw new Error(candidates.length ? 'Steam saves found in two folders; keep only one source' : `No Steam global${savePolicy.extension} found in the game save folder`);
        const max = runtime.DataManager.maxSavefiles();
        if (!Number.isInteger(max) || max < 1 || max > 999) throw new Error('Invalid save slot count');
        const readSource = (id: number) => text(fs.readFileSync(`${candidates[0]}/${name(id, savePolicy.extension)}`));
        const validate = (value: string, kind: string) => {
                if (value.length > 8 * 1024 * 1024) throw new Error(`${kind} is too large`);
                const decoded = runtime.LZString.decompressFromBase64(value);
                if (typeof decoded !== 'string' || !decoded.length || decoded.length > 16 * 1024 * 1024) throw new Error(`Invalid ${kind}`);
                try { return JSON.parse(decoded); } catch { throw new Error(`Invalid ${kind}`); }
        };
        const global = readSource(0);
        if (global === null) throw new Error('Invalid Steam save index');
        const index = validate(global, 'Steam save index');
        if (!Array.isArray(index)) throw new Error('Invalid Steam save index');
        const source: [number, string][] = [];
        for (let id = 1; id <= max; id++) {
                const value = readSource(id);
                if (value !== null) {
                        const data = validate(value, `Steam slot ${id}`);
                        if (!data || typeof data !== 'object' || !data.system || !data.map || !data.player || !data.party || !index[id]) throw new Error(`Invalid Steam slot ${id} or missing index entry`);
                        source.push([id, value]);
                } else if (index[id]) throw new Error(`Steam slot ${id} is listed but missing`);
        }
        if (!source.length) throw new Error('No Steam save slots found');
        const rawKey = (id: number) => runtime.StorageManager.webStorageKey(id);
        const target = (id: number) => location.kind === 'sd' ? `${location.folder}/${name(id, savePolicy.extension)}` : rawKey(id);
        for (let id = 0; id <= max; id++) {
                if (location.kind === 'switch') {
                        if (runtime.localStorage.getItem(target(id)) !== null || runtime.localStorage.getItem(target(id) + 'bak') !== null) throw new Error('Destination has existing saves or backups; import cancelled');
                } else {
                        const p = target(id);
                        if ([p, `${p}.burialnx-backup`, `${p}.burialnx-journal`, `${p}.bak`].some((x) => fs.statSync(x) !== null)) throw new Error('Destination has existing saves or backups; import cancelled');
                }
        }
        for (const [id, value] of [...source, [0, global] as [number, string]]) {
                if (location.kind === 'switch') runtime.localStorage.setItem(target(id), value);
                else fs.writeFileSync(target(id), value);
        }
        try { runtime.StorageManager?.refreshSaveCache?.(); } catch { /* best-effort */ }
        return source.length;
}

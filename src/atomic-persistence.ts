export type AtomicData = string | Uint8Array | ArrayBuffer;

export interface AtomicFileSystem {
  writeFile(path: string, data: AtomicData): void | Promise<void>;
  rename(from: string, to: string): void | Promise<void>;
  remove(path: string): void | Promise<void>;
}

export interface AtomicFileSystemSync {
  writeFileSync(path: string, data: AtomicData): void;
  renameSync(from: string, to: string): void;
  removeSync(path: string): void;
}

export interface AtomicWriteOptions { tempSuffix?: string; cleanup?: boolean }

function tempPath(path: string, suffix?: string): string {
  return `${path}${suffix ?? `.part-${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

/**
 * Small filesystem-neutral primitive for save/config writers.
 *
 * This provides atomic replacement when the platform's rename operation is
 * atomic. It deliberately does not claim crash durability: the injected
 * filesystem must provide its own flush/fsync primitive if callers need a
 * power-loss commit guarantee.
 */
export async function atomicWrite(fs: AtomicFileSystem, path: string, data: AtomicData, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = tempPath(path, options.tempSuffix);
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, path);
  } catch (error) {
    if (options.cleanup !== false) {
      try { await fs.remove(temp); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

/** Synchronous equivalent for nx.js/Switch configuration and save writers. */
export function atomicWriteSync(fs: AtomicFileSystemSync, path: string, data: AtomicData, options: AtomicWriteOptions = {}): void {
  const temp = tempPath(path, options.tempSuffix);
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, path);
  } catch (error) {
    if (options.cleanup !== false) {
      try { fs.removeSync(temp); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

/**
 * Use atomic replacement when the runtime exposes the complete synchronous
 * primitive. Returns false when it does not, allowing an explicit direct-write
 * fallback for older nx.js builds without pretending it is atomic.
 */
export function atomicWriteSyncIfSupported(
  fs: { writeFileSync?: (path: string, data: AtomicData) => void; renameSync?: (from: string, to: string) => void; removeSync?: (path: string) => void; unlinkSync?: (path: string) => void },
  path: string,
  data: AtomicData,
  options: AtomicWriteOptions = {},
): boolean {
  const remove = fs.removeSync ?? fs.unlinkSync;
  if (typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function' || typeof remove !== 'function') return false;
  atomicWriteSync({
    writeFileSync: fs.writeFileSync.bind(fs),
    renameSync: fs.renameSync.bind(fs),
    removeSync: remove.bind(fs),
  }, path, data, options);
  return true;
}

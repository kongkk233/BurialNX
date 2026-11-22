import { PatchRegistry } from './patch-registry';

export interface GameSessionSnapshot {
        names: Set<string>;
        values: Record<string, unknown>;
        fonts: Set<unknown>;
        timeouts: Set<unknown>;
        intervals: Set<unknown>;
        rafIds: Set<number>;
        nativeClearTimeout: ((id: unknown) => void) | undefined;
        nativeClearInterval: ((id: unknown) => void) | undefined;
        nativeCancelAnimationFrame: ((id: number) => void) | undefined;
        patches: PatchRegistry;
}

export interface GameSessionCleanupReport {
        hadSession: boolean;
        trackedTimeouts: number;
        trackedIntervals: number;
        trackedAnimationFrames: number;
        timeoutCancelAttempts: number;
        intervalCancelAttempts: number;
        animationFrameCancelAttempts: number;
        timeoutCancelFailures: number;
        intervalCancelFailures: number;
        animationFrameCancelFailures: number;
        patchesBefore: number;
        patchRestoreFailures: number;
        removedGlobals: number;
        restoredGlobals: number;
}

let gameSession: GameSessionSnapshot | undefined;
let lastCleanupReport: GameSessionCleanupReport | null = null;

function emptyCleanupReport(hadSession: boolean): GameSessionCleanupReport {
        return {
                hadSession,
                trackedTimeouts: 0,
                trackedIntervals: 0,
                trackedAnimationFrames: 0,
                timeoutCancelAttempts: 0,
                intervalCancelAttempts: 0,
                animationFrameCancelAttempts: 0,
                timeoutCancelFailures: 0,
                intervalCancelFailures: 0,
                animationFrameCancelFailures: 0,
                patchesBefore: 0,
                patchRestoreFailures: 0,
                removedGlobals: 0,
                restoredGlobals: 0,
        };
}

/** Return the most recent session cleanup report without exposing mutable state. */
export function getLastGameSessionCleanup(): GameSessionCleanupReport | null {
        return lastCleanupReport ? { ...lastCleanupReport } : null;
}

/** Snapshot globalThis before launch so teardown can restore it. */
export function beginGameSession() {
        // A failed launch must never leave the next launch sharing the previous
        // session's wrappers, timers, or global objects.
        if (gameSession) endGameSession();
        lastCleanupReport = null;
        const global = globalThis as any;
        const values: Record<string, unknown> = {};
        const names = Object.getOwnPropertyNames(globalThis);
        for (const name of names) values[name] = global[name];
        const fonts = new Set<unknown>();
        try {
                if (global.fonts && typeof global.fonts[Symbol.iterator] === 'function') {
                        for (const font of global.fonts) fonts.add(font);
                }
        } catch { /* the fonts set is optional */ }
        const snapshot: GameSessionSnapshot = {
                names: new Set(names),
                values,
                fonts,
                timeouts: new Set<unknown>(),
                intervals: new Set<unknown>(),
                rafIds: new Set<number>(),
                nativeClearTimeout: typeof global.clearTimeout === 'function' ? global.clearTimeout.bind(global) : undefined,
                nativeClearInterval: typeof global.clearInterval === 'function' ? global.clearInterval.bind(global) : undefined,
                nativeCancelAnimationFrame: typeof global.cancelAnimationFrame === 'function' ? global.cancelAnimationFrame.bind(global) : undefined,
                patches: new PatchRegistry(),
        };
        gameSession = snapshot;
        if (typeof global.setTimeout === 'function') {
                const nativeSetTimeout = global.setTimeout;
                global.setTimeout = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
                        const id = nativeSetTimeout(handler, timeout, ...args);
                        snapshot.timeouts.add(id);
                        return id;
                };
        }
        if (typeof global.setInterval === 'function') {
                const nativeSetInterval = global.setInterval;
                global.setInterval = function (handler: unknown, timeout?: unknown, ...args: unknown[]) {
                        const id = nativeSetInterval(handler, timeout, ...args);
                        snapshot.intervals.add(id);
                        return id;
                };
        }
        if (typeof global.requestAnimationFrame === 'function' && typeof global.cancelAnimationFrame === 'function') {
                const nativeRequestAnimationFrame = global.requestAnimationFrame;
                global.requestAnimationFrame = function (handler: unknown) {
                        const id = nativeRequestAnimationFrame(handler);
                        if (typeof id === 'number') snapshot.rafIds.add(id);
                        return id;
                };
        }
}

/** Return the active session registry, or null outside a game launch. */
export function currentGamePatches(): PatchRegistry | null {
        return gameSession?.patches ?? null;
}

/** Register a reversible method replacement owned by the current game session. */
export function patchSessionMethod(
        key: string,
        target: Record<string, any>,
        property: string,
        makeReplacement: (original: any) => any,
): boolean {
        const session = gameSession;
        if (!session || !target) return false;
        session.patches.replace(key, () => {
                const original = target[property];
                const replacement = makeReplacement(original);
                target[property] = replacement;
                return () => { target[property] = original; };
        });
        return true;
}

/** Register arbitrary session cleanup, such as event listener removal. */
export function registerSessionCleanup(key: string, install: () => () => void): boolean {
        const session = gameSession;
        if (!session) return false;
        session.patches.replace(key, install);
        return true;
}

/**
 * Snapshot an object's own properties before compatibility patches mutate it.
 * This covers nested runtime namespaces and prototypes that are not removed by
 * the globalThis snapshot. It restores descriptors, not just values, so a
 * patched getter/setter is also put back.
 */
export function snapshotSessionObject(key: string, target: object | Function | null | undefined): boolean {
        const session = gameSession;
        if (!session || !target) return false;
        let descriptors: PropertyDescriptorMap;
        try { descriptors = Object.getOwnPropertyDescriptors(target); }
        catch { return false; }
        session.patches.replace(key, () => () => {
                const current = Reflect.ownKeys(target);
                for (const property of current) {
                        if (!(property in descriptors)) {
                                try { Reflect.deleteProperty(target, property); } catch { /* best-effort */ }
                        }
                }
                for (const property of Reflect.ownKeys(descriptors)) {
                        try { Object.defineProperty(target, property, descriptors[property as keyof typeof descriptors]); }
                        catch { /* non-configurable properties cannot be rewritten */ }
                }
        });
        return true;
}

/** Restore globalThis, nested runtime patches, fonts, timers, and rAFs. */
export function endGameSession(): GameSessionCleanupReport {
        const snapshot = gameSession;
        if (!snapshot) {
                const report = emptyCleanupReport(false);
                lastCleanupReport = report;
                return report;
        }
        const report = emptyCleanupReport(true);
        report.trackedTimeouts = snapshot.timeouts.size;
        report.trackedIntervals = snapshot.intervals.size;
        report.trackedAnimationFrames = snapshot.rafIds.size;
        report.patchesBefore = snapshot.patches.activeCount;
        // Restore nested runtime methods before deleting newly-created globals.
        // PatchRegistry deliberately continues after an individual cleanup fails.
        try { snapshot.patches.restoreAll(); } catch { report.patchRestoreFailures++; }
        gameSession = undefined;
        const global = globalThis as any;
        for (const id of snapshot.rafIds) {
                report.animationFrameCancelAttempts++;
                if (!snapshot.nativeCancelAnimationFrame) { report.animationFrameCancelFailures++; continue; }
                try { snapshot.nativeCancelAnimationFrame(id); } catch { report.animationFrameCancelFailures++; }
        }
        for (const id of snapshot.timeouts) {
                report.timeoutCancelAttempts++;
                if (!snapshot.nativeClearTimeout) { report.timeoutCancelFailures++; continue; }
                try { snapshot.nativeClearTimeout(id); } catch { report.timeoutCancelFailures++; }
        }
        for (const id of snapshot.intervals) {
                report.intervalCancelAttempts++;
                if (!snapshot.nativeClearInterval) { report.intervalCancelFailures++; continue; }
                try { snapshot.nativeClearInterval(id); } catch { report.intervalCancelFailures++; }
        }
        try {
                const fonts = global.fonts;
                if (fonts && typeof fonts[Symbol.iterator] === 'function' && typeof fonts.delete === 'function') {
                        for (const font of [...fonts]) {
                                if (!snapshot.fonts.has(font)) { try { fonts.delete(font); } catch { /* best-effort */ } }
                        }
                }
        } catch { /* font cleanup is optional */ }
        for (const name of Object.getOwnPropertyNames(globalThis)) {
                if (snapshot.names.has(name)) continue;
                try {
                        if (delete global[name]) report.removedGlobals++;
                } catch { /* non-configurable: keep */ }
        }
        for (const name of snapshot.names) {
                if (!(name in globalThis)) continue;
                try {
                        if (global[name] !== snapshot.values[name]) {
                                global[name] = snapshot.values[name];
                                if (global[name] === snapshot.values[name]) report.restoredGlobals++;
                        }
                } catch { /* non-writable: keep */ }
        }
        lastCleanupReport = report;
        return { ...report };
}

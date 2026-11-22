import { S } from '../src/state';
import { beginGameSession, currentGamePatches, endGameSession } from '../src/game-session';
import { handleWake, SLEEP_MARKER_PATH, SLEEP_SAVE_PATH } from '../src/sleep-recovery';

function assert(condition: unknown, message: string): asserts condition {
        if (!condition) throw new Error(message);
}

function encode(value: string | ArrayBuffer): ArrayBuffer {
        return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
}

/**
 * Exercise the production sleep→teardown→chain-reload path with a synthetic
 * Switch API. This is control-flow evidence only: no console, NRO, or device
 * sleep event is involved.
 */
export function probeLifecycleEvidence() {
        const global = globalThis as any;
        const hadSwitch = Object.prototype.hasOwnProperty.call(global, 'Switch');
        const oldSwitch = global.Switch;
        const oldRuntime = S.runtime;
        const oldHost = S.host;
        const oldMapPrefetch = S.mapPrefetch;
        const oldSelectedGame = S.selectedGame;
        const oldCurrentEntry = S.currentEntry;
        const oldPhase = S.phase;
        const oldAllowExit = S.allowExit;
        const oldGameStopped = S.gameStopped;
        const files = new Map<string, ArrayBuffer>();
        const launches: string[] = [];
        class Application {
                constructor(public path: string) {}
                launch(path: string) { launches.push(path); }
        }
        const SwitchFixture: any = {
                argv: ['sdmc:/switch/burialnx/burialnx.nro'],
                Application,
                mkdirSync() {},
                writeFileSync(path: string, value: string | ArrayBuffer) { files.set(path, encode(value)); },
                readFileSync(path: string) { return files.get(path) ?? null; },
                removeSync(path: string) { files.delete(path); },
                unlinkSync(path: string) { files.delete(path); },
        };
        const manager: any = { _scene: { name: 'map' }, update() {}, updateMain() {}, requestUpdate() {} };
        global.Switch = SwitchFixture;
        S.runtime = {
                SceneManager: manager,
                AudioManager: {
                        saveBgm: () => ({ name: 'fixture-bgm', volume: 90, pitch: 100, pos: 12 }),
                        saveBgs: () => ({ name: 'fixture-bgs', volume: 70, pitch: 100, pos: 3 }),
                        stopBgm() {}, stopBgs() {}, stopMe() {}, stopSe() {},
                },
                DataManager: { makeSaveContents: () => ({ mapId: 7, party: ['hero'] }) },
                JsonEx: { stringify: (value: unknown) => JSON.stringify(value) },
                LZString: { compressToBase64: (value: string) => value },
                ImageManager: { _imageCache: { clear() {} }, _cache: { clear() {} }, clear() {} },
                $gameSystem: { saveBgm() {}, saveBgs() {} },
        };
        S.host = { dispose() {} } as any;
        S.mapPrefetch = { dispose() {} } as any;
        S.selectedGame = 'sdmc:/switch/burialnx/Games/Fixture/www';
        S.currentEntry = { id: 'fixture', name: 'Fixture', root: S.selectedGame, sharedSaves: false };
        S.phase = 'game';
        S.allowExit = false;
        S.gameStopped = false;
        beginGameSession();
        const timeout = (globalThis as any).setTimeout(() => {}, 60_000);
        const interval = (globalThis as any).setInterval(() => {}, 60_000);
        timeout?.unref?.();
        interval?.unref?.();
        try {
                const report = handleWake(true);
                assert(report.schema === 1, 'sleep report schema is invalid');
                assert(report.gameLive === true && report.saveAttempted === true && report.saveSucceeded === true, 'sleep autosave path was not observed');
                assert(report.markerAttempted === true && report.markerWritten === true, 'sleep marker path was not observed');
                assert(report.chainReload === 'launched', 'sleep chain reload was not observed');
                assert(report.teardown?.hadSession === true, 'production teardown did not return session evidence');
                assert(report.teardown.trackedTimeouts === 1 && report.teardown.trackedIntervals === 1, 'production teardown timer ownership was not observed');
                assert(report.teardown.timeoutCancelFailures === 0 && report.teardown.intervalCancelFailures === 0 && report.teardown.patchRestoreFailures === 0, 'production teardown reported cleanup failures');
                assert(files.has(SLEEP_SAVE_PATH) && files.has(SLEEP_MARKER_PATH), 'sleep artifacts were not written');
                assert(launches.length === 1 && launches[0] === 'sdmc:/switch/burialnx/burialnx.nro', 'chain reload target was not observed');
                return {
                        status: 'pass',
                        scope: 'host-lifecycle-control-flow',
                        execution: 'synthetic-switch-control-flow',
                        wake: {
                                gameLive: report.gameLive,
                                saveAttempted: report.saveAttempted,
                                saveSucceeded: report.saveSucceeded,
                                markerAttempted: report.markerAttempted,
                                markerWritten: report.markerWritten,
                                chainReload: report.chainReload,
                        },
                        teardown: {
                                hadSession: report.teardown.hadSession,
                                trackedTimeouts: report.teardown.trackedTimeouts,
                                trackedIntervals: report.teardown.trackedIntervals,
                                timeoutCancelFailures: report.teardown.timeoutCancelFailures,
                                intervalCancelFailures: report.teardown.intervalCancelFailures,
                                patchRestoreFailures: report.teardown.patchRestoreFailures,
                        },
                        switchHardware: 'not-verified',
                        externalRuntime: 'not-verified',
                };
        } finally {
                if (currentGamePatches()) endGameSession();
                S.runtime = oldRuntime;
                S.host = oldHost;
                S.mapPrefetch = oldMapPrefetch;
                S.selectedGame = oldSelectedGame;
                S.currentEntry = oldCurrentEntry;
                S.phase = oldPhase;
                S.allowExit = oldAllowExit;
                S.gameStopped = oldGameStopped;
                if (hadSwitch) global.Switch = oldSwitch;
                else delete global.Switch;
        }
}

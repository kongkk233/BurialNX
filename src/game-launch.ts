import { S } from './state';
import { log } from './log';
import { setLoadingProgress, resetLoading } from './loading-screen';
import { beginGameSession, patchSessionMethod, snapshotSessionObject, endGameSession } from './game-session';
import { createMovieResolver, createAudioResolver } from './video-source';
import { gameAssets } from './game-assets';
import { loadPortProfileFromRoots, mediaPolicyFromProfile } from './port-profile';
import type { Reader } from './library';
import { scriptPlan, startGame } from './runtime-plan';
import { createBrowserHost } from './browser-host';
import {
        installGameCompatibility, languageTable, prepareGameScript, registerFonts,
        scanLanguageFiles, parseLanguagePack, withLanguageImages, registerLanguageFont,
        type LanguagePack, type LanguageEntry, type LanguageScanFs,
} from './game-compat';
import { installNodeCompat, type SwitchFs } from './node-compat';
import { needsPngFix } from './indexed-png';
import { ensureGameSaveFolder, installSdSaves, importSteamSaves } from './saves';
import { installMapPrefetch, MapPrefetcher } from './map-prefetch';
import { markPlayed, type LibraryAccess } from './game-library';
import { pollStickBindings, clearButtonKeyState } from './stick-bindings';
import { isSaveLoadKeymapActive, installSaveLoadPopHook } from './save-load-keymap';
import { fail, failRequest } from './error-handling';
import { getGameLanguage, validSaveLocation } from './selection';
import { mergedKeymap } from './keymap-editor';
import { hud } from './render-overlay';
import { installSleepAutoload } from './sleep-recovery';

declare const __DEBUG__: boolean;

/**
 * Compatibility code mutates methods on runtime namespaces and prototypes. The
 * global snapshot in game-session only sees top-level globals, so snapshot the
 * known MV/NW.js patch targets after scripts have loaded and before any loader
 * compatibility code runs.
 */
function snapshotRuntimeForSession(runtime: any): void {
        const paths = [
                'Input', 'Graphics', 'SceneManager', 'StorageManager', 'DataManager',
                'Decrypter', 'WebAudio', 'AudioManager', 'Bitmap', 'Window', 'WindowLayer',
                'Game_Map', 'Game_Event', 'Game_CharacterBase', 'Sprite', 'ScreenSprite',
                'Window_Message', 'Window_Base', 'Window_ChoiceList', 'Window_NameBox', 'Window_Options',
                'Game_Message', 'Scene_Boot', 'Scene_Map', 'Scene_Save', 'Scene_Load',
                'Scene_Title', 'Window_TitleCommand', 'Galv', 'Galv.CRED', 'Yanfly', 'Yanfly.Param',
                '$dataSystem',
        ];
        const seen = new Set<object>();
        for (const path of paths) {
                const value = path.split('.').reduce((current, part) => current?.[part], runtime);
                for (const target of [value, typeof value === 'function' ? value.prototype : null]) {
                        if ((!target || (typeof target !== 'object' && typeof target !== 'function')) || seen.has(target)) continue;
                        seen.add(target);
                        snapshotSessionObject(`runtime:${path}:${seen.size}`, target);
                }
        }
}

/** Async game launch pipeline: snapshot realm, load assets + scripts, install host/compat/hooks, start game. */
export async function launch() {
        S.phase = 'loading';
        S.gameStopped = false;
        S.exitBehavior = S.forwarderTargetId ? 'shutdown' : 'restart';
        log(`_exit: game launch (${S.forwarderTargetId ? 'forwarder' : 'library'}) — exit behavior: ${S.exitBehavior}`);
        resetLoading(S.currentEntry?.name || 'BurialNX', 'Preparing game…');
        try {
                beginGameSession();
                if (!S.selectedGame) throw new Error('No game selected');
                setLoadingProgress(0.04, 'Reading game index…', S.selectedGame);
                // The profile is a loader-owned control file, not a game asset:
                // read it directly from the selected overlay roots so a missing
                // profile does not trigger hashed-asset probing or unpacking.
                const profileRoots = [S.selectedMod, S.selectedGame].filter((value): value is string => !!value);
                const profileLoad = await loadPortProfileFromRoots(profileRoots, (path) => {
                        if (typeof (Switch as any).readFileSync === 'function') return (Switch as any).readFileSync(path);
                        return (Switch as any).readFile(path);
                });
                const profile = profileLoad.profile;
                const profileSource = profileLoad.source;
                log(`Port profile: ${profileSource} (${profile.id}); runtime=${profile.runtime.kind}; media variants=${profile.media.variantFallback.join(',') || '(none)'}; hashed assets=${profile.assets.hashedLookup ? 'on' : 'off'}; envelope=${profile.assets.envelope?.algorithm || 'none'}`);
                const rawAssets = gameAssets(S.selectedGame, S.selectedMod || null, { async read(path) {
                        const bytes = await (Switch as any).readFile(path);
                        if (__DEBUG__ && bytes && /\/data\//i.test(path)) log(`Read game data: ${path} (${bytes.byteLength} bytes)`);
                        return bytes;
                } }, 16 * 1024 * 1024, profile.assets);
                const assets = { async read(path: string) {
                        const result = await rawAssets.read(path);
                        if (result === null) log(`Asset missing: ${path}`);
                        return result;
                } };
                const entryHtml = profile.entry.html;
                const index = await assets.read(entryHtml);
                if (!index) throw new Error(`Game entry ${entryHtml} is missing`);
                const scripts = scriptPlan(new TextDecoder().decode(index));
                log(`Game: ${S.selectedGame}; mod: ${S.selectedMod || 'none'}; shared saves: ${S.sharedSaves}`);
                setLoadingProgress(0.12, 'Loading fonts and language…');
                const [, , pngFix] = await Promise.all([languageTable(assets), registerFonts(assets, S.runtime), needsPngFix(log)]);
                let language = await languageTable(assets);
                let languagePack: LanguagePack | null = null;
                let imageReader: Reader = assets;
                S.activeLanguageCode = '';
                S.languageEntries = [];
                try {
                        const scanFs = (Switch as unknown as LanguageScanFs) ?? null;
                        S.languageEntries = scanLanguageFiles(scanFs, S.selectedGame);
                        if (S.languageEntries.length > 0) {
                                const savedRaw = getGameLanguage(S.selectedGame);
                                let chosen: LanguageEntry | null = null;
                                if (savedRaw === undefined) chosen = S.languageEntries[0];
                                else if (savedRaw !== '') chosen = S.languageEntries.find((e) => e.code === savedRaw) ?? null;
                                if (chosen) {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; loading ${chosen.code}`);
                                        let cldBytes: ArrayBuffer | null = null;
                                        if (chosen.path) cldBytes = await assets.read(chosen.path);
                                        else try { cldBytes = await (Switch as any).readFile(chosen.absPath); } catch { /* unreadable */ }
                                        if (cldBytes) {
                                                languagePack = parseLanguagePack(cldBytes, chosen.path || chosen.absPath);
                                                S.activeLanguageCode = chosen.code;
                                                language = languagePack.table;
                                                if (languagePack.langName) chosen.name = languagePack.langName;
                                                try { imageReader = withLanguageImages(assets, languagePack); } catch { imageReader = assets; }
                                        }
                                } else if (savedRaw === '') {
                                        log(`Languages: ${S.languageEntries.map((e) => e.code).join(', ')}; using English (user preference)`);
                                }
                        }
                } catch (langError) {
                        log(`Language .cld loading failed (using English): ${langError instanceof Error ? langError.message : String(langError)}`);
                        languagePack = null;
                        S.activeLanguageCode = '';
                        imageReader = assets;
                }
                setLoadingProgress(0.20, 'Preparing runtime host…');
                const mediaRoots=[S.selectedMod,S.selectedGame].filter((p):p is string=>!!p);
                const mediaPolicy = {
                        ...mediaPolicyFromProfile(profile),
                        hashedLookup: profile.assets.hashedLookup,
                        envelope: profile.assets.envelope,
                };
                S.host = createBrowserHost(imageReader, prepareGameScript, log, pngFix, S.directScreen, failRequest,
                        createMovieResolver(imageReader, mediaRoots, undefined, false, mediaPolicy),
                        createAudioResolver(imageReader, mediaRoots, undefined, mediaPolicy));
                try { installNodeCompat(S.runtime, (Switch as unknown as SwitchFs) ?? null, { gameRoot: S.selectedGame, log: __DEBUG__ ? log : undefined }); }
                catch (compatError) { log(`node-compat install failed: ${compatError instanceof Error ? compatError.message : String(compatError)}`); }
                const total = scripts.length;
                for (let i = 0; i < total; i++) {
                        const path = scripts[i];
                        log(`Loading ${path}`);
                        setLoadingProgress(0.20 + 0.70 * (i + 1) / total, `Loading scripts ${i + 1}/${total}…`, path);
                        await S.host.loadScript(path);
                }
                setLoadingProgress(0.92, 'Settling runtime…');
                await S.host.settled();
                // From this point on plugins and loader compatibility code mutate
                // MV objects/prototypes; make those mutations session-owned.
                snapshotRuntimeForSession(S.runtime);
                setLoadingProgress(0.95, 'Installing compatibility…');
                const km0 = mergedKeymap();
                const btnSummary = km0.buttons.map((b: string, i: number) => b !== 'none' ? `${i}=${b}` : null).filter(Boolean).join(' ');
                log(`_keymap: buttons = ${btnSummary}`);
                const stickDirs = ['lUp','lDown','lLeft','lRight','rUp','rDown','rLeft','rRight'] as const;
                const stickSummary = stickDirs.filter(d => km0.sticks?.[d]).map(d => `${d}=${km0.sticks![d].vkey || km0.sticks![d].label}`).join(' ');
                log(`_keymap: sticks = ${stickSummary || '(none)'}`);
                const mouseBtns = km0.buttons.map((b: string, i: number) => {
                        const isMouse = b === 'mup' || b === 'mdown' || b === 'mleft' || b === 'mright' || b === 'lmb' || b === 'rmb';
                        return isMouse ? `${i}=${b}` : null;
                }).filter(Boolean).join(' ');
                log(`_keymap: mouse buttons = ${mouseBtns || '(none)'}`);
                installGameCompatibility(S.runtime, S.selectedGame, S.sharedSaves, language, pngFix, km0);
                if (languagePack) {
                        try { await registerLanguageFont(S.runtime, languagePack); }
                        catch (fontError) { log(`Language font install failed: ${fontError instanceof Error ? fontError.message : String(fontError)}`); }
                }
                if (S.runtime.Input?._updateGamepadState && !(S.runtime.Input as any).__bnxStickWrap) {
                        patchSessionMethod('input.stick-bindings', S.runtime.Input, '_updateGamepadState', (originalUpdateGamepad) => {
                                (S.runtime.Input as any).__bnxStickWrap = true;
                                return function() {
                                        originalUpdateGamepad.apply(this, arguments);
                                        if (isSaveLoadKeymapActive()) return;
                                        try { pollStickBindings(S.currentEntry, S.globalKeymap); } catch { /* best-effort */ }
                                };
                        });
                }
                S.mapPrefetch = new MapPrefetcher(assets, log);
                installMapPrefetch(S.runtime, S.mapPrefetch, log);
                if (!S.saveLocation) throw new Error('No save location selected');
                if (S.saveLocation.kind === 'sd' || S.saveLocation.kind === 'game') {
                        if (!validSaveLocation(S.saveLocation, S.selectedGame, S.selectedMod || null)) throw new Error('Invalid save folder');
                        if (S.saveLocation.kind === 'game') ensureGameSaveFolder(Switch as any, S.saveLocation.folder, S.selectedGame, S.selectedMod || null);
                        installSdSaves(S.runtime, Switch as any, S.saveLocation.folder);
                }
                if (S.importRequested) { const count = importSteamSaves(S.runtime, Switch as any, S.selectedGame, S.saveLocation); log(`Imported ${count} Steam save slots`); }
                setLoadingProgress(0.98, 'Starting game…');
                if (S.runtime.Graphics?.render) {
                        patchSessionMethod('graphics.render', S.runtime.Graphics, 'render', (render) => function() {
                                const result = render.apply(this, arguments);
                                // Game and host have separate rAF callbacks. Direct rendering can otherwise
                                // overwrite the movie after host.present(), depending on callback order.
                                if (S.host?.direct()) S.host.paintMovie(!!this._rendered);
                                hud(); return result;
                        });
                }
                if (S.runtime.Graphics?._createRenderer) {
                        patchSessionMethod('graphics.create-renderer', S.runtime.Graphics, '_createRenderer', (create) => function() {
                                const result = create.apply(this, arguments);
                                const renderer = this._renderer, pixi = S.runtime.PIXI;
                                const saturation = pixi?.BLEND_MODES?.SATURATION;
                                if (renderer?.type === pixi?.RENDERER_TYPE?.CANVAS && renderer.blendModes?.[saturation] === 'saturate') renderer.blendModes[saturation] = 'saturation';
                                this._maxSkip = S.host?.direct() ? 0 : 1;
                                return result;
                        });
                }
                if (S.runtime.SceneManager?.updateMain) {
                        installSaveLoadPopHook();
                        patchSessionMethod('scene-manager.update-main', S.runtime.SceneManager, 'updateMain', (update) => function() {
                                if (S.gameStopped || (S.phase === 'notice' && S.exitNoticeArmed)) { this.requestUpdate(); return; }
                                if (S.menu.blocksInput) {
                                        this._accumulator = 0;
                                        if (this._getTimeInMsWithoutMobileSafari) this._currentTime = this._getTimeInMsWithoutMobileSafari();
                                        S.runtime.Input?.clear?.(); this.requestUpdate(); return;
                                }
                                return update.apply(this, arguments);
                        });
                        if (typeof S.runtime.SceneManager.catchException === 'function') {
                                patchSessionMethod('scene-manager.catch-exception', S.runtime.SceneManager, 'catchException', (catchException) => function(error: unknown) {
                                        fail(error);
                                        return catchException.call(this, error);
                                });
                        }
                }
                S.phase = 'game';
                const startup = startGame(S.runtime);
                log(`Game started: ${startup}`);
                if (S.sleepAutoloadPending) {
                        try { installSleepAutoload(); }
                        catch (error) { log(`_sleep: installSleepAutoload threw: ${error instanceof Error ? error.message : String(error)}`); }
                }
                if (S.currentEntry) {
                        try { S.library = markPlayed((Switch as any) as unknown as LibraryAccess, S.library, S.currentEntry.id); } catch { /* non-fatal */ }
                }
        } catch (error) {
                // A launch failure is a transaction failure: do not leave a
                // partially-installed MV realm behind while showing the error UI.
                try { S.host?.dispose(); } catch { /* best-effort */ }
                try { S.mapPrefetch?.dispose(); } catch { /* best-effort */ }
                S.host = undefined;
                S.mapPrefetch = undefined;
                S.gameStopped = true;
                try { endGameSession(); } catch { /* best-effort */ }
                fail(error);
        }
}

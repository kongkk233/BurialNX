# ⚰️ BurialNX

**Independent Switch homebrew loader for RPG Maker MV Games**

BurialNX is a Nintendo Switch homebrew application and **BurialNX Port Kit** for RPG Maker MV/NW.js games. The port contract is expressed through a validated, game-neutral Port Profile; the repository contains no commercial game assets. See the [porting guide](docs/porting-guide.md) to adapt a legally obtained game package.

> **Trusted-package warning:** BurialNX executes game and mod JavaScript in the same nx.js runtime as the loader. It is **not a sandbox** and does not guarantee offline execution; only run packages and mods you trust. See [SECURITY.md](SECURITY.md).

---

## Port Kit release: 0.2.0

This release packages the pinned ARM64 nx.js media runtime and the game-neutral loader contracts for RPG Maker MV/NW.js ports. The media layer supports independent game audio elements, sibling MP4/WebM fallback, unequal audio/video timelines, and detached `<video><source>` inputs. The synthetic fixtures and native-runtime provenance are documented in [runtime validation](runtime/README.md), [movie playback validation](docs/movie-playback-zh.md), and [sprite verification](docs/pixi-movies-zh.md).

The repository's media fixtures are original, synthetic test inputs; no commercial game assets are included. Hardware validation is still required for a particular permitted game package and console; host acceptance is not a physical-device claim.

## 📸 Screenshots

### Library

Browse your game library with cover thumbnails. Reorder games with **L/R** shoulder buttons.

### Game Options
![Game Options](docs/screenshots/game-options.jpg)

Per-game settings: cover, keymap, mod, saves, language, and forwarder management.

### Keymap Editor
![Keymap Editor](docs/screenshots/keymap.jpg)

Full visual keyboard picker — remap any joycon button to any keyboard key or gamepad action. Per-game keymaps with presets.

### In-Game Pause Menu
![Pause Menu](docs/screenshots/pause-menu.jpg)

Hold **Minus** in-game to access the pause menu: save, load, edit keymap, switch language, or return to library.

### In-Game Options
![Options](docs/screenshots/options.jpg)

Options are fully translated — Always Dash, BGM/SFX Volume, On/Off — using the language pack's translation tables.

---

## ✨ Features

### 🎮 Library & Game Management
- **Multi-game library** with JSON persistence on the SD card
- **Cover thumbnails** — auto-extracted from .exe/.ico, or pick your own PNG/JPG/GIF/WebP
- **Game reordering** — move games up/down with L/R shoulder buttons
- **Rename games** — type a custom name, or pick one from a folder/file
- **Mod support** — select a mod folder, enable/disable per-game
- **Save management** — Switch user data, SD card, or game folder; import Steam saves

### 🌍 Localization (.cld files in games)
- **`.cld` language pack** loading — text, embedded font, translated images
- **Full translation** — menu items, dialogue, options (Always Dash → Всегда бежать, BGM Volume → Громкость музыки, On/Off → Вкл./Выкл.)
- **YEP_MessageCore override** — dialogue windows use the localized font with Cyrillic glyphs
- **Language switching** — cycle languages with L/R in pause menu or library settings
- **Preference persisted** in library.json (works in forwarder NROs with saveData=0)

### 🎨 Visual
- **Selection border** renders on top of cover images
- **Cover format support** — PNG, JPG, JPEG, GIF, WebP, ICO, EXE (auto-detect from magic bytes)
- **Marquee scrolling** for long game names
- **Touch screen** support for part of UI navigation - Key Remapping.

### 🕹️ Key Remapping
- **Visual keyboard picker** — 60+ keys, navigate with D-pad or touch
- **Per-game keymaps** — override the global default per game
- **Stick bindings** — L-stick and R-stick directions map to keys
- **Presets** — L/ZL/R/ZR apply common configurations instantly

### 📦 Forwarder NROs
- **Self-contained forwarder** — baked-in game ID, no chain-loading
- **Auto-naming** — folder/file based on sanitized game name (spaces → underscores)
- **Rename on game rename** — forwarder folder + .nro are renamed automatically
- **Clean deletion** — removes .nro, folder, and leftover files

### 🔧 Technical
- **Node.js / NW.js compatibility** — polyfills `require`, `process`, `Buffer`, `nw` globals
- **Audio panning** — StereoPanner fallback for nx.js's missing createPanner
- **Exit crash fix** — removes beforeunload listener before Switch.exit (prevents infinite recursion)
- **Memory management** — explicit GC after forwarder build (frees 54 MB)
- **Debug build** — extra logging, diagnostic snapshots, numbered log files

---

## Package acceptance and neutral validation

`npm run accept:package` is the game-neutral, profile-driven package gate. It validates the profile, entry and ordered script graph, safe asset paths, media policy shape, dynamic save directory/extension round-trip, and session patch rollback without executing target game scripts. Its result explicitly reports `executedGameScripts: false` and `runtimeBehavior: not-observed`.

`npm run accept:host` and `npm run accept:overlay` are separate neutral-fixture deep acceptance checks. They exercise the repository's synthetic neutral runtime contract and are not evidence that a commercial game, native decoder, or Switch hardware has been tested.

`npm run verify:runtime-provenance` recomputes the tracked patch and preroll-runtime blob hashes recorded in `runtime/manifest.json`. Its explicit `not-verified` entries cover external nx.js source, SDK/toolchain, signing, and standalone-artifact claims that are recorded but not reconstructed by this host-only repository.

## 🧰 Port Kit commands

```bash
npm ci
npm run profile:validate -- profiles/examples/minimal-mv.json
npm run port:check -- --game-root tests/fixtures/neutral-mv/www
npm run accept:package   # generic profile contract; does not execute game scripts
npm run accept:host       # neutral fixture deep contract; host-only
npm run accept:overlay    # neutral game + mod-first overlay contract
npm run smoke:neutral     # same neutral contract through the smoke entrypoint
npm run verify:runtime-provenance # recompute tracked runtime patch/blob hashes
npm test                  # host regression tests; not hardware validation
npm run typecheck         # production TypeScript module/bundle boundary
npm run build             # release NRO
npm run verify:release    # all host gates + provenance + clean/repro build + manifest
```

Profiles are described by [`profiles/schema.json`](profiles/schema.json), with a neutral example at [`profiles/examples/minimal-mv.json`](profiles/examples/minimal-mv.json). `createMovieResolver` accepts profile-derived media policy while retaining the default MP4/WebM and `-l` fallback behavior when no profile is supplied.

## 🚀 Installation

### Requirements
- Nintendo Switch with Atmosphère or hbmenu
- SD card

### Steps
1. Download `BurialNX-*.nro` from [Releases](../../releases)
2. Copy to `sdmc:/switch/burialnx/burialnx.nro`
3. Launch from hbmenu
4. Select "Add Game" and browse to your game's `www` folder
5. Play!

### Game Setup
- Game must have `www/index.html` and `www/js/rpg_core.js`
- Place `.cld` language packs in `www/languages/`
- Cover images: place in the game folder or use auto-detect from .exe

---

## 🎯 Controls

| Button | Action |
|--------|--------|
| **D-Pad** | Navigate library/options |
| **A** | Select / Play / Confirm |
| **B** | Back / Cancel |
| **X** | Game options (in library) |
| **Y** | Add game |
| **L / R** | Reorder games (library) / Cycle language (pause menu & options) |
| **Minus** | Pause menu (hold in-game) |
| **Plus** | Quit (hold) |

---

## 🏗️ Building from Source

### Prerequisites
- Node.js 18+
- npm

### Build
```bash
# From this source tree (the upstream tag by itself does not include the movie fix):
cd BurialNX
npm ci
npm test          # neutral fixture, loader, and movie-host regression tests
npm run build     # → burialnx.nro
npm run build -- --debug  # → burialnx-debug.nro
```

### GitHub Actions
This repo includes a manual build workflow. Go to **Actions → "Build NRO" → Run workflow**, enter a version tag, and GitHub builds the .nro and creates a release automatically.

---

## 📜 License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

BurialNX is an independent homebrew project. It is not affiliated with or endorsed by any game creator or platform vendor. All game content belongs to its respective owner.

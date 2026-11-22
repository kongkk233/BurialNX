# Porting guide

> **Security model:** BurialNX is a trusted-package executor, not a sandbox. Game and mod JavaScript run in the same nx.js runtime as the loader and may reach native filesystem/network APIs. Only run packages and mods you trust; see [SECURITY.md](../SECURITY.md).

BurialNX Port Kit targets legally obtained RPG Maker MV/NW.js game packages. A port input must be a game package the operator is allowed to run, with its own `index.html`, JavaScript, data, image/audio/video assets, and save directory. Do not put commercial assets, private SD paths, saves, keys, or title identifiers in this repository.

## Workflow

1. Copy the permitted game package into a local staging directory outside this source tree.
2. Create `burialnx.port.json` in the package `www` root (or in an overlay root) from `profiles/examples/minimal-mv.json`.
3. Validate the profile and package contract with executable checks:

   ```bash
   npm ci
   npm run profile:validate -- /path/to/www/burialnx.port.json
   npm run accept:package -- --game-root /path/to/www
   npm run port:check -- --game-root /path/to/www
   npm run accept:host
   npm run accept:overlay
   ```

   `accept:package` is the generic package gate: it never executes target scripts and reports `executedGameScripts:false` and `runtimeBehavior:'not-observed'`. It checks the profile, entry, ordered local script graph, safe paths, media policy shape, dynamic save naming, and session rollback. `port:check` reads the mod profile before the game profile, verifies the same structural graph, and rejects external or traversal paths. Add `--mod-root /path/to/mod` to either structural command; `accept:overlay` is the separate repository-neutral deep acceptance check with runtime behavior. Add `--manifest ./port-manifest.json` only when you explicitly want a generated audit file.
4. Set the entry HTML, runtime compatibility metadata, save contract, and media policy. Keep paths relative and use forward slashes. If `entry.script` is declared, it must already occur in the HTML script graph; the checker does not inject it. `accept:package` reports that relationship as graph-only, while `accept:package:runtime` reports the declaration as executed only when the same path runs at the same graph index in the host fixture.
5. Run `npm test`, `npm run typecheck`, and `npm run verify:release`.
6. Test the resulting NRO with neutral media fixtures before testing the permitted target package. Host acceptance does not replace native or physical Switch validation.

The profile API is intentionally additive in phase one. Existing launch behavior remains the default when no profile is supplied. In v1, `entry.html`, `assets`, `media`, and file-mode `save.extension` drive launch behavior; `entry.script` remains a validation contract for structural checking, while runtime acceptance can separately observe its execution in the host fixture; `save.directory` is a package-relative diagnostic contract because the actual writable destination is always selected and safety-checked by the operator. `compat.mv`, `compat.node`, and `compat.nwjs` are runtime switches applied before game scripts load; they respectively control MV patches/language hooks, Node globals, and NW.js globals/modules. Switch-user saves intentionally retain MV's `RPG ...` localStorage namespace rather than inventing file extensions. `runtime.kind`, `runtime.version`, and `package` remain validated declarations rather than unverified runtime or package-manager claims. The selected mod profile wins over the base game profile, and the control file is read directly rather than through hashed asset lookup or envelope decoding.

## Assets and media

`assets.hashedLookup` controls whether the reader probes the package's short hashed filename after plain and extensionless names. Plain names always win, so a mod overlay can replace one asset without rewriting the base package. If a package uses a documented wrapper, `assets.envelope` selects the named `basename-xor-v1` decoder with its magic, header size, and length-byte offset; decoding is in memory only and the original SD file is never rewritten. Do not invent or copy a commercial game's private format into the kit—keep the decoder parameters in that game's local profile.

The media resolver protects local paths, checks container headers when a MIME hint is supplied, and preserves Blob URL ownership and SD streaming semantics. A policy may list extension fallbacks (`webm`, `mp4`) and filename variants such as `-l`; variants never contain path separators. A missing candidate may fall back, but a present corrupt file is not silently bypassed. The media resolver receives the same hashed/envelope asset policy as the game reader.

## Validation layers

Host tests cover deterministic logic and fixtures. For the repository fixture, `BURIALNX_GAME_ROOT=tests/fixtures/neutral-mv/www npm run smoke` runs the same executable Port Kit contract in explicit `neutral-port-contract` mode; a permitted full MV game root uses the development smoke harness instead. Browser tests cover DOM/media behavior where available. Native tests cover the Switch runtime and decoder. Hardware playback requires a physical console, known build, permitted game package, and operator observations; `npm test` is not hardware validation.

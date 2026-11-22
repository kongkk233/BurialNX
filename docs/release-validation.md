# Release validation

`npm run verify:release` first runs the executable profile validator, the neutral `port:check`, `accept:host`, and the explicit neutral smoke contract; it then runs host tests, the controlled TypeScript module/bundle check, asserts a clean worktree, performs two host NRO builds and compares their byte hashes, checks the NRO structural header, and writes `release-manifest.json`. The manifest records package version, git commit, whether the worktree was dirty, a deterministic source-tree SHA-256, Node/npm versions, lockfile SHA-256, NRO SHA-256, runtime executable digest (or an explicit null), NACP source summary, neutral host acceptance checks and evidence, mod-overlay host acceptance checks and evidence, the neutral smoke report, and the two-build reproducibility report. The verifier cross-checks overlay precedence, smoke checks/evidence against fresh host acceptance, and binds both reports to the current clean commit and release NRO hash. Dirty worktrees, commit-mismatched smoke/repro reports, and non-identical host builds are release-gate failures; generate the final artifact from the clean `main` commit.

Validation levels:

- **Port contract**: `npm run profile:validate`, `npm run port:check`, and `npm run accept:host`; this uses only the repository's neutral fixture and is explicitly host-only.
- **Host**: `npm test`; no real game directory and no hardware.
- **Build/typecheck**: reproducible dependency install with `npm ci`, NRO packaging, and production graph resolution.
- **Smoke**: `npm run smoke:neutral` checks the repository fixture through the explicit `neutral-port-contract` mode; a permitted full MV directory uses `BURIALNX_GAME_ROOT=<www> npm run smoke` and the development-only simulated-frame harness. The release manifest does not infer full-game smoke or hardware results.
- **Browser**: optional `npm run test:movie:browser`; requires browser/media support.
- **Native**: optional `npm run test:movie:native`; requires native fixtures/toolchain.
- **Hardware**: physical Switch playback and operator evidence. It is not inferred from a passing host test or NRO build, and the manifest remains `not verified` unless explicitly observed.

A release package must include the generated NRO and manifest. NACP metadata comes from the package manifest used by the build; it is not a claim that a target game was tested.

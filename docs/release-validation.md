# Release validation

`npm run verify:release` runs host tests, the controlled TypeScript module/bundle check, builds the release NRO, checks the NRO structural header, and writes `release-manifest.json`. The manifest records package version, git commit, whether the worktree was dirty, a deterministic source-tree SHA-256, Node/npm versions, lockfile SHA-256, NRO SHA-256, runtime executable digest (or an explicit null), NACP source summary, and honest validation states. A dirty manifest is useful for local review but must not be published as the final release provenance; generate the final artifact from the clean `main` commit.

Validation levels:

- **Host**: `npm test`; no real game directory and no hardware.
- **Build/typecheck**: reproducible dependency install with `npm ci`, NRO packaging, and production graph resolution.
- **Browser**: optional `npm run test:movie:browser`; requires browser/media support.
- **Native**: optional `npm run test:movie:native`; requires native fixtures/toolchain.
- **Hardware**: physical Switch playback and operator evidence. It is not inferred from a passing host test or NRO build, and the manifest remains `not verified` unless explicitly observed.

A release package must include the generated NRO and manifest. NACP metadata comes from the package manifest used by the build; it is not a claim that a target game was tested.

# Port Profile schema

A Port Profile is versioned JSON describing the minimum contract between the loader and an RPG Maker MV/NW.js package. The canonical JSON Schema is [`../profiles/schema.json`](../profiles/schema.json); TypeScript callers should use `parsePortProfile` from `src/port-profile.ts` for strict validation and normalized defaults.

Required sections are `runtime`, `entry`, `compat`, `save`, and `package`; `assets` and `media` are optional and receive safe defaults. `assets.hashedLookup` controls the profile's short hashed-name fallback. `assets.envelope` is an explicit, versioned in-memory decoder contract (`basename-xor-v1`) and must only be used when the package owner can document that format. Version `1` defaults media extension fallback to MP4/WebM siblings and variant fallback to `-l`. Profiles are game-neutral: do not encode title IDs, private SD paths, or redistributed game content.

`entry.html` is the active launcher input: the loader reads it and follows its ordered local `<script src>` tags. If `entry.script` is present, it is an active contract: it must appear in that ordered script graph; it is not injected or reordered. `runtime.kind`, `compat.mv`, `compat.nwjs`, `save`, and `package` remain validated metadata in v1; they are emitted by `port:check` so a future runtime can wire them without silently changing current save or compatibility behavior. The v1 launcher wiring that changes behavior is `entry.html`, `entry.script` validation, `assets`, and `media`; the remaining fields are deliberately honest metadata-only contracts.

Unknown future fields should be rejected by the current schema until a profile version explicitly defines them. The phase-one launcher does not require a profile, so existing installations remain compatible.

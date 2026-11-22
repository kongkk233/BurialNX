# `game-assets.ts`

Provides the asset-reading layer the game runtime sees: maps a logical asset path to its on-disk location(s), optionally decodes a profile-selected envelope in memory (never modifying the original SD file), and wraps the raw disk `Reader` in a small bounded LRU cache plus a request-coalescing layer for simultaneous image/data reads. Profiles may enable short SHA-256 asset-name fallback; the resolver always tries the plain name first so an unpacked mod can replace an individual asset.

## `gameAssetNames`

> /**
>  * A profile may store files under a short hash of their normal path. Plain
>  * files are tried first so an unpacked mod can replace an individual asset.
>  */

## `namesForSafePath`

> // The caller already decoded and checked this path. Do not decode it twice:
> // a legitimate filename may itself contain a percent sign.

## `unpackGameAsset`

> /** Decode an optional profile-selected file envelope in memory; never modify the SD file. */

## `gameAssets`

> /** Small bounded cache for repeated images and map data, not large audio. */

### `gameAssets` → `resolve`

> // Hashing is comparatively expensive; only do it when plain files miss.

### `gameAssets` → `read`

> // Share simultaneous image/data reads. Each waiter gets its own copy so
> // native decoders and game code can safely transfer or mutate buffers.

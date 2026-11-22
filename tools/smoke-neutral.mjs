// Cross-platform entrypoint for the repository's neutral Port Kit contract.
// Keep the game root explicit rather than making the general smoke command
// silently choose a fixture or accidentally execute an untrusted package.
import { resolve } from 'node:path';

process.env.BURIALNX_GAME_ROOT = resolve('tests/fixtures/neutral-mv/www');
await import('./smoke.mjs');

if (!globalThis.__neutralMvFixture) throw new Error('rpg_core.js must load first');
globalThis.__neutralMvFixture.scripts.push('main');
globalThis.onload = function () { globalThis.__neutralMvFixture.booted = true; };

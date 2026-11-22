import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cache = new Map();

/** Load a TypeScript module using the same esbuild toolchain as host tests. */
export async function loadBundledModule(relativeEntry) {
  const entry = resolve(root, relativeEntry);
  if (!cache.has(entry)) {
    cache.set(entry, build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      logLevel: 'silent',
    }).then(async (result) => {
      const source = result.outputFiles[0].text;
      return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    }));
  }
  return cache.get(entry);
}

export { root };

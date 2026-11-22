import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '--noEmit', '--project', 'tsconfig.json'], {
  stdio: 'inherit',
});
console.log('typecheck: TypeScript semantic check passed');

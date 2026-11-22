import { execFileSync } from 'node:child_process';

const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' });
if (status.trim()) {
  console.error('release gate requires a clean worktree; commit or remove these paths first:');
  console.error(status.trim());
  process.exitCode = 1;
} else {
  console.log('release gate: clean worktree');
}

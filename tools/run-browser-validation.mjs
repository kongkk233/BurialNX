import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BROWSER_REPORT_PATH, validateBrowserReport } from './browser-report.mjs';

const project = resolve('.');
const reportPath = resolve(project, BROWSER_REPORT_PATH);

if (process.env.BURIALNX_REUSE_BROWSER_REPORT === '1') {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  validateBrowserReport(report, { expectedCommit: commit, requirePass: true });
  console.log(`browser validation report accepted: ${reportPath}`);
} else {
  execFileSync(process.execPath, ['tools/test-video-browser.mjs', '--report', BROWSER_REPORT_PATH], { cwd: project, stdio: 'inherit' });
}

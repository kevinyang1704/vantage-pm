import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skipped = new Set(['.git', 'node_modules', 'release', 'dist', 'target', '.test-tmp', '.tools', 'coverage', 'test-results', 'playwright-report', 'blob-report']);
const marketingDirectory = /(^|\/)(marketing(?:-evidence)?|landing(?:-page)?|website)(\/|$)/i;
const marketingScript = /^scripts\/[^/]*(marketing|landing-page)[^/]*\.(mjs|js|ts|ps1|bat)$/i;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name) || entry.isSymbolicLink()) return [];
    const absolute = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [relative(root, absolute).replaceAll('\\', '/')];
  });
}

let files;
try {
  const top = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (resolve(top) !== root) throw new Error('This directory is a source archive.');
  files = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  // Downloaded ZIPs also support the check, without depending on a parent repo.
  files = walk(root);
}

const unexpected = files.filter(file => {
  const appOrHarnessHtml = file === 'index.html' || file.startsWith('tests/') || file.startsWith('spikes/phase-0-durability/');
  return marketingDirectory.test(file) || marketingScript.test(file) || (/\.html?$/i.test(file) && !appOrHarnessHtml);
});
if (unexpected.length) {
  process.stderr.write(`App-only check failed. Keep website assets outside this repository:\n${unexpected.map(file => `  ${file}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`check-app-only: ${files.length} files checked; app and test harness only.\n`);
}

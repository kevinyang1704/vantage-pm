import { cp, mkdir, readFile, readdir, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== '24.18.0') {
  throw new Error('Package with Windows x64 Node 24.18.0 so the bundled runtime matches the supported version.');
}
// Invoke Vite directly: the recipient package never needs npm or node_modules.
const build = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'production'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PMAPP_COLLABORATION: '0', PMAPP_COLLABORATION_ORIGIN: '' },
});
if (build.status !== 0) process.exit(build.status ?? 1);
const release = join(root, 'release');
const folder = join(release, 'vantage-pm-portable');
await mkdir(release, { recursive: true });
// Never follow a replaced release directory or junction when clearing output.
if ((await realpath(release)).toLowerCase() !== release.toLowerCase()) {
  throw new Error('release/ must be a real directory inside this checkout.');
}
const prior = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (prior?.isSymbolicLink()) throw new Error('Refusing to replace a linked output directory.');
if (resolve(folder) !== resolve(root, 'release', 'vantage-pm-portable')) {
  throw new Error('Unexpected portable output path.');
}
// This verified, fixed directory contains only generated packaging output.
await rm(folder, { recursive: true, force: true });
await mkdir(join(folder, 'runtime'), { recursive: true });
await cp(join(root, 'dist'), join(folder, 'app'), { recursive: true });
await cp(process.execPath, join(folder, 'runtime/node.exe'));
await cp(join(dirname(process.execPath), 'LICENSE'), join(folder, 'runtime/LICENSE'));
await cp(join(root, 'LICENSE'), join(folder, 'LICENSE'));
await cp(join(root, 'scripts/serve-portable.mjs'), join(folder, 'serve-portable.mjs'));
await cp(join(root, 'start_vantage.bat'), join(folder, 'start_vantage.bat'));
await cp(join(root, 'docs/portable-windows.md'), join(folder, 'README.txt'));
// Preserve notices for the bundled application dependencies.
const notices = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) { await collect(join(directory, entry.name)); continue; }
    const packageDir = join(directory, entry.name);
    for (const file of await readdir(packageDir)) {
      if (/^(licen[cs]e|notice|copying)(\.|$)/i.test(file)) {
        try { notices.push(`\n--- ${entry.name}/${file} ---\n${await readFile(join(packageDir, file), 'utf8')}`); } catch { /* directory */ }
      }
    }
  }
}
await collect(join(root, 'node_modules'));
await writeFile(join(folder, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const zip = new JSZip();
async function add(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await add(file, name);
    else zip.file(name, await readFile(file));
  }
}
await add(folder, 'vantage-pm-portable');
const output = join(release, 'vantage-pm-portable-windows-x64.zip');
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
console.log(`Portable package: ${output}`);

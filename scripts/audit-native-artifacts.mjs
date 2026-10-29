import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const marker = 'PMAPP_QUALIFICATION_BUILD_SENTINEL';
const releaseDir = path.resolve('src-tauri', 'target', 'release');
const distDir = path.resolve('dist');

function findBinaries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((entry) => /\.(exe|dll)$/i.test(String(entry)))
    .map((entry) => path.join(dir, String(entry)));
}

function auditBinary() {
  const binaries = findBinaries(releaseDir);
  const qualified = binaries.filter((file) => {
    try {
      return readFileSync(file).includes(marker);
    } catch {
      return false;
    }
  });
  if (qualified.length > 0) {
    console.error(`FAIL: production binary contains qualification sentinel: ${qualified.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASS: no production binary exports the qualification sentinel (${binaries.length} binaries checked).`);
}

function auditDist() {
  const files = readdirSync(distDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.(wasm|js)$/.test(entry) && !entry.includes('pmapp-native-build-identity'));
  const sqliteAssets = files.filter((file) => file.includes('sqlite3') || file.includes('sqlite-wasm'));
  if (sqliteAssets.length > 0) {
    console.warn(`WARN: dist still contains browser SQLite assets: ${sqliteAssets.join(', ')}`);
  } else {
    console.log('PASS: dist contains no browser SQLite-WASM assets');
  }
}

auditBinary();
auditDist();

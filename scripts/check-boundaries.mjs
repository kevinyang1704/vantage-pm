#!/usr/bin/env node
/**
 * Domain-import boundary check (AD-1 enforcement).
 * Fails the build if any file under src/domain/** imports a forbidden package.
 *
 * Forbidden packages: react, react-dom, @sqlite.org/sqlite-wasm,
 * any browser-only global, Worker API, elkjs, pptxgenjs, docx.
 *
 * Usage: node scripts/check-boundaries.mjs
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DOMAIN_DIR = join(ROOT, 'src', 'domain');

const FORBIDDEN = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  '@sqlite.org/sqlite-wasm',
  'elkjs',
  'pptxgenjs',
  'docx',
]);

const FORBIDDEN_PREFIXES = [
  'react/',
  'react-dom/',
  '@sqlite.org/',
];

const FORBIDDEN_BROWSER_GLOBALS = new Set([
  'document', 'window', 'navigator', 'localStorage',
  'sessionStorage', 'indexedDB', 'location', 'history',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker',
  'SharedWorker', 'ServiceWorker', 'MessageChannel',
  'BroadcastChannel', 'Notification', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback',
]);

/**
 * Recursively collect all .ts and .tsx files under a directory.
 */
function collectTsFiles(dir) {
  const files = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectTsFiles(full));
      } else if (extname(entry) === '.ts' || extname(entry) === '.tsx') {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist yet — no files to check
  }
  return files;
}

/**
 * Extract import specifiers from a TypeScript source file.
 * Handles: import { X } from 'specifier'
 *          import 'specifier'
 *          import type { X } from 'specifier'
 *          export { X } from 'specifier'
 */
function extractImports(source) {
  const imports = [];
  // Match static imports
  const staticRe = /(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = staticRe.exec(source)) !== null) {
    imports.push(m[1]);
  }
  // Match dynamic imports
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRe.exec(source)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

/**
 * Check if an import specifier is forbidden.
 */
function isForbidden(specifier) {
  if (FORBIDDEN.has(specifier)) return true;
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check if source code references forbidden browser globals directly.
 * Only flags direct references (e.g., `document.querySelector`), not
 * parameter names or local variables.
 */
function hasForbiddenGlobals(source) {
  // Simple heuristic: check for direct usage of browser globals
  // that aren't inside string literals or comments
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const global of FORBIDDEN_BROWSER_GLOBALS) {
      // Check for the global used as an identifier (not inside a string)
      const re = new RegExp(`\\b${global}\\b`);
      // Skip if it's inside a string literal
      const withoutStrings = trimmed.replace(/(['"`])(?:(?!\1).)*\1/g, '');
      if (re.test(withoutStrings)) {
        return global;
      }
    }
  }
  return null;
}

function main() {
  const files = collectTsFiles(DOMAIN_DIR);
  if (files.length === 0) {
    console.log('check-boundaries: No domain files found — nothing to check.');
    process.exit(0);
  }

  let violations = 0;

  for (const file of files) {
    const rel = file.replace(ROOT + '/', '').replace(ROOT + '\\', '');
    const source = readFileSync(file, 'utf-8');
    const imports = extractImports(source);

    for (const spec of imports) {
      if (isForbidden(spec)) {
        console.error(`VIOLATION: ${rel} imports forbidden package "${spec}"`);
        violations++;
      }
    }

    const forbiddenGlobal = hasForbiddenGlobals(source);
    if (forbiddenGlobal) {
      console.error(`VIOLATION: ${rel} references forbidden browser global "${forbiddenGlobal}"`);
      violations++;
    }
  }

  if (violations > 0) {
    console.error(`\ncheck-boundaries: ${violations} violation(s) found.`);
    console.error('Domain code (src/domain/) must not import React, browser APIs, SQLite, workers, layout, or Office packages (AD-1).');
    process.exit(1);
  }

  console.log(`check-boundaries: ${files.length} domain file(s) checked — clean.`);
  process.exit(0);
}

main();

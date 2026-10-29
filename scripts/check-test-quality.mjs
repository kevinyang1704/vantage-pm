#!/usr/bin/env node
/**
 * Test-quality guard — grep-based enforcement of test hygiene rules.
 *
 * Rejects:
 *   - waitForTimeout( in any spec file (no fixed sleeps)
 *   - .only( outside a local dev branch (no focused tests in shared branches)
 *   - test.skip( outside tests/acceptance/ (acceptance specs are deliberately
 *     skip-until-activated by design)
 *   - Mutable top-level let/var in fixture files (module-scoped shared state
 *     is the concrete failure mode the rule exists to prevent)
 *
 * Also parses test-results/results.xml (JUnit, already produced by Playwright)
 * and fails if any non-@lab-tagged test exceeds 90 seconds.
 *
 * Usage: node scripts/check-test-quality.mjs
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const SPEC_GLOBS = [
  'tests/**/*.spec.ts',
  'src/**/*.spec.ts',
];

const FIXTURE_GLOBS = [
  'tests/support/fixtures/**/*.ts',
  'tests/fixtures/**/*.ts',
];

const ACCEPTANCE_DIR = join(ROOT, 'tests', 'acceptance');

/**
 * Recursively collect files matching glob patterns.
 */
function collectFiles(globs) {
  const files = [];
  for (const glob of globs) {
    const [base, ...rest] = glob.split('/');
    const pattern = rest.join('/');
    const dir = join(ROOT, base);
    if (!existsSync(dir)) continue;
    _walk(dir, pattern, files);
  }
  return files;
}

function _walk(dir, pattern, results, currentRel = '') {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const entryRel = currentRel ? `${currentRel}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) {
        _walk(full, pattern, results, entryRel);
      } else if (_matchesPattern(entryRel, pattern)) {
        results.push(full);
      }
    }
  } catch {
    // Directory doesn't exist — skip
  }
}

function _matchesPattern(relPath, pattern) {
  const normalized = relPath.replaceAll('\\', '/');
  if (pattern.startsWith('support/fixtures/')) {
    return normalized.startsWith('support/fixtures/') && normalized.endsWith('.ts');
  }
  if (pattern.startsWith('fixtures/')) {
    return normalized.startsWith('fixtures/') && normalized.endsWith('.ts');
  }
  if (pattern.endsWith('.spec.ts')) {
    return normalized.endsWith('.spec.ts');
  }
  return normalized.endsWith('.ts');
}

/**
 * Check if we're on a local dev branch (not main, not CI).
 */
function isLocalDev() {
  return !process.env.CI && !process.env.GITHUB_ACTIONS;
}

function main() {
  let violations = 0;

  // --- Spec file checks ---
  const specFiles = collectFiles(SPEC_GLOBS);

  for (const file of specFiles) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf-8');

    // Reject waitForTimeout(
    if (/waitForTimeout\(/.test(source)) {
      console.error(`VIOLATION: ${rel} contains waitForTimeout( — no fixed sleeps allowed`);
      violations++;
    }

    // Reject .only( outside local dev
    if (/\.only\(/.test(source) && !isLocalDev()) {
      console.error(`VIOLATION: ${rel} contains .only( — focused tests forbidden outside local dev`);
      violations++;
    }

    // Reject test.skip( outside tests/acceptance/
    if (/test\.skip\(/.test(source)) {
      const absFile = join(ROOT, rel);
      if (!absFile.startsWith(ACCEPTANCE_DIR)) {
        console.error(`VIOLATION: ${rel} contains test.skip( — only allowed in tests/acceptance/`);
        violations++;
      }
    }
  }

  // --- Fixture file checks ---
  const fixtureFiles = collectFiles(FIXTURE_GLOBS);

  for (const file of fixtureFiles) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf-8');

    // Reject mutable top-level let/var (not inside a function)
    // Simple heuristic: check for `let ` or `var ` at the start of a line
    // (outside of function bodies — we strip function bodies for this check)
    const withoutFunctions = source.replace(
      /(?:function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\})|(?:(?:async\s+)?\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{[\s\S]*?\})|(?:\{[^}]*\})/g,
      '',
    );
    const lines = withoutFunctions.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith('let ') || trimmed.startsWith('var ')) &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*')
      ) {
        console.error(`VIOLATION: ${rel} has mutable top-level binding: "${trimmed.slice(0, 60)}"`);
        violations++;
      }
    }
  }

  // --- Time budget enforcement ---
  const resultsXml = join(ROOT, 'test-results', 'results.xml');
  if (existsSync(resultsXml)) {
    const xml = readFileSync(resultsXml, 'utf-8');
    const timeBudgetMs = 90_000; // 90 seconds

    // Parse testcase elements with their time attributes
    const testcaseRe = /<testcase[^>]*name="([^"]*)"[^>]*time="([^"]*)"[^>]*>/g;
    let match;
    while ((match = testcaseRe.exec(xml)) !== null) {
      const name = match[1] ?? '';
      const timeStr = match[2] ?? '0';
      const timeSec = Number.parseFloat(timeStr);
      const timeMs = timeSec * 1000;

      // Skip @lab-tagged tests
      if (name.includes('@lab')) continue;

      if (timeMs > timeBudgetMs) {
        console.error(
          `VIOLATION: Test "${name}" took ${(timeMs / 1000).toFixed(1)}s ` +
          `(budget: ${timeBudgetMs / 1000}s). Tag with @lab or optimize.`,
        );
        violations++;
      }
    }
  }

  // --- Summary ---
  const specCount = specFiles.length;
  const fixtureCount = fixtureFiles.length;

  if (violations > 0) {
    console.error(
      `\ncheck-test-quality: ${violations} violation(s) found ` +
      `(${specCount} spec file(s), ${fixtureCount} fixture file(s) checked).`,
    );
    process.exit(1);
  }

  console.log(
    `check-test-quality: ${specCount} spec file(s), ${fixtureCount} fixture file(s) checked — clean.`,
  );
  process.exit(0);
}

main();

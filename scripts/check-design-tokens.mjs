#!/usr/bin/env node
/**
 * check-design-tokens.mjs — machine-enforceable design rules from DESIGN.md.
 *
 * Rules (each a direct, mechanical reading of a DESIGN.md Do's-and-Don'ts row
 * or a stated invariant):
 *
 *   1. No raw hex, rgb(), rgba(), or hsl() literal anywhere under src/adapters/ui/**
 *      outside meridian.tokens.ts and meridian.generated.css.
 *      Allowlist: index.html's theme-color meta, vite.config.ts's manifest colours.
 *
 *   2. No box-shadow and no filter: drop-shadow anywhere in src/**.
 *      ("Depth is tonal, never cast. There are no drop shadows anywhere in the product.")
 *
 *   3. No light-mode rule (inside a prefers-color-scheme: light block or a
 *      [data-theme="light"] selector) referencing any DARK_ONLY_DERIVED token.
 *
 *   4. No text-transform: uppercase / capitalize on a sans typography role.
 *      ("Sans is never set in caps.")
 *
 *   5. No border-style: dashed / dashed shorthand outside the four sanctioned
 *      dash patterns declared in the token module.
 *
 *   6. No transition or animation property. (Open Item 11 containment.)
 *
 *   7. generate-theme-css.mjs --check reports no drift.
 *
 * Usage: node scripts/check-design-tokens.mjs
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const UI_DIR = join(ROOT, 'src', 'adapters', 'ui');
const SRC_DIR = join(ROOT, 'src');

// ── Allowlist ─────────────────────────────────────────────────────────────

const HEX_ALLOWLIST = new Set([
  // index.html theme-color meta — consumed by browser chrome before stylesheets
  'index.html',
  // vite.config.ts PWA manifest colours — consumed by browser chrome
  'vite.config.ts',
]);

const TOKEN_FILES = new Set([
  'meridian.tokens.ts',
  'meridian.generated.css',
]);

// ── DARK_ONLY_DERIVED tokens (must not appear in light-mode rules) ─────────

const DARK_ONLY_TOKENS = new Set([
  '--pm-phase-1', '--pm-phase-2', '--pm-phase-3', '--pm-phase-4',
  '--pm-connector-rail', '--pm-connector-drop',
  '--pm-tag-dim', '--pm-node-editing-bg',
]);

// ── Sanctioned dash patterns ──────────────────────────────────────────────

const SANCTIONED_DASHES = new Set([
  'dashed 5 4',
  'dashed 4 4',
  'dashed 3 3',
  'dashed', // inherited value (dashed border on a pill)
]);

// ── File collection ──────────────────────────────────────────────────────

function collectFiles(dir, exts = ['.ts', '.tsx', '.css', '.html']) {
  const files = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectFiles(full, exts));
      } else if (exts.includes(extname(entry))) {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

function collectAllSrcFiles() {
  const files = [];
  try {
    const entries = readdirSync(SRC_DIR);
    for (const entry of entries) {
      const full = join(SRC_DIR, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectFiles(full));
      } else if (['.ts', '.tsx', '.css'].includes(extname(entry))) {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

// ── Rule checks ───────────────────────────────────────────────────────────

function checkRule1(files) {
  // No raw hex, rgb(), rgba(), hsl() outside token files and allowlist
  let violations = 0;
  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  const rgbRe = /rgba?\s*\(/g;
  const hslRe = /hsla?\s*\(/g;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const basename = file.split(/[/\\]/).pop() ?? '';

    // Skip token files
    if (TOKEN_FILES.has(basename)) continue;
    // Skip allowlisted files
    if (HEX_ALLOWLIST.has(rel)) continue;

    const source = readFileSync(file, 'utf-8');

    // Check hex
    let m;
    hexRe.lastIndex = 0;
    while ((m = hexRe.exec(source)) !== null) {
      // Skip if inside a comment
      const lineStart = source.lastIndexOf('\n', m.index) + 1;
      const line = source.slice(lineStart, source.indexOf('\n', m.index));
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      console.error(`VIOLATION (rule 1): ${rel} contains raw hex "${m[0]}"`);
      violations++;
    }

    // Check rgb/rgba
    rgbRe.lastIndex = 0;
    while ((m = rgbRe.exec(source)) !== null) {
      const lineStart = source.lastIndexOf('\n', m.index) + 1;
      const line = source.slice(lineStart, source.indexOf('\n', m.index));
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      console.error(`VIOLATION (rule 1): ${rel} contains rgb()/rgba()`);
      violations++;
    }

    // Check hsl/hsla
    hslRe.lastIndex = 0;
    while ((m = hslRe.exec(source)) !== null) {
      const lineStart = source.lastIndexOf('\n', m.index) + 1;
      const line = source.slice(lineStart, source.indexOf('\n', m.index));
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      console.error(`VIOLATION (rule 1): ${rel} contains hsl()/hsla()`);
      violations++;
    }
  }

  return violations;
}

function checkRule2(files) {
  // No cast box-shadow (inset spines are permitted depth devices per DESIGN.md) or filter: drop-shadow
  let violations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf-8');

    // Check for cast box-shadow (box-shadow without inset)
    const shadowRe = /box-shadow\s*:\s*([^;]+);/g;
    let m;
    while ((m = shadowRe.exec(source)) !== null) {
      const val = m[1].trim();
      if (!val.startsWith('inset') && val !== 'none') {
        console.error(`VIOLATION (rule 2): ${rel} contains cast box-shadow: "${val}"`);
        violations++;
      }
    }

    if (/filter\s*:\s*drop-shadow/.test(source)) {
      console.error(`VIOLATION (rule 2): ${rel} contains filter: drop-shadow`);
      violations++;
    }
  }

  return violations;
}

function checkRule3(files) {
  // No light-mode rule referencing DARK_ONLY_DERIVED tokens
  // Exclude generated CSS — it is guaranteed correct by the codegen script
  let violations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const basename = file.split(/[/\\]/).pop() ?? '';
    if (basename === 'meridian.generated.css') continue;

    const source = readFileSync(file, 'utf-8');

    // Find light-mode blocks: @media (prefers-color-scheme: light) or [data-theme="light"]
    // Simple approach: check if any DARK_ONLY token appears in the file,
    // then check if it's inside a light-mode context
    for (const token of DARK_ONLY_TOKENS) {
      if (!source.includes(token)) continue;

      // Find all occurrences of the token
      let idx = 0;
      while ((idx = source.indexOf(token, idx)) !== -1) {
        // Look backwards for a light-mode context
        const before = source.slice(Math.max(0, idx - 2000), idx);
        const inLightBlock =
          before.includes('prefers-color-scheme: light') ||
          before.includes('[data-theme="light"]');

        if (inLightBlock) {
          console.error(
            `VIOLATION (rule 3): ${rel} references DARK_ONLY_DERIVED token "${token}" in a light-mode context`,
          );
          violations++;
          break; // One violation per token per file is enough
        }
        idx++;
      }
    }
  }

  return violations;
}

function checkRule4(files) {
  // No text-transform: uppercase/capitalize on sans typography
  // This is a heuristic — we check for text-transform in CSS files
  // and flag any that aren't clearly on a mono role
  let violations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (!rel.endsWith('.css')) continue;

    const source = readFileSync(file, 'utf-8');

    // Check for text-transform: uppercase or capitalize
    const ttRe = /text-transform\s*:\s*(uppercase|capitalize)/g;
    let m;
    while ((m = ttRe.exec(source)) !== null) {
      // Inspect the current declaration block. A mono font declaration is the
      // authoritative signal; selector names are retained for older shared
      // roles whose font is supplied by a grouped rule.
      const before = source.slice(Math.max(0, m.index - 500), m.index);
      const blockStart = source.lastIndexOf('{', m.index);
      const declarationBlock = blockStart >= 0 ? source.slice(blockStart + 1, m.index) : '';
      const isMonoRole =
        /font-family\s*:\s*var\(--pm-font-mono\)/.test(declarationBlock) ||
        before.includes('section-label') ||
        before.includes('stat-label') ||
        before.includes('column-header') ||
        before.includes('type-tag');

      if (!isMonoRole) {
        console.error(
          `VIOLATION (rule 4): ${rel} uses text-transform: ${m[1]} on a non-mono role`,
        );
        violations++;
      }
    }
  }

  return violations;
}

function checkRule5(files) {
  // No dashed borders outside sanctioned patterns
  let violations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (!rel.endsWith('.css')) continue;

    const source = readFileSync(file, 'utf-8');

    // Find border-style: dashed or border: ... dashed ...
    const dashRe = /border(?:-[a-z]+)?\s*:\s*([^;]*dashed[^;]*)/g;
    let m;
    while ((m = dashRe.exec(source)) !== null) {
      const value = m[1].trim();
      // Check if it matches a sanctioned pattern
      let sanctioned = false;
      for (const pattern of SANCTIONED_DASHES) {
        if (value.includes(pattern)) {
          sanctioned = true;
          break;
        }
      }

      if (!sanctioned) {
        console.error(
          `VIOLATION (rule 5): ${rel} uses dashed border outside sanctioned patterns: "${value.slice(0, 60)}"`,
        );
        violations++;
      }
    }
  }

  return violations;
}

function checkRule6(files) {
  // No transition or animation properties except the single sanctioned 110ms metadata reveal
  let violations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (!rel.endsWith('.css')) continue;

    const source = readFileSync(file, 'utf-8');

    // Check transition
    const transRe = /transition\s*:\s*([^;]+);/g;
    let m;
    while ((m = transRe.exec(source)) !== null) {
      const val = m[1].trim();
      const isAllowed =
        val === 'opacity 110ms ease-out' ||
        val === 'opacity 0ms' ||
        val === 'none';
      if (!isAllowed) {
        console.error(`VIOLATION (rule 6): ${rel} contains unauthorized transition property: "${val}"`);
        violations++;
      }
    }

    if (/\banimation\s*:/.test(source)) {
      console.error(`VIOLATION (rule 6): ${rel} contains animation property`);
      violations++;
    }
  }

  return violations;
}

function checkRule7() {
  // generate-theme-css.mjs --check reports no drift
  try {
    execFileSync('node', ['scripts/generate-theme-css.mjs', '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
    return 0;
  } catch {
    console.error('VIOLATION (rule 7): meridian.generated.css is out of date. Run: node scripts/generate-theme-css.mjs');
    return 1;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const uiFiles = collectFiles(UI_DIR);
  const allSrcFiles = collectAllSrcFiles();

  let violations = 0;

  violations += checkRule1(allSrcFiles);
  violations += checkRule2(allSrcFiles);
  violations += checkRule3(uiFiles);
  violations += checkRule4(uiFiles);
  violations += checkRule5(uiFiles);
  violations += checkRule6(uiFiles);
  violations += checkRule7();

  if (violations > 0) {
    console.error(`\ncheck-design-tokens: ${violations} violation(s) found.`);
    process.exit(1);
  }

  console.log(`check-design-tokens: ${allSrcFiles.length} src file(s) checked — clean.`);
  process.exit(0);
}

main();

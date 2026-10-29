#!/usr/bin/env node
/**
 * check-motion-budget.mjs — machine-enforceable motion budget rule from EXPERIENCE.md Open Item #11.
 *
 * Scans src/adapters/ui for any transition or animation property outside the single
 * sanctioned metadata reveal (opacity 110ms ease-out / opacity 0ms under reduced motion).
 *
 * Usage: node scripts/check-motion-budget.mjs
 * Exit code: 0 = clean, 1 = violations found
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const UI_DIR = join(ROOT, 'src', 'adapters', 'ui');

export function scanMotionBudget(content, filename = 'inline') {
  const violations = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) {
      continue;
    }

    // Check transition
    const transMatch = /transition(?:-property)?\s*:\s*([^;]+);/.exec(line);
    if (transMatch) {
      const val = transMatch[1].trim();
      const isAllowed =
        val === 'opacity 110ms ease-out' ||
        val === 'opacity 0ms' ||
        val === 'none' ||
        val === 'opacity';
      if (!isAllowed) {
        violations.push({
          file: filename,
          line: i + 1,
          property: 'transition',
          value: val,
          reason:
            'EXPERIENCE.md Open Item #11 — no motion system is defined; 110 ms ease-out metadata reveal is the only specified duration.',
        });
      }
    }

    // Check animation
    if (/\banimation(?:-name)?\s*:/.test(line) && !trimmed.includes('animation: none')) {
      violations.push({
        file: filename,
        line: i + 1,
        property: 'animation',
        value: trimmed,
        reason: 'EXPERIENCE.md Open Item #11 — animations are not permitted.',
      });
    }

    // Check @keyframes
    if (/@keyframes\b/.test(line)) {
      violations.push({
        file: filename,
        line: i + 1,
        property: '@keyframes',
        value: trimmed,
        reason: 'EXPERIENCE.md Open Item #11 — keyframe animations are not permitted.',
      });
    }
  }

  return violations;
}

function collectUiFiles(dir, exts = ['.ts', '.tsx', '.css']) {
  const files = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...collectUiFiles(full, exts));
      } else if (exts.includes(extname(entry))) {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

export function runCheck() {
  const files = collectUiFiles(UI_DIR);
  let totalViolations = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (rel.includes('.spec.') || rel.includes('motion-budget')) continue;

    const content = readFileSync(file, 'utf-8');
    const violations = scanMotionBudget(content, rel);

    for (const v of violations) {
      console.error(
        `VIOLATION: ${v.file}:${v.line} uses ${v.property}: "${v.value}" — ${v.reason}`,
      );
      totalViolations++;
    }
  }

  if (totalViolations > 0) {
    console.error(`check-motion-budget: ${totalViolations} violation(s) found.`);
    return 1;
  }

  console.log(`check-motion-budget: ${files.length} UI file(s) checked — clean.`);
  return 0;
}

// Run CLI when invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runCheck());
}

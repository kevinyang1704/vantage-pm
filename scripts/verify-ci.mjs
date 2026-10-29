#!/usr/bin/env node
/**
 * Reproduce the configured GitHub Actions CI locally (Task F, CI incident
 * 2026-08-16; scope corrected by Story 21.14, C2/AC 3-4).
 *
 * Mirrors the steps of `.github/workflows/ci.yml` in order, stopping at the
 * first failure.
 *
 * Coverage is MODE-DEPENDENT and matches ci.yml exactly:
 *
 *   npm run verify:ci        (default) reproduces the `fast-gate` job ONLY:
 *                            typecheck, boundaries, design tokens, motion,
 *                            theme drift, spike build, unit coverage,
 *                            acceptance specs.
 *
 *   npm run verify:ci -- --full
 *                            ALSO reproduces the `full-ci` job's three test
 *                            steps, in ci.yml order, after the Fast Gate:
 *                            the full non-destructive Playwright selection
 *                            (chrome), check-test-quality.mjs, and the
 *                            axe-scan selection. The `--full` run needs the
 *                            Playwright chrome channel installed and starts
 *                            the two Vite dev servers itself (the workflow's
 *                            `npx playwright install --with-deps chrome` and
 *                            `npm ci` steps are NOT reproduced).
 *
 * Neither mode reproduces the runner environment: ci.yml executes on
 * `ubuntu-latest`, and this script runs on your machine. A green result
 * here is a local reproduction of the configured steps — the first remote
 * run on real Linux is the only evidence of Linux-only behaviour, and a
 * local pass does not substitute for it (Story 21.14, C1).
 *
 * Usage: npm run verify:ci [-- --full]
 * Exit code: 0 = all steps passed, non-zero = first failing step
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CI = 'true';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const FULL_MODE = process.argv.includes('--full');

const FAST_GATE_STEPS = [
  { name: 'Typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'Check domain boundaries', cmd: 'npm', args: ['run', 'check:boundaries', '--if-present'] },
  { name: 'Check design tokens', cmd: 'npm', args: ['run', 'check:design-tokens'] },
  { name: 'Check motion budget', cmd: 'npm', args: ['run', 'check:motion'] },
  { name: 'Check theme CSS drift', cmd: 'npm', args: ['run', 'generate:theme', '--', '--check'] },
  { name: 'Build durability spike bundle', cmd: 'npm', args: ['run', 'build:spike'] },
  { name: 'Unit tests with coverage', cmd: 'npm', args: ['run', 'test:coverage'] },
  { name: 'Acceptance contract specs', cmd: 'npm', args: ['run', 'test:acceptance'] },
];

// The `full-ci` job's three test steps, in workflow order. Each Playwright
// invocation cold-starts both Vite dev servers, exactly as the workflow does.
// On Windows (spawnSync shell path) grep patterns with spaces must be quoted
// or the command line splits them; elsewhere args pass directly, unquoted.
const IS_WIN = process.platform === 'win32';
const q = (pattern) => (IS_WIN ? `"${pattern}"` : pattern);
const FULL_CI_STEPS = [
  {
    name: 'Full E2E smoke (non-destructive, chrome)',
    cmd: 'npx',
    args: ['playwright', 'test', '--grep-invert', q('phase-0-durability'), '--project=chrome'],
  },
  { name: 'Check test quality', cmd: 'node', args: ['scripts/check-test-quality.mjs'] },
  {
    name: 'Accessibility scan (axe-core)',
    cmd: 'npx',
    args: [
      'playwright',
      'test',
      '--project=chrome',
      '--grep',
      q('axe scan'),
      '--grep-invert',
      q('phase-0-durability'),
    ],
  },
];

function runStep({ name, cmd, args }) {
  console.log(`\n===== verify:ci → ${name} =====`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return { ok: result.status === 0, status: result.status };
}

async function main() {
  const steps = FULL_MODE ? [...FAST_GATE_STEPS, ...FULL_CI_STEPS] : FAST_GATE_STEPS;

  for (const step of steps) {
    const result = runStep(step);
    if (!result.ok) {
      console.error(`\nverify:ci FAILED at step "${step.name}" (exit ${result.status}). Stopping.`);
      process.exit(1);
    }
  }

  console.log(
    FULL_MODE
      ? '\nverify:ci --full: all Fast Gate and Full CI test steps passed.'
      : '\nverify:ci: all Fast Gate steps passed.',
  );
  console.log(
    'This is a LOCAL reproduction of the configured checks — it does not ' +
      'predict Linux-only behaviour on the ubuntu-latest runner (Story 21.14, C1).',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('verify:ci: unexpected error', err);
  process.exit(1);
});
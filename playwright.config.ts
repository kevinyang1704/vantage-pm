import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const isCI = Boolean(process.env.CI);
const campaignDigest = randomBytes(10).toString('hex');
process.env.PMAPP_QUALIFICATION_CAMPAIGN_ID ??=
  `019ffd50-0000-7${campaignDigest.slice(0, 3)}-8${campaignDigest.slice(3, 6)}-${campaignDigest.slice(6, 18)}`;
process.env.PMAPP_QUALIFICATION_BROWSER_MODE ??= process.argv.includes('--headed') ? 'headed' : 'headless';
process.env.PMAPP_QUALIFICATION_OS_BUILD ??= (() => {
  if (process.platform !== 'win32') return `${process.platform}:${process.version}`;
  try {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', 'ver'], { encoding: 'utf8' }).trim();
  } catch {
    return 'WINDOWS_BUILD_EXTERNAL_QUERY_FAILED';
  }
})();

/**
 * Dev-server ports. Defaults are the vite configs' pinned 5173 (product) and
 * 4173 (qualification harness). The Lab workflow sets PMAPP_E2E_PRODUCT_PORT
 * and PMAPP_E2E_QUALIFICATION_PORT so its servers never collide with a dev
 * server left running on the runner machine, which doubles as a workstation
 * (QUALITY-CONTRACT §3). Every spec reads BASE_URL / QUALIFICATION_URL, so the
 * derived URLs are published here for the workers to inherit.
 */
const productPort = process.env.PMAPP_E2E_PRODUCT_PORT;
const qualificationPort = process.env.PMAPP_E2E_QUALIFICATION_PORT;
if (productPort) process.env.BASE_URL ??= `http://127.0.0.1:${productPort}`;
if (qualificationPort) process.env.QUALIFICATION_URL ??= `http://127.0.0.1:${qualificationPort}`;
const productUrl = `http://127.0.0.1:${productPort ?? '5173'}`;
const qualificationUrl = `http://127.0.0.1:${qualificationPort ?? '4173'}`;

export default defineConfig({
  testDir: './tests/e2e',
  // Performance harnesses are opt-in (PMAPP_PERF=1, the Lab's forecast-responsiveness
  // job). Evidence capture is opt-in (PMAPP_EVIDENCE=1). Excluded here rather
  // than with test.skip, which check-test-quality forbids outside tests/acceptance/.
  testIgnore: [
    ...(process.env.PMAPP_PERF ? [] : ['**/*.perf.spec.ts']),
    ...(process.env.PMAPP_EVIDENCE ? [] : ['**/epic-24-evidence.spec.ts']),
  ],
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['list'],
  ],
  use: {
    // The Phase 0 qualification harness (relative `/qualification.html`).
    // Deliberately NOT BASE_URL: every product spec reads BASE_URL as the
    // product app's URL, so sharing it sent the durability specs to the
    // product server whenever a worktree pointed BASE_URL at its dev port.
    baseURL: process.env.QUALIFICATION_URL ?? qualificationUrl,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure-and-retries',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: qualificationPort ? `npm run dev:spike -- --port ${qualificationPort}` : 'npm run dev:spike',
      url: `${qualificationUrl}/qualification.html`,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: productPort ? `npm run dev -- --port ${productPort}` : 'npm run dev',
      url: productUrl,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chrome',
      use: { channel: 'chrome' },
    },
    {
      name: 'msedge',
      use: { channel: 'msedge' },
    },
  ],
});

import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Epic 27 collaboration scenarios: a real local pmapp-server plus a
 * collaboration-flag app build, driven by two isolated browser contexts.
 * Separate from the product config so its single-origin guarantees stay
 * strict. Each run uses a fresh throwaway server data directory.
 */
const appPort = process.env.PMAPP_COLLAB_APP_PORT ?? '5297';
const serverPort = process.env.PMAPP_COLLAB_SERVER_PORT ?? '8797';
process.env.PMAPP_COLLAB_APP_URL ??= `http://127.0.0.1:${appPort}`;
process.env.PMAPP_COLLAB_SERVICE_URL ??= `http://127.0.0.1:${serverPort}`;
const dataDir = process.env.PMAPP_COLLAB_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'pmapp-collab-e2e-'));
const env = { ...process.env, PMAPP_COLLAB_APP_PORT: appPort, PMAPP_COLLAB_SERVER_PORT: serverPort, PMAPP_DATA_DIR: dataDir } as Record<string, string>;

export default defineConfig({
  testDir: './tests/collab',
  outputDir: 'test-results/collab',
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/collab', open: 'never' }]],
  use: { actionTimeout: 15_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } }],
  webServer: [
    {
      command: 'node scripts/dev-collaboration.mjs server',
      url: `http://127.0.0.1:${serverPort}/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 600_000,
    },
    {
      command: 'node scripts/dev-collaboration.mjs app',
      url: `http://127.0.0.1:${appPort}`,
      env,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

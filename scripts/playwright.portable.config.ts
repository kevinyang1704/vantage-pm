import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export default defineConfig({
  testDir: resolve(root, 'tests/e2e'),
  testMatch: ['local-file-collaboration.spec.ts', 'web-portable-import.spec.ts'],
  outputDir: resolve(root, 'test-results/portable'),
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: { channel: 'chrome', baseURL: 'http://127.0.0.1:5173', trace: 'on', screenshot: 'only-on-failure' },
  webServer: {
    command: 'release\\vantage-pm-portable\\runtime\\node.exe release/vantage-pm-portable/serve-portable.mjs --no-open',
    cwd: root,
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testDir: './tests/acceptance',
  webServer: undefined,
  projects: [
    {
      name: 'contract',
      use: baseConfig.use,
    },
  ],
});

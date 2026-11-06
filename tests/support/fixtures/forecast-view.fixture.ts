import { test as base } from '@playwright/test';
import type { Browser } from '@playwright/test';

export type ForecastViewOption = 'board' | 'list';

type ForecastViewFixtures = {
  /**
   * The legacy Forecast specs exercise the List view and its selectors.
   * Delivery-board specs opt into `board` explicitly.
   */
  forecastView: ForecastViewOption;
  /** Auto fixture: seeds the browser preference before the app boots. */
  forecastViewSetup: void;
  /** Overridden so contexts created inside a spec inherit the preference. */
  browser: Browser;
};

export const forecastViewTest = base.extend<ForecastViewFixtures>({
  forecastView: ['list', { option: true }],

  browser: async ({ browser }, use) => {
    const originalNewContext = browser.newContext.bind(browser);
    // Contexts created inside a spec do not inherit the page-level script.
    // The existing Forecast regression suite expects the List view there.
    browser.newContext = (async (options) => {
      const context = await originalNewContext(options);
      await context.addInitScript(() => {
        try {
          window.localStorage.setItem('vantage.forecast.view', 'list');
        } catch {
          /* storage may be unavailable */
        }
      });
      return context;
    }) as typeof browser.newContext;
    try {
      await use(browser);
    } finally {
      browser.newContext = originalNewContext as typeof browser.newContext;
    }
  },

  forecastViewSetup: [
    async ({ page, forecastView }, use) => {
      await page.addInitScript((view) => {
        try {
          window.localStorage.setItem('vantage.forecast.view', view);
        } catch {
          /* storage may be unavailable */
        }
      }, forecastView);
      await use();
    },
    { auto: true },
  ],
});

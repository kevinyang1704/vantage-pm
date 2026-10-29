/**
 * Injected "today" for browser scenarios (Story 26.6, FC-NFR2, AC 26.6-4).
 *
 * The live build evaluates the forecast as of the local calendar date. Tests
 * must never read the wall clock, so this fixture seeds
 * `globalThis.__PMAPP_TODAY__` before every page script with a fixed date
 * before the plans' start dates (2026-09-07 and later) — the as-of offset is
 * then exactly zero and the pre-26.6 arithmetic is preserved. A scenario that
 * exercises "from today" overrides the value with `page.addInitScript` before
 * navigating (see `forecast-from-today.spec.ts`).
 */

import { test as base } from '@playwright/test';

export const todayFixture = base.extend<{ injectedToday: string }>({
  injectedToday: ['2020-01-01', { option: true }],
  page: async ({ page, injectedToday }, use) => {
    await page.addInitScript((value) => {
      (globalThis as { __PMAPP_TODAY__?: string }).__PMAPP_TODAY__ = value;
    }, injectedToday);
    await use(page);
  },
});

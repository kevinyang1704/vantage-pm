/**
 * Narrow forecast browser helpers (Story 26.1).
 *
 * The raw math (Coverage / Arithmetic / Assumptions) is folded behind the
 * "Show the math" disclosure as of Story 26.1 AC 26.1-3. Any scenario that
 * reads one of those values must first open the disclosure; this helper keeps
 * that one gesture in one place.
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Opens the "Show the math" disclosure if it is currently collapsed. */
export async function revealForecastMath(page: Page): Promise<void> {
  const disclosure = page.getByRole('button', { name: /Show the math/ });
  await expect(disclosure).toBeVisible({ timeout: 30_000 });
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') {
    await disclosure.click();
  }
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
}

/**
 * A settled-sync for a configured plan, then the math is revealed. Waits for
 * the plain-language Live plan card (which the level chip sits beside) to be
 * present, then opens the folded "Show the math" disclosure. Replaces the old
 * `Capacity / sprint` visibility wait, which no longer renders folded
 * (Story 26.1 AC 26.1-3).
 */
export async function expectForecastReady(page: Page): Promise<void> {
  await expect(page.locator('.pm-forecast__completion').first()).toBeVisible({ timeout: 30_000 });
  await revealForecastMath(page);
}

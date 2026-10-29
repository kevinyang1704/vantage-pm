/**
 * Forecast-owned blockers — browser acceptance (Story 20.1, AC 20.1-1,
 * 20.1-2, 20.1-5, 20.1-6, AR-12).
 *
 * Marking an included Feature as blocked turns a complete numeric forecast
 * `Conditional` with no assumed delay; clearing it restores `ready`;
 * excluding a blocked Feature clears its blocker; and the blocker fact
 * survives a reload. Uses merged Playwright fixtures, deterministic seeded
 * graphs, event-based synchronisation, and no fixed sleeps.
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';

/** Overridable so a worktree can run against its own dev server port. */
const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function typeFirstNodeAsFeature(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

async function configureAndSelectOneEstimatedFeature(page: import('@playwright/test').Page): Promise<void> {
  // First-run entry is the Planning Level step (AC 21.5-2): Continue opens
  // plan configuration.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);

  // Add from the Backlog (AC 21.5-1). The ✕ remove control renders only once
  // the membership command is acknowledged, so waiting on it guarantees the
  // follow-up estimate command reads the post-membership revision — web-first
  // synchronization (AC 21.5-4), never a fixed sleep.
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
  const pointsInput = page.getByRole('spinbutton', { name: /Points for .*/ }).first();
  await pointsInput.fill('20');
  await pointsInput.blur();
  // The completion card reads a real Sprint once the projection settles.
  await expect(page.getByText('capacity-derived')).toBeVisible();
}

test('marking a Feature blocked makes the forecast Conditional with no assumed delay', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureAndSelectOneEstimatedFeature(page);

  const completionValue = page.locator('.pm-forecast__completion-value');
  // 20 points / 10 per sprint = 2 sprints; start Sprint 12 → completion Sprint 13.
  await expect(completionValue).toHaveText('Sprint 13');

  await page.getByRole('button', { name: /Mark .* as blocked/ }).first().click();

  await expect(page.getByText(/Conditional —/)).toBeVisible();
  await expect(page.getByText(/No delay duration was assumed\./).first()).toBeVisible();
  // The numeric timeline is unchanged — the blocker invents no delay.
  await expect(completionValue).toHaveText('Sprint 13');
  await expect(page.getByText('· blocked (no delay assumed)')).toBeVisible();
});

test('clearing the blocker removes only the conditional fact', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureAndSelectOneEstimatedFeature(page);

  await page.getByRole("button", { name: /Mark .* as blocked/ }).first().click();
  await expect(page.getByText(/Conditional —/)).toBeVisible();

  await page.getByRole("button", { name: /Clear blocker on .*/ }).first().click();
  await expect(page.getByText(/Conditional —/)).toHaveCount(0);
  await expect(page.getByText('capacity-derived')).toBeVisible();
});

test('excluding a blocked Feature clears its blocker, and the fact survives a reload', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureAndSelectOneEstimatedFeature(page);

  await page.getByRole("button", { name: /Mark .* as blocked/ }).first().click();
  await expect(page.getByText('· blocked (no delay assumed)')).toBeVisible();

  // Reload — the blocker persists.
  await page.reload();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await expect(page.getByText('· blocked (no delay assumed)')).toBeVisible();

  // Exclude the blocked Feature — the blocker is cleared with membership.
  const removeButton = page.getByRole('button', { name: /Remove .* from the priority list/ }).first();
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  await expect(removeButton).toHaveCount(0);
  await expect(page.getByText('· blocked (no delay assumed)')).toHaveCount(0);
});

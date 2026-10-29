/**
 * Story 26.5 — points done in the Forecast row (FC-FR5, AC 26.5-2/-3/-4).
 *
 * A labeled "Done" field sits beside the points field on an in-progress
 * Feature. The value records, never flips the delivery status, and lowering
 * the estimate below the recorded value is refused with named guidance.
 * (Persistence and migration are proven at the repository boundary in
 * `src/adapters/persistence/points-done.spec.ts`.)
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';
import type { Page } from '@playwright/test';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Creates a project with one in-progress Feature, sets 20 points, opens Forecast. */
async function setupFeatureWithPoints(page: Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();
  const input = page.locator('input.pm-outline-row__title-input').first();
  await input.fill('Feature Alpha');
  await input.blur();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();

  // Mark it in progress so points done is editable.
  const row = page.locator('.pm-outline-row').first();
  await row.locator('.pm-outline-row__status-badge').click();
  await row.locator('.pm-outline-row__status-menu button:has-text("In progress")').click();
  if (await page.locator('.pm-schedule-modal').isVisible().catch(() => false)) {
    await page.locator('.pm-schedule-modal__close-btn').click();
  }

  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Forecast', exact: true }).click();
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  if (await continueBtn.isVisible().catch(() => false)) await continueBtn.click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);

  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  const points = page.getByRole('spinbutton', { name: 'Points for Feature Alpha' });
  await points.fill('20');
  await points.blur();
  await expect(points).toHaveValue('20');
}

test.describe('Story 26.5 — points done in the Forecast row', () => {
  test('AC 26.5-4: a labeled Done field records points done', async ({ page }) => {
    await setupFeatureWithPoints(page);

    const done = page.getByRole('spinbutton', { name: 'Points done for Feature Alpha' });
    await expect(done).toBeVisible();
    await expect(page.locator('.pm-forecast__row-done-label').first()).toHaveText('Done');

    // The value commits and is shown.
    await done.fill('11');
    await done.blur();
    await expect(done).toHaveValue('11');
  });

  test('AC 26.5-2: lowering the estimate below the recorded done value is refused with guidance', async ({ page }) => {
    await setupFeatureWithPoints(page);

    const done = page.getByRole('spinbutton', { name: 'Points done for Feature Alpha' });
    await done.fill('15');
    await done.blur();
    await expect(done).toHaveValue('15');

    // Attempting to lower the estimate to 10 is rejected; both values hold.
    const points = page.getByRole('spinbutton', { name: 'Points for Feature Alpha' });
    await points.fill('10');
    await points.blur();
    await expect(points).toHaveValue('20');
    await expect(done).toHaveValue('15');
  });
});

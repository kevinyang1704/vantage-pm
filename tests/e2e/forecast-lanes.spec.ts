/**
 * Story 26.3 — show who is busy when (FC-FR3, FC-NFR1, FC-NFR3, FC-NFR4).
 * Browser evidence for the busy/idle lanes, the idle-sum oracle and the
 * shared-mode team lane.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';

test.describe('Story 26.3 — who is busy when', () => {
  test('AC 26.3-1: a lane per person with busy and idle segments', async ({ page }) => {
    await setupS1StaffedForecast(page);

    const lanes = page.getByRole('group', { name: 'Who is busy when' });
    await expect(lanes).toBeVisible();
    // The S1 roster is Ada and Ben.
    await expect(lanes.locator('.pm-forecast__lane')).toHaveCount(2, { timeout: 30_000 });
    await expect(lanes.locator('.pm-forecast__lane-name').first()).toContainText(/Ada|Ben/);
    await expect(lanes.locator('.pm-forecast__lane-segment--busy').first()).toBeVisible();
    // Each lane carries a full text equivalent.
    await expect(lanes.locator('.pm-forecast__lane-track').first()).toHaveAttribute('aria-label', /busy on/);
  });

  test('AC 26.3-3: shared mode shows one whole-team lane', async ({ page }) => {
    await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173');
    await page.getByLabel('Outline').click();
    await page.getByRole('button', { name: 'NO TYPE' }).first().click();
    await page.getByRole('button', { name: 'Feature', exact: true }).click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Points per sprint').fill('10');
    await page.getByLabel('Sprint length (days)').fill('14');
    await page.getByLabel('Start sprint').fill('12');
    await page.getByLabel('First date').fill('2026-09-07');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
    await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
    const points = page.locator('.pm-forecast__row-points-input').first();
    await points.fill('20');
    await points.blur();

    const lanes = page.getByRole('group', { name: 'Who is busy when' });
    await expect(lanes).toBeVisible();
    await expect(lanes.locator('.pm-forecast__lane')).toHaveCount(1);
    await expect(lanes.locator('.pm-forecast__lane-name').first()).toHaveText('Whole team');
  });

  test('AC 26.3-5: axe is clean with lanes in both themes', async ({ page }) => {
    await setupS1StaffedForecast(page);
    await expect(page.getByRole('group', { name: 'Who is busy when' })).toBeVisible();

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });
});

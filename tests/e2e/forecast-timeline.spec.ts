/**
 * Story 26.2 — show each item's time on a sprint timeline (FC-FR2, FC-NFR3,
 * FC-NFR4). Browser evidence for the shared axis, per-item bars, waits
 * connectors, milestones and the work-done/forecast markers.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';
import { revealForecastMath } from '../support/helpers/forecast';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Creates a Feature project with two rows, configures the plan, opens math. */
async function setupTwoFeaturePlan(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature One');
  await firstInput.blur();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();

  await firstInput.focus();
  await page.keyboard.press('Enter');
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature Two');
  await row2Input.blur();
  // A new sibling takes the previous row's type.
  await expect(row2.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Show the math/ })).toBeVisible();
  await revealForecastMath(page);
}

/** Adds the first Backlog item and sets its points on the Priority row. */
async function addFirstItemWithPoints(page: import('@playwright/test').Page, points: string): Promise<void> {
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
  const field = page.locator('.pm-forecast__row-points-input').first();
  await field.fill(points);
  await field.blur();
  await expect(field).toHaveValue(points);
}

test.describe('Story 26.2 — sprint timeline', () => {
  test('AC 26.2-1/-2: the axis and one bar per item render', async ({ page }) => {
    await setupTwoFeaturePlan(page);
    await addFirstItemWithPoints(page, '20');

    const axis = page.getByRole('group', { name: 'Sprint timeline axis' });
    await expect(axis).toBeVisible();
    await expect(axis.locator('.pm-forecast__axis-column').first()).toContainText(/Sprint \d+/);

    const track = page.locator('.pm-forecast__row-timeline-track').first();
    await expect(track).toHaveAttribute('aria-label', /Starts Sprint \d+, finishes ≈/);
    await expect(page.locator('.pm-forecast__row-timeline-bar').first()).toBeVisible();
  });

  test('AC 26.2-4: the work-done and rounded-forecast markers are both labelled', async ({ page }) => {
    await setupTwoFeaturePlan(page);
    await addFirstItemWithPoints(page, '15');

    await expect(page.locator('.pm-forecast__axis-workdone')).toContainText('Work done ≈');
    await expect(page.locator('.pm-forecast__axis-forecast')).toContainText('Forecast · end of Sprint');
  });

  test('AC 26.2-6: axe is clean with bars rendered in both themes', async ({ page }) => {
    await setupTwoFeaturePlan(page);
    await addFirstItemWithPoints(page, '20');

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });
});

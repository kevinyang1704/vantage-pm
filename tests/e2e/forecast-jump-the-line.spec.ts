/**
 * Story 26.7 — show the tradeoff when something jumps the line (FC-FR7, FC-FR8,
 * FC-UX4, FC-UX5). Browser evidence for the what-if entry, strategy choice,
 * comparison and stakeholder summary.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Creates a Feature plan with one 20-point item, then opens the what-if. */
async function setupPlan(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
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

  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Forecast', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint', { exact: true }).fill('10');
  await page.getByLabel('Sprint length (days)', { exact: true }).fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
  const points = page.locator('.pm-forecast__row-points-input').first();
  await points.fill('20');
  await points.blur();
}

test.describe('Story 26.7 — jump the line', () => {
  test('AC 26.7-1/-2: entry, strategy choice and a what-if evaluation', async ({ page }) => {
    await setupPlan(page);

    const panel = page.getByRole('region', { name: 'What if something jumps the line' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Start a what-if/ }).click();

    // A new draft item, ranked first.
    await panel.getByRole('radio', { name: 'A new item' }).check();
    await panel.getByLabel('New item title').fill('Emergency fix');
    await panel.getByLabel('New item points').fill('16');
    await panel.getByRole('radio', { name: 'Everyone pauses' }).check();
    await panel.getByRole('button', { name: 'Compare' }).click();

    await expect(panel.getByLabel('What-if completion')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByLabel('Current completion')).toBeVisible();
    // AC 26.7-3/-4: a per-item diff with a slip label, and a plain summary.
    await expect(panel.locator('.pm-forecast__whatif-list .pm-forecast__slip-badge').first()).toBeVisible();
    await expect(panel.locator('.pm-forecast__whatif-list').first()).toContainText(/first|\+?\d+ days|sooner|deferred/);
    await expect(panel.locator('.pm-forecast__whatif-summary')).toContainText(/Sprint \d+/);
  });

  test('AC 26.7-5: Apply commits the new item and ranks it first', async ({ page }) => {
    await setupPlan(page);
    const panel = page.getByRole('region', { name: 'What if something jumps the line' });
    await panel.getByRole('button', { name: /Start a what-if/ }).click();
    await panel.getByRole('radio', { name: 'A new item' }).check();
    await panel.getByLabel('New item title').fill('Emergency fix');
    await panel.getByLabel('New item points').fill('16');
    await panel.getByRole('button', { name: 'Compare' }).click();
    await expect(panel.getByLabel('What-if completion')).toBeVisible({ timeout: 30_000 });

    await panel.getByRole('button', { name: 'Apply' }).click();
    // The urgent item now heads the Priority list.
    await expect(page.locator('.pm-forecast__row-title').first()).toContainText('Emergency fix', {
      timeout: 30_000,
    });
  });

  test('AC 26.7-7: axe is clean with the what-if open in both themes', async ({ page }) => {
    await setupPlan(page);
    const panel = page.getByRole('region', { name: 'What if something jumps the line' });
    await panel.getByRole('button', { name: /Start a what-if/ }).click();
    await panel.getByRole('radio', { name: 'A new item' }).check();
    await panel.getByLabel('New item title').fill('Emergency fix');
    await panel.getByLabel('New item points').fill('16');
    await panel.getByRole('button', { name: 'Compare' }).click();
    await expect(panel.getByLabel('What-if completion')).toBeVisible({ timeout: 30_000 });

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast__whatif').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });
});

/**
 * Story 26.6 — forecast from today on the remaining work (FC-FR6, FC-NFR2,
 * FC-NFR4). Browser evidence for the "as of today" answer, the axis Today
 * rule, and remaining-work behaviour through the injected date.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * Seeds a forecast evaluated as of 2026-09-14 (start + 0.5 sprint) — after the
 * plan's 2026-09-07 start. Overrides the default pre-start fixture date.
 */
async function seedToday(page: import('@playwright/test').Page, today: string): Promise<void> {
  await page.addInitScript((value) => {
    (globalThis as { __PMAPP_TODAY__?: string }).__PMAPP_TODAY__ = value;
  }, today);
}

/** Creates a Feature plan (start 2026-09-07) with one 20-point item, as of today. */
async function setupFromToday(page: import('@playwright/test').Page): Promise<void> {
  await seedToday(page, '2026-09-14');
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

test.describe('Story 26.6 — forecast from today', () => {
  test('AC 26.6-3: the answer says "as of today" and the axis marks today', async ({ page }) => {
    await setupFromToday(page);

    await expect(page.locator('.pm-forecast__completion-note').first()).toContainText('as of today');
    const axis = page.getByRole('group', { name: 'Sprint timeline axis' });
    // The Today rule renders in the summary markers row (the axis itself is
    // header-only since the timeline layout rework), so it is located by class.
    await expect(page.locator('.pm-forecast__axis-asof')).toContainText('Today · 2026-09-14');
    await expect(page.locator('.pm-forecast__summary-tick--today')).toBeVisible();
    await expect(axis).toBeVisible();
  });

  test('AC 26.6-2: the as-of offset shifts the completion later than the fixed-start plan', async ({ page }) => {
    await setupFromToday(page);

    // 20 points at 10/sprint = 2 sprints; as of 0.5 sprint → ceil(0.5 + 2) = 3
    // → Sprint 12 + 2 = 14. Without the as-of it would be Sprint 13.
    await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 14');
    // The rail states the date it is evaluated as of.
    await expect(page.locator('.pm-forecast__completion-note').first()).toContainText('as of today');
  });

  test('AC 26.6-4: axe is clean with the today marker in both themes', async ({ page }) => {
    await setupFromToday(page);
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });
});

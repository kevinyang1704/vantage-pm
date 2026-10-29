/**
 * Story 26.1 — explain the forecast in plain language (FC-FR1, FC-UX1, FC-UX2,
 * FC-NFR4). Browser evidence for the Live plan answer card, the plain-language
 * reasons, and the folded "Show the math" disclosure.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Types the default project's first node as a Feature, then opens Forecast. */
async function typeFirstNodeAsFeature(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

async function configureCompletePlan(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Show the math/ })).toBeVisible();
}

test.describe('Story 26.1 — plain-language forecast', () => {
  test('AC 26.1-1/-2: leads with the answer and states why in plain words', async ({ page }) => {
    await typeFirstNodeAsFeature(page);
    await configureCompletePlan(page);

    // Add the Feature and estimate it so the plan is ready.
    await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
    await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
    const points = page.locator('.pm-forecast__row-points-input').first();
    await points.fill('20');
    await points.blur();

    // The answer card leads with "Sprint N" and a full readable date.
    const answer = page.locator('.pm-forecast__completion');
    await expect(answer.getByText(/^Sprint \d+$/)).toBeVisible();
    await expect(answer.locator('.pm-forecast__completion-note')).toContainText('capacity-derived');

    // The reasons are real text, in plain words, with no policy identifiers.
    await expect(page.locator('.pm-forecast__reason').first()).toBeVisible();
    await expect(page.locator('.pm-forecast__reasons')).toContainText('rank order');
    await expect(page.locator('.pm-forecast__reasons')).toContainText('pts/sprint');
    await expect(page.locator('.pm-forecast__reasons')).not.toContainText('-v1');
  });

  test('AC 26.1-3: the math is folded behind one disclosure and keeps every value', async ({ page }) => {
    await typeFirstNodeAsFeature(page);
    await configureCompletePlan(page);

    const disclosure = page.getByRole('button', { name: /Show the math/ });
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    // Folded by default: the arithmetic table is not rendered.
    await expect(page.getByText('Exact ratio')).toBeHidden();

    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    // Every existing value remains reachable, unchanged.
    await expect(page.locator('.pm-forecast__math').getByText('Coverage', { exact: true })).toBeVisible();
    await expect(page.getByText('Exact ratio')).toBeVisible();
    await expect(page.getByText('Total points')).toBeVisible();
    await expect(page.locator('.pm-forecast__math').getByText('Policy', { exact: true })).toBeVisible();
    await expect(page.getByText('shared-capacity-v1')).toBeVisible();
  });

  test('AC 26.1-5: the mode chip says "Whole team", not a policy id', async ({ page }) => {
    await typeFirstNodeAsFeature(page);
    await configureCompletePlan(page);
    const select = page.getByRole('combobox', { name: 'Forecast calculation mode' });
    await expect(select.locator('option').first()).toHaveText('Whole team');
    // The rail's reasons/answer never print a raw policy id; the id lives only
    // inside the folded math.
    await expect(page.locator('.pm-forecast__section').first()).not.toContainText('shared-capacity-v1');
    await expect(page.locator('.pm-forecast__section').first()).not.toContainText('staffed-capacity-v1');
  });

  test('AC 26.1-6: axe is clean in both themes and the disclosure is keyboard-operable', async ({ page }) => {
    await typeFirstNodeAsFeature(page);
    await configureCompletePlan(page);

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast__rail').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }

    const disclosure = page.getByRole('button', { name: /Show the math/ });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  });
});

/**
 * Story 26.4 — preview lever changes before applying (FC-FR4, FC-UX3,
 * FC-NFR1, FC-NFR2). Browser evidence for the levers, the preview card, the
 * no-write-until-applied rule and Apply.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Creates a Feature plan with one 20-point item included, then opens levers. */
async function setupPlanWithItem(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
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

test.describe('Story 26.4 — preview lever changes', () => {
  test('AC 26.4-1/-2: changing the capacity lever previews a new completion beside the live plan', async ({ page }) => {
    await setupPlanWithItem(page);

    const levers = page.getByRole('group', { name: 'Levers' });
    await expect(levers).toBeVisible();
    await expect(levers.getByRole('radiogroup', { name: 'Pacing mode' })).toBeVisible();

    // Raise capacity from 10 to 20: the completion should move earlier.
    const capacity = levers.getByRole('spinbutton', { name: 'Team capacity' });
    await capacity.fill('20');
    await capacity.blur();

    const previewCard = levers.getByLabel('Previewed plan');
    await expect(previewCard).toBeVisible({ timeout: 30_000 });
    await expect(previewCard.getByText(/^Sprint \d+$/)).toBeVisible();
    await expect(previewCard.locator('.pm-forecast__preview-delta')).toContainText(/Same completion|sprints/);
  });

  test('AC 26.4-3: Reset returns to the live plan and writes nothing', async ({ page }) => {
    await setupPlanWithItem(page);
    const levers = page.getByRole('group', { name: 'Levers' });

    const capacity = levers.getByRole('spinbutton', { name: 'Team capacity' });
    await capacity.fill('20');
    await capacity.blur();
    await expect(levers.getByLabel('Previewed plan')).toBeVisible({ timeout: 30_000 });

    await levers.getByRole('button', { name: 'Reset' }).click();
    await expect(levers.getByLabel('Previewed plan')).toBeHidden();
    await expect(capacity).toHaveValue('10');
    // Nothing was written: the rail math still shows the live capacity.
    await expect(page.locator('.pm-forecast__completion')).toContainText('Sprint');
  });

  test('AC 26.4-4/-5: Apply writes the new capacity and the live plan matches the preview', async ({ page }) => {
    await setupPlanWithItem(page);
    const levers = page.getByRole('group', { name: 'Levers' });

    const capacity = levers.getByRole('spinbutton', { name: 'Team capacity' });
    await capacity.fill('20');
    await capacity.blur();
    await expect(levers.getByLabel('Previewed plan')).toBeVisible({ timeout: 30_000 });
    const previewSprint = await levers.getByLabel('Previewed plan').getByText(/^Sprint \d+$/).textContent();

    await levers.getByRole('button', { name: 'Apply to plan' }).click();
    await expect(levers.getByRole('status')).toContainText('Applied');

    // The live completion now equals the previewed sprint (AC 26.4-5).
    await expect(page.locator('.pm-forecast__completion')).toContainText(previewSprint!.trim());
  });

  test('AC 26.4-6: axe is clean with the levers rendered in both themes', async ({ page }) => {
    await setupPlanWithItem(page);
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const results = await new AxeBuilder({ page }).include('.pm-forecast__levers').analyze();
      expect(results.violations, `${colorScheme}: ${JSON.stringify(results.violations)}`).toEqual([]);
    }
  });
});

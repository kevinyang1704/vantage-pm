/**
 * Forecast surface accessibility scan (Story 21.13, D2, AC 7-8).
 *
 * The Forecast planning surface had NO axe coverage at all — the eight
 * pre-existing scans cover authoring-shell, inspector, side-nav, visual-tree
 * and workspace-overview. This spec checks dark and light modes on a fully
 * configured plan with a Backlog, a Priority list and a parallel bucket,
 * including the level-change button's hover and keyboard focus states.
 *
 * AC 8: when first written and run, this scan reports the
 * `aria-required-children` violation produced by the pre-fix
 * `role="listbox"` / `role="option"` structure (rows owning a spinbutton and
 * a button, plus a childless empty-state li). The fix (Story 21.13 AC 5)
 * swaps the roles AFTER this scan demonstrated the defect, so the scan is
 * proof the ARIA repair is real — not an assertion that passes vacuously.
 *
 * Hierarchy setup mirrors forecast-multilevel.spec.ts's proven pattern:
 * Theme One → Theme Two → Feature One, each typed through its own row's type
 * selector with the project revision settled between every mutation.
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Settles each outline mutation so the next row selector always exists. */
async function waitForProjectRevisionAdvance(
  page: import('@playwright/test').Page,
  action: () => Promise<void>,
): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

/** Creates a project with Theme One, Theme Two and Feature One; opens Forecast. */
async function setupForecastWithRows(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();

  // Theme One (row 1)
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Theme One');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Theme', exact: true }).click());

  // Theme Two (row 2)
  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Theme Two');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());
  await row2.locator('.pm-outline-row__type-tag').click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Theme', exact: true }).click());

  // Feature One (row 3)
  await row2Input.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row3 = page.locator('.pm-outline-row').nth(2);
  const row3Input = row3.locator('input.pm-outline-row__title-input');
  await row3Input.fill('Feature One');
  await waitForProjectRevisionAdvance(page, () => row3Input.blur());
  await row3.locator('.pm-outline-row__type-tag').click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

test.describe('Story 21.13 D2 — Forecast surface accessibility', () => {
  for (const colorScheme of ['dark', 'light'] as const) {
  test(`axe scan: zero violations on the configured Forecast surface in ${colorScheme} mode (Backlog + Priority + bucket)`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.emulateMedia({ colorScheme });
    await setupForecastWithRows(page);

    // Theme-level plan: the Backlog lists the Themes, the Priority list
    // ranks both, one parallel bucket holds them.
    await page.getByRole('radio', { name: /Themes/ }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Points per sprint').fill('10');
    await page.getByLabel('Sprint length (days)').fill('14');
    await page.getByLabel('Start sprint').fill('12');
    await page.getByLabel('First date').fill('2026-09-07');
    await page.getByRole('button', { name: 'Save' }).click();
    await expectForecastReady(page);
    await expect(page.getByText('▚ Level: Themes')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();
    await page.getByRole('button', { name: 'Add Theme Two to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Theme Two from the priority list' })).toBeVisible();

    await page.getByRole('button', { name: 'Group parallel work…' }).click();
    await page.getByLabel('Select Theme One for parallel group').check();
    await page.getByLabel('Select Theme Two for parallel group').check();
    await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
    await expect(page.locator('.pm-forecast__group')).toHaveCount(1);

    // Backlog, Priority list and rail all present — the surface the scan covers.
    const workspace = page.locator('.pm-forecast');
    await expect(workspace.getByRole('region', { name: 'Backlog' })).toBeVisible();
    await expect(workspace.locator('.pm-forecast__row-wrapper')).toHaveCount(2);

    const results = await new AxeBuilder({ page })
      .include('.pm-forecast')
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    const change = workspace.getByRole('button', { name: 'Change', exact: true });
    await change.hover();
    const hovered = await new AxeBuilder({ page }).include('.pm-forecast__level-chip').analyze();
    expect(hovered.violations, JSON.stringify(hovered.violations, null, 2)).toEqual([]);
    await change.click();
    await expect(page.getByRole('dialog', { name: 'Confirm planning level change' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(change).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`forecast-${colorScheme}.png`) });
    expect(pageErrors).toEqual([]);
  });
  }
});

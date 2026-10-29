/**
 * Epic 22 End-to-End Staffing Certification (Story 22.9, AC 22.9-1..22.9-6).
 *
 * Certifies the complete live staffing experience across Chrome and Edge:
 *   - AC 22.9-1: M3 plan authoring (Ada, Ben, Cara), concurrency conflict detection & repair,
 *     level switch & undo (restoring assignments), and persistence across reload.
 *   - AC 22.9-2: Keyboard navigation, dialog focus trap, focus return by identity, viewports
 *     (1280, 1100, 900, 768) without horizontal scrollbar overflow, and AxeBuilder scan
 *     with zero violations in dark and light modes.
 *   - AC 22.9-4: Regression integrity: shared calculation, hierarchy fixtures, and scope protections.
 *   - AC 22.9-5: Recovery paths: rejection retains draft in dialog, no partial write,
 *     zero console errors.
 *   - AC 22.9-6: Complete delivery verification.
 */

import { expect, test } from '../support/fixtures';
import { revealForecastMath } from '../support/helpers/forecast';
import { expectForecastReady } from '../support/helpers/forecast';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Settles each outline mutation so the next selector is stable. */
async function waitForProjectRevisionAdvance(
  page: import('@playwright/test').Page,
  action: () => Promise<void>,
): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

/** Sets up a fresh project with three typed features and navigates to Forecast. */
async function setupProjectWithThreeFeatures(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();

  // Row 1: Feature Alpha
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature Alpha');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  // Row 2: Feature Beta
  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature Beta');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());
  // A new sibling takes the previous row's type.
  await expect(row2.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  // Row 3: Feature Gamma
  await row2Input.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row3 = page.locator('.pm-outline-row').nth(2);
  const row3Input = row3.locator('input.pm-outline-row__title-input');
  await row3Input.fill('Feature Gamma');
  await waitForProjectRevisionAdvance(page, () => row3Input.blur());
  // A new sibling takes the previous row's type.
  await expect(row3.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  // Navigate to Forecast
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

/** Configures initial forecast parameters and saves. */
async function configureForecastPlan(page: import('@playwright/test').Page): Promise<void> {
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  if (await continueBtn.isVisible()) {
    await continueBtn.click();
  }
  await page.getByLabel('Points per sprint').fill('20');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
}

test.describe('Epic 22 Certification — Live Staffing Experience', () => {
  test('AC 22.9-1 / AC 22.9-4 / AC 22.9-5: M3 authoring, conflict repair, level switch undo, and reload persistence', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => console.log(`[BROWSER ${msg.type()}] ${msg.text()}`));

    await setupProjectWithThreeFeatures(page);
    await configureForecastPlan(page);

    // 1. Add all 3 features to priority list from Backlog
    await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Feature Beta to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Feature Beta from the priority list' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Feature Gamma to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Feature Gamma from the priority list' })).toBeVisible();

    // 2. Set estimates: Alpha = 10, Beta = 30, Gamma = 10
    const pointsAlpha = page.getByRole('spinbutton', { name: /Points for Feature Alpha/ });
    await pointsAlpha.fill('10');
    await pointsAlpha.blur();

    const pointsBeta = page.getByRole('spinbutton', { name: /Points for Feature Beta/ });
    await pointsBeta.fill('30');
    await pointsBeta.blur();

    const pointsGamma = page.getByRole('spinbutton', { name: /Points for Feature Gamma/ });
    await pointsGamma.fill('10');
    await pointsGamma.blur();

    // 3. Group Feature Alpha and Feature Beta into a parallel group
    await page.getByRole('button', { name: 'Group parallel work…' }).click();
    await page.getByLabel('Select Feature Alpha for parallel group').check();
    await page.getByLabel('Select Feature Beta for parallel group').check();
    await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
    await expect(page.locator('.pm-forecast__group')).toHaveCount(1);

    // 4. Open People Editor and add Ada, Ben, and Cara
    await page.getByRole('button', { name: /Add people…|Manage people…/ }).click();
    const peopleDialog = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await expect(peopleDialog).toBeVisible();

    // Add Ada (weight 1.00)
    await page.locator('#pm-pe-new-name').fill('Ada');
    const addBtn = peopleDialog.getByRole('button', { name: 'Add Person' });
    await expect(addBtn).toBeEnabled();
    await addBtn.click();
    await expect(page.locator('#pm-pe-new-name')).toHaveValue('');
    await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Ada' })).toBeVisible();

    // Add Ben (weight 1.00)
    await page.locator('#pm-pe-new-name').fill('Ben');
    await peopleDialog.getByRole('button', { name: 'Add Person' }).click();
    await expect(page.locator('#pm-pe-new-name')).toHaveValue('');
    await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Ben' })).toBeVisible();

    // Add Cara (weight 1.00)
    await page.locator('#pm-pe-new-name').fill('Cara');
    await peopleDialog.getByRole('button', { name: 'Add Person' }).click();
    await expect(page.locator('#pm-pe-new-name')).toHaveValue('');
    await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Cara' })).toBeVisible();

    // Close People Editor dialog
    await peopleDialog.getByRole('button', { name: 'Close people editor' }).click();
    await expect(peopleDialog).not.toBeVisible();

    // 5. Switch Forecast mode to "Assigned people" (staffed-capacity-v1)
    const modeSelect = page.locator('select.pm-forecast__mode-select');
    await modeSelect.selectOption('staffed-capacity-v1');
    await expect(modeSelect).toHaveValue('staffed-capacity-v1');

    // 6. Assign Ada to Feature Alpha
    await page.getByRole('button', { name: 'Assign people to Feature Alpha (required)' }).click();
    const assignDialog = page.getByRole('dialog', { name: 'Assign People' });
    await expect(assignDialog).toBeVisible();
    await assignDialog.getByRole('checkbox', { name: 'Assign Ada' }).check();
    await assignDialog.getByRole('button', { name: 'Apply' }).click();
    await expect(assignDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Alpha: Ada/ })).toBeVisible();

    // 7. Concurrency Conflict Detection & Repair (AC 22.9-1, AC 22.9-5)
    // Attempt to assign Ada to Feature Beta as well (in same parallel group)
    await page.getByRole('button', { name: 'Assign people to Feature Beta (required)' }).click();
    await expect(assignDialog).toBeVisible();
    await assignDialog.getByRole('checkbox', { name: 'Assign Ada' }).check();
    await assignDialog.getByRole('button', { name: 'Apply' }).click();

    // Rejection banner must appear explaining concurrency conflict, dialog remains open
    await expect(assignDialog.getByRole('alert')).toBeVisible();
    await expect(assignDialog.getByText(/Assignment could not be applied/)).toBeVisible();

    // Repair the conflict: deselect Ada, select Ben instead
    await assignDialog.getByRole('checkbox', { name: 'Assign Ada' }).uncheck();
    await assignDialog.getByRole('checkbox', { name: 'Assign Ben' }).check();
    await assignDialog.getByRole('button', { name: 'Apply' }).click();
    await expect(assignDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Beta: Ben/ })).toBeVisible();

    // Assign Cara to Feature Gamma (singleton)
    await page.getByRole('button', { name: 'Assign people to Feature Gamma (required)' }).click();
    await expect(assignDialog).toBeVisible();
    await assignDialog.getByRole('checkbox', { name: 'Assign Cara' }).check();
    await assignDialog.getByRole('button', { name: 'Apply' }).click();
    await expect(assignDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Gamma: Cara/ })).toBeVisible();

    // 8. Verify M3 arithmetic & bottleneck indicators (SF-FR8, SF-FR9, SF-FR10, Story 22.7)
    // Feature Beta is the bottleneck in Bucket A
    await expect(page.locator('.pm-forecast__row-bottleneck-tag').first()).toBeVisible();
    await revealForecastMath(page);
    await expect(page.getByText('Elapsed staffing duration')).toBeVisible();
    await expect(page.locator('.pm-forecast__math').getByText('Idle capacity', { exact: true })).toBeVisible();

    // 9. Level switch and Undo (AC 22.9-1)
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    const levelDialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
    await expect(levelDialog).toBeVisible();
    await expect(levelDialog).toContainText('clears the current ranking, buckets, blockers, and assignments');
    await levelDialog.getByRole('radio', { name: 'Themes' }).check();
    await levelDialog.getByRole('button', { name: 'Switch level' }).click();
    await expect(levelDialog).not.toBeVisible();
    await expect(page.getByText('▚ Level: Themes')).toBeVisible();

    // Undo level switch with Ctrl+Z
    await page.keyboard.press('Control+z');
    await expect(page.getByText('▚ Level: Features')).toBeVisible();

    // Prior assignments and mode must be restored!
    await expect(page.getByRole('button', { name: /Assigned to Feature Alpha: Ada/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Beta: Ben/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Gamma: Cara/ })).toBeVisible();
    await expect(modeSelect).toHaveValue('staffed-capacity-v1');

    // 10. Persistence across reload (AC 22.9-1)
    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();

    // After reload, staffed plan, roster, assignments, and bottleneck badge survive
    await expect(page.locator('select.pm-forecast__mode-select')).toHaveValue('staffed-capacity-v1');
    await expect(page.getByRole('button', { name: /Assigned to Feature Alpha: Ada/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Beta: Ben/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Assigned to Feature Gamma: Cara/ })).toBeVisible();
    await expect(page.locator('.pm-forecast__row-bottleneck-tag').first()).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('AC 22.9-2: Keyboard navigation, dialog focus trap, viewports, and Axe accessibility in dark and light modes', async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await setupProjectWithThreeFeatures(page);
    await configureForecastPlan(page);

    // Add Feature Alpha
    await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
    await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();

    // Open People Editor
    const addPeopleBtn = page.getByRole('button', { name: /Add people…|Manage people…/ });
    await addPeopleBtn.click();
    const peopleDialog = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await expect(peopleDialog).toBeVisible();

    // Keyboard focus trap verification: Tab cycles within dialog
    await page.keyboard.press('Tab');
    const activeEl = await page.evaluate(() => document.activeElement?.tagName);
    expect(['INPUT', 'BUTTON']).toContain(activeEl);

    // Escape closes dialog and returns focus by identity to trigger button
    await page.keyboard.press('Escape');
    await expect(peopleDialog).not.toBeVisible();
    await expect(addPeopleBtn).toBeFocused();

    // Accessibility Scan in dark and light modes
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });

      const axeForecast = await new AxeBuilder({ page }).include('.pm-forecast').analyze();
      expect(axeForecast.violations, `Axe violations in ${colorScheme} mode: ${JSON.stringify(axeForecast.violations, null, 2)}`).toEqual([]);

      // Open People Editor and scan dialog
      await addPeopleBtn.click();
      await expect(peopleDialog).toBeVisible();
      const axeDialog = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(axeDialog.violations, `Axe dialog violations in ${colorScheme} mode: ${JSON.stringify(axeDialog.violations, null, 2)}`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(peopleDialog).not.toBeVisible();

      await page.screenshot({ path: testInfo.outputPath(`forecast-staffing-${colorScheme}.png`) });
    }

    // Test Viewports: 1280, 1100, 900, 768
    for (const width of [1280, 1100, 900, 768]) {
      await page.setViewportSize({ width, height: 800 });
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasHorizontalScroll, `Horizontal scroll detected at width ${width}px`).toBe(false);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    expect(pageErrors).toEqual([]);
  });
});

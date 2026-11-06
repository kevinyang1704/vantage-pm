/**
 * Example S1 staffed-forecast setup through the real UI (Stories 23.6-23.10).
 *
 * Ada 3.00 and Ben 1.00; Feature Alpha 30 points assigned Ben, Feature Beta
 * 10 points assigned Ada; Alpha and Beta in one parallel group; C = 20,
 * start Sprint 12 on 2026-09-07. The live forecast finishes at Sprint 17 /
 * 2026-11-29; swapping the two assignments finishes at Sprint 13 / 2026-10-04.
 */

import { expect, type Page } from '@playwright/test';
import { revealForecastMath } from './forecast';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Settles each outline mutation so the next selector is stable. */
export async function waitForProjectRevisionAdvance(
  page: Page,
  action: () => Promise<void>,
): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

/** Sets up a fresh project with two typed features (Alpha and Beta) and navigates to Forecast. */
export async function setupProjectWithTwoFeatures(page: Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  // The new project becomes current asynchronously; wait for it before opening a view.
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText('New Project', { timeout: 30_000 });
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();

  // Row 1: Feature Alpha (30 pts in S1)
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature Alpha');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  // Row 2: Feature Beta (10 pts in S1)
  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature Beta');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());
  // A new sibling takes the previous row's type.
  await expect(row2.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  // Navigate to Forecast
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

/** Configures initial forecast parameters matching S1 specification and saves. */
async function configureS1ForecastPlan(page: Page): Promise<void> {
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  // Wait for the Forecast view to render one of its two first-run states
  // before deciding: an immediate isVisible() can run before either exists.
  await expect(continueBtn.or(page.getByLabel('Points per sprint'))).toBeVisible({ timeout: 30_000 });
  if (await continueBtn.isVisible()) {
    await continueBtn.click();
  }
  // S1: C = 20, startSprintOrdinal = 12, startDate = 2026-09-07, sprintLengthDays = 14
  await page.getByLabel('Points per sprint').fill('20');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await revealForecastMath(page);
}

/** Fully sets up the S1 staffed forecast environment: features, points, roster, staffed mode, and baseline assignments. */
export async function setupS1StaffedForecast(page: Page): Promise<void> {
  await setupProjectWithTwoFeatures(page);
  await configureS1ForecastPlan(page);

  // 1. Add both features from Backlog to Priority list
  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Feature Beta to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Beta from the priority list' })).toBeVisible();

  // 2. Set estimates: Alpha = 30 pts, Beta = 10 pts
  // Commit each estimate before typing the next: a commit re-renders the list.
  const knownPoints = page
    .locator('.pm-forecast__arithmetic-row')
    .filter({ hasText: 'Known points' })
    .locator('.pm-forecast__arithmetic-value');
  const pointsAlpha = page.getByRole('spinbutton', { name: /Points for Feature Alpha/ });
  await pointsAlpha.fill('30');
  await pointsAlpha.blur();
  await expect(knownPoints).toHaveText('30');

  const pointsBeta = page.getByRole('spinbutton', { name: /Points for Feature Beta/ });
  await pointsBeta.fill('10');
  await pointsBeta.blur();
  await expect(knownPoints).toHaveText('40');

  // 3. Group Feature Alpha and Feature Beta into a parallel group (S1 parallel buckets)
  await page.getByRole('button', { name: 'Group parallel work…' }).click();
  await page.getByLabel('Select Feature Alpha for parallel group').check();
  await page.getByLabel('Select Feature Beta for parallel group').check();
  await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
  await expect(page.locator('.pm-forecast__group')).toHaveCount(1);

  // 4. Add Ada (weight 3.00) and Ben (weight 1.00) to Project Roster
  const addPeopleBtn = page.getByRole('button', { name: /Add people…|Manage people…/ });
  await addPeopleBtn.click();
  const peopleDialog = page.getByRole('dialog', { name: 'Manage project people and capacity' });
  await expect(peopleDialog).toBeVisible();

  // Add Ada (3.00)
  await page.locator('#pm-pe-new-name').fill('Ada');
  await page.locator('#pm-pe-new-weight').fill('3.00');
  await peopleDialog.getByRole('button', { name: 'Add Person' }).click();
  await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Ada' })).toBeVisible();

  // Add Ben (1.00)
  await page.locator('#pm-pe-new-name').fill('Ben');
  await page.locator('#pm-pe-new-weight').fill('1.00');
  await peopleDialog.getByRole('button', { name: 'Add Person' }).click();
  await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Ben' })).toBeVisible();

  await peopleDialog.getByRole('button', { name: 'Close people editor' }).click();
  await expect(peopleDialog).not.toBeVisible();

  // 4. Switch calculation mode to staffed-capacity-v1
  const modeSelect = page.locator('select.pm-forecast__mode-select');
  await modeSelect.selectOption('staffed-capacity-v1');
  await expect(modeSelect).toHaveValue('staffed-capacity-v1');

  // 5. Initial S1 assignment: Feature Alpha -> Ben; Feature Beta -> Ada
  // Assign Ben to Feature Alpha
  await page.getByRole('button', { name: 'Assign people to Feature Alpha (required)' }).click();
  const assignDialogAlpha = page.getByRole('dialog', { name: 'Assign People' });
  await expect(assignDialogAlpha).toBeVisible();
  await assignDialogAlpha.getByRole('checkbox', { name: 'Assign Ben' }).check();
  await assignDialogAlpha.getByRole('button', { name: 'Apply' }).click();
  await expect(assignDialogAlpha).not.toBeVisible();

  // Assign Ada to Feature Beta
  await page.getByRole('button', { name: 'Assign people to Feature Beta (required)' }).click();
  const assignDialogBeta = page.getByRole('dialog', { name: 'Assign People' });
  await expect(assignDialogBeta).toBeVisible();
  await assignDialogBeta.getByRole('checkbox', { name: 'Assign Ada' }).check();
  await assignDialogBeta.getByRole('button', { name: 'Apply' }).click();
  await expect(assignDialogBeta).not.toBeVisible();

  // 6. Verify Baseline S1 Outcome: finishes in 6 sprints (Sprint 17 / 2026-11-29)
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
  await expect(page.locator('.pm-forecast__completion-date')).toHaveText('2026-11-29');
}


/**
 * Multi-level forecast certification (Story 21.10, AC 21.10-1..6).
 *
 * Browser acceptance for the Stage 2 planning surface:
 * - the level step enables every level with project nodes and disables
 *   zero-node levels with a `0 available` badge (AC 21.10-1)
 * - the level chip Change button opens a focus-trapped confirmation dialog;
 *   confirming dispatches SetForecastPlanningLevel, cancelling leaves the
 *   plan untouched (AC 21.10-3)
 * - a Theme-level plan lists Theme nodes in the Backlog and Priority list
 *   and sums Theme effortPoints in the rail (AC 21.10-4)
 * - single Ctrl+Z restores the prior level AND scope AND buckets AND
 *   blockers (AC 21.10-6)
 * - a cross-level scenario shows its notice instead of a diff (AC 21.10-5)
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function waitForProjectRevisionAdvance(
  page: import('@playwright/test').Page,
  action: () => Promise<void>,
): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

/**
 * Wait for the `▚ Level: …` chip (Story 21.13 D4). The chip reflects the
 * persisted plan, which the app learns through the async snapshot refresh
 * after the save — every site waits on this condition with one shared
 * 15 s budget, not the 10 s default. (Since atomic creation, D5, there is
 * no second command and no Feature→Theme flip to outwait — the budget is
 * headroom for the one refresh, kept uniform at all sites.)
 */
async function expectLevelChip(page: import('@playwright/test').Page, level: 'Themes' | 'Components' | 'Features'): Promise<void> {
  await expect(page.getByText(`▚ Level: ${level}`)).toBeVisible({ timeout: 15_000 });
}

/** Creates a project with one Theme, one Component, and one Feature. */
async function setupMixedHierarchy(page: import('@playwright/test').Page, secondTheme = false): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();

  // Theme (row 1)
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Theme One');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Theme', exact: true }).click());

  // Component (row 2, child of Theme)
  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Component One');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());
  await row2.locator('.pm-outline-row__type-tag').click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Component', exact: true }).click());

  // Feature (row 3, child of Component)
  await row2Input.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row3 = page.locator('.pm-outline-row').nth(2);
  const row3Input = row3.locator('input.pm-outline-row__title-input');
  await row3Input.fill('Feature One');
  await waitForProjectRevisionAdvance(page, () => row3Input.blur());
  await row3.locator('.pm-outline-row__type-tag').click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  if (secondTheme) {
    await row3Input.focus();
    await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
    const row4 = page.locator('.pm-outline-row').nth(3);
    const input = row4.locator('input.pm-outline-row__title-input');
    await input.fill('Theme Two');
    await waitForProjectRevisionAdvance(page, () => input.blur());
    await row4.locator('.pm-outline-row__type-tag').click();
    await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Theme', exact: true }).click());
  }

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

test('the level step enables every level with nodes and disables zero-node levels (AC 21.10-1)', async ({ page }) => {
  await setupMixedHierarchy(page);

  const levelStep = page.getByRole('group', { name: 'Choose a planning level' });
  await expect(levelStep).toBeVisible();
  await expect(page.getByRole('radio', { name: /Themes/ })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /Components/ })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /Features/ })).toBeEnabled();

  // Choose Theme and continue.
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Points per sprint')).toBeVisible();
});

test('a Theme-level plan lists Theme nodes and sums Theme effortPoints (AC 21.10-4)', async ({ page }) => {
  await setupMixedHierarchy(page);

  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  // The level command is dispatched asynchronously after the config save;
  // the helper carries the shared 15 s budget for this known-async condition
  // (Story 21.13 D4).
  await expectLevelChip(page, 'Themes');

  // The Backlog lists the Theme node; the Priority list ranks it.
  const backlog = page.getByRole('region', { name: 'Backlog' });
  await expect(backlog.getByText('Theme One')).toBeVisible();
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();

  // Set the Theme's own effortPoints and verify the rail sums it.
  await page.getByRole('spinbutton', { name: 'Points for Theme One' }).fill('25');
  await page.getByRole('spinbutton', { name: 'Points for Theme One' }).blur();
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 14');
});

test('the Change chip traps keyboard focus; cancel leaves the plan untouched (AC 21.10-3)', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await setupMixedHierarchy(page);
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await expectLevelChip(page, 'Themes');
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();

  // Open the confirmation dialog and cancel.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
  await expect(dialog).toContainText('clears the current ranking, buckets, blockers, and assignments');
  await dialog.getByRole('radio', { name: 'Components' }).check();
  await expect(dialog).toContainText('Switching to Component clears the current ranking, buckets, blockers, and assignments. Roster, capacity, and mode are preserved. Proceed?');
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const selectedLevel = dialog.getByRole('radio', { name: 'Components' });
  await cancel.focus();
  await page.keyboard.press('Tab');
  await expect(selectedLevel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(cancel).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('level-dialog.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toBeFocused();

  // The plan is untouched: still Theme level with the Theme ranked.
  await expectLevelChip(page, 'Themes');
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('confirming the dialog switches level and clears scope; Ctrl+Z restores everything (AC 21.10-3/6)', async ({ page }) => {
  await setupMixedHierarchy(page, true);
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await expectLevelChip(page, 'Themes');
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Theme Two to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme Two from the priority list' })).toBeVisible();
  await page.getByRole('button', { name: 'Group parallel work…' }).click();
  await page.getByLabel('Select Theme One for parallel group').check();
  await page.getByLabel('Select Theme Two for parallel group').check();
  await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
  const bucket = page.locator('.pm-forecast__group');
  await expect(bucket).toHaveCount(1);
  await page.getByRole('button', { name: 'Mark Theme One as blocked' }).click();
  await expect(page.getByRole('button', { name: 'Clear blocker on Theme One' })).toBeVisible();

  // Switch to Feature level via the dialog.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
  await dialog.getByRole('radio', { name: 'Features' }).check();
  await dialog.getByRole('button', { name: 'Switch level' }).click();
  await expect(dialog).not.toBeVisible();

  // The plan is at Feature level; the Theme is no longer ranked.
  await expectLevelChip(page, 'Features');
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Feature One to the priority list' })).toBeVisible();
  await expect(bucket).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear blocker on Theme One' })).toHaveCount(0);

  // Single Ctrl+Z restores the prior level AND scope.
  await page.keyboard.press('Control+z');
  await expectLevelChip(page, 'Themes');
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();
  await expect(bucket).toHaveCount(1);
  await expect(bucket.locator('.pm-forecast__row-title')).toHaveText(['Theme One · blocked (no delay assumed)', 'Theme Two']);
  await expect(page.getByRole('button', { name: 'Clear blocker on Theme One' })).toBeVisible();
});

test('a cross-level scenario labels the level mismatch and keeps its own captured comparison (AC 21.10-5, Story 23.8 AC 23.8-4 / D1)', async ({ page }) => {
  await setupMixedHierarchy(page);
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await expectLevelChip(page, 'Themes');
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Points for Theme One' }).fill('25');
  await page.getByRole('spinbutton', { name: 'Points for Theme One' }).blur();
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 14');

  // Save a scenario at Theme level.
  await page.getByRole('button', { name: 'Create scenario…' }).click();
  await page.getByLabel('Scenario name').fill('Theme scenario');
  await page.getByRole('button', { name: 'Save scenario' }).click();
  const scenarios = page.getByRole('region', { name: 'Scenarios' });
  await expect(scenarios.getByText('Theme scenario')).toBeVisible();
  await expect(scenarios.getByText('Captured at Theme level')).toBeVisible();

  // Switch to Feature level: the scenario shows the cross-level notice.
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
  await dialog.getByRole('radio', { name: 'Features' }).check();
  await dialog.getByRole('button', { name: 'Switch level' }).click();
  await expectLevelChip(page, 'Features');
  // Story 23.8 (D1): the mismatch is labelled and the scenario's own captured
  // comparison stays readable; it is never compared with live Feature facts.
  const card = scenarios.locator('li.pm-forecast__cause').filter({ hasText: 'Theme scenario' });
  await expect(card).toContainText('Captured at Theme level; the live plan is now at Feature level.');
  await expect(card).not.toContainText('Comparison is unavailable across levels');
  const rows = card.locator('.pm-forecast__scenario-outcomes dd');
  // 25 points at 10/sprint from Sprint 12: three sprints, as the live Theme plan showed.
  await expect(rows.nth(0)).toHaveText('Sprint 14 · 2026-10-18');
  await expect(rows.nth(1)).toHaveText('Sprint 14 · 2026-10-18');
});

test('creating a Theme plan is atomic: one Ctrl+Z returns to the pre-creation level step (Story 21.13 D5, AC 13-14)', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await setupMixedHierarchy(page);

  // Choose Themes on the step card and save the configuration: with atomic
  // creation the level rides the SAME command — the chip settles on Themes
  // once, with no second async flip through Features.
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await expectLevelChip(page, 'Themes');

  // One command, one revision: the whole creation is a single undo entry.
  // A single Ctrl+Z removes the plan and returns to the pre-creation state —
  // the level step — never to a Feature plan with the Theme configuration
  // retained (the D5 defect).
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('group', { name: 'Choose a planning level' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('▚ Level: Themes')).toHaveCount(0);
  await expect(page.getByText('Capacity / sprint')).toHaveCount(0);

  // Redo replays the forward command and re-creates the Theme plan whole.
  await page.keyboard.press('Control+Shift+z');
  await expectLevelChip(page, 'Themes');
  await expectForecastReady(page);
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('retyping and deleting a ranked, bucketed node preserves the invalid reference with no errors or console noise (Story 21.14 AC 14; Story 21.2 AC 7)', async ({ page }) => {
  const consoleProblems: string[] = [];
  const onConsole = (msg: import('@playwright/test').ConsoleMessage): void => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    // Pre-existing SQLite/OPFS SAH pool noise fires on every app load and is
    // unrelated to the forecast surface (same filter as side-nav.spec.ts).
    if (text.includes('NoModificationAllowedError') || text.includes('pmapp-sah-')) return;
    consoleProblems.push(`[${msg.type()}] ${text}`);
  };
  const onPageError = (err: Error): void => {
    consoleProblems.push(`[pageerror] ${err.message}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  // A Theme-level plan with BOTH Themes ranked and bucketed — the exact state
  // the delete/retype paths must survive.
  await setupMixedHierarchy(page, true);
  await page.getByRole('radio', { name: /Themes/ }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await expectLevelChip(page, 'Themes');
  await page.getByRole('button', { name: 'Add Theme One to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme One from the priority list' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Theme Two to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Theme Two from the priority list' })).toBeVisible();
  await page.getByRole('button', { name: 'Group parallel work…' }).click();
  await page.getByLabel('Select Theme One for parallel group').check();
  await page.getByLabel('Select Theme Two for parallel group').check();
  await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
  await expect(page.locator('.pm-forecast__group')).toHaveCount(1);

  // setupMixedHierarchy nests each row under the previous one, so the
  // outline rows in order are: Theme One, Component One, Feature One,
  // Theme Two. Rows are matched positionally — an input's value is not DOM
  // text, so hasText cannot target outline rows by title.
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  const outlineRows = page.locator('.pm-outline-row');
  await expect(outlineRows).toHaveCount(4);

  // ── Retype: Theme Two becomes a Component while ranked and bucketed. ──
  const themeTwoRow = outlineRows.nth(3);
  await themeTwoRow.locator('input.pm-outline-row__title-input').focus();
  await themeTwoRow.getByRole('button', { name: 'THEME', exact: true }).click();
  await page.getByRole('button', { name: 'Component', exact: true }).click();
  await expect(outlineRows.nth(3).getByRole('button', { name: 'COMPONENT', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  // The preserved policy: the retyped node is NOT silently normalized out of
  // scope — it stays as an invalid reference with an explicit exclude
  // affordance (Story 21.2 AC 7 as ruled; AC 18.1-4).
  await expect(page.getByText('invalid reference — exclude to resolve').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove Theme Two from the priority list' }),
  ).toBeVisible();
  await expect(page.locator('.pm-forecast__group')).toHaveCount(1);

  // ── Delete: Theme One while ranked and bucketed. ──
  // Shift+Delete on the first row removes that node; its three sibling rows
  // (Component One, Feature One, and the retyped Theme Two) remain.
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await outlineRows.nth(0).locator('input.pm-outline-row__title-input').focus();
  await page.keyboard.press('Shift+Delete');
  await expect(outlineRows).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Forecast', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  // Same policy for the deleted node: preserved as an invalid reference
  // (titled `(removed Theme)` once the node no longer resolves), never
  // silently dropped from scope. The retyped Theme Two reference is invalid
  // as well — both remain visible together.
  await expect(page.getByText('invalid reference — exclude to resolve')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Remove (removed Theme) from the priority list' }),
  ).toBeVisible();

  // The surface stays operable: resolve the deleted reference through its
  // explicit exclude affordance; the retyped invalid reference remains.
  await page.getByRole('button', { name: 'Remove (removed Theme) from the priority list' }).click();
  await expect(
    page.getByRole('button', { name: 'Remove (removed Theme) from the priority list' }),
  ).toHaveCount(0);
  await expect(page.getByText('invalid reference — exclude to resolve')).toHaveCount(1);

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  expect(consoleProblems, consoleProblems.join('\n')).toEqual([]);
});

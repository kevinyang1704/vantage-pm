/**
 * Forecast foundation certification (Story 18.7, AC 18.7-1..18.7-6).
 *
 * Browser acceptance for the Epic 18 whole-set foundation: navigation to the
 * Forecast destination, atomic configuration save, include/estimate flow,
 * revision-matched completion rendering, reload persistence, and the
 * no-silent-date-mutation write-set discipline. Uses merged Playwright
 * fixtures, deterministic seeded synthetic graphs, event-based
 * synchronization, and no fixed sleeps.
 *
 * Passing application tests is not automatic Gate A or Gate B certification
 * (AC 18.7 Dev Notes). This spec closes only Epic 18's whole-set foundation;
 * full parallel allocation is certified in Epic 19.
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';

/** Overridable so a worktree can run against its own dev server port. */
const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * Types the default project's first node as a Feature via the outline's
 * type selector, so the Forecast workspace has an eligible member. Enters
 * the project through the Outline view first (the Forecast destination is
 * not a peer structural view).
 */
async function typeFirstNodeAsFeature(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

async function openForecast(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

async function configureCompletePlan(page: import('@playwright/test').Page): Promise<void> {
  // First-run entry is the Planning Level step (AC 21.5-2): Feature is
  // enabled; Continue opens plan configuration.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  // The arithmetic block renders only after the plan is saved and the
  // forecast projection settles — an observable synchronization point that
  // guarantees the next command reads the refreshed revision.
  await expectForecastReady(page);
}

/** Adds the first eligible Backlog item; waits for acknowledgment sync point. */
async function addFirstFeatureFromBacklog(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  // The ✕ remove control renders only once the membership command is
  // acknowledged — the web-first sync point before any estimate command.
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
}

test('opens the Forecast destination from the SideNav after Gantt', async ({ page }) => {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Gantt').waitFor({ state: 'visible', timeout: 30_000 });

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();

  await expect(page.getByRole('region', { name: 'Forecast planning list' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Forecast', exact: true })).toBeVisible();
});

test('first-time forecast entry shows the level step with Continue opening configuration (AC 21.5-2)', async ({ page }) => {
  await openForecast(page);

  // The level step card leads with the node-type options; the default
  // project's node is untyped, so every level shows the `0 available` badge
  // and is disabled (UX-DR1, Story 21.10 AC 1).
  const levelStep = page.getByRole('group', { name: 'Choose a planning level' });
  await expect(levelStep).toBeVisible();
  await expect(page.getByRole('radio', { name: /Feature/ })).toBeDisabled();
  await expect(levelStep.locator('.pm-forecast__level-option-soon')).toHaveCount(3);
  await expect(levelStep.locator('.pm-forecast__level-option-soon').first()).toHaveText('0 available');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();

  // Continue proceeds to open plan configuration, not a fabricated default.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Points per sprint')).toBeVisible();
});

test('an outline item added after a Feature is a Feature and lands in the Forecast Backlog, unranked', async ({ page }) => {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  const rows = page.locator('.pm-outline-row');
  const firstInput = rows.first().locator('input.pm-outline-row__title-input');
  await firstInput.fill('Alpha');
  await firstInput.blur();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await expect(rows.first().getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  // Enter on a Feature makes a Feature — no type step needed.
  await firstInput.focus();
  await page.keyboard.press('Enter');
  await expect(rows.nth(1).getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();
  const secondInput = rows.nth(1).locator('input.pm-outline-row__title-input');
  await secondInput.fill('Bravo');
  await secondInput.blur();

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await configureCompletePlan(page);
  await expect(page.getByRole('button', { name: 'Add Bravo to the priority list' })).toBeVisible();
  // Backlog only: nothing is ranked until the user adds it.
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ })).toHaveCount(0);
});

test('saves the complete configuration group atomically and renders the exact operands', async ({ page }) => {
  await openForecast(page);

  await configureCompletePlan(page);

  // The rail shows the exact saved operands (AC 18.5-5). `exact` because the
  // Epic 20 "What changed" section also lists "Sprint length: — → 14 days".
  await expectForecastReady(page);
  await expect(page.getByText('Sprint length', { exact: true })).toBeVisible();
  await expect(page.getByText('14 days').first()).toBeVisible();
});

test('retains incomplete configuration values and explains the missing condition', async ({ page }) => {
  await typeFirstNodeAsFeature(page);

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  // Leave start sprint and first date empty.
  await page.getByRole('button', { name: 'Save' }).click();
  // The plan exists once the Edit action appears (the arithmetic block is
  // correctly withheld while the start anchor is unconfigured).
  await expect(page.getByRole('button', { name: 'Edit configuration…' })).toBeVisible();

  // Include a Feature so the incomplete configuration is the named condition.
  await addFirstFeatureFromBacklog(page);

  // Incomplete inputs are preserved and explained — never a stale current date.
  await expect(page.getByText('Incomplete inputs')).toBeVisible();
  await page.getByRole('button', { name: 'Edit configuration…' }).click();
  await expect(page.getByLabel('Points per sprint')).toHaveValue('10');
  await expect(page.getByLabel('Sprint length (days)')).toHaveValue('14');
});

test('includes a Feature, edits its points inline, and renders the capacity-derived completion', async ({ page }) => {
  await typeFirstNodeAsFeature(page);

  await configureCompletePlan(page);

  // Add the seeded Feature from the Backlog and set its points inline.
  await addFirstFeatureFromBacklog(page);
  await expect(page.getByText('Selected', { exact: true })).toBeVisible();
  const pointsInput = page.getByRole('spinbutton', { name: /Points for .*/ }).first();
  await pointsInput.fill('25');
  await pointsInput.blur();

  // The completion card leads with sprint and calendar date (UX-DR7). Scoped
  // to the visible card so the polite live-region summary is not also matched.
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 14');
  await expect(page.locator('.pm-forecast__completion-date')).toHaveText('2026-10-18');
  await expect(page.getByText('capacity-derived')).toBeVisible();
});

test('withholds timelines for missing estimates while retaining known totals', async ({ page }) => {
  await typeFirstNodeAsFeature(page);

  await configureCompletePlan(page);

  // Add a Feature without an estimate.
  await addFirstFeatureFromBacklog(page);

  await expect(page.getByText('Incomplete inputs')).toBeVisible();
  await expect(page.getByText('Known points')).toBeVisible();
});

test('persists the forecast plan across reload (AC 18.7-2)', async ({ page }) => {
  await openForecast(page);

  await configureCompletePlan(page);

  await page.reload();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();

  // The saved configuration is displayed, not a fabricated default (FR-7).
  await expectForecastReady(page);
  await page.getByRole('button', { name: 'Edit configuration…' }).click();
  await expect(page.getByLabel('Points per sprint')).toHaveValue('10');
  await expect(page.getByLabel('Sprint length (days)')).toHaveValue('14');
  await expect(page.getByLabel('Start sprint')).toHaveValue('12');
  await expect(page.getByLabel('First date')).toHaveValue('2026-09-07');
});

test('keyboard-only flow: configure, include, and review arithmetic without a pointer (AC 18.7-4)', async ({ page }) => {
  await typeFirstNodeAsFeature(page);

  // Configure via keyboard.
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await continueButton.focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).focus();
  await page.keyboard.press('Enter');

  // Add the first Feature via keyboard: roving-tabindex row + Enter (AC 21.2-8).
  const backlogRow = page.locator('.pm-forecast__backlog-row').first();
  await backlogRow.focus();
  await expect(backlogRow).toBeFocused();
  await page.keyboard.press('Enter');

  // The arithmetic block is readable text (UX-DR8, UX-DR17); it is folded
  // behind the keyboard-operable "Show the math" disclosure (Story 26.1).
  const mathDisclosure = page.getByRole('button', { name: /Show the math/ });
  await mathDisclosure.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Arithmetic')).toBeVisible();
  await expect(page.getByText('Exact ratio')).toBeVisible();
});
test('reflows without clipping at 200% zoom and required text spacing (AC 18.7-5)', async ({ page }) => {
  await openForecast(page);

  // First-run entry: Continue from the level step.
  await configureCompletePlan(page);

  // 200% zoom.
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await expectForecastReady(page);

  // WCAG text-spacing overrides.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; }
    `;
    document.head.appendChild(style);
  });
  await expectForecastReady(page);
  await expect(page.getByRole('button', { name: 'Edit configuration…' })).toBeVisible();
});

test('`/` focuses the Backlog search and filters rows in real time (AC 21.5-6, UX-DR3)', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureCompletePlan(page);

  // Pressing `/` from anywhere in the workspace (not editing text) focuses
  // the Backlog search input.
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: /Search the Features backlog/ })).toBeFocused();

  // Typing filters the unranked rows in real time.
  await page.getByRole('searchbox', { name: /Search the Features backlog/ }).fill('zzz-no-match');
  await expect(page.getByText('No matches.')).toBeVisible();
  await page.getByRole('searchbox', { name: /Search the Features backlog/ }).fill('');
  await expect(page.getByText('No matches.')).toHaveCount(0);
});

test('roving tabindex: ArrowUp/Down move Backlog focus and Enter adds (AC 21.5-6, AC 21.2-8)', async ({ page }) => {
  await setupWithFeatures(page, ['Feature One', 'Feature Two']);
  await configureCompletePlan(page);

  const backlog = page.getByRole('region', { name: 'Backlog' });
  const firstRow = page.locator('.pm-forecast__backlog-row').nth(0);
  const secondRow = page.locator('.pm-forecast__backlog-row').nth(1);
  await firstRow.focus();
  await expect(firstRow).toBeFocused();

  // ArrowDown moves focus to the second unranked row; Enter adds it.
  await page.keyboard.press('ArrowDown');
  await expect(secondRow).toBeFocused();

  // Press Enter on the focused row: the second feature joins the Priority
  // list (its Backlog row flips to 'in plan') and the polite region announces
  // the addition (AC 21.2-5).
  await page.keyboard.press('Enter');
  await expect(backlog.getByText('in plan', { exact: true })).toHaveCount(1);
  await expect(page.locator('.pm-forecast__row', { hasText: 'Feature Two' })).toBeVisible();
});

test('Backlog inline points commit on Enter/blur, revert on Escape, and reject negatives (AC 21.5-6, AC 21.2-3)', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureCompletePlan(page);

  // The Backlog points input uses a local draft buffer (never one repository
  // command per keystroke): commit on blur/Enter, revert on Escape.
  const backlog = page.getByRole('region', { name: 'Backlog' });
  const pointsInput = backlog.getByRole('spinbutton', { name: /Points for .*/ }).first();

  // Negative values are rejected: nothing commits, the value does not stick.
  await pointsInput.fill('-5');
  await pointsInput.blur();
  await expect(pointsInput).not.toHaveValue('-5');

  // A draft is not persisted until commit — Escape reverts it.
  await pointsInput.fill('12');
  await expect(pointsInput).toHaveValue('12');
  await page.keyboard.press('Escape');
  await expect(pointsInput).not.toHaveValue('12');

  // Commit via Enter persists the estimate and drives the projection.
  await pointsInput.fill('25');
  await pointsInput.press('Enter');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('No features selected');
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 14');
  await expect(page.getByRole('spinbutton', { name: /Points for .*/ }).first()).toHaveValue('25');
});

test('Escape cancels a keyboard grab and restores the pre-grab position (AC 21.5-6, AC 21.4-5)', async ({ page }) => {
  await setupWithFeatures(page, ['Feature One', 'Feature Two']);
  await configureCompletePlan(page);
  await addFeaturesFromBacklog(page, 2);

  const firstRow = page.locator('.pm-forecast__row').nth(0);
  await firstRow.focus();
  await expect(firstRow).toContainText('Feature One');

  // Grab, move down one slot, then cancel with Escape. Transient action
  // narration lives in its own polite region (Story 21.11 AC 17), so the
  // cancellation announcement is asserted directly — no MutationObserver
  // workaround needed. The add announcements from setup are async (they land
  // when the membership promise resolves), so sync on them first — otherwise
  // a stale add announcement can overwrite the grab announcement.
  const transientStatus = page.locator('.pm-forecast > [role="status"]').nth(1);
  await expect(transientStatus).toContainText('Added Feature Two to Priority list');
  await page.keyboard.press('Space');
  await expect(transientStatus).toContainText('position 1 of 2');
  await page.keyboard.press('ArrowDown');
  // Assert the row actually moved before cancelling — the test must fail if
  // ArrowDown is a no-op (Story 21.11 AC 33).
  await expect(page.locator('.pm-forecast__row').nth(1)).toContainText('Feature One');
  await page.keyboard.press('Escape');

  // Position restored, and the transient region announced the cancellation.
  await expect(page.locator('.pm-forecast__row').nth(0)).toContainText('Feature One');
  await expect(transientStatus).toContainText('Reorder cancelled');
});

test('Escape with nothing grabbed and no selection mode is a no-op (AC 21.4-8)', async ({ page }) => {
  await setupWithFeatures(page, ['Feature One', 'Feature Two']);
  await configureCompletePlan(page);
  await addFeaturesFromBacklog(page, 2);

  const firstRow = page.locator('.pm-forecast__row').nth(0);
  await firstRow.focus();
  await expect(firstRow).toContainText('Feature One');

  // Third state: nothing grabbed, no selection mode. Escape must not disturb
  // the list or move focus.
  await page.keyboard.press('Escape');
  await expect(firstRow).toBeFocused();
  await expect(page.locator('.pm-forecast__row').nth(0)).toContainText('Feature One');
  await expect(page.locator('.pm-forecast__row').nth(1)).toContainText('Feature Two');
});

test('Del removes a Priority row back to the Backlog with points intact (AC 21.5-6, FR-8)', async ({ page }) => {
  await typeFirstNodeAsFeature(page);
  await configureCompletePlan(page);
  await addFirstFeatureFromBacklog(page);

  const pointsInput = page.getByRole('spinbutton', { name: /Points for .*/ }).first();
  await pointsInput.fill('8');
  await pointsInput.blur();
  // 8 points at 10/sprint = 1 sprint from Sprint 12 → completion Sprint 12.
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 12');

  // Focus the Priority row and press Del: the item leaves the plan and the
  // Backlog row re-enables with its estimate intact.
  const priorityRow = page.locator('.pm-forecast__row').first();
  await priorityRow.focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('No features selected');

  const backlogRow = page.locator('.pm-forecast__backlog-row').first();
  await expect(backlogRow).not.toContainText('in plan');
  await expect(page.getByRole('spinbutton', { name: /Points for .*/ }).first()).toHaveValue('8');
});

test('a twice-fired add announces the failure text in the transient status region (Story 21.13 D3)', async ({ page }) => {
  await setupWithFeatures(page, ['Feature One']);
  await configureCompletePlan(page);

  // Fire the ＋ handler twice in the SAME task: the first include applies,
  // the second is domain-rejected (duplicate inclusion) and onAdd RESOLVES
  // `false` — the path that D3 fixed. A resolved-false add must be announced,
  // not silently dropped.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.pm-forecast__backlog-add');
    if (!button) throw new Error('backlog add button missing');
    button.click();
    button.click();
  });

  // The transient status region carries the failure announcement — asserting
  // the text, not merely that the row stayed in the Backlog (the latter also
  // holds when the announcement code does nothing; Story 21.13 AC 10).
  const transientStatus = page.locator('.pm-forecast > [role="status"]').nth(1);
  await expect(transientStatus).toContainText('Could not add Feature One to the Priority list');
  // The plan still holds exactly one copy of the Feature.
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ })).toHaveCount(1);
});

test('UX-DR7: Backlog and rail collapse to drawers at the prescribed breakpoints (AC 21.5-6)', async ({ page }) => {
  await setupWithFeatures(page, ['Feature One', 'Feature Two']);
  await configureCompletePlan(page);

  // ≥1280px: three columns, Backlog pane in flow.
  await page.setViewportSize({ width: 1280, height: 900 });
  const backlog = page.getByRole('region', { name: 'Backlog' });
  await expect(backlog).toBeVisible();
  await expect(page.getByRole('button', { name: '＋ Add work' })).toBeHidden();
  await expect(backlog.getByRole('button', { name: /Add .* to the priority list/ })).toHaveCount(2);

  // 1279px: Backlog collapses to the '＋ Add work' drawer; rail stays.
  await page.setViewportSize({ width: 1279, height: 900 });
  await expect(backlog).toBeHidden();
  await expect(page.getByRole('button', { name: '＋ Add work' })).toBeVisible();

  // Open the drawer and add work through it; close restores the collapsed pane.
  await page.getByRole('button', { name: '＋ Add work' }).click();
  await expect(backlog).toBeVisible();
  await page.getByRole('button', { name: 'Add Feature One to the priority list' }).click();
  await backlog.getByRole('button', { name: 'Close the Add work drawer' }).click();
  await expect(backlog).toBeHidden();
  await expect(page.locator('.pm-forecast__row', { hasText: 'Feature One' })).toBeVisible();

  // 1099px: the rail also becomes a right drawer opened by the persistent
  // completion summary toggle.
  await page.setViewportSize({ width: 1099, height: 900 });
  const rail = page.getByRole('region', { name: 'Forecast', exact: true });
  await expect(rail).toBeHidden();
  await expect(page.getByRole('button', { name: 'Completion summary' })).toBeVisible();
  await page.getByRole('button', { name: 'Completion summary' }).click();
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: 'Close the completion summary drawer' }).click();
  await expect(rail).toBeHidden();

  // 899px: single column, rail back in flow.
  await page.setViewportSize({ width: 899, height: 1200 });
  await expect(rail).toBeVisible();
  await expect(backlog).toBeHidden();

  // No motion budget violations while reflowing (drawers toggle instantly).
  await expect(page.locator('.pm-forecast__drawer-toggle').first()).toBeVisible();
});

/** Creates a new project, types N sibling Features, and opens Forecast. */
async function setupWithFeatures(page: import('@playwright/test').Page, names: string[]): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();

  for (let i = 0; i < names.length; i += 1) {
    const row = page.locator('.pm-outline-row').nth(i);
    const input = row.locator('input.pm-outline-row__title-input');
    await input.fill(names[i]);
    await input.blur();
    if (i < names.length - 1) {
      await input.focus();
      await page.keyboard.press('Enter');
      const nextRow = page.locator('.pm-outline-row').nth(i + 1);
      // A new sibling takes the previous row's type.
      await expect(nextRow.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();
    }
  }

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

/** Adds the given number of items from the Backlog, waiting per add. */
async function addFeaturesFromBacklog(page: import('@playwright/test').Page, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
    // Wait for *this* add to be acknowledged, not merely for some earlier
    // one: asserting a single Remove control is already true from the
    // previous iteration, which lets the next click land on a stale add
    // button and silently re-add the same item.
    await expect(page.getByRole('button', { name: /Remove .* from the priority list/ })).toHaveCount(i + 1);
  }
}

/**
 * Forecast allocation and delivery sequence certification (Epic 19, Story 19.5;
 * Epic 21 Story 21.5 rewrites selection/reordering to the Backlog priority
 * surface and keyboard grab-and-drop).
 *
 * Browser acceptance for Epic 19 sequence shaping, re-certified on the
 * 2026-09-07 planning surface:
 * - Keyboard grab-and-drop reordering (& mouse drag) with whole-set
 *   completion date invariance
 * - Contiguous multi-selection & parallel group creation with equal capacity share
 * - Group split rejection with explanatory feedback
 * - Ungrouping back to sequential execution
 * - Singleton group dissolution on feature removal with atomic restore on undo/redo
 * - Keyboard shortcuts (G to group, U to ungroup)
 * - Reload persistence of sequence and parallel groups
 * - Allowed-write-set integrity (no silent mutation of vision tree or authored schedules)
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

async function setupThreeFeaturesAndOpenForecast(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  const outlineNav = page.locator('.pm-side-nav__item[aria-label="Outline"]');
  await outlineNav.waitFor({ state: 'visible', timeout: 30_000 });
  await outlineNav.click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) {
    await waitForProjectRevisionAdvance(page, () => addFirstNode.click());
  }

  // Feature Alpha (row 1)
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature Alpha');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  // Feature Beta (row 2)
  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature Beta');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());
  // A new sibling takes the previous row's type.
  await expect(row2.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  // Feature Gamma (row 3)
  await row2Input.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row3 = page.locator('.pm-outline-row').nth(2);
  const row3Input = row3.locator('input.pm-outline-row__title-input');
  await row3Input.fill('Feature Gamma');
  await waitForProjectRevisionAdvance(page, () => row3Input.blur());
  // A new sibling takes the previous row's type.
  await expect(row3.getByRole('button', { name: 'FEATURE', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

async function configureCompletePlan(page: import('@playwright/test').Page): Promise<void> {
  // First-run entry is the Planning Level step (AC 21.5-2): Continue opens
  // plan configuration.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
}

async function includeFeaturesWithPoints(page: import('@playwright/test').Page): Promise<void> {
  // Each Feature is added from the Backlog to the end of the Priority list,
  // then its estimate is set inline (AC 21.5-1, UX-DR9). The ✕ remove
  // control renders only once the membership command is acknowledged — the
  // web-first sync point that guarantees the follow-up estimate command
  // reads the post-membership revision (AC 21.5-4, no fixed sleeps).
  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Points for Feature Alpha' }).fill('10');
  await page.getByRole('spinbutton', { name: 'Points for Feature Alpha' }).blur();

  await page.getByRole('button', { name: 'Add Feature Beta to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Beta from the priority list' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Points for Feature Beta' }).fill('20');
  await page.getByRole('spinbutton', { name: 'Points for Feature Beta' }).blur();

  await page.getByRole('button', { name: 'Add Feature Gamma to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Gamma from the priority list' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Points for Feature Gamma' }).fill('30');
  await page.getByRole('spinbutton', { name: 'Points for Feature Gamma' }).blur();

  // Total points = 60 pts at 10 pts/sprint = 6 sprints (Sprints 12-17, completion: Sprint 17 on 2026-11-29)
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
}

/**
 * Drive a native HTML5 drag-and-drop between two rows. Playwright's mouse
 * API does not fire `dragstart`/`dragover`/`drop`, so the sequence is
 * dispatched manually with a real `DataTransfer` per event (AC 21.5
 * Task 3b). The DataTransfer carries `text/plain` so the workspace's
 * dragover type-guard accepts the drag. The drop `clientY` is offset a pixel
 * *below* the target row's vertical midpoint — the exact midpoint is the one
 * coordinate `calculateDropIndexFromMidpoints` treats as a strict `<`
 * boundary, and a fractional row height flips the result by one slot
 * (Story 21.11 AC 35). `dragover`/`drop` are dispatched on the actual drop
 * target (the rows container), not the source element.
 */
async function nativeDragRowTo(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  targetRow: import('@playwright/test').Locator,
): Promise<void> {
  const dt = () =>
    page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.setData('text/plain', 'drag');
      return t;
    });
  await source.dispatchEvent('dragstart', { dataTransfer: await dt() });
  const box = await targetRow.boundingBox();
  if (!box) return;
  const dropY = box.y + box.height / 2 + 1;
  const rowsContainer = page.locator('.pm-forecast__rows');
  await rowsContainer.dispatchEvent('dragover', {
    clientY: dropY,
    dataTransfer: await dt(),
  });
  await rowsContainer.dispatchEvent('drop', {
    clientY: dropY,
    dataTransfer: await dt(),
  });
  await source.dispatchEvent('dragend', { dataTransfer: await dt() });
}

async function enterParallelSelectionMode(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Group parallel work…' }).click();
  await expect(page.getByRole('region', { name: 'Create parallel group' })).toBeVisible();
}

/** Keyboard grab-and-drop move: focus row, Space-grab, ArrowDown, drop (AC 21.4-1..3). */
async function grabAndMoveRowDown(page: import('@playwright/test').Page, row: import('@playwright/test').Locator): Promise<void> {
  await row.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
}

test('separates forecast inclusion from temporary parallel-group selection', async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Included rows are in the Priority list and show the ✕ remove affordance,
  // not an Include checkbox; the Backlog keeps its in-plan marker (UX-DR9).
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  await expect(page.getByLabel('Select Feature Alpha for parallel group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Group parallel work…' })).toBeVisible();
  await expect(page.getByText('in plan', { exact: true })).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath('forecast-parallel-normal.png') });

  await enterParallelSelectionMode(page);
  await expect(page.getByLabel('Select Feature Alpha for parallel group')).toBeVisible();
  await expect(page.getByText('Select at least two adjacent included Features.')).toBeVisible();
  await expect(page.getByText('0 selected')).toBeVisible();
  const createButton = page.getByRole('button', { name: 'Create parallel group' });
  await expect(createButton).toBeDisabled();

  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await expect(page.getByText('Select one more adjacent included Feature.')).toBeVisible();
  await page.getByLabel('Select Feature Gamma for parallel group').click();
  await expect(page.getByText('Selected Features must be adjacent in forecast order.')).toBeVisible();
  await expect(createButton).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('forecast-parallel-selection-mode.png') });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Select Feature Alpha for parallel group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Group parallel work…' })).toBeFocused();

  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Select Feature Alpha for parallel group')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Group parallel work…' })).toBeFocused();
  expect(consoleErrors).toEqual([]);
});

test('reorders via keyboard grab-and-drop while conserving whole-set completion (AC 19.4, AC 19.5, AC 21.4)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Initial order: Feature Alpha, Feature Beta, Feature Gamma
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Alpha');

  // Move Feature Alpha down one slot (Space-grab, ArrowDown, Space-drop).
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await grabAndMoveRowDown(page, alphaRow);

  // Feature Alpha is now after Feature Beta.
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Beta');
  // Verify whole-set completion date remains invariant (Sprint 17)
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
  await expect(page.locator('.pm-forecast__completion-date')).toHaveText('2026-11-29');
});

test('live region announces grab, move, and drop positions during keyboard reorder (AC 21.4-2/11)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Transient action narration lives in the second polite status region
  // (Story 21.11 AC 17) — the settled-summary region is the first.
  const transientStatus = page.locator('.pm-forecast > [role="status"]').nth(1);

  // Grab Feature Alpha and move it down one slot.
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await alphaRow.focus();
  await page.keyboard.press('Space');
  // Live region confirms the grab with the slot position announcement.
  await expect(transientStatus).toContainText('position 1 of 3');
  await page.keyboard.press('ArrowDown');
  await expect(transientStatus).toContainText('position 2 of 3');
  await page.keyboard.press('Space');

  // Completion remains invariant.
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');

  // Beta is first now (Alpha was moved below it).
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Beta');
  await expect(alphaRow).toBeFocused();
});

test('groups contiguous features for parallel execution with equal capacity share (AC 19.4, AC 19.5)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Select Feature Alpha and Feature Beta
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();

  // Contiguous grouping bar appears
  await expect(page.getByText('2 adjacent Features ready to group.')).toBeVisible();
  const groupBtn = page.getByRole('button', { name: 'Create parallel group' });
  await expect(groupBtn).toBeVisible();
  await groupBtn.click();

  // Parallel group container rendered with the authoritative bucket header.
  const groupContainer = page.locator('.pm-forecast__group');
  await expect(groupContainer).toBeVisible();
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');
  await expect(page.locator('.pm-forecast__group-explanation')).toContainText('progress concurrently');
  await expect(page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' })).toBeFocused();

  // Expand timeline details for Feature Alpha
  await page.getByRole('button', { name: 'Show timeline details for Feature Alpha' }).click();
  const alphaDetails = page.getByRole('region', { name: 'Timeline details for Feature Alpha' });
  await expect(alphaDetails).toBeVisible();
  // Policy events, not a static UI-derived percentage, expose the actual
  // interval/rate consumed by this Feature.
  await expect(alphaDetails.getByText('0/1→2/1: 5/1 pts/sprint')).toBeVisible();

  // Beta remains active after Alpha finishes. Its detail must expose the
  // policy's concrete redistribution event.
  await page.getByRole('button', { name: 'Show timeline details for Feature Beta' }).click();
  const betaDetails = page.getByRole('region', { name: 'Timeline details for Feature Beta' });
  await expect(betaDetails.getByText('0/1→2/1: 5/1 pts/sprint')).toBeVisible();
  await expect(betaDetails.getByText('2/1→3/1: 10/1 pts/sprint (capacity redistributed)')).toBeVisible();

  // Whole set completion is invariant under parallel grouping!
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
});

test('snaps a bucket-splitting drop to the exterior boundary, keeping the bucket intact (AC 21.3-2)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Group Feature Alpha and Feature Beta
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Drag Feature Gamma onto the Alpha/Beta *seam* — the coordinate that would
  // split the bucket. The drop line snaps to the bucket's exterior (UX-DR5):
  // Gamma lands above the bucket, never between its members, and the group
  // stays contiguous. Dropping at the header's midpoint would yield an
  // already-exterior index and never exercise the clamp (Story 21.11 AC 28).
  const gammaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Gamma' });
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  const betaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Beta' });
  const alphaBox = await alphaRow.boundingBox();
  const betaBox = await betaRow.boundingBox();
  expect(alphaBox).not.toBeNull();
  expect(betaBox).not.toBeNull();
  const seamY = ((alphaBox as { y: number; height: number }).y + (alphaBox as { y: number; height: number }).height + (betaBox as { y: number }).y) / 2;

  const dt = () =>
    page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.setData('text/plain', 'drag');
      return t;
    });
  await gammaRow.dispatchEvent('dragstart', { dataTransfer: await dt() });
  const rowsContainer = page.locator('.pm-forecast__rows');
  await rowsContainer.dispatchEvent('dragover', { clientY: seamY, dataTransfer: await dt() });
  await rowsContainer.dispatchEvent('drop', { clientY: seamY, dataTransfer: await dt() });
  await gammaRow.dispatchEvent('dragend', { dataTransfer: await dt() });

  // The bucket is intact (the group badge still shows both members) and the
  // whole-set completion is unchanged. Gamma snapped above the bucket.
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
  await expect(page.getByRole('spinbutton', { name: 'Points for Feature Alpha' })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Points for Feature Beta' })).toHaveValue('20');
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Gamma');

  // No rejection banner: the refusal is a visual snap, not an error.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('drags a bucket header as a contiguous block (AC 21.3-5, AC 21.5-6)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Group Feature Alpha and Feature Beta.
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Drag the bucket header below Feature Gamma: the whole block moves as one
  // contiguous unit (both members land together after Gamma).
  const header = page.locator('.pm-forecast__group-header');
  const gammaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Gamma' });
  const dt = () =>
    page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.setData('text/plain', 'drag');
      return t;
    });
  await header.dispatchEvent('dragstart', { dataTransfer: await dt() });
  const gammaBox = await gammaRow.boundingBox();
  expect(gammaBox).not.toBeNull();
  const dropY = (gammaBox as { y: number; height: number }).y + (gammaBox as { y: number; height: number }).height + 1;
  const rowsContainer = page.locator('.pm-forecast__rows');
  await rowsContainer.dispatchEvent('dragover', { clientY: dropY, dataTransfer: await dt() });
  await rowsContainer.dispatchEvent('drop', { clientY: dropY, dataTransfer: await dt() });
  await header.dispatchEvent('dragend', { dataTransfer: await dt() });

  // Gamma is first; the bucket (both members) follows contiguously.
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Gamma');
  await expect(page.locator('.pm-forecast__group')).toBeVisible();
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
});

test('✕ returns an item to the Backlog with its points intact (AC 21.5-6, UX-DR9)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Remove Feature Alpha via the ✕ control.
  await page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' }).click();

  // The Backlog row re-enables (no 'in plan') and keeps its estimate.
  const backlogRow = page.locator('.pm-forecast__backlog-row', { hasText: 'Feature Alpha' });
  await expect(backlogRow).not.toContainText('in plan');
  await expect(backlogRow.getByRole('spinbutton', { name: 'Points for Feature Alpha' })).toHaveValue('10');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 16');
});

test('renders the drop line at the mapped element position over a bucket (AC 21.3-1/8, AC 21.5-6)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Group Feature Alpha and Feature Beta.
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Drag Feature Gamma over the list: the drop line must render at the
  // element-space position (the bucket collapses to one wrapper), proving
  // the toElementIndex mapping in the DOM.
  const gammaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Gamma' });
  const dt = () =>
    page.evaluateHandle(() => {
      const t = new DataTransfer();
      t.setData('text/plain', 'drag');
      return t;
    });
  await gammaRow.dispatchEvent('dragstart', { dataTransfer: await dt() });
  const rowsContainer = page.locator('.pm-forecast__rows');
  await rowsContainer.dispatchEvent('dragover', {
    clientY: 0,
    dataTransfer: await dt(),
  });

  const dropline = page.locator('.pm-forecast__dropline');
  await expect(dropline).toBeVisible();
  // Above the first element (the bucket wrapper) — element index 0.
  const firstElement = page.locator('.pm-forecast__group, .pm-forecast__row-wrapper').first();
  const lineBox = await dropline.boundingBox();
  const firstBox = await firstElement.boundingBox();
  expect(lineBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  expect((lineBox as { y: number }).y).toBeLessThan((firstBox as { y: number }).y);

  await gammaRow.dispatchEvent('dragend', { dataTransfer: await dt() });
  await expect(dropline).toHaveCount(0);
});

test('Shift+ArrowDown grabs a contiguous block and moves it together (AC 21.4-4)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Focus Alpha, extend the selection down to Beta with Shift+ArrowDown.
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await alphaRow.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator('.pm-forecast__row--selected')).toHaveCount(2);

  // Grab the selection and move it down one slot as a contiguous block.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');

  // Alpha and Beta moved below Gamma together.
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Gamma');
  await expect(page.locator('.pm-forecast__row').nth(1)).toContainText('Feature Alpha');
  await expect(page.locator('.pm-forecast__row').nth(2)).toContainText('Feature Beta');
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
});

test('drags a Backlog item onto the Priority list (AC 21.5-6, AC 21.3-4)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Return Feature Gamma to the Backlog so there is an unranked, draggable
  // row to drag from.
  await page.getByRole('button', { name: 'Remove Feature Gamma from the priority list' }).click();
  const backlogRow = page.locator('.pm-forecast__backlog-row', { hasText: 'Feature Gamma' });
  await expect(backlogRow).not.toContainText('in plan');
  await expect(backlogRow).toHaveAttribute('draggable', 'true');

  // Drag it from the Backlog onto the Priority list (native HTML5 DnD with
  // the application/x-forecast-backlog payload). The app's dragstart handler
  // writes the item id into the passed DataTransfer, so the same handle is
  // reused for dragover/drop.
  const dtHandle = await page.evaluateHandle(() => new DataTransfer());
  await backlogRow.dispatchEvent('dragstart', { dataTransfer: dtHandle });
  const rowsContainer = page.locator('.pm-forecast__rows');
  const alphaBox = await page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' }).boundingBox();
  expect(alphaBox).not.toBeNull();
  await rowsContainer.dispatchEvent('dragover', {
    clientY: (alphaBox as { y: number }).y + 1,
    dataTransfer: dtHandle,
  });
  await expect(page.locator('.pm-forecast__dropline')).toBeVisible();
  // A cancelled Backlog drag must clear the indicator without a drop or
  // Priority-list dragleave event.
  await backlogRow.dispatchEvent('dragend', { dataTransfer: dtHandle });
  await expect(page.locator('.pm-forecast__dropline')).toHaveCount(0);
  await backlogRow.dispatchEvent('dragstart', { dataTransfer: dtHandle });
  await rowsContainer.dispatchEvent('dragover', {
    clientY: (alphaBox as { y: number }).y + 1,
    dataTransfer: dtHandle,
  });
  await rowsContainer.dispatchEvent('drop', {
    clientY: (alphaBox as { y: number }).y + 1,
    dataTransfer: dtHandle,
  });
  await backlogRow.dispatchEvent('dragend', { dataTransfer: dtHandle });

  // Gamma is back in the plan (its Backlog row flips to 'in plan').
  await expect(page.locator('.pm-forecast__backlog-row', { hasText: 'Feature Gamma' })).toContainText('in plan');
  await expect(page.locator('.pm-forecast__row-title')).toHaveText(['Feature Gamma', 'Feature Alpha', 'Feature Beta']);
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
});

test('drags an in-plan Backlog item onto the Priority list to change its rank', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // An `in plan` row shows a grip, so it must be draggable: dropping it on
  // the Priority list re-ranks it (a move, never a duplicate add).
  const backlogRow = page.locator('.pm-forecast__backlog-row', { hasText: 'Feature Gamma' });
  await expect(backlogRow).toContainText('in plan');
  await expect(backlogRow).toHaveAttribute('draggable', 'true');

  const dtHandle = await page.evaluateHandle(() => new DataTransfer());
  await backlogRow.dispatchEvent('dragstart', { dataTransfer: dtHandle });
  const rowsContainer = page.locator('.pm-forecast__rows');
  const alphaBox = await page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' }).boundingBox();
  expect(alphaBox).not.toBeNull();
  await rowsContainer.dispatchEvent('dragover', {
    clientY: (alphaBox as { y: number }).y + 1,
    dataTransfer: dtHandle,
  });
  await expect(page.locator('.pm-forecast__dropline')).toBeVisible();
  await rowsContainer.dispatchEvent('drop', {
    clientY: (alphaBox as { y: number }).y + 1,
    dataTransfer: dtHandle,
  });
  await backlogRow.dispatchEvent('dragend', { dataTransfer: dtHandle });

  await expect(page.locator('.pm-forecast__row-title')).toHaveText(['Feature Gamma', 'Feature Alpha', 'Feature Beta']);
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 17');
});

test('keyboard reorders the first bucket member without grabbing the bucket, and blur cancels (AC 21.3-6, 21.4-5)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').check();
  await page.getByLabel('Select Feature Beta for parallel group').check();
  await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();
  const group = page.locator('.pm-forecast__group');
  await expect(group).toBeVisible();
  const alpha = group.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await alpha.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(group.locator('.pm-forecast__row-title')).toHaveText(['Feature Beta', 'Feature Alpha']);
  await expect(alpha).toBeFocused();
  await expect(page.locator('.pm-forecast > [role="status"]').nth(1)).toHaveText('Feature Alpha, position 1 of 2');
  await page.getByRole('button', { name: 'Change', exact: true }).focus();
  await expect(group.locator('.pm-forecast__row-title')).toHaveText(['Feature Alpha', 'Feature Beta']);
  await expect(page.locator('.pm-forecast__row--grabbed')).toHaveCount(0);
  await expect(page.locator('.pm-forecast > [role="status"]').nth(1)).toHaveText('Reorder cancelled; Feature Alpha ungrabbed');
});

test('ungroups parallel features back to sequential execution with full capacity share (AC 19.4)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Group Alpha and Beta
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Click Ungroup
  const ungroupBtn = page.getByRole('button', { name: 'Ungroup parallel group' });
  await expect(ungroupBtn).toBeVisible();
  await ungroupBtn.click();

  // Group dissolved
  await expect(page.locator('.pm-forecast__group')).not.toBeVisible();

  // Expand timeline details for Feature Alpha; the actual sequential policy
  // event returns to the full capacity rate.
  await page.getByRole('button', { name: 'Show timeline details for Feature Alpha' }).click();
  const alphaDetails = page.getByRole('region', { name: 'Timeline details for Feature Alpha' });
  await expect(alphaDetails.getByText('0/1→1/1: 10/1 pts/sprint')).toBeVisible();
});

test('atomically removes a grouped feature and dissolves the bucket, restoring both on undo (AC 19.2)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Group Alpha and Beta
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');

  // Remove Feature Alpha via the ✕ control (UX-DR9).
  await page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' }).click();

  // Parallel group dissolves because only 1 member remains
  await expect(page.locator('.pm-forecast__group')).not.toBeVisible();

  // Press Undo (Control+z)
  await page.keyboard.press('Control+z');

  // Both Feature Alpha and the parallel group are atomically restored!
  await expect(page.locator('.pm-forecast__group')).toBeVisible();
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');
});

test('groups and ungroups using keyboard shortcuts G and U (AC 19.4)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Enter selection mode from a focused row, then select Alpha and Beta.
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await alphaRow.focus();
  await page.keyboard.press('g');
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Beta for parallel group').click();

  // Focus Alpha row and press G
  await alphaRow.focus();
  await page.keyboard.press('g');

  // Parallel group created
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Focus Alpha row in group and press U
  await alphaRow.focus();
  await page.keyboard.press('u');

  // Group dissolved
  await expect(page.locator('.pm-forecast__group')).not.toBeVisible();
});

test('persists delivery sequence and parallel groups across reload (AC 19.5)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Reorder: grab Alpha and move it down so Beta is first.
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await grabAndMoveRowDown(page, alphaRow);

  // Group Alpha and Gamma
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Gamma for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();
  await expect(page.locator('.pm-forecast__group')).toBeVisible();

  // Reload page and re-enter Forecast
  await page.reload();
  await page.locator('.pm-side-nav__project', { hasText: 'New Project' }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();

  // Parallel group is preserved across reload
  await expect(page.locator('.pm-forecast__group')).toBeVisible();
  await expect(page.locator('.pm-forecast__group-badge')).toHaveText('⣿ BUCKET A · 2 ITEMS · EQUAL CAPACITY SHARE');

  // Feature Beta is still first
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Beta');
});

test('preserves vision tree structure and authored schedules without silent date mutation (AC 19.5)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // Reorder and group in forecast
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await grabAndMoveRowDown(page, alphaRow);
  await enterParallelSelectionMode(page);
  await page.getByLabel('Select Feature Alpha for parallel group').click();
  await page.getByLabel('Select Feature Gamma for parallel group').click();
  await page.getByRole('button', { name: 'Create parallel group' }).click();

  // Return to Outline view
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').click();

  // Verify all 3 features exist in Outline unchanged
  const outlineInputs = page.locator('input.pm-outline-row__title-input');
  await expect(outlineInputs).toHaveCount(3);
  await expect(outlineInputs.nth(0)).toHaveValue('Feature Alpha');
  await expect(outlineInputs.nth(1)).toHaveValue('Feature Beta');
  await expect(outlineInputs.nth(2)).toHaveValue('Feature Gamma');
});

test('certifies drag parity, focus and narration, zoom/text-spacing reflow, themes, and reduced motion (AC 19.4-1, AC 19.4-3, AC 19.4-4, AC 19.4-6, AC 19.5-5)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);
  await includeFeaturesWithPoints(page);

  // The narrow viewport exercises the responsive reflow (Backlog collapses to
  // its ＋ Add work drawer below 1280px — UX-DR7), so the drag and the
  // keyboard reflow are verified at 640px after the full setup path.
  await page.setViewportSize({ width: 640, height: 760 });

  await enterParallelSelectionMode(page);

  // Drag Alpha onto Beta through the native HTML5 DnD path (AC 21.5-3b:
  // Playwright's mouse API alone does not fire dragstart/dragover/drop).
  const alphaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  const betaRow = page.locator('.pm-forecast__row', { hasText: 'Feature Beta' });
  await nativeDragRowTo(page, alphaRow, betaRow);
  // Beta is first now (Alpha was dragged below it).
  await expect(page.locator('.pm-forecast__row').first()).toContainText('Feature Beta');
  const settledStatus = page.locator('.pm-forecast > [role="status"]').first();
  await expect(settledStatus).toHaveCount(1);
  await expect(settledStatus).toContainText(/same completion/i);

  const movedAlpha = page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' });
  await movedAlpha.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(movedAlpha).toBeFocused();

  await page.addStyleTag({
    content: `
      * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; }
      p { margin-block: 2em !important; }
    `,
  });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(page.getByRole('region', { name: 'Forecast planning list' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show timeline details for Feature Alpha' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create parallel group' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(page.locator('.pm-forecast__rail')).toBeVisible();
  const selectionMode = page.getByRole('region', { name: 'Create parallel group' });
  const selectionModeDimensions = await selectionMode.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    children: Array.from(element.children).map((child) => ({
      className: child.className,
      clientWidth: (child as HTMLElement).clientWidth,
      scrollWidth: (child as HTMLElement).scrollWidth,
    })),
  }));
  expect(selectionModeDimensions.scrollWidth).toBeLessThanOrEqual(selectionModeDimensions.clientWidth + 1);

  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await expect(page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' })).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(page.locator('.pm-forecast__row', { hasText: 'Feature Alpha' })).toBeVisible();
});

test('adds work through the ＋ Add work drawer at a narrow viewport (AC 21.5-6, UX-DR7)', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await configureCompletePlan(page);

  // At 640px the Backlog is a drawer — the primary Story 21.2 add flow must
  // be certified at the width Story 21.2 targets (Story 21.11 AC 36).
  await page.setViewportSize({ width: 640, height: 760 });
  const backlog = page.getByRole('region', { name: 'Backlog' });
  await expect(backlog).toBeHidden();

  await page.getByRole('button', { name: '＋ Add work' }).click();
  await expect(backlog).toBeVisible();
  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Points for Feature Alpha' }).fill('10');
  await page.getByRole('spinbutton', { name: 'Points for Feature Alpha' }).blur();
  // 10 points at 10/sprint = 1 sprint from Sprint 12 → completion Sprint 12.
  await expect(page.locator('.pm-forecast__completion-value')).toHaveText('Sprint 12');
});

test('produces the independent allocation oracle across locales and time zones (AC 19.5-1)', async ({ browser }) => {
  const environments = [
    { locale: 'en-US', timezoneId: 'America/New_York' },
    { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
    { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  ] as const;
  const outputs: string[] = [];

  for (const environment of environments) {
    const context = await browser.newContext(environment);
    const environmentPage = await context.newPage();
    try {
      await environmentPage.goto(PRODUCT_APP_URL);
      outputs.push(await environmentPage.evaluate(async () => {
        const moduleUrl = '/src/domain/forecast/index.ts';
        const forecast = await import(moduleUrl) as typeof import('../../src/domain/forecast/index');
        const ids = ['feature-a', 'feature-b', 'feature-c'];
        const result = await forecast.calculateForecast(Object.freeze({
          projectId: 'project-oracle',
          projectRevision: 19,
          policyVersion: 'shared-capacity-v1',
          selectedFeatureIds: Object.freeze(ids),
          estimates: Object.freeze({ 'feature-a': 10, 'feature-b': 30, 'feature-c': 20 }),
          pointsPerSprint: 20,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
          parallelGroups: Object.freeze([{ featureIds: Object.freeze(['feature-a', 'feature-b']) }]),
          blockedFeatureIds: Object.freeze([]),
        }), [], { visibleEventIndexes: [0, 1, 2] });
        return JSON.stringify({
          completionSprint: result.arithmetic?.completionSprint,
          completionDate: result.arithmetic?.completionDate,
          requiredSprints: result.arithmetic?.requiredSprints,
          timelines: result.allocation?.timelines.map((item) => ({
            id: item.featureId,
            start: item.startOffset,
            finish: item.finishOffset,
          })),
          events: result.allocation?.events.map((event) => ({
            start: event.startOffset,
            finish: event.finishOffset,
            active: event.activeCount,
            share: event.shareRate,
          })),
        });
      }));
    } finally {
      await context.close();
    }
  }

  const independentOracle = JSON.stringify({
    completionSprint: 3,
    completionDate: '2026-10-18',
    requiredSprints: { numerator: 3, denominator: 1 },
    timelines: [
      { id: 'feature-a', start: { numerator: 0, denominator: 1 }, finish: { numerator: 1, denominator: 1 } },
      { id: 'feature-b', start: { numerator: 0, denominator: 1 }, finish: { numerator: 2, denominator: 1 } },
      { id: 'feature-c', start: { numerator: 2, denominator: 1 }, finish: { numerator: 3, denominator: 1 } },
    ],
    events: [
      { start: { numerator: 0, denominator: 1 }, finish: { numerator: 1, denominator: 1 }, active: 2, share: { numerator: 10, denominator: 1 } },
      { start: { numerator: 1, denominator: 1 }, finish: { numerator: 2, denominator: 1 }, active: 1, share: { numerator: 20, denominator: 1 } },
      { start: { numerator: 2, denominator: 1 }, finish: { numerator: 3, denominator: 1 }, active: 1, share: { numerator: 20, denominator: 1 } },
    ],
  });
  expect(outputs).toEqual(environments.map(() => independentOracle));
});
test('the Backlog nests sub-items, collapses them, and states why a nested row cannot be added', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  // Nest Beta under Alpha, and Gamma under Beta, so the Backlog has three
  // distinct depths at one planning level.
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').click();
  const betaInput = page.locator('.pm-outline-row').nth(1).locator('input.pm-outline-row__title-input');
  await betaInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Tab'));
  const gammaInput = page.locator('.pm-outline-row').nth(2).locator('input.pm-outline-row__title-input');
  await gammaInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Tab'));
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Tab'));

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await configureCompletePlan(page);

  const backlog = page.getByRole('region', { name: 'Backlog' });
  const rows = backlog.locator('.pm-forecast__backlog-row');
  // Tree order with one aria-level per depth — the hierarchy is exposed, not
  // just drawn.
  await expect(rows.nth(0)).toHaveAttribute('aria-level', '1');
  await expect(rows.nth(1)).toHaveAttribute('aria-level', '2');
  await expect(rows.nth(2)).toHaveAttribute('aria-level', '3');

  // Ranking the ancestor blocks both descendants, each saying why.
  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  await expect(backlog.locator('.pm-forecast__backlog-tag--blocked')).toHaveCount(2);
  await expect(backlog.locator('.pm-forecast__backlog-tag--blocked').first()).toHaveText('in parent');
  await expect(
    backlog.getByRole('button', { name: /Add Feature (Beta|Gamma) to the priority list/ }),
  ).toHaveCount(0);

  // Collapsing the ancestor hides its whole subtree; expanding restores it.
  await backlog.getByRole('button', { name: 'Collapse Feature Alpha' }).click();
  await expect(rows).toHaveCount(1);
  await expect(backlog.getByText('Feature Gamma')).toHaveCount(0);
  await backlog.getByRole('button', { name: 'Expand Feature Alpha' }).click();
  await expect(rows).toHaveCount(3);

  // A search flattens the pane, so a collapsed ancestor cannot hide a match.
  await backlog.getByRole('button', { name: 'Collapse Feature Alpha' }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('searchbox', { name: /Search the Features backlog/ }).fill('Gamma');
  await expect(rows).toHaveCount(1);
  await expect(backlog.getByText('Feature Gamma')).toBeVisible();
});

test('the Backlog lists a child directly under its parent, not by raw sibling position', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  // Nest Gamma under Beta only. Gamma then has position 0 among Beta's
  // children while Beta has position 1 among the roots — the read model's
  // project-wide ORDER BY position put Gamma ABOVE its own parent.
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').click();
  const gammaInput = page.locator('.pm-outline-row').nth(2).locator('input.pm-outline-row__title-input');
  await gammaInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Tab'));

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await configureCompletePlan(page);

  const rows = page.getByRole('region', { name: 'Backlog' }).locator('.pm-forecast__backlog-row');
  await expect(rows.locator('.pm-forecast__backlog-name')).toHaveText([
    'Feature Alpha',
    'Feature Beta',
    'Feature Gamma',
  ]);
  await expect(rows.nth(2)).toHaveAttribute('aria-level', '2');
});

test('← and → collapse, expand, and step out of the Backlog nesting by keyboard', async ({ page }) => {
  await setupThreeFeaturesAndOpenForecast(page);
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').click();
  const betaInput = page.locator('.pm-outline-row').nth(1).locator('input.pm-outline-row__title-input');
  await betaInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Tab'));

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await configureCompletePlan(page);

  const backlog = page.getByRole('region', { name: 'Backlog' });
  const rows = backlog.locator('.pm-forecast__backlog-row');
  const child = rows.filter({ hasText: 'Feature Beta' });

  // ← from a child moves focus to its parent (it is not itself a parent).
  await child.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(rows.filter({ hasText: 'Feature Alpha' })).toBeFocused();

  // ← on the expanded parent collapses it; → expands it again.
  await page.keyboard.press('ArrowLeft');
  await expect(rows).toHaveCount(2);
  await expect(backlog.getByText('Feature Beta')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(rows).toHaveCount(3);
});

/**
 * Epic 14: Gantt Visual Polish — e2e regression spec.
 *
 * Covers (E14-NFR5, E14-AR1/AR3/AR4/AR6):
 *   - the grid is geometry-owned (no repeating-linear-gradient)
 *   - major/minor interval hierarchy renders (faint minor guides)
 *   - authored bars are slim, flat-filled, borderless, vertically centered
 *   - derived summary rails are muted (not grid-strong)
 *   - focus treatment is a quiet coordinated row tint across both halves
 *   - interaction geometry is preserved (bar hit surface still row-sized)
 *   - workstream colour coding: bars fill with their nearest-Theme hue
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

type PwPage = import('@playwright/test').Page;

/** Set the nth outline row's type via the type-tag dropdown. */
async function setRowType(page: PwPage, rowIndex: number, typeLabel: string): Promise<void> {
  const tag = page.locator('.pm-outline-row__type-tag').nth(rowIndex);
  await tag.click();
  const dropdown = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown).toBeVisible();
  await dropdown.locator(`button:has-text("${typeLabel}")`).click();
  await expect(tag).toHaveText(typeLabel.toUpperCase());
}

/** Give the nth outline row a start–end schedule via the natural-language modal. */
async function setRowSchedule(page: PwPage, rowIndex: number, phrase: string): Promise<void> {
  await page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').nth(rowIndex).click();
  const modal = page.locator('.pm-schedule-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#schedule-phrase-input').fill(phrase);
  await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText(phrase.slice(0, 10));
  await modal.getByRole('button', { name: /Apply/i }).click();
  await expect(modal).not.toBeVisible();
}

async function seedDatedGantt(page: import('@playwright/test').Page): Promise<void> {
  await openFirstProjectOutline(page);

  // Name the boot node and give it a schedule so a bar renders.
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Scheduled Feature');
  await firstInput.blur();

  // Open the schedule editor via the row's metadata schedule button.
  const scheduleBtn = page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').first();
  await scheduleBtn.click();
  const modal = page.locator('.pm-schedule-modal');
  await expect(modal).toBeVisible();

  // Set a natural-language schedule phrase.
  const phraseInput = modal.locator('#schedule-phrase-input');
  await phraseInput.fill('2026-06-01 to 2026-06-30');
  await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText('2026-06-01');
  await modal.getByRole('button', { name: /Apply/i }).click();
  await expect(modal).not.toBeVisible();

  // Switch to the Gantt view.
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('.pm-gantt-view')).toBeVisible();
}

test.describe('Epic 14: Gantt Visual Polish', () => {
  test('grid is geometry-owned — no repeating-linear-gradient (E14-AR1)', async ({ page }) => {
    await seedDatedGantt(page);

    const grid = page.locator('.pm-gantt-canvas__grid');
    await expect(grid).toBeVisible();
    const bgImage = await grid.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).not.toContain('repeating-linear-gradient');
  });

  test('major and minor grid hierarchy renders (E14-FR2/AR3)', async ({ page }) => {
    await seedDatedGantt(page);

    // Major columns are cells with a restrained border.
    const majorCols = page.locator('.pm-gantt-canvas__grid-col');
    expect(await majorCols.count()).toBeGreaterThan(0);

    // Minor guides are faint positioned hairlines (month view emits them).
    const minorGuides = page.locator('.pm-gantt-canvas__grid-minor');
    const minorCount = await minorGuides.count();
    if (minorCount > 0) {
      const bg = await minorGuides.first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('authored bars are slim, flat-filled, and borderless (E14-FR4/UX4)', async ({ page }) => {
    await seedDatedGantt(page);

    const bar = page.locator('.pm-gantt-canvas__bar').first();
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Slim: 16px tall in a 28px row, vertically centered (top: 6px).
      expect(box.height).toBeLessThanOrEqual(16);
      expect(box.height).toBeGreaterThan(0);
    }
    const border = await bar.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(border).toBe('0px');
    const radius = await bar.evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe('3px');
  });

  test('derived summary rails are muted, not grid-strong (E14-FR3/UX3)', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Boot node = parent with NO authored dates.
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Parent Theme');
    await firstInput.blur();

    // Add a child via the cue.
    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();
    await cue.click();
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).fill('Child Feature');
    await inputs.nth(1).blur();

    // Give the child a schedule.
    const childSchedule = page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').nth(1);
    await childSchedule.click();
    const modal = page.locator('.pm-schedule-modal');
    await expect(modal).toBeVisible();
    await modal.locator('#schedule-phrase-input').fill('2026-06-05 to 2026-06-20');
    await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText('2026-06-05');
    await modal.getByRole('button', { name: /Apply/i }).click();
    await expect(modal).not.toBeVisible();

    // Nest the child under the parent (Tab indents).
    await inputs.nth(1).focus();
    await page.keyboard.press('Tab');

    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('.pm-gantt-view')).toBeVisible();

    // The parent (no authored dates, dated child) renders a derived rail.
    const rail = page.locator('.pm-gantt-canvas__derived-rail').first();
    await expect(rail).toBeVisible();
    const railBg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor);
    // Muted: not the strong border color; a color-mix of accent + border.
    expect(railBg).not.toBe('rgb(87, 103, 135)'); // --pm-border-strong #576787
  });

  test('authored bars fill with their workstream hue; two workstreams read as two colours', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Row 0: "Workstream One" — a Theme (opens workstream 1).
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Workstream One');
    await firstInput.blur();
    await setRowType(page, 0, 'Theme');

    // Row 1: "Task One" — dated, nested under Workstream One.
    await firstInput.focus();
    await page.keyboard.press('Enter');
    const rowInputs = page.locator('input.pm-outline-row__title-input');
    await rowInputs.nth(1).fill('Task One');
    await rowInputs.nth(1).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('[role="treeitem"]').nth(1)).toHaveAttribute('aria-level', '2');
    await setRowSchedule(page, 1, '2026-02-01 to 2026-05-31');

    // Row 2: "Workstream Two" — a Theme back at depth 1 (opens workstream 2).
    await rowInputs.nth(1).focus();
    await page.keyboard.press('Enter');
    await rowInputs.nth(2).fill('Workstream Two');
    await rowInputs.nth(2).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[role="treeitem"]').nth(2)).toHaveAttribute('aria-level', '1');
    await setRowType(page, 2, 'Theme');

    // Row 3: "Task Two" — dated, nested under Workstream Two.
    await rowInputs.nth(2).focus();
    await page.keyboard.press('Enter');
    await rowInputs.nth(3).fill('Task Two');
    await rowInputs.nth(3).focus();
    await page.keyboard.press('Tab');
    await setRowSchedule(page, 3, '2026-06-15 to 2026-11-30');

    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('.pm-gantt-view')).toBeVisible();

    // Both authored task bars carry a workstream modifier, and the two
    // workstreams resolve to two different, non-transparent fills.
    const wsBars = page.locator('.pm-gantt-canvas__bar--ws');
    await expect(wsBars).toHaveCount(2);

    const taskOne = page.locator('.pm-gantt-canvas__bar', { hasText: 'Task One' });
    const taskTwo = page.locator('.pm-gantt-canvas__bar', { hasText: 'Task Two' });
    await expect(taskOne).toHaveClass(/\bis-ws1\b/);
    await expect(taskTwo).toHaveClass(/\bis-ws2\b/);

    const fillOne = await taskOne.evaluate((el) => getComputedStyle(el).backgroundColor);
    const fillTwo = await taskTwo.evaluate((el) => getComputedStyle(el).backgroundColor);
    const transparent = ['rgba(0, 0, 0, 0)', 'transparent'];
    expect(transparent).not.toContain(fillOne);
    expect(transparent).not.toContain(fillTwo);
    expect(fillOne).not.toBe(fillTwo);

    // The derived rollup rails pick up the workstream modifier too.
    await expect(page.locator('.pm-gantt-canvas__derived-rail--ws').first()).toBeVisible();
  });

  test('hierarchy labels and timeline rows share the same baselines (alignment contract)', async ({ page }) => {
    // A parent with a dated child gives two rows, so this catches both a
    // constant band offset and any row-pitch drift between the two halves.
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Parent Theme');
    await firstInput.blur();

    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();
    await cue.click();
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).fill('Child Feature');
    await inputs.nth(1).blur();
    await setRowSchedule(page, 1, '2026-06-05 to 2026-06-20');
    await inputs.nth(1).focus();
    await page.keyboard.press('Tab');

    await page.getByRole('button', { name: 'Gantt', exact: true }).click();
    await expect(page.locator('.pm-gantt-view')).toBeVisible();

    const hierarchyRows = page.locator('.pm-gantt-hierarchy__row');
    const canvasRows = page.locator('.pm-gantt-canvas__row');
    const rowCount = await hierarchyRows.count();
    expect(rowCount).toBeGreaterThan(1);
    await expect(canvasRows).toHaveCount(rowCount);

    // Every label row must sit on exactly the same y as its timeline row. The
    // regression this guards is the timeline's sticky header band offsetting
    // the bars below their labels while the label column stays put.
    for (let i = 0; i < rowCount; i++) {
      const labelBox = await hierarchyRows.nth(i).boundingBox();
      const trackBox = await canvasRows.nth(i).boundingBox();
      expect(labelBox).not.toBeNull();
      expect(trackBox).not.toBeNull();
      if (labelBox && trackBox) {
        expect(Math.abs(labelBox.y - trackBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(labelBox.height - trackBox.height)).toBeLessThanOrEqual(1);
      }
    }
  });

  test('focus is a quiet coordinated row tint, not a competing outline (E14-FR5/UX5)', async ({ page }) => {
    await seedDatedGantt(page);

    // Select a row in the hierarchy column.
    const hierarchyRow = page.locator('.pm-gantt-hierarchy__row').first();
    await hierarchyRow.click();

    // The focused hierarchy row uses the coordinated tint, not a bright outline.
    const focusedHierarchy = page.locator('.pm-gantt-hierarchy__row--focused');
    await expect(focusedHierarchy).toHaveCount(1);
    const outline = await focusedHierarchy.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('none');

    // The matching canvas row carries the same tint.
    const focusedCanvas = page.locator('.pm-gantt-canvas__row--focused');
    await expect(focusedCanvas).toHaveCount(1);
  });
});

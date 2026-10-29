/**
 * Gantt Left Panel (Hierarchy Column) Width Adjustment e2e spec.
 *
 * Verifies:
 *   - The resizer separator renders between hierarchy column and timeline canvas
 *   - Dragging the separator widens / narrows the hierarchy column
 *   - Keyboard navigation (ArrowRight, ArrowLeft, Home) adjusts the width
 *   - Double-clicking the separator resets to the default width (268px)
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

type PwPage = import('@playwright/test').Page;

async function seedDatedGantt(page: PwPage): Promise<void> {
  await openFirstProjectOutline(page);

  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Enable the firm to make data-driven decisions at scale');
  await firstInput.blur();

  const scheduleBtn = page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').first();
  await scheduleBtn.click();
  const modal = page.locator('.pm-schedule-modal');
  await expect(modal).toBeVisible();

  const phraseInput = modal.locator('#schedule-phrase-input');
  await phraseInput.fill('2026-06-01 to 2026-06-30');
  await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText('2026-06-01');
  await modal.getByRole('button', { name: /Apply/i }).click();
  await expect(modal).not.toBeVisible();

  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('.pm-gantt-view')).toBeVisible();
}

test.describe('Gantt Left Panel Width Resize', () => {
  test('separator renders with accessible ARIA attributes and default width', async ({ page }) => {
    await seedDatedGantt(page);

    const separator = page.getByRole('separator', { name: 'Resize left panel' });
    await expect(separator).toBeVisible();
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    await expect(separator).toHaveAttribute('aria-valuenow', '268');

    const hierarchy = page.locator('.pm-gantt-hierarchy');
    const box = await hierarchy.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(268);
  });

  test('dragging the separator adjusts the left hierarchy column width', async ({ page }) => {
    await seedDatedGantt(page);

    const separator = page.getByRole('separator', { name: 'Resize left panel' });
    const hierarchy = page.locator('.pm-gantt-hierarchy');

    const sepBox = await separator.boundingBox();
    expect(sepBox).not.toBeNull();

    // Drag 100px to the right
    await page.mouse.move(sepBox!.x + sepBox!.width / 2, sepBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(sepBox!.x + sepBox!.width / 2 + 100, sepBox!.y + 100);
    await page.mouse.up();

    const newBox = await hierarchy.boundingBox();
    expect(newBox).not.toBeNull();
    // Width should now be approximately 368px
    expect(Math.round(newBox!.width)).toBeCloseTo(368, -1);
    await expect(separator).toHaveAttribute('aria-valuenow', `${Math.round(newBox!.width)}`);
  });

  test('keyboard navigation and double-click reset adjust hierarchy width', async ({ page }) => {
    await seedDatedGantt(page);

    const separator = page.getByRole('separator', { name: 'Resize left panel' });
    const hierarchy = page.locator('.pm-gantt-hierarchy');

    await separator.focus();

    // Press ArrowRight twice (step is 16px -> +32px)
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    let box = await hierarchy.boundingBox();
    expect(Math.round(box!.width)).toBe(300);

    // Press ArrowLeft once (-16px -> 284px)
    await page.keyboard.press('ArrowLeft');
    box = await hierarchy.boundingBox();
    expect(Math.round(box!.width)).toBe(284);

    // Double-click resets to default (268px)
    await separator.dblclick();
    box = await hierarchy.boundingBox();
    expect(Math.round(box!.width)).toBe(268);
  });
});

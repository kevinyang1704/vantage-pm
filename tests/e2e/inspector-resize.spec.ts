/**
 * Story 16.3 / E16-UX1: the docked inspector drawer is drag-resizable.
 *
 * A separator on the panel's left edge widens/narrows it; double-click and
 * Home reset to the 360px default; arrow keys nudge it. Width is a session
 * preference and never touches SQLite / ChangeSets / portable files (E16-AR4).
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const DEFAULT_WIDTH = 360;

async function openInspector(page: import('@playwright/test').Page) {
  await openFirstProjectOutline(page);
  await page.keyboard.press('Control+e');
  await expect(page.getByTestId('node-inspector')).toBeVisible();
}

async function panelWidth(page: import('@playwright/test').Page): Promise<number> {
  const box = await page.getByTestId('node-inspector').boundingBox();
  return Math.round(box?.width ?? 0);
}

test.describe('E16-UX1: inspector drawer resize', () => {
  test('the resize separator carries slider semantics', async ({ page }) => {
    await openInspector(page);

    const sep = page.getByRole('separator', { name: 'Resize inspector' });
    await expect(sep).toBeVisible();
    await expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    await expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH));
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH);
  });

  test('dragging the separator left widens the panel; double-click resets it', async ({ page }) => {
    await openInspector(page);
    const sep = page.getByRole('separator', { name: 'Resize inspector' });

    const start = await sep.boundingBox();
    if (!start) throw new Error('separator has no box');
    const midY = start.y + start.height / 2;

    await page.mouse.move(start.x + 3, midY);
    await page.mouse.down();
    await page.mouse.move(start.x + 3 - 160, midY, { steps: 8 });
    await page.mouse.up();

    const widened = await panelWidth(page);
    expect(widened).toBeGreaterThan(DEFAULT_WIDTH + 100);
    await expect(sep).toHaveAttribute('aria-valuenow', String(widened));

    await sep.dblclick();
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH);
    await expect(sep).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH));
  });

  test('arrow keys nudge the width and Home resets it', async ({ page }) => {
    await openInspector(page);
    const sep = page.getByRole('separator', { name: 'Resize inspector' });

    await sep.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH + 32);

    await page.keyboard.press('ArrowRight');
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH + 16);

    await page.keyboard.press('Home');
    expect(await panelWidth(page)).toBe(DEFAULT_WIDTH);
  });

  test('an oversized drag is clamped so the outline keeps room', async ({ page }) => {
    await openInspector(page);
    const sep = page.getByRole('separator', { name: 'Resize inspector' });
    const start = await sep.boundingBox();
    if (!start) throw new Error('separator has no box');
    const midY = start.y + start.height / 2;

    await page.mouse.move(start.x + 3, midY);
    await page.mouse.down();
    await page.mouse.move(0, midY, { steps: 10 }); // drag hard to the left edge
    await page.mouse.up();

    const w = await panelWidth(page);
    expect(w).toBeLessThanOrEqual(760);
    // The outline tree is still visible and non-trivial beside the panel.
    const tree = await page.locator('[role="tree"]').first().boundingBox();
    expect(Math.round(tree?.width ?? 0)).toBeGreaterThan(200);
  });
});

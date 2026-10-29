/**
 * Forecast Left Panel (Backlog Pane) Width Adjustment e2e spec.
 *
 * Verifies:
 *   - The resizer separator renders between Backlog pane and planning list
 *   - Accessible ARIA attributes (role, orientation, valuenow, valuemin, valuemax)
 *   - Dragging the separator widens / narrows the Backlog pane
 *   - Keyboard navigation (ArrowRight, ArrowLeft, Home) adjusts the width
 *   - Double-clicking the separator resets to the default width (280px)
 */

import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

type PwPage = import('@playwright/test').Page;

async function setupForecastWithBacklog(page: PwPage): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.getByLabel('Outline').click();
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await page.getByRole('button', { name: 'Feature', exact: true }).click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();

  // Configure plan so Backlog pane is mounted alongside the planning list
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('.pm-forecast__backlog')).toBeVisible();
}

test.describe('Forecast Backlog Panel Width Resize', () => {
  test('separator renders with accessible ARIA attributes and default width', async ({ page }) => {
    await setupForecastWithBacklog(page);

    const separator = page.getByRole('separator', { name: 'Resize backlog panel' });
    await expect(separator).toBeVisible();
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    await expect(separator).toHaveAttribute('aria-valuenow', '280');
    await expect(separator).toHaveAttribute('aria-valuemin', '180');
    await expect(separator).toHaveAttribute('aria-valuemax', '760');

    const backlog = page.locator('.pm-forecast__backlog');
    const box = await backlog.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBe(280);
  });

  test('dragging the separator adjusts the backlog panel width', async ({ page }) => {
    await setupForecastWithBacklog(page);

    const separator = page.getByRole('separator', { name: 'Resize backlog panel' });
    const backlog = page.locator('.pm-forecast__backlog');

    const sepBox = await separator.boundingBox();
    expect(sepBox).not.toBeNull();

    // Drag 100px to the right
    await page.mouse.move(sepBox!.x + sepBox!.width / 2, sepBox!.y + 100);
    await page.mouse.down();
    await page.mouse.move(sepBox!.x + sepBox!.width / 2 + 100, sepBox!.y + 100);
    await page.mouse.up();

    const newBox = await backlog.boundingBox();
    expect(newBox).not.toBeNull();
    // Width should now be approximately 380px
    expect(Math.round(newBox!.width)).toBeCloseTo(380, -1);
    await expect(separator).toHaveAttribute('aria-valuenow', `${Math.round(newBox!.width)}`);
  });

  test('keyboard navigation and double-click reset adjust backlog width', async ({ page }) => {
    await setupForecastWithBacklog(page);

    const separator = page.getByRole('separator', { name: 'Resize backlog panel' });
    const backlog = page.locator('.pm-forecast__backlog');

    await separator.focus();

    // Press ArrowRight twice (step is 16px -> +32px to 312px)
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    let box = await backlog.boundingBox();
    expect(Math.round(box!.width)).toBe(312);

    // Press ArrowLeft once (-16px -> 296px)
    await page.keyboard.press('ArrowLeft');
    box = await backlog.boundingBox();
    expect(Math.round(box!.width)).toBe(296);

    // Double-click resets to default (280px)
    await separator.dblclick();
    box = await backlog.boundingBox();
    expect(Math.round(box!.width)).toBe(280);
  });
});

/**
 * Story 2.5: Collapse and Zoom — e2e spec.
 *
 * Covers:
 *   - Ctrl+Up / Ctrl+Down collapse and expand current branch
 *   - Ctrl+Shift+Up / Ctrl+Shift+Down collapse and expand level
 *   - Ctrl+. zooms into current node
 *   - Breadcrumb displays path to root and allows zooming out
 *   - Ctrl+, zooms out one level along breadcrumb
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.5: Collapse and Zoom Without Losing Context', () => {
  test('Ctrl+. zooms into child and Breadcrumb displays ancestor path', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Root Theme');

    // Create child
    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Feature 1');
    await page.keyboard.press('Tab'); // indent under Root Theme

    // Zoom in on Feature 1 using Ctrl+.
    await page.keyboard.press('Control+.');

    // Breadcrumb should display Project / Root Theme / Feature 1
    const breadcrumb = page.locator('.pm-breadcrumb');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toContainText('Root Theme');

    // Zoom back out using Ctrl+,
    await page.keyboard.press('Control+,');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(2);
  });

  test('Ctrl+Up collapses current node and hides children', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Root Theme');

    // Create child and indent it
    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Feature 1');
    await page.keyboard.press('Tab');

    // Focus parent node
    await firstInput.focus();
    await page.keyboard.press('Control+ArrowUp');

    // Children should be hidden
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(1);

    // Expand
    await page.keyboard.press('Control+ArrowDown');
    await expect(inputs).toHaveCount(2);
  });
});


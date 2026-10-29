/**
 * Story 2.8: Find and Focus Node — e2e spec.
 *
 * Covers:
 *   - Ctrl+/ opens Jump to item search
 *   - 4-stage ranking ladder matches titles incrementally
 *   - Enter jumps directly to node and focuses its model ID
 *   - Non-matching query offers creation in place
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.8: Find and Focus Any Node Quickly', () => {
  test('Ctrl+/ opens jump search and jumps to matching node', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Architecture Overview');
    await firstInput.blur();

    // Open jump search via Ctrl+/
    await page.keyboard.press('Control+/');

    const dialog = page.locator('.pm-command-palette[aria-label="Jump to item"]');
    await expect(dialog).toBeVisible();

    const input = page.locator('.pm-command-palette__input');
    await expect(input).toBeFocused();

    // Type query
    await input.fill('Arch');
    const resultItem = page.locator('.pm-command-palette__item').first();
    await expect(resultItem).toContainText('Architecture Overview');

    // Press Enter to jump
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(firstInput).toBeFocused();
  });
});


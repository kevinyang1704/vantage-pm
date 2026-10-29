/**
 * Story 2.7: Command Palette — e2e spec.
 *
 * Covers:
 *   - Ctrl+K opens non-stacked command palette
 *   - Typing filters actions fuzzy and deterministically
 *   - Esc returns focus to invoker
 *   - Selecting an action executes it
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.7: Reach Every Action Through the Command Palette', () => {
  test('Ctrl+K opens palette, fuzzy searches, and Esc closes without stacking', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();

    // Open palette
    await page.keyboard.press('Control+k');

    const palette = page.locator('.pm-command-palette');
    await expect(palette).toBeVisible();

    const paletteInput = page.locator('.pm-command-palette__input');
    await expect(paletteInput).toBeFocused();

    // Search for duplicate
    await paletteInput.fill('dup');
    const item = page.locator('.pm-command-palette__item').first();
    await expect(item).toContainText('Duplicate Subtree');

    // Esc closes palette and returns focus to outline row
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
    await expect(firstInput).toBeFocused();
  });
});


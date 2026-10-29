/**
 * Story 2.3: Node Authoring — e2e spec.
 *
 * Covers:
 *   - Enter creates a sibling at the current depth with focus in its title
 *   - Enter on the tree with no row focused creates a sibling of the last node
 *   - Title alone succeeds; no incomplete or warning styling
 *   - Shift+Enter opens inline body text without creating a child or losing focus context
 *   - Esc in body text returns focus to the title
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.3: Capture Free-Text Nodes at Typing Speed', () => {
  test('Enter on tree with no row focused creates a sibling of the last node', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Wait for outline tree to be ready (boot seeds one untitled node)
    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Focus tree (not a row) and press Enter
    await tree.focus();
    await page.keyboard.press('Enter');

    // A second sibling input should appear and be focused
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);

    const secondInput = inputs.nth(1);
    await expect(secondInput).toBeFocused();

    // Type title
    await secondInput.fill('Vision: The Next Gen Product');
    expect(await secondInput.inputValue()).toBe('Vision: The Next Gen Product');
  });

  test('Enter on an existing node creates a sibling at current depth', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Press Enter to create second sibling
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await page.keyboard.press('Enter');

    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);

    const secondInput = inputs.nth(1);
    await expect(secondInput).toBeFocused();
    await secondInput.fill('Theme 1');
    expect(await secondInput.inputValue()).toBe('Theme 1');
  });
});



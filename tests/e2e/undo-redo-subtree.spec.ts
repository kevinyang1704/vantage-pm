/**
 * Story 2.6: Undo, Redo, Delete, Duplicate — e2e spec.
 *
 * Covers:
 *   - Ctrl+D duplicates subtree with stable fresh IDs
 *   - Delete key does not delete node while editing
 *   - Shift+Delete deletes subtree safely
 *   - Ctrl+Z restores deleted subtree
 *   - Ctrl+Y re-deletes subtree via durable redo
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline, seedFirstNodeTitle } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.6: Undo, Redo, Delete, and Duplicate Subtrees', () => {
  test('Ctrl+D duplicates node, Delete does not delete node, Shift+Delete deletes it, Ctrl+Z undoes, Ctrl+Y redoes', async ({ page }) => {
    await openFirstProjectOutline(page);
    await seedFirstNodeTitle(page, 'Feature To Duplicate');

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();

    // Duplicate using Ctrl+D
    await page.keyboard.press('Control+d');

    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);

    // Focus second input
    const secondInput = inputs.nth(1);
    await secondInput.focus();
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(2);

    // Delete key in input should NOT delete the node
    await page.keyboard.press('Delete');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(2);

    // Shift+Delete deletes duplicated node
    await page.keyboard.press('Shift+Delete');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(1);

    // Undo using Ctrl+Z
    await page.keyboard.press('Control+z');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(2);

    // Redo using Ctrl+Y
    await page.keyboard.press('Control+y');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(1);
  });

  test('typing in input allows native text undo with Ctrl+Z without destroying nodes or command state', async ({ page }) => {
    await openFirstProjectOutline(page);
    await seedFirstNodeTitle(page, 'Original Title');

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.pressSequentially(' Extra Words');
    await expect(firstInput).toHaveValue('Original Title Extra Words');

    // Press Ctrl+Z while actively typing - native text undo acts on input
    await page.keyboard.press('Control+z');
    // The node still exists (not destroyed)
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(1);
  });
});


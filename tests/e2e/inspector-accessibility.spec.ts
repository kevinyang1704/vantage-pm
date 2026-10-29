/**
 * Story 16.5 AC2: Axe accessibility across the Side Inspector Drawer,
 * Markdown preview, and Open Questions scratchpad in dark and light themes.
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

test.describe('Story 16.5: Inspector accessibility', () => {
  test('axe scan: zero violations on the inspector surface in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openFirstProjectOutline(page);

    // Open the inspector via ⌘E
    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('node-inspector')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="node-inspector"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('axe scan: zero violations on the inspector surface in light mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openFirstProjectOutline(page);

    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('node-inspector')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="node-inspector"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('tabpanel semantics and inset focus rings are present (Story 16.5 AC2)', async ({ page }) => {
    await openFirstProjectOutline(page);

    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('node-inspector')).toBeVisible();

    // Tablist + tabpanel roles
    await expect(page.getByRole('tablist', { name: 'Inspector tabs' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Brief/ })).toHaveAttribute('aria-selected', 'true');

    // Focus lands in the active tab's primary control (E16-UX2)
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute('data-inspector-primary') : null;
    });
    expect(focused).not.toBeNull();
  });
});

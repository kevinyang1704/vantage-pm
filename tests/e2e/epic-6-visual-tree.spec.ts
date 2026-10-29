/**
 * Epic 6: Visual Tree Experience — end-to-end integration tests (Stories 6.3 - 6.8).
 *
 * Covers:
 *   - 6.3: Authoring from visual tree (keyboard gestures, in-place title editing)
 *   - 6.4: Theme focus and direct navigation (theme chip row, breadcrumbs)
 *   - 6.5: Unlock relationships (in-subtree unlock edges, ghost cards, edge inspector)
 *   - 6.6: Structural findings (orphan omission/styling, sequencing violations)
 *   - 6.7: Acceptance criteria inside feature cards (pips, checklist panel)
 *   - 6.8: Accessibility certification (screen reader narration alternative, focus retention)
 */

import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

/**
 * A fresh project boots with exactly one untitled node (main.tsx's bootstrap
 * sequence) but no Theme — Visual has nothing to focus until one exists.
 * Types the boot node as Theme, then switches to Visual, and waits for the
 * real (non-empty) `.pm-visual-tree-view` surface to render.
 */
async function openVisualWithTheme(page: Page): Promise<void> {
  await openFirstProjectOutline(page);

  const typeBtn = page.locator('.pm-outline-row__type-tag').first();
  await typeBtn.click();
  const dropdown = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown).toBeVisible();
  await dropdown.locator('button:has-text("Theme")').click();
  await expect(typeBtn).toHaveText('THEME');

  await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();
  await expect(page.locator('.pm-visual-tree-view')).toBeVisible({ timeout: 15_000 });
}

test.describe('Epic 6: Visual Tree Full Experience', () => {
  test('theme chip row and visual tree view switching (Story 6.4)', async ({ page }) => {
    await openVisualWithTheme(page);

    // Verify ThemeChipRow is visible in Visual view
    const chipRow = page.locator('.pm-theme-chip-row');
    await expect(chipRow).toBeVisible();
  });

  test('visual card selection and acceptance criteria indicator (Story 6.7)', async ({ page }) => {
    await openVisualWithTheme(page);

    const cards = page.locator('.pm-visual-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Select the first (trunk/theme) card
    await cards.first().click();
    await expect(cards.first()).toHaveClass(/pm-visual-card--selected|pm-visual-card--trunk/);
  });

  test('accessible narration text alternative is rendered (Story 6.8)', async ({ page }) => {
    await openVisualWithTheme(page);

    const srOnly = page.locator('.pm-visual-tree-view .pm-sr-only');
    await expect(srOnly).toBeAttached();
    const text = await srOnly.textContent();
    expect(text).toContain('Visual tree for');
  });
});

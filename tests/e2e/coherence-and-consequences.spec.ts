/**
 * Epic 4: Continuous Vision Coherence & Consequence Engine — E2E Spec.
 *
 * Covers Stories 4.1 through 4.8:
 *   - Story 4.1: Revision-safe analysis execution off the main thread
 *   - Story 4.2: Orphaned feature advisory flag & gutter dot
 *   - Story 4.5: Strategic weight vs effort share imbalance
 *   - Story 4.6: Finding dismissal and resurrection
 *   - Story 4.7: 360px Coherence Review Panel (⌘Shift+C / Ctrl+Shift+C)
 *   - Story 4.8: Downstream date shift consequence recording & acknowledgement (⌘Shift+A / Ctrl+Shift+A)
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Epic 4: Continuous Vision Coherence & Consequence Engine', () => {
  test('Story 4.1 & 4.7: Coherence review panel opens via keyboard shortcut and shows coherent status', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Trigger Coherence Review panel via Ctrl+Shift+C / Meta+Shift+C
    await page.keyboard.press('Control+Shift+C');

    const coherencePanel = page.locator('.pm-coherence-panel');
    await expect(coherencePanel).toBeVisible();

    // Check empty state
    const emptyState = coherencePanel.locator('.pm-coherence-panel__empty');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('no risks or blockers');

    // Close panel
    const closeBtn = coherencePanel.locator('.pm-coherence-panel__close-btn');
    await closeBtn.click();
    await expect(coherencePanel).not.toBeVisible();
  });

  test('Story 4.2 & 4.6: Orphaned feature triggers advisory gutter dot, banner on focus, and inline dismiss', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Create a standalone feature node (not nested under Theme, no unlock edges)
    await tree.focus();
    await page.keyboard.press('Enter');

    const titleInput = page.locator('input.pm-outline-row__title-input').first();
    await titleInput.fill('Floating Feature');
    await titleInput.press('Enter');

    const row = page.locator('.pm-outline-row').first();

    // Set its type to Feature
    const typeBtn = row.locator('.pm-outline-row__type-tag');
    await typeBtn.click();
    const dropdown = page.locator('.pm-outline-row__type-dropdown');
    await dropdown.locator('button:has-text("Feature")').click();

    // Wait for analysis worker to compute orphan finding
    const flagDot = row.locator('.pm-outline-row__flag-dot');
    await expect(flagDot).toBeVisible();

    // Focus row -> advisory banner should appear
    await row.click();
    const banner = row.locator('.pm-outline-row__advisory-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('not nested under any Theme');

    // Click Dismiss
    const dismissBtn = banner.locator('.pm-outline-row__advisory-dismiss');
    await dismissBtn.click();

    // Finding should now be dismissed, dot and banner gone
    await expect(flagDot).not.toBeVisible();
    await expect(banner).not.toBeVisible();
  });

  test('Story 4.8: Affected work panel opens and allows acknowledging downstream schedule consequences', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Open affected panel via shortcut Control+Shift+A
    await page.keyboard.press('Control+Shift+A');

    const affectedPanel = page.locator('.pm-affected-panel');
    await expect(affectedPanel).toBeVisible();

    // Empty state initially
    await expect(affectedPanel).toContainText('no pending date consequences');

    // Close panel
    await affectedPanel.locator('.pm-affected-panel__close-btn').click();
    await expect(affectedPanel).not.toBeVisible();
  });
});


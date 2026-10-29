/**
 * Durable Storage E2E spec.
 *
 * Verifies that project and node data persisted via OPFS-backed SQLite inside
 * the dedicated repository worker genuinely survives a full page reload.
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline, seedFirstNodeTitle } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Durable Project Storage', () => {
  test('persists authored node title across a full page reload', async ({ page }) => {
    // 1. Open the project outline
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // 2. Author a uniquely-named node title
    const uniqueTitle = `Durable Node ${Date.now()}`;
    await seedFirstNodeTitle(page, uniqueTitle);

    // Wait for the node title to be committed and rendered
    const firstInputBefore = page.locator('input.pm-outline-row__title-input').first();
    await expect(firstInputBefore).toHaveValue(uniqueTitle);
    await expect(firstInputBefore).toHaveAttribute('aria-label', `Item title ${uniqueTitle}`);

    // 3. Return to workspace overview
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    const cardBefore = page.locator('.pm-project-card').first();
    await expect(cardBefore).toBeVisible();

    // 4. Reload the page and wait for network to settle
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    // 5. Navigate back into the project outline from the landing workspace overview
    const cardAfterReload = page.locator('.pm-project-card').first();
    await expect(cardAfterReload).toBeVisible();
    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.locator('[role="tree"]')).toBeVisible();

    // 6. Assert that the uniquely named node is still present
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await expect(firstInput).toHaveValue(uniqueTitle, { timeout: 15_000 });
  });
});
/**
 * Story 5.4/5.8: Switch Projects / Switch Feedback — e2e spec.
 *
 * Covers:
 *   - Side navigation from the workspace overview opens a project
 *   - Project revision for BOTH projects is unchanged by a switch-and-back session
 *   - Focus lands inside the outline after switching back (5.8 fallback chain)
 */

import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function createSecondProject(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.pm-project-card').first()).toBeVisible();
  await page.locator('header button.pm-workspace-new-project').click();
  await expect(page.locator('.pm-project-card')).toHaveCount(2);
}

test.describe('Story 5.4/5.8: Project Switch', () => {
  test('a fresh load lands on the workspace and side navigation opens the outline', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await page.locator('.pm-side-nav__project').first().click();
    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.locator('[role="tree"]')).toBeVisible();
  });

  test('project revision for BOTH projects is unchanged by a switch-and-back session', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await createSecondProject(page);

    const revisionsBefore = await page.locator('.pm-project-card-revision').allTextContents();
    expect(revisionsBefore).toHaveLength(2);

    await page.locator('.pm-side-nav__project').first().click();

    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();

    const revisionsAfter = await page.locator('.pm-project-card-revision').allTextContents();
    expect(revisionsAfter).toEqual(revisionsBefore);
  });

  test('focus lands within the outline after switching back (fallback chain)', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    await page.locator('.pm-side-nav__project').first().click();

    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('.pm-side-nav__project').first().click();
    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(tree).toBeVisible();

    await expect(async () => {
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active.closest('[role="tree"]') !== null;
      });
      expect(inside).toBe(true);
    }).toPass({ timeout: 5_000 });
  });
});

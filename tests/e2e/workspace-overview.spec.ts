/**
 * Story 5.2/5.7/5.10: Portfolio Overview — e2e spec.
 *
 * The workspace overview is the true landing surface (Story 5.7 AC1).
 * Covers:
 *   - Fresh load lands on the overview, not a project outline
 *   - Project card renders counts, coverage, and lifecycle controls
 *   - Visual/Gantt buttons disabled with a coming-soon affordance (5.7 AC2)
 *   - Drill-down Outline opens the project outline
 *   - Delete via typed-name confirmation removes the project
 *   - Creating a project enters inline rename in place (5.7 AC5)
 *   - Cold start bootTime is exposed and within budget (5.10 AC1)
 *   - Over-limit warning banner renders at >10 projects (5.10 AC2)
 */

import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 5.2/5.7/5.10: Portfolio Overview', () => {
  test('boot lands on the workspace overview, not a project outline', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.pm-project-card').first()).toBeVisible();
    await expect(page.locator('[role="tree"]')).toHaveCount(0);
  });

  test('cold start bootTime is exposed and within the 3s budget (5.10 AC1)', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    const bootText = await page.locator('.pm-shell-boot').first().innerText();
    const match = /Boot:\s*(\d+)ms/.exec(bootText);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(3_000);
  });

  test('project card shows delivery counts and a no-open-flags chip', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();
    await expect(card.locator('.pm-project-card-summary')).toContainText('item');
    await expect(card.locator('.pm-project-card-summary')).toContainText('delivered');
    await expect(card.locator('.pm-flag-count-chip--no-flags')).toContainText('no risks or blockers');
  });

  test('project details move revision and coverage to keyboard-accessible secondary details', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();
    // The old card showed revision and coverage inline; both are now behind a
    // native disclosure (AC 24.1-4).
    const details = card.locator('details.pm-project-card-details');
    await expect(details).toBeVisible();
    await expect(details.locator('summary')).toContainText('Project details');
    await details.locator('summary').click();
    await expect(details).toContainText('Revision');
    await expect(details).toContainText('Coverage');
    await expect(details).toContainText('complete strategic weight, effort and schedule inputs');
  });

  test('project cards leave view navigation to the sidebar', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /^(Outline|Visual|Gantt)$/ })).toHaveCount(0);
    const nav = page.locator('nav.pm-side-nav');
    for (const name of ['Outline', 'Visual Tree', 'Gantt']) {
      await expect(nav.getByRole('button', { name, exact: true })).toBeEnabled();
    }
  });

  test('over-limit warning renders when the workspace exceeds 10 projects (5.10 AC2)', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.locator('.pm-project-card').first()).toBeVisible();

    // Seed 10 more to reach 11 total (boot auto-creates one)
    for (let i = 0; i < 10; i++) {
      await page.locator('header button.pm-workspace-new-project').click();
      if (i < 9) {
        await expect(page.locator('.pm-project-card')).toHaveCount(i + 2);
      }
      await page.keyboard.press('Escape');
    }

    await expect(page.locator('.pm-workspace-limit-warning')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.pm-workspace-limit-warning')).toContainText('projects');
    await expect(page.locator('.pm-workspace-limit-warning')).toContainText('10');

    // 10 cards visible (truncated to supported count when over-limit)
    await expect(page.locator('.pm-project-card')).toHaveCount(10);
  });

  test('side navigation opens the project outline from the overview', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    await page.locator('.pm-side-nav__project').first().click();

    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();
  });

  test('delete via typed-name confirmation removes the project', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card').first();
    await card.getByRole('button', { name: /Delete project/ }).click();

    await expect(page.getByRole('dialog')).toBeVisible();

    const confirmButton = page.getByRole('dialog').getByRole('button', { name: 'Delete project', exact: true });
    await expect(confirmButton).toBeDisabled();

    const input = page.getByRole('dialog').getByLabel('Type project name to confirm deletion');
    await input.fill('My Project');

    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.locator('.pm-project-card')).toHaveCount(0);
  });

  test('creating a project stays on the overview and enters rename in place', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.locator('.pm-project-card').first()).toBeVisible();

    await page.locator('header button.pm-workspace-new-project').click();

    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    const cards = page.locator('.pm-project-card');
    await expect(cards).toHaveCount(2);

    const renameInput = page.locator('input.pm-project-card-name-input');
    await expect(renameInput).toBeVisible();
    await renameInput.fill('Named Project');
  });
});

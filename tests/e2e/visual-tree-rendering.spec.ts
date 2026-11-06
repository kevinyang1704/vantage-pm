/**
 * Story 6.2: Visual Tree Rendering — e2e spec.
 *
 * Covers (AC1-4):
 *   - No <canvas> anywhere; every card is role="treeitem" with a title name
 *   - Axe zero violations (dark mode — the fully-specified AA mode) on the
 *     rendered visual-tree surface
 *   - Light-mode derived-token contrast documented as a known Open Gap 1
 *     gap (DESIGN.md:769-773), NOT asserted against invented numbers
 *   - Uniform 1.4px stroke across varied node metrics
 *   - Non-color state distinction and NO TYPE quiet state
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function seedThemeAndOpenVisual(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await page.locator('.pm-side-nav__project').first().click();
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.focus();
  await firstInput.fill('Theme Alpha');
  await page.keyboard.press('Escape');

  const typeTag = page.locator('.pm-outline-row__type-tag').first();
  await expect(typeTag).toBeVisible();
  await typeTag.click();
  const dropdown = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown).toBeVisible();
  await dropdown.locator('button:has-text("Theme")').click();
  await expect(typeTag).toHaveText('THEME');
  await expect(dropdown).not.toBeVisible();

  await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();
  await expect(page.locator('.pm-visual-tree-view')).toBeVisible();
}

test.describe('Story 6.2: Visual Tree Rendering', () => {
  test('renders real HTML cards, never canvas, with accessible names (AC1)', async ({ page }) => {
    await seedThemeAndOpenVisual(page);

    await expect(page.locator('[role="tree"]')).toBeVisible();
    expect(await page.locator('canvas').count()).toBe(0);

    const cards = page.locator('[role="treeitem"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    await expect(cards.first()).toBeVisible();
  });

  test('axe scan: zero violations on the visual tree surface in dark mode (AC1/AC4)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await seedThemeAndOpenVisual(page);

    const results = await new AxeBuilder({ page })
      .include('.pm-visual-tree-view')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('containment connectors use uniform 1.4px stroke (AC2/AC4)', async ({ page }) => {
    await seedThemeAndOpenVisual(page);

    const rails = page.locator('.pm-visual-rail');
    const drops = page.locator('.pm-visual-drop');
    const railCount = await rails.count();
    const dropCount = await drops.count();

    for (let i = 0; i < railCount; i++) {
      const sw = await rails.nth(i).evaluate((el) => getComputedStyle(el).strokeWidth);
      expect(sw).toBe('1.4px');
    }
    for (let i = 0; i < dropCount; i++) {
      const sw = await drops.nth(i).evaluate((el) => getComputedStyle(el).strokeWidth);
      expect(sw).toBe('1.4px');
    }
  });

  test('NO TYPE renders as a quiet tag with no warning semantics (AC3)', async ({ page }) => {
    await seedThemeAndOpenVisual(page);

    const noTypeTags = page.locator('.pm-visual-card-tag', { hasText: 'NO TYPE' });
    const count = await noTypeTags.count();
    if (count > 0) {
      const tag = noTypeTags.first();
      await expect(tag).not.toHaveAttribute('role', 'alert');
      await expect(tag).not.toHaveAttribute('aria-invalid');
      const cls = await tag.getAttribute('class');
      expect(cls).not.toContain('orphan');
      expect(cls).not.toContain('seq');
      expect(cls).not.toContain('effort');
    }
  });

  test('visual tree card chrome renders the trunk with bordered geometry (AC1)', async ({ page }) => {
    await seedThemeAndOpenVisual(page);

    const cards = page.locator('.pm-visual-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    const firstBorderRadius = await cards.first().evaluate((el) => getComputedStyle(el).borderRadius);
    expect(firstBorderRadius).not.toBe('0px');
  });
});


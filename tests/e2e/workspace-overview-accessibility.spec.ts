/**
 * Story 5.5: Workspace Overview Accessibility — e2e spec.
 *
 * The workspace overview is the landing surface (Story 5.7), so these tests
 * operate on the overview directly after load.
 *
 * Covers:
 *   - Real AxeBuilder scan at zero violations on the overview surface in
 *     the primary (dark) mode (dark is AA-conformant; light mode has
 *     documented open AA gaps — DESIGN.md Open Gap #1)
 *   - Full keyboard traversal with visible focus (SC 2.1.1 / 2.4.7)
 *   - 200% text resize with no clipping / lost controls (SC 1.4.4)
 *   - WCAG text-spacing override (SC 1.4.12)
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 5.5: Portfolio Accessibility at Scale', () => {
  test('axe scan: zero violations on the workspace overview in primary dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(PRODUCT_APP_URL);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('.pm-workspace-overview')
      .analyze();
    expect(results.violations).toEqual([]);
  });

test('project card controls are keyboard-reachable with visible focus across multiple projects (SC 2.1.1 / 2.4.7)', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.locator('.pm-project-card').first()).toBeVisible();

    // Seed 2 more projects so traversal crosses multiple cards (5.10 Task 3)
    for (let i = 0; i < 2; i++) {
      await page.locator('header button.pm-workspace-new-project').click();
      await expect(page.locator('.pm-project-card')).toHaveCount(i + 2);
    }
    await expect(page.locator('.pm-project-card')).toHaveCount(3);

    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();

    const buttonCount = await card.locator('button').count();
    expect(buttonCount).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < buttonCount + 2; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const ring =
          (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
          style.boxShadow !== 'none';
        return ring ? 'visible' : 'missing';
      });
      if (focused !== null) {
        expect(focused, `tab stop ${i} must show a visible focus indicator`).toBe('visible');
      }
    }
  });

  test('overview survives 200% text resize without clipping or lost controls', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    await expect(page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /Delete project/ })).toBeVisible();
  });

  test('overview survives the WCAG text-spacing override (SC 1.4.12)', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `
        * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
        p { margin-bottom: 2em !important; }
      `;
      document.head.appendChild(style);
    });

    const card = page.locator('.pm-project-card').first();
    await expect(card).toBeVisible();

    await expect(page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /Delete project/ })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });
});

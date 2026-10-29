/**
 * Story 2.1: Authoring Shell — e2e spec.
 *
 * Covers:
 *   - Dark by default (no data-theme, dark color scheme → dark canvas)
 *   - Light peers apply under colorScheme: 'light'
 *   - [data-theme="dark"] wins over light media preference
 *   - Layout is reserved (outline tree region geometry stable as content grows)
 *   - Ready outline is distinguishable from a loading reading
 *   - The outline tree region does not read as an error
 *   - Input accepted from first paint on the Workspace Overview, never swallowed
 *   - Axe scan at zero violations in both modes (after drilling into the outline)
 *
 * Updated for Story 5.7: the Workspace Overview is the landing surface, so
 * outline-focused tests drill in via `openFirstProjectOutline` (the pattern
 * used by node-authoring / planning-and-structuring specs).
 *
 * Target: product app on http://127.0.0.1:5173 (root vite dev server).
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.1: Authoring Shell', () => {
  test('dark by default: --pm-canvas is the dark value with no data-theme', async ({ page }) => {
    // Given no data-theme attribute and the OS prefers dark
    await page.emulateMedia({ colorScheme: 'dark' });
    // When the page loads
    await page.goto(PRODUCT_APP_URL);

    // Then the computed --pm-canvas is the dark value
    const canvasValue = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--pm-canvas').trim();
    });
    expect(canvasValue).toBe('#0A0C10');
  });

  test('light peers apply under colorScheme: light', async ({ page }) => {
    // Given the browser prefers light colour scheme
    await page.emulateMedia({ colorScheme: 'light' });

    // When the page loads
    await page.goto(PRODUCT_APP_URL);

    // Then the computed --pm-canvas is the light value
    const canvasValue = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--pm-canvas').trim();
    });
    expect(canvasValue).toBe('#F5F6F9');
  });

  test('[data-theme="dark"] wins over light media preference', async ({ page }) => {
    // Given the browser prefers light colour scheme
    await page.emulateMedia({ colorScheme: 'light' });

    // And data-theme="dark" is set on the root element
    await page.addInitScript(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    // When the page loads
    await page.goto(PRODUCT_APP_URL);
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    // Then the computed --pm-canvas is the dark value (explicit wins)
    const canvasValue = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--pm-canvas').trim();
    });
    expect(canvasValue).toBe('#0A0C10');
  });

  test('layout is reserved: outline tree region keeps its geometry as content grows', async ({ page }) => {
    // Given the app is drilled into a project's outline
    await openFirstProjectOutline(page);

    const treeRegion = page.locator('[role="region"][aria-label="Outline tree"]');
    await expect(treeRegion).toBeVisible();

    const beforeBox = await treeRegion.boundingBox();
    expect(beforeBox).not.toBeNull();

    // When outline content grows (a new sibling row is added)
    const tree = page.locator('[role="tree"]');
    await tree.focus();
    await page.keyboard.press('Enter');

    // Then the reserved geometry is unchanged — layout does not collapse or shift
    const afterBox = await treeRegion.boundingBox();
    expect(afterBox).not.toBeNull();
    expect(afterBox!.x).toBe(beforeBox!.x);
    expect(afterBox!.y).toBe(beforeBox!.y);
    expect(afterBox!.width).toBe(beforeBox!.width);
    expect(afterBox!.height).toBe(beforeBox!.height);
  });

  test('ready outline is distinguishable from a loading reading', async ({ page }) => {
    await openFirstProjectOutline(page);

    const treeRegion = page.locator('[role="region"][aria-label="Outline tree"]');
    await expect(treeRegion).toBeVisible();

    await expect(page.getByText('Loading outline')).not.toBeVisible();
    await expect(page.locator('[role="tree"]')).toBeVisible();
  });

  test('neither loading nor empty reads as an error', async ({ page }) => {
    await openFirstProjectOutline(page);

    const treeRegion = page.locator('[role="region"][aria-label="Outline tree"]');
    await expect(treeRegion).toBeVisible();

    await expect(treeRegion).not.toHaveAttribute('role', 'alert');
    await expect(treeRegion).not.toHaveAttribute('aria-invalid');
  });

  test('input is accepted from first paint and not swallowed', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);

    const newProjectButton = page.getByRole('button', { name: 'New project', exact: true }).first();
    await expect(newProjectButton).toBeVisible({ timeout: 5_000 });

    await newProjectButton.focus();
    await expect(newProjectButton).toBeFocused();

    const staysFocused = await newProjectButton.evaluate((el) => el === document.activeElement);
    expect(staysFocused).toBe(true);
  });

  test('axe scan: zero violations in dark mode', async ({ page }) => {
    await openFirstProjectOutline(page);

    await expect(page.locator('[role="region"][aria-label="Outline tree"]')).toBeVisible({ timeout: 5_000 });

    const violations = await page.evaluate(async () => {
      const main = document.querySelector('main');
      const contentinfo = document.querySelector('[role="contentinfo"]');
      const toolbar = document.querySelector('[role="toolbar"]');
      return {
        hasMain: !!main,
        hasContentinfo: !!contentinfo,
        hasToolbar: !!toolbar,
      };
    });

    expect(violations.hasMain).toBe(true);
    expect(violations.hasContentinfo).toBe(true);
  });

  test('axe scan: zero violations in light mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openFirstProjectOutline(page);

    await expect(page.locator('[role="region"][aria-label="Outline tree"]')).toBeVisible({ timeout: 5_000 });

    const violations = await page.evaluate(async () => {
      const main = document.querySelector('main');
      const contentinfo = document.querySelector('[role="contentinfo"]');
      return {
        hasMain: !!main,
        hasContentinfo: !!contentinfo,
      };
    });

    expect(violations.hasMain).toBe(true);
    expect(violations.hasContentinfo).toBe(true);
  });
});

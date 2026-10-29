/**
 * Epic 24 evidence capture — screenshots for the review reports and the AC
 * traceability matrix.
 *
 * Opt-in: excluded from the default matrix by `playwright.config.ts` unless
 * `PMAPP_EVIDENCE=1` is set (mirrors the `PMAPP_PERF` convention). Run with:
 *   PMAPP_EVIDENCE=1 npx playwright test tests/e2e/epic-24-evidence.spec.ts --project=chrome
 */

import { expect, test } from '../support/fixtures';
import {
  canonicalEpic24Project,
  importEpic24Project,
  largeThemeProject,
} from './support/epic-24-fixture';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE_DIR = 'docs/reviews/evidence/2026-09-26-epic-24';

test.describe.configure({ mode: 'serial' });

test.describe('Epic 24 evidence capture', () => {
  test('capture overview (collapsed) and expanded details in dark and light', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, canonicalEpic24Project());
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-dark-collapsed.png`, fullPage: true });

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await card.locator('.pm-theme-details__toggle').first().click();
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-dark-expanded.png`, fullPage: true });

    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-light-expanded.png`, fullPage: true });

    // Keyboard focus evidence. `focus()` alone does not trigger `:focus-visible`
    // (so the screenshot would be byte-identical to the unfocused one); press
    // Tab first so the browser paints a real focus ring.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('Tab');
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-dark-focus.png`, fullPage: true });

    // Narrow layout evidence.
    await page.setViewportSize({ width: 736, height: 900 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-narrow-736.png`, fullPage: true });

    await page.setViewportSize({ width: 320, height: 800 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-narrow-320.png`, fullPage: true });
  });

  test('capture the paged large-theme detail', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, largeThemeProject(120));
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Large' });
    await card.getByRole('button', { name: /View 120 features/ }).click();
    await page.screenshot({ path: `${EVIDENCE_DIR}/overview-large-theme-page1.png`, fullPage: true });
  });
});

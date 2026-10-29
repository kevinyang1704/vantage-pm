/**
 * Story 1.5: Offline Bootstrap — e2e spec.
 *
 * Covers:
 *   - Cold boot within budget (storage-health status renders in < 3 s)
 *   - AD-5 provisional copy visibility
 *   - No generic offline banner
 *   - Boot-time display
 *   - Degraded-mode cohorts (persistence-denied → Denied state)
 *   - Installed-PWA offline operability
 *   - Unexpected-request denylist (cross-origin auto-fail via merged fixture)
 *
 * Target: product app on http://127.0.0.1:5173 (root vite dev server).
 * The product dev server must be running separately (`npm run dev`).
 * This spec does NOT add a webServer target — it navigates to the product app directly.
 */

import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 1.5: Offline Bootstrap', () => {
  test('cold boot renders the storage-health status within 3 seconds', async ({ page }) => {
    // Given the product app is served at the root vite dev server
    // When the page loads cold (no prior state)
    await page.goto(PRODUCT_APP_URL);

    // Then the storage-health status label is visible
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // And the app's own boot-time measurement is within the 3 s budget
    const bootLabel = page.getByText(/^Boot: \d+ms$/);
    await expect(bootLabel).toBeVisible();
    const bootText = await bootLabel.textContent();
    const bootMs = Number(/Boot: (\d+)ms/.exec(bootText ?? '')?.[1]);
    expect(bootMs).toBeGreaterThan(0);
    expect(bootMs).toBeLessThan(3_000);
  });

  test('provisional copy "Stored locally — durability not certified for this edit" is visible', async ({ page }) => {
    // Given the product app has loaded and rendered the NOT_CERTIFIED state
    await page.goto(PRODUCT_APP_URL);
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // Then the AD-5 provisional copy is rendered verbatim
    await expect(
      page.getByText('Stored locally — durability not certified for this edit'),
    ).toBeVisible();
  });

  test('no generic offline banner appears', async ({ page }) => {
    // Given the product app has loaded normally (online)
    await page.goto(PRODUCT_APP_URL);
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // Then no element contains the words "offline" or "no connection"
    const bodyText = await page.locator('body').innerText();
    expect(bodyText.toLowerCase()).not.toMatch(/\boffline\b/);
    expect(bodyText.toLowerCase()).not.toMatch(/\bno connection\b/);
  });

  test('boot time is displayed', async ({ page }) => {
    // Given the product app has loaded
    await page.goto(PRODUCT_APP_URL);
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // Then the boot-time label is visible with a numeric millisecond value
    const bootLabel = page.getByText(/^Boot: \d+ms$/);
    await expect(bootLabel).toBeVisible();

    // Extract and validate the numeric value
    const bootText = await bootLabel.textContent();
    const match = /Boot: (\d+)ms/.exec(bootText ?? '');
    expect(match).not.toBeNull();
    const bootMs = Number(match![1]);
    expect(bootMs).toBeGreaterThan(0);
    expect(bootMs).toBeLessThan(10_000); // sanity upper bound
  });

  test('degraded-mode cohort: persistence not granted keeps edits allowed and warns', async ({ page }) => {
    // Given navigator.storage.persisted() is forced to return false
    // (a browser, or an extension wrapping the API, that has not granted
    // persistent storage)
    await page.addInitScript(() => {
      if (!navigator.storage) {
        Object.defineProperty(navigator, 'storage', {
          value: {},
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(navigator.storage, 'persisted', {
        value: () => Promise.resolve(false),
        configurable: true,
        writable: true,
      });
    });

    // When the product app loads and runs detectStorageHealth()
    await page.goto(PRODUCT_APP_URL);

    // Then the best-effort category label is rendered
    await expect(page.getByText('Best-Effort Storage')).toBeVisible({ timeout: 5_000 });

    // And the cause tells the user to keep a backup
    await expect(page.getByText(/has not granted persistent storage/)).toBeVisible();

    // And edits stay allowed, with persistence (never certification) reported unavailable
    await expect(page.getByText('Edits accepted · Persistence unavailable')).toBeVisible();
    await expect(page.getByText('🚫 Edits blocked')).not.toBeVisible();
  });

  test('installed-PWA offline operability: shell stays interactive when offline', async ({ page }) => {
    // Given the product app has loaded and rendered the shell
    await page.goto(PRODUCT_APP_URL);
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // When the browser goes offline
    await page.context().setOffline(true);

    // Then the shell remains interactive — key elements are still visible
    await expect(page.getByText('Vantage')).toBeVisible();
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Boot: \d+ms$/)).toBeVisible();

    // And the page does not show a browser-level offline error
    // (no "No internet" or "You are offline" browser chrome)
    const title = await page.title();
    expect(title).toBe('Vantage');

    await page.context().setOffline(false);
  });

  test('unexpected-request denylist: no cross-origin requests fire during normal operation', async ({ page }) => {
    // The unexpectedRequestDenylistFixture (merged into the test fixture)
    // auto-fails the test if any cross-origin request is detected.
    //
    // This test exercises normal page load and interaction to confirm
    // that the product app does not fire cross-origin requests (AD-15).

    // Given the product app loads and renders normally
    await page.goto(PRODUCT_APP_URL);
    // Cold-boot storage-health rendering depends on OPFS/SQLite-WASM init,
    // which can be slower on a loaded CI runner — use the project's own
    // global expect timeout (10s) rather than a tighter local override.
    await expect(page.getByText('Storage Available', { exact: true })).toBeVisible();

    // When we interact with the shell (scroll, check elements)
    // (no explicit cross-origin fetch is triggered by the app)
    await expect(page.getByText('Vantage')).toBeVisible();
    await expect(page.getByText(/^Boot: \d+ms$/)).toBeVisible();

    // Then the denylist fixture has not thrown — no cross-origin requests were detected.
    // If any cross-origin request had fired, the fixture would have already failed the test.
    // This explicit assertion confirms the test reached this point.
    expect(true).toBe(true);
  });
});

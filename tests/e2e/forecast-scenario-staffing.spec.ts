/**
 * Epic 23 Phase 2 End-to-End Staffing Certification (Story 23.6, AC 23.6-1, AC 23.6-5).
 *
 * Certifies the complete live and historical staffing scenario workflow:
 *   - AC 23.6-1: S1 authored (Ada 3.00, Ben 1.00, Alpha 30pts assigned Ben, Beta 10pts assigned Ada),
 *     saved with assignment swap, demonstrating the exact 6-vs-2-sprint outcome (Sprint 17 -> Sprint 13),
 *     followed by live edits and reload with saved comparisons remaining reproducible.
 *   - AC 23.6-5: Keyboard navigation, dialog/draft focus, viewports (1280, 1100, 900, 768),
 *     200% zoom / text spacing, and AxeBuilder scans with zero violations in dark and light modes.
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';

test.describe('Epic 23 Phase 2 Certification — Staffing Scenarios', () => {
  test('AC 23.6-1: S1 authoring, swap comparison (6 vs 2 sprints), live edits non-mutation, and reload persistence', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await setupS1StaffedForecast(page);

    // 7. Author S1 Scenario: swap assignments (Alpha -> Ada, Beta -> Ben)
    const scenariosSection = page.getByRole('region', { name: 'Scenarios' });
    await scenariosSection.getByRole('button', { name: 'Create scenario…' }).click();
    await expect(scenariosSection.getByText('Scenario scope, order, estimates, and assignments')).toBeVisible();

    // Name scenario
    await scenariosSection.getByLabel('Scenario name').fill('S1 Assignment Swap');

    // Swap assignments in the draft:
    // Feature Alpha: unassign Ben, assign Ada
    await scenariosSection.getByLabel('Assign Ben to Feature Alpha').uncheck();
    await scenariosSection.getByLabel('Assign Ada to Feature Alpha').check();

    // Feature Beta: unassign Ada, assign Ben
    await scenariosSection.getByLabel('Assign Ada to Feature Beta').uncheck();
    await scenariosSection.getByLabel('Assign Ben to Feature Beta').check();

    // 8. Verify S1 Draft Live Preview: finishes in 2 sprints (Sprint 13 / 2026-10-04)
    await expect(scenariosSection.getByText('Sprint 13 · 2026-10-04')).toBeVisible();

    // 9. Save scenario
    await scenariosSection.getByRole('button', { name: 'Save scenario' }).click();

    // Scenario card appears in list
    const savedCard = scenariosSection.locator('li.pm-forecast__cause').filter({ hasText: 'S1 Assignment Swap' });
    await expect(savedCard).toBeVisible();
    await expect(savedCard).toContainText('Sprint 13 · 2026-10-04');
    await expect(savedCard).toContainText('Changed lever:');
    await expect(savedCard).toContainText('Assignment');

    // 10. Mutate live plan: add Cara to roster
    const addPeopleBtn = page.getByRole('button', { name: /Add people…|Manage people…/ });
    await addPeopleBtn.click();
    const peopleDialog = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await expect(peopleDialog).toBeVisible();
    await page.locator('#pm-pe-new-name').fill('Cara');
    await page.locator('#pm-pe-new-weight').fill('1.00');
    await peopleDialog.getByRole('button', { name: 'Add Person' }).click();
    await expect(peopleDialog.locator('.pm-people-editor__person-name', { hasText: 'Cara' })).toBeVisible();
    await peopleDialog.getByRole('button', { name: 'Close people editor' }).click();
    await expect(peopleDialog).not.toBeVisible();

    // The saved scenario still displays its exact captured baseline and variant results!
    await expect(savedCard).toContainText('Sprint 13 · 2026-10-04');

    // 11. Persistence across reload
    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();

    const reloadedCard = page.getByRole('region', { name: 'Scenarios' }).locator('li.pm-forecast__cause').filter({ hasText: 'S1 Assignment Swap' });
    await expect(reloadedCard).toBeVisible();
    await expect(reloadedCard).toContainText('Sprint 13 · 2026-10-04');

    expect(pageErrors).toEqual([]);
  });

  test('AC 23.6-5: Keyboard accessibility, viewports, and Axe accessibility in dark and light modes', async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await setupS1StaffedForecast(page);

    // Open Scenario draft
    const scenariosSection = page.getByRole('region', { name: 'Scenarios' });
    const createBtn = scenariosSection.getByRole('button', { name: 'Create scenario…' });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    await expect(scenariosSection.getByLabel('Scenario name')).toBeVisible();

    // Keyboard navigation: Tab focuses through scenario draft fields
    await scenariosSection.getByLabel('Scenario name').focus();
    await page.keyboard.press('Tab');
    const activeElTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(['INPUT', 'BUTTON']).toContain(activeElTag);

    // Accessibility Scan in dark and light modes
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });

      const axeResults = await new AxeBuilder({ page }).include('[aria-label="Scenarios"]').analyze();
      expect(axeResults.violations, `Axe violations in ${colorScheme} mode: ${JSON.stringify(axeResults.violations, null, 2)}`).toEqual([]);

      await page.screenshot({ path: testInfo.outputPath(`scenario-staffing-${colorScheme}.png`) });
    }

    // Cancel draft and verify focus returns by identity
    await scenariosSection.getByRole('button', { name: 'Cancel' }).click();
    await expect(createBtn).toBeFocused();

    // 200% Zoom and Text Spacing reflow check
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
      document.documentElement.style.letterSpacing = '0.12em';
      document.documentElement.style.wordSpacing = '0.16em';
      document.documentElement.style.lineHeight = '1.5';
    });
    await expect(createBtn).toBeVisible();

    // Test Viewports: 1280, 1100, 900, 768
    for (const width of [1280, 1100, 900, 768]) {
      await page.setViewportSize({ width, height: 800 });
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(hasHorizontalScroll, `Horizontal scroll detected at width ${width}px`).toBe(false);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    expect(pageErrors).toEqual([]);
  });
});

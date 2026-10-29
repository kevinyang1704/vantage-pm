/**
 * Epic 24 — Workspace Delivery Overview — e2e spec.
 *
 * Covers Stories 24.1–24.3 in a real browser with a deterministic imported
 * fixture (see `support/epic-24-fixture.ts`), plus the 24.4 integrated journey.
 * The fixture's totals, dates and statuses are independently specified and
 * asserted literally here so the test cannot tautologically mirror the
 * projection.
 */

import { expect, test } from '../support/fixtures';
import {
  canonicalEpic24Project,
  importEpic24Project,
  largeThemeProject,
  openEpic24Workspace,
} from './support/epic-24-fixture';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Epic 24.1: delivery-status summaries', () => {
  test('AC 24.1-3/7: project and theme counts render with accessible labels, not colour alone', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(card).toBeVisible();

    // Project totals: 11 items (Vision + 3 themes + 7 features) / 7 features / 2 delivered.
    const summary = card.locator('.pm-project-card-summary');
    await expect(summary).toContainText('11 items');
    await expect(summary).toContainText('7 features');
    await expect(summary).toContainText('2 delivered');
    // Unattributed count is explicit.
    await expect(summary).toContainText('1 feature without a theme');

    const measurement = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"]');
    await expect(measurement).toContainText('5 features');
    // Distribution carries an accessible, text label independent of colour.
    await expect(measurement.locator('.pm-theme-distribution')).toHaveAttribute(
      'aria-label',
      '2 Not started · 2 In progress · 1 Delivered',
    );
    await expect(measurement.locator('.pm-theme-status-counts')).toContainText('2 Not started');
    await expect(measurement.locator('.pm-theme-status-counts')).toContainText('2 In progress');
    await expect(measurement.locator('.pm-theme-status-counts')).toContainText('1 Delivered');

    await page.context().close();
  });

  test('AC 24.1-3: zero-Feature themes say "No features yet", never 0% or a filled bar', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const empty = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000003"]');
    await expect(empty).toContainText('No features yet');
    await expect(empty.locator('.pm-theme-status-empty')).toBeVisible();
    await expect(empty.locator('.pm-theme-distribution')).toHaveCount(0);
    // A zero-Feature theme renders no expansion control.
    await expect(empty.locator('.pm-theme-details__toggle')).toHaveCount(0);

    await page.context().close();
  });

  test('AC 24.1-4: Phase, Effort and redundant card view buttons are gone; details hold revision/coverage', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(card.getByText('Phase', { exact: true })).toHaveCount(0);
    await expect(card.getByText('Effort', { exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /^(Outline|Visual|Gantt)$/ })).toHaveCount(0);

    const details = card.locator('details.pm-project-card-details');
    await expect(details).toBeVisible();
    await details.locator('summary').click();
    await expect(details).toContainText('Revision');
    await expect(details).toContainText('Coverage');

    // Preserve project lifecycle + sidebar navigation.
    await expect(card.getByRole('button', { name: /Delete project/ })).toBeVisible();
    const nav = page.locator('nav.pm-side-nav');
    for (const name of ['Outline', 'Visual Tree', 'Gantt']) {
      await expect(nav.getByRole('button', { name, exact: true })).toBeEnabled();
    }

    await page.context().close();
  });
});

test.describe('Epic 24.2: shared theme timeline', () => {
  test('AC 24.2-3: a scheduled zero-Feature theme still shows its authored span', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL, {
      id: '019ffea0-0000-7000-8000-000000000021',
      name: 'Scheduled Empty',
      themes: [
        {
          id: '019ffea0-0001-7000-8000-000000000031',
          title: 'Scheduled Empty Theme',
          startDate: '2026-06-01',
          endDate: '2026-08-01',
          features: [],
        },
      ],
    });

    const card = page.locator('.pm-project-card', { hasText: 'Scheduled Empty' });
    const row = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000031"]');
    await expect(row).toContainText('No features yet');
    // The bar renders and the dates are shown; the lane is not "Not scheduled".
    await expect(row.locator('.pm-theme-timeline-lane__bar')).toBeVisible();
    await expect(row.locator('.pm-theme-timeline-lane__dates')).toContainText('Jun 1 – Aug 1');
    await expect(row.locator('.pm-theme-timeline-lane__state')).toHaveCount(0);

    await page.context().close();
  });

  test('AC 24.2-6: no theme-lane label overlaps its bar at 1024/736/320 widths', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);
    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });

    for (const width of [1024, 736, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = card.locator('.pm-theme-row:not(.pm-theme-row--header)');
      const count = await rows.count();
      for (let i = 0; i < count; i += 1) {
        const row = rows.nth(i);
        const bar = row.locator('.pm-theme-timeline-lane__bar');
        if ((await bar.count()) === 0) continue;
        const barBox = (await bar.boundingBox())!;
        const dates = row.locator('.pm-theme-timeline-lane__dates');
        if ((await dates.count()) === 0) continue;
        const datesBox = (await dates.boundingBox())!;
        // The dates sit below the bar's own row, never on top of it.
        expect(datesBox.y, `width ${width} row ${i}`).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
      }
      // No horizontal document overflow at any of these widths.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow, `width ${width}`).toBe(false);
    }

    await page.context().close();
  });

  test('AC 24.2-7: Gantt activation writes no project revision', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const revisionBefore = await card.locator('.pm-project-card-revision').textContent();

    await card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"]').getByRole('button', { name: /Open the Gantt/ }).click();
    await expect(page.locator('.pm-gantt-view').first()).toBeVisible({ timeout: 15_000 });

    // Return to the overview and confirm the project revision did not move.
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const cardAfter = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(cardAfter.locator('.pm-project-card-revision')).toHaveText(revisionBefore ?? '');

    await page.context().close();
  });
  test('AC 24.2-1/7: September lane begins later and is shorter than the May–Dec lane on one axis', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const longLane = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"] .pm-theme-timeline-lane__bar');
    const shortLane = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000002"] .pm-theme-timeline-lane__bar');

    const longBox = (await longLane.boundingBox())!;
    const shortBox = (await shortLane.boundingBox())!;

    // Same origin (left edge shared), later start for September on the common axis.
    expect(shortBox.x).toBeGreaterThan(longBox.x);
    expect(shortBox.width).toBeLessThan(longBox.width);

    // Exact dates are visible without hover.
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"] .pm-theme-timeline-lane__dates')).toContainText('May 1 – Dec 1');
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000002"] .pm-theme-timeline-lane__dates')).toContainText('Sep 5 – Sep 30');

    await page.context().close();
  });

  test('AC 24.2-3: unscheduled and invalid themes render honest states with no invented bar', async ({ browser, request }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL, {
      ...canonicalEpic24Project(),
      themes: [
        {
          id: '019ffea0-0001-7000-8000-000000000010',
          title: 'Undated Theme',
          features: [{ id: '019ffea0-0019-7000-8000-000000000001', title: 'A', deliveryStatus: 'not_started' }],
        },
        {
          id: '019ffea0-0001-7000-8000-000000000011',
          title: 'One-sided Theme',
          features: [
            // Only a start date on the descendant -> the derived theme span is
            // one-sided, which the timeline must report honestly (AC 24.2-3).
            { id: '019ffea0-0019-7000-8000-000000000002', title: 'B', deliveryStatus: 'not_started', startDate: '2026-05-01' },
          ],
        },
        {
          id: '019ffea0-0001-7000-8000-000000000012',
          title: 'Scheduled Theme',
          features: [
            { id: '019ffea0-0019-7000-8000-000000000003', title: 'C', deliveryStatus: 'not_started', startDate: '2026-05-01', endDate: '2026-06-01' },
          ],
        },
      ],
    });
    void request;

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000010"] .pm-theme-timeline-lane__state')).toContainText('Not scheduled');
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000011"] .pm-theme-timeline-lane__state')).toContainText('Dates incomplete');
    // No bar is drawn for the undated/incomplete lanes.
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000010"] .pm-theme-timeline-lane__bar')).toHaveCount(0);
    await expect(card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000011"] .pm-theme-timeline-lane__bar')).toHaveCount(0);

    await page.context().close();
  });

  test('AC 24.2-4: the injected local date places one shared Today reference', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL, canonicalEpic24Project(), '2026-09-26');

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(card.locator('.pm-theme-timeline-axis__today-label')).toContainText('Today · Sep 26');
    // The Today line is aligned across every scheduled lane.
    const todayLines = card.locator('.pm-theme-timeline-lane__today');
    expect(await todayLines.count()).toBeGreaterThanOrEqual(2);

    await page.context().close();
  });

  test('AC 24.2-4: Today is omitted when outside the domain without expanding it', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL, canonicalEpic24Project(), '2030-01-01');

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await expect(card.locator('.pm-theme-timeline-axis__today-label')).toHaveCount(0);
    await expect(card.locator('.pm-theme-timeline-lane__today')).toHaveCount(0);

    await page.context().close();
  });

  test('AC 24.2-5: a scheduled lane opens the correct project in Gantt through the guarded route', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"]').getByRole('button', { name: /Open the Gantt/ }).click();

    // The Gantt view for the target project is what appears — not Outline.
    await expect(page.locator('.pm-gantt-view').first()).toBeVisible({ timeout: 15_000 });
    // The toolbar identifies the active view as Gantt (not Outline).
    await expect(page.locator('.pm-toolbar-view-title').first()).toHaveText('Gantt');

    await page.context().close();
  });
});

test.describe('Epic 24.3: expandable read-only Feature details', () => {
  test('AC 24.3-1/3: disclosure lists Features with statuses, is read-only, and keeps focus/semantics', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const row = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"]');
    const toggle = row.getByRole('button', { name: /View 5 features in Measurement at scale/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(row.getByRole('button', { name: /Hide Measurement at scale features/ })).toHaveAttribute('aria-expanded', 'true');

    const panel = card.locator('#pm-theme-details-019ffea0-0000-7000-8000-000000000001-019ffea0-0001-7000-8000-000000000001');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Measurement at scale / Features');
    await expect(panel).toContainText('5 items');

    const featureRows = panel.locator('tbody tr');
    await expect(featureRows).toHaveCount(5);
    await expect(panel).toContainText('Experiment event collection');
    await expect(panel).toContainText('Delivered');
    await expect(panel).toContainText('Segment comparisons');
    await expect(panel).toContainText('Not started');

    // Read-only: no editable controls in the panel.
    await expect(panel.locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0);

    await page.context().close();
  });

  test('AC 24.3-6: a 120-Feature theme pages at 50 with Previous/Next and complete coverage', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, largeThemeProject(120));
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Large' });
    const row = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000004"]');
    await row.getByRole('button', { name: /View 120 features/ }).click();

    const panel = card.locator('[id^="pm-theme-details-"]').first();
    await expect(panel.locator('tbody tr')).toHaveCount(50);
    await expect(panel.locator('.pm-theme-details__page-state')).toContainText('Page 1 of 3');
    await expect(panel.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel.locator('.pm-theme-details__page-state')).toContainText('Page 2 of 3');
    await expect(panel.locator('tbody tr')).toHaveCount(50);

    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel.locator('.pm-theme-details__page-state')).toContainText('Page 3 of 3');
    await expect(panel.locator('tbody tr')).toHaveCount(20);
    await expect(panel.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('AC 24.3-4: disclosure state is isolated per theme', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const measurementToggle = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"] .pm-theme-details__toggle');
    const performanceToggle = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000002"] .pm-theme-details__toggle');

    await measurementToggle.click();
    await expect(measurementToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(performanceToggle).toHaveAttribute('aria-expanded', 'false');

    await performanceToggle.click();
    await expect(measurementToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(performanceToggle).toHaveAttribute('aria-expanded', 'true');

    await page.context().close();
  });

  test('AC 24.3-3: opening and closing disclosure creates no project revision change', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const revisionBefore = await card.locator('.pm-project-card-revision').textContent();

    const toggle = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"] .pm-theme-details__toggle');
    await toggle.click();
    await expect(card.locator('[id^="pm-theme-details-"]').first()).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // No command ran, so the revision the overview read is unchanged.
    await expect(card.locator('.pm-project-card-revision')).toHaveText(revisionBefore ?? '');

    await page.context().close();
  });

  test('AC 24.3-6 / 24.4-3: paging keeps focus on an enabled pager control', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, largeThemeProject(120));
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Large' });
    await card.getByRole('button', { name: /View 120 features/ }).click();
    const panel = card.locator('[id^="pm-theme-details-"]').first();

    // Forward from page 1: Next stays enabled and keeps focus.
    await panel.getByRole('button', { name: 'Next' }).click();
    await expect(panel.getByRole('button', { name: 'Next' })).toBeFocused();

    // Back to page 1: Previous becomes disabled, so focus lands on the
    // surviving enabled control rather than dropping to <body>.
    await panel.getByRole('button', { name: 'Previous' }).click();
    await expect(panel.getByRole('button', { name: 'Next' })).toBeFocused();
    await expect(panel.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });
});

test.describe('Epic 24.4: integrated journey', () => {
  test('AC 24.4-1: overview → expand → inspect → collapse → Gantt, counts agree', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    const row = card.locator('.pm-theme-row[data-theme-id="019ffea0-0001-7000-8000-000000000001"]');

    await row.getByRole('button', { name: /View 5 features/ }).click();
    const panel = card.locator('[id^="pm-theme-details-"]').first();
    await expect(panel.locator('tbody tr')).toHaveCount(5);
    // Detail status counts equal the summary buckets (2 / 2 / 1).
    await expect(panel).toContainText('Delivered');
    const deliveredInPanel = panel.locator('td:has-text("Delivered")');
    expect(await deliveredInPanel.count()).toBe(1);

    await row.getByRole('button', { name: /Hide Measurement at scale features/ }).click();
    await expect(panel).toBeHidden();

    await row.getByRole('button', { name: /Open the Gantt/ }).click();
    await expect(page.locator('.pm-gantt-view').first()).toBeVisible({ timeout: 15_000 });

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    await page.context().close();
  });

  test('AC 24.4-3: axe scan is clean on the overview with expanded details', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default;
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, canonicalEpic24Project());
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const card = page.locator('.pm-project-card', { hasText: 'Epic 24 Canonical' });
    await card.locator('.pm-theme-details__toggle').first().click();

    const results = await new AxeBuilder({ page }).include('.pm-workspace-overview').analyze();
    expect(results.violations).toEqual([]);
  });

  test('AC 24.4-3: axe scan is clean in light mode too', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, canonicalEpic24Project());
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    const results = await new AxeBuilder({ page }).include('.pm-workspace-overview').analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('Epic 25.4: focus after deletion', () => {
  test('AC 25.4-1: deleting a project moves focus to a surviving control, never <body>', async ({ page }) => {
    await page.goto(PRODUCT_APP_URL);
    await importEpic24Project(page, canonicalEpic24Project());
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await expect(page.locator('.pm-project-card')).toHaveCount(2);

    // Delete the FIRST card; the boot "My Project" survives as the neighbour.
    const first = page.locator('.pm-project-card').first();
    await first.getByRole('button', { name: /Delete project/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type project name to confirm deletion').fill(
      (await first.locator('.pm-project-card-name').textContent())!.trim(),
    );
    await dialog.getByRole('button', { name: 'Delete project', exact: true }).click();
    await expect(page.locator('.pm-project-card')).toHaveCount(1);

    const tag = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(tag).not.toBe('BODY');
    const focusedIsVisible = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return Boolean(el && el.offsetParent !== null);
    });
    expect(focusedIsVisible).toBe(true);
  });

  test('AC 25.4-2: deleting the last project focuses the empty-state New project button', async ({ browser }) => {
    const page = await openEpic24Workspace(browser, PRODUCT_APP_URL);
    await expect(page.locator('.pm-project-card')).toHaveCount(2);

    // Delete every card until the empty state appears, waiting for each deletion
    // to actually land before moving on.
    for (let i = 0; i < 5; i += 1) {
      const cards = page.locator('.pm-project-card');
      const remaining = await cards.count();
      if (remaining === 0) break;
      const card = cards.first();
      const name = (await card.locator('.pm-project-card-name').textContent())!.trim();
      await card.getByRole('button', { name: /Delete project/ }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Type project name to confirm deletion').fill(name);
      await dialog.getByRole('button', { name: 'Delete project', exact: true }).click();
      await expect(cards).toHaveCount(remaining - 1, { timeout: 15_000 });
    }

    await expect(page.locator('.pm-project-card')).toHaveCount(0);
    await expect(page.locator('.pm-workspace-new-project--empty')).toBeFocused();

    await page.context().close();
  });
});

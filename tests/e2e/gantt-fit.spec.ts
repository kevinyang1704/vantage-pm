/**
 * Gantt Fit control (defect 2026-09-27): Fit only reset the date window, and
 * every scale draws at a fixed zoom, so a multi-year project stayed wider than
 * the canvas. Once the window equalled the project span, further presses did
 * nothing, and none returned a scrolled timeline to its start. Fit now zooms
 * the whole span into the visible canvas width on every press, from any scale.
 */
import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

type PwPage = import('@playwright/test').Page;

async function seedLongProject(page: PwPage): Promise<void> {
  await openFirstProjectOutline(page);
  const input = page.locator('input.pm-outline-row__title-input').first();
  await input.fill('Multi-year initiative');
  await input.blur();

  await page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').first().click();
  const modal = page.locator('.pm-schedule-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#schedule-phrase-input').fill('2025-05-01 to 2027-12-01');
  await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText('2025-05-01');
  await modal.getByRole('button', { name: /Apply/i }).click();
  await expect(modal).not.toBeVisible();

  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('.pm-gantt-view')).toBeVisible();
}

/** The timeline's horizontal overflow and scroll offset. */
async function timelineOverflow(page: PwPage): Promise<{ overflowPx: number; scrollLeft: number }> {
  return page.locator('.pm-gantt-canvas').evaluate((canvas) => ({
    overflowPx: canvas.scrollWidth - canvas.clientWidth,
    scrollLeft: canvas.scrollLeft,
  }));
}

async function expectFitted(page: PwPage, expectedGranularity: string = 'month'): Promise<void> {
  await expect.poll(async () => (await timelineOverflow(page)).overflowPx).toBeLessThanOrEqual(1);
  expect((await timelineOverflow(page)).scrollLeft).toBe(0);
  await expect(page.getByLabel('Timeline Start Date')).toHaveValue('2025-05-01');
  await expect(page.getByLabel('Timeline End Date')).toHaveValue('2027-12-01');
  // Zoomed to fit, preserving the active time horizon granularity button.
  await expect(
    page.getByRole('group', { name: 'Timeline Granularity' }).getByRole('button', { name: expectedGranularity }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Fit', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

test.describe('Gantt Fit', () => {
  test('every press shows the whole project, from any scale and scroll position', async ({ page }) => {
    await seedLongProject(page);
    const fit = page.getByRole('button', { name: 'Fit', exact: true });
    const scale = (name: string) => page.getByRole('group', { name: 'Timeline Granularity' }).getByRole('button', { name });

    // A multi-year span overflows every fixed scale.
    await expect.poll(async () => (await timelineOverflow(page)).overflowPx).toBeGreaterThan(0);

    await fit.click();
    await expectFitted(page, 'month');

    // Pressing again keeps it fitted.
    await fit.click();
    await expectFitted(page, 'month');

    for (const name of ['week', 'month', 'quarter']) {
      await scale(name).click();
      await expect(scale(name)).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await timelineOverflow(page)).overflowPx).toBeGreaterThan(0);
      await page.locator('.pm-gantt-canvas').evaluate((canvas) => {
        canvas.scrollLeft = canvas.scrollWidth;
      });
      await expect.poll(async () => (await timelineOverflow(page)).scrollLeft).toBeGreaterThan(0);

      await fit.click();
      await expectFitted(page, name);
    }

    // After narrowing the window by hand, Fit restores the full span.
    await page.getByLabel('Timeline Start Date').fill('2026-01-01');
    await expect(page.getByLabel('Timeline Start Date')).toHaveValue('2026-01-01');
    await fit.click();
    await expectFitted(page, 'quarter');
  });

  test('stays fitted when the window resizes', async ({ page }) => {
    await seedLongProject(page);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expectFitted(page, 'month');

    await page.setViewportSize({ width: 1600, height: 900 });
    await expectFitted(page, 'month');
    await page.setViewportSize({ width: 1024, height: 768 });
    await expectFitted(page, 'month');
  });
});

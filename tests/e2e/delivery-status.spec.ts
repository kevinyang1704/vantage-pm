/**
 * Outline delivery-status badging — E2E.
 *
 * Each outline row carries a clickable status badge (Not started / In progress /
 * Delivered) in the slot the acceptance-criteria pill used to occupy. Changing
 * the status to In progress (on an unscheduled row) or to Delivered opens the
 * schedule editor so the timeline stays in step.
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

test.describe('Outline delivery-status badges', () => {
  test('row shows a Not started badge by default and the AC pill is gone', async ({ page }) => {
    await openFirstProjectOutline(page);

    const row = page.locator('.pm-outline-row').first();
    await row.locator('input.pm-outline-row__title-input').fill('Metrics Repo');

    const badge = row.locator('.pm-outline-row__status-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/pm-outline-row__status-badge--not-started/);
    await expect(badge).toContainText('Not started');

    // The acceptance-criteria summary pill no longer occupies this slot.
    await expect(row.locator('.pm-outline-row__ac-summary')).toHaveCount(0);
  });

  test('changing status to In progress updates the badge and opens the schedule editor', async ({ page }) => {
    await openFirstProjectOutline(page);

    const row = page.locator('.pm-outline-row').first();
    await row.locator('input.pm-outline-row__title-input').fill('ExpDASH Dashboard');

    await row.locator('.pm-outline-row__status-badge').click();
    const menu = row.locator('.pm-outline-row__status-menu');
    await expect(menu).toBeVisible();

    await menu.locator('button:has-text("In progress")').click();

    await expect(row.locator('.pm-outline-row__status-badge')).toHaveClass(
      /pm-outline-row__status-badge--in-progress/,
    );
    await expect(row.locator('.pm-outline-row__status-badge')).toContainText('In progress');

    // The row had no authored dates → the schedule prompt opens.
    await expect(page.locator('.pm-schedule-modal')).toBeVisible();
    await page.locator('.pm-schedule-modal__close-btn').click();
    await expect(page.locator('.pm-schedule-modal')).toHaveCount(0);
  });

  test('marking a row Delivered opens the schedule editor to review the end date', async ({ page }) => {
    await openFirstProjectOutline(page);

    const row = page.locator('.pm-outline-row').first();
    await row.locator('input.pm-outline-row__title-input').fill('Report builder');

    await row.locator('.pm-outline-row__status-badge').click();
    await row.locator('.pm-outline-row__status-menu button:has-text("Delivered")').click();

    await expect(row.locator('.pm-outline-row__status-badge')).toHaveClass(
      /pm-outline-row__status-badge--delivered/,
    );
    await expect(page.locator('.pm-schedule-modal')).toBeVisible();
  });

  test('undo restores the previous status', async ({ page }) => {
    await openFirstProjectOutline(page);

    const row = page.locator('.pm-outline-row').first();
    await row.locator('input.pm-outline-row__title-input').fill('Undo me');

    await row.locator('.pm-outline-row__status-badge').click();
    await row.locator('.pm-outline-row__status-menu button:has-text("In progress")').click();
    await expect(row.locator('.pm-outline-row__status-badge')).toHaveClass(
      /pm-outline-row__status-badge--in-progress/,
    );

    // Dismiss the schedule prompt, then undo the status change.
    await page.locator('.pm-schedule-modal__close-btn').click();
    await row.locator('input.pm-outline-row__title-input').click();
    await page.keyboard.press('Control+z');

    await expect(row.locator('.pm-outline-row__status-badge')).toHaveClass(
      /pm-outline-row__status-badge--not-started/,
    );
  });
});

/**
 * People editor: strict weight grammar and confirmation focus (Story 22.12,
 * AC 22.12-1..6; review R3, R4).
 *
 * R3: add, edit and preview parsed weights with `parseFloat` + rounding, so an
 * edit of `1.001` saved as 1.00 and exponent notation slipped past the decimal
 * grammar. Every path must use the domain parser, keep the exact draft, name
 * the error on the field, and write nothing.
 *
 * R4: the discard and assigned-person-removal confirmations are siblings of
 * the editor dialog. Opening one neither moved focus nor moved the Tab trap,
 * and the Escape handler read a stale `removalImpactPerson`, so Escape on the
 * removal confirmation could close the whole editor.
 *
 * Assertions check focus identity and persisted facts (project revision,
 * roster after reload), not just dialog text.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function waitForProjectRevisionAdvance(page: Page, action: () => Promise<void>): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

/** One Feature, a configured plan, and Feature Alpha in the priority list. */
async function setupForecast(page: Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByLabel('Outline').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();
  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) await addFirstNode.click();
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature Alpha');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  if (await continueBtn.isVisible()) await continueBtn.click();
  await page.getByLabel('Points per sprint').fill('20');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);
  await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
}

/** The authoritative revision, read from the outline and back to Forecast. */
async function projectRevision(page: Page): Promise<number> {
  await page.locator('.pm-side-nav__item[aria-label="Outline"]').click();
  await expect(page.locator('[role="tree"]')).toBeVisible();
  const revision = Number(await page.locator('[role="tree"]').getAttribute('data-project-revision'));
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await expectForecastReady(page);
  return revision;
}

function peopleTrigger(page: Page) {
  return page.getByRole('button', { name: /Add people…|Manage people…/ });
}
function peopleDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Manage project people and capacity' });
}

async function openPeople(page: Page) {
  await peopleTrigger(page).click();
  await expect(peopleDialog(page)).toBeVisible();
  return peopleDialog(page);
}

async function addPerson(page: Page, name: string, weight = '1.00'): Promise<void> {
  const dialog = peopleDialog(page);
  await dialog.getByLabel('Person Name').fill(name);
  await dialog.getByLabel('Relative Weight').fill(weight);
  await dialog.getByRole('button', { name: 'Add Person' }).click();
  await expect(dialog.locator('.pm-people-editor__person-name', { hasText: name })).toBeVisible();
  await expect(dialog.getByLabel('Person Name')).toHaveValue('');
}

/** Focus is inside the named alertdialog (not the obscured editor behind it). */
async function expectFocusInside(page: Page, dialogName: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (name) => document.activeElement?.closest('[role="alertdialog"]')?.getAttribute('aria-label') ?? null,
        dialogName,
      ),
    )
    .toBe(dialogName);
}

async function expectTabStaysInside(page: Page, dialogName: string, presses = 6): Promise<void> {
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
    await expectFocusInside(page, dialogName);
    await page.keyboard.press('Tab');
    await expectFocusInside(page, dialogName);
  }
}

// ── R3: strict weight grammar ───────────────────────────────────────────

test.describe('AC 22.12-1: invalid weights are rejected without a write or a rounded substitute', () => {
  const INVALID = ['1.001', '1e2', '0', '-1', 'Infinity', '1.5x', '99999999999999999'];

  test('add: every invalid weight keeps the exact draft, names the error on the field, and writes nothing', async ({ page }) => {
    await setupForecast(page);
    const before = await projectRevision(page);
    const dialog = await openPeople(page);
    const weight = dialog.getByLabel('Relative Weight');

    for (const value of INVALID) {
      await dialog.getByLabel('Person Name').fill('Robin');
      await weight.fill(value);
      // No redistribution preview is built from an invalid weight.
      await expect(dialog.getByLabel('Redistribution preview')).toHaveCount(0);
      // Keyboard submit (Enter) and pointer submit take the same path.
      await weight.press('Enter');
      await expect(weight, `draft kept for ${value}`).toHaveValue(value);
      await expect(weight).toHaveAttribute('aria-invalid', 'true');
      const errorId = await weight.getAttribute('aria-describedby');
      expect(errorId, `error associated for ${value}`).toBeTruthy();
      await expect(dialog.locator(`[id="${errorId}"]`)).toContainText(/weight/i);
      await dialog.getByRole('button', { name: 'Add Person' }).click();
      await expect(weight).toHaveValue(value);
      await expect(dialog.locator('.pm-people-editor__person-name')).toHaveCount(0);
    }

    // Discard the draft and prove the repository never moved.
    await dialog.getByRole('button', { name: 'Close people editor' }).click();
    await page.getByRole('alertdialog', { name: 'Discard unsaved changes' }).getByRole('button', { name: 'Discard' }).click();
    expect(await projectRevision(page)).toBe(before);
  });

  test('edit: 1.001 is rejected, not saved as 1.00', async ({ page }) => {
    await setupForecast(page);
    const dialog = await openPeople(page);
    await addPerson(page, 'Ada', '1.00');
    await dialog.getByRole('button', { name: 'Close people editor' }).click();
    const before = await projectRevision(page);

    await openPeople(page);
    await dialog.getByRole('button', { name: 'Edit Ada' }).click();
    const weight = dialog.getByLabel('Edit weight for Ada');
    for (const value of ['1.001', '2e1', '0.00']) {
      await weight.fill(value);
      await dialog.getByRole('button', { name: 'Save changes for Ada' }).click();
      await expect(weight).toHaveValue(value);
      await expect(weight).toHaveAttribute('aria-invalid', 'true');
      const errorId = await weight.getAttribute('aria-describedby');
      await expect(dialog.locator(`[id="${errorId}"]`)).toContainText(/weight/i);
    }
    await dialog.getByRole('button', { name: 'Cancel editing Ada' }).click();
    await expect(dialog.locator('.pm-people-editor__person-weight')).toHaveText('1.00');
    await dialog.getByRole('button', { name: 'Close people editor' }).click();
    expect(await projectRevision(page)).toBe(before);
  });
});

test('AC 22.12-2: approved two-decimal weights save exactly through add, edit and preview', async ({ page }) => {
  await setupForecast(page);
  const dialog = await openPeople(page);
  await addPerson(page, 'Ada', '1.00');

  // Preview uses the same exact hundredths as the save.
  await dialog.getByLabel('Person Name').fill('Tiny');
  await dialog.getByLabel('Relative Weight').fill('0.01');
  const preview = dialog.getByLabel('Redistribution preview');
  await expect(preview).toContainText('2000/101');
  await dialog.getByRole('button', { name: 'Add Person' }).click();
  await expect(dialog.locator('.pm-people-editor__person-weight').nth(1)).toHaveText('0.01');
  await expect(dialog.locator('.pm-people-editor__share-exact').nth(1)).toContainText('20/101');

  await dialog.getByRole('button', { name: 'Edit Tiny' }).click();
  await dialog.getByLabel('Edit weight for Tiny').fill('2.5');
  await dialog.getByRole('button', { name: 'Save changes for Tiny' }).click();
  await expect(dialog.locator('.pm-people-editor__person-weight').nth(1)).toHaveText('2.50');
  await expect(dialog.locator('.pm-people-editor__share-exact').nth(1)).toContainText('100/7');
  // C never changes with headcount or weights.
  await expect(dialog).toContainText('Total team capacity: 20 points/sprint');
});

// ── R4: confirmation focus ownership ────────────────────────────────────

test('AC 22.12-3: the discard confirmation owns focus and returns it correctly', async ({ page }) => {
  await setupForecast(page);
  const trigger = peopleTrigger(page);
  const dialog = await openPeople(page);
  const name = dialog.getByLabel('Person Name');
  await name.fill('Robin');

  for (const request of ['Escape', 'Done', 'Close people editor'] as const) {
    if (request === 'Escape') {
      await name.focus();
      await page.keyboard.press('Escape');
    } else {
      await dialog.getByRole('button', { name: request }).click();
    }
    const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes' });
    await expect(confirm).toBeVisible();
    await expectFocusInside(page, 'Discard unsaved changes');
    await expectTabStaysInside(page, 'Discard unsaved changes');

    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Robin');
  }

  // Keyboard-only confirm: Escape opens it, Enter on Discard closes the editor.
  await page.keyboard.press('Escape');
  await expectFocusInside(page, 'Discard unsaved changes');
  await page.getByRole('alertdialog', { name: 'Discard unsaved changes' }).getByRole('button', { name: 'Discard' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // Reopening starts clean: no stale confirmation, no retained draft.
  await openPeople(page);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(dialog.getByLabel('Person Name')).toHaveValue('');
});

test('AC 22.12-4 / AC 22.12-5: assigned-person removal is keyboard operable, atomic and undoable', async ({ page }) => {
  await setupForecast(page);
  const dialog = await openPeople(page);
  await addPerson(page, 'Ada', '1.50');
  await dialog.getByRole('button', { name: 'Close people editor' }).click();

  await page.locator('select.pm-forecast__mode-select').selectOption('staffed-capacity-v1');
  await page.getByRole('button', { name: 'Assign people to Feature Alpha (required)' }).click();
  const assign = page.getByRole('dialog', { name: 'Assign People' });
  await assign.getByRole('checkbox', { name: 'Assign Ada' }).check();
  await assign.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('button', { name: /Assigned to Feature Alpha: Ada/ })).toBeVisible();
  const before = await projectRevision(page);

  // Escape dismisses ONLY the confirmation, with no mutation.
  await openPeople(page);
  const remove = dialog.getByRole('button', { name: 'Remove Ada' });
  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Confirm person removal' });
  await expect(confirm).toContainText('Remove Ada from roster?');
  await expect(confirm).toContainText('Feature Alpha');
  await expectFocusInside(page, 'Confirm person removal');
  await expectTabStaysInside(page, 'Confirm person removal');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(remove).toBeFocused();

  // Cancel does the same.
  await page.keyboard.press('Enter');
  await expectFocusInside(page, 'Confirm person removal');
  await confirm.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(remove).toBeFocused();
  await expect(dialog.locator('.pm-people-editor__person-name', { hasText: 'Ada' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close people editor' }).click();
  expect(await projectRevision(page)).toBe(before);

  // Confirmed removal by keyboard: one command clears person and assignment.
  await openPeople(page);
  await remove.focus();
  await page.keyboard.press('Enter');
  await confirm.getByRole('button', { name: 'Remove person' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.pm-people-editor__person-name')).toHaveCount(0);
  await expect(page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).resolves.toBe(true);
  await dialog.getByRole('button', { name: 'Close people editor' }).click();
  await expect(page.getByRole('button', { name: 'Assign people to Feature Alpha (required)' })).toBeVisible();
  // Feature Alpha stays in scope.
  await expect(page.getByRole('button', { name: 'Remove Feature Alpha from the priority list' })).toBeVisible();
  expect(await projectRevision(page)).toBe(before + 1);

  // One undo restores identity, weight and assignment.
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /Assigned to Feature Alpha: Ada/ })).toBeVisible();
  await openPeople(page);
  await expect(dialog.locator('.pm-people-editor__person-weight')).toHaveText('1.50');
});

test('AC 22.12-6: confirmations and weight errors stay visible and contained across themes, zoom and spacing', async ({ page }) => {
  await setupForecast(page);
  const dialog = await openPeople(page);

  // The UI sizes text in px, so browser zoom is what scales it: 200% zoom of a
  // 1280x800 window is a 640x400 CSS viewport. Plus a narrow phone layout.
  const viewports = [
    { label: '100% desktop', width: 1280, height: 800 },
    { label: '200% zoom', width: 640, height: 400 },
    { label: 'narrow', width: 390, height: 844 },
  ];
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const { label, width, height } of viewports) {
      await page.setViewportSize({ width, height });
      // WCAG 1.4.12 text spacing.
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.id = 'pm-text-spacing';
        style.textContent =
          '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
        document.head.appendChild(style);
      });

      const weight = dialog.getByLabel('Relative Weight');
      await dialog.getByLabel('Person Name').fill('Robin');
      await weight.fill('1.001');
      await dialog.getByRole('button', { name: 'Add Person' }).click();
      const errorId = await weight.getAttribute('aria-describedby');
      const error = dialog.locator(`[id="${errorId}"]`);
      await error.scrollIntoViewIfNeeded();
      await expect(error).toBeInViewport();

      await page.keyboard.press('Escape');
      const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes' });
      for (const button of ['Discard', 'Keep editing']) {
        await expect(confirm.getByRole('button', { name: button })).toBeInViewport();
      }
      await expectFocusInside(page, 'Discard unsaved changes');
      // Every rule, color-contrast included: the enabled primary "Discard"
      // button is the case that exposed white-on-#4179FF (3.89:1) before
      // filled accents moved to `--pm-accent-strong`.
      const axe = await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze();
      expect(axe.violations, `${colorScheme} ${label}`).toEqual([]);
      await confirm.getByRole('button', { name: 'Keep editing' }).click();

      await page.evaluate(() => document.getElementById('pm-text-spacing')?.remove());
    }
  }
});

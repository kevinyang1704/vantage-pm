/**
 * Scenario explanations and safe dismissal (Story 23.8, AC 23.8-1..7;
 * review R8, R11, D1, D2). Real editor, real worker, real repository.
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';

function outcomes(scope: Locator) {
  const rows = scope.locator('.pm-forecast__scenario-outcomes dd');
  return { baseline: rows.nth(0), variant: rows.nth(1) };
}

async function openDraft(page: Page) {
  const scenarios = page.getByRole('region', { name: 'Scenarios' });
  const trigger = scenarios.getByRole('button', { name: 'Create scenario…' });
  await trigger.click();
  const draft = scenarios.getByRole('group', { name: 'Scenario draft' });
  const preview = draft.getByLabel('Draft scenario preview');
  await expect(outcomes(preview).baseline).toHaveText('Sprint 17 · 2026-11-29');
  return { scenarios, trigger, draft, preview };
}

async function swap(draft: Locator): Promise<void> {
  await draft.getByLabel('Assign Ben to Feature Alpha').uncheck();
  await draft.getByLabel('Assign Ada to Feature Alpha').check();
  await draft.getByLabel('Assign Ada to Feature Beta').uncheck();
  await draft.getByLabel('Assign Ben to Feature Beta').check();
}

test.describe('Story 23.8 — explanations and safe dismissal', () => {
  test('AC 23.8-1: S1 shows captured baseline and variant together, levers, and exact item timing — draft and saved', async ({ page }, testInfo) => {
    await setupS1StaffedForecast(page);
    const { scenarios, draft, preview } = await openDraft(page);
    await draft.getByLabel('Scenario name').fill('S1 swap');
    await swap(draft);
    await expect(outcomes(preview).variant).toHaveText('Sprint 13 · 2026-10-04');
    await expect(outcomes(preview).baseline).toHaveText('Sprint 17 · 2026-11-29');
    await expect(preview).toContainText('Assignment — Feature Alpha: Ben → Ada');
    await expect(preview).toContainText('Assignment — Feature Beta: Ada → Ben');

    // Exact timing by keyboard.
    // The name flips between "Show" and "Hide" with the state.
    const draftTiming = preview.getByRole('button', { name: /exact item timing for the draft$/ });
    await draftTiming.focus();
    await page.keyboard.press('Enter');
    await expect(draftTiming).toHaveAttribute('aria-expanded', 'true');
    const list = preview.getByRole('list', { name: 'Exact item timing for the draft' });
    const alpha = list.getByRole('listitem').filter({ hasText: 'Feature Alpha' });
    await expect(alpha).toContainText(
      'Baseline: Ben · rate 5 points/sprint · duration 6 sprints · sprint offset 0 → 6 · Sprints 12–17 (2026-09-07 → 2026-11-29)',
    );
    await expect(alpha).toContainText(
      'Variant: Ada · rate 15 points/sprint · duration 2 sprints · sprint offset 0 → 2 · Sprints 12–13 (2026-09-07 → 2026-10-04)',
    );
    const beta = list.getByRole('listitem').filter({ hasText: 'Feature Beta' });
    await expect(beta).toContainText('Baseline: Ada · rate 15 points/sprint · duration 2/3 sprints');
    await expect(beta).toContainText('Variant: Ben · rate 5 points/sprint · duration 2 sprints');
    await list.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('s1-draft-comparison-timing.png') });

    await draft.getByRole('button', { name: 'Save scenario' }).click();
    const card = scenarios.locator('li.pm-forecast__cause').filter({ hasText: 'S1 swap' });
    await expect(outcomes(card).baseline).toHaveText('Sprint 17 · 2026-11-29');
    await expect(outcomes(card).variant).toHaveText('Sprint 13 · 2026-10-04');
    await card.getByRole('button', { name: 'Show exact item timing for S1 swap' }).click();
    await expect(card.getByRole('list', { name: 'Exact item timing for S1 swap' })).toContainText(
      'Variant: Ada · rate 15 points/sprint · duration 2 sprints',
    );
  });

  test('AC 23.8-2/-3: a concurrent assignment names the person and items with a repair; no variant timeline; inputs kept', async ({ page }, testInfo) => {
    await setupS1StaffedForecast(page);
    const { scenarios, draft, preview } = await openDraft(page);
    await draft.getByLabel('Scenario name').fill('Ada on both');
    await draft.getByLabel('Assign Ada to Feature Alpha').check(); // Ada now on Alpha and Beta, one group

    const conflict = preview.getByRole('alert').filter({ hasText: 'The variant has no forecast' });
    await expect(conflict).toContainText(
      'Ada is assigned to Feature Alpha and Feature Beta, which run at the same time in one parallel group. Assign Ada to only one of them, or remove one item from the scenario.',
    );
    await expect(outcomes(preview).variant).toHaveText('unavailable — invalid inputs');
    await expect(outcomes(preview).baseline).toHaveText('Sprint 17 · 2026-11-29');
    await expect(preview).not.toContainText('CONCURRENT_ASSIGNMENT_CONFLICT');
    await preview.getByRole('button', { name: 'Show exact item timing for the draft' }).click();
    await expect(preview.getByRole('list', { name: 'Exact item timing for the draft' }).getByRole('listitem').first()).toContainText(
      'Variant: no timing — the variant has no forecast',
    );
    await expect(draft.getByLabel('Assign Ada to Feature Alpha')).toBeChecked();
    await conflict.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('concurrent-conflict-explained.png') });

    // Repair by following the guidance: the explanation clears and a forecast returns.
    await draft.getByLabel('Assign Ada to Feature Beta').uncheck();
    await draft.getByLabel('Assign Ben to Feature Beta').check();
    await draft.getByLabel('Assign Ben to Feature Alpha').uncheck();
    await expect(conflict).toHaveCount(0);
    await expect(outcomes(preview).variant).toHaveText('Sprint 13 · 2026-10-04');
    await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(0);
  });

  test('AC 23.8-4/-6: history stays readable across a live level switch and uses captured people after live changes', async ({ page }, testInfo) => {
    await setupS1StaffedForecast(page);
    const { scenarios, draft } = await openDraft(page);
    await draft.getByLabel('Scenario name').fill('Kept history');
    await swap(draft);
    await draft.getByRole('button', { name: 'Save scenario' }).click();
    const card = scenarios.locator('li.pm-forecast__cause').filter({ hasText: 'Kept history' });
    await expect(outcomes(card).variant).toHaveText('Sprint 13 · 2026-10-04');

    // Live: Ben leaves the roster.
    await page.getByRole('button', { name: /Add people…|Manage people…/ }).click();
    const people = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await people.getByRole('button', { name: 'Remove Ben' }).click();
    await page.getByRole('alertdialog', { name: 'Confirm person removal' }).getByRole('button', { name: 'Remove person' }).click();
    await people.getByRole('button', { name: 'Close people editor' }).click();

    // Live: the plan moves to Theme level.
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    const levelDialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
    await levelDialog.getByRole('radio', { name: 'Themes' }).check();
    await levelDialog.getByRole('button', { name: 'Switch level' }).click();
    await expect(page.getByText('▚ Level: Themes')).toBeVisible();

    const history = page.getByRole('region', { name: 'Scenarios' }).locator('li.pm-forecast__cause').filter({ hasText: 'Kept history' });
    await expect(history).toContainText('Captured at Feature level; the live plan is now at Theme level.');
    await expect(outcomes(history).baseline).toHaveText('Sprint 17 · 2026-11-29');
    await expect(outcomes(history).variant).toHaveText('Sprint 13 · 2026-10-04');
    // Captured people are used although Ben is no longer on the live roster.
    // Story 23.8 AC 23.8-6 (review L9): saved scenarios store no item titles,
    // so items are named by stable identifier with an unavailable-title label,
    // never by the current live title.
    await expect(history).toContainText('Ben → Ada');
    await expect(history).toContainText('title unavailable');
    await history.getByRole('button', { name: 'Show exact item timing for Kept history' }).click();
    await expect(history.getByRole('list', { name: 'Exact item timing for Kept history' })).toContainText('Variant: Ben · rate 5 points/sprint');
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('cross-level-history.png') });
  });

  test('AC 23.8-5: a dirty draft asks before discarding; Keep editing restores focus; a clean draft just closes', async ({ page }, testInfo) => {
    await setupS1StaffedForecast(page);
    let { scenarios, trigger, draft } = await openDraft(page);

    // Clean: Cancel closes without asking.
    await draft.getByRole('button', { name: 'Cancel' }).click();
    await expect(draft).toHaveCount(0);
    await expect(trigger).toBeFocused();

    ({ scenarios, trigger, draft } = await openDraft(page));
    const name = draft.getByLabel('Scenario name');
    await name.fill('Unsaved idea');
    await draft.getByLabel('Ben weight override').fill('2');
    const confirm = scenarios.getByRole('alertdialog', { name: 'Discard this scenario draft?' });

    // Cancel on a dirty draft asks; focus goes to the least destructive action.
    const cancel = draft.getByRole('button', { name: 'Cancel' });
    await cancel.focus();
    await page.keyboard.press('Enter');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('dirty-discard-confirmation.png') });
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(cancel).toBeFocused();
    await expect(name).toHaveValue('Unsaved idea');

    // Escape in a field asks too; Escape again keeps editing, back in that field.
    await name.focus();
    await page.keyboard.press('Escape');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(name).toBeFocused();
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('2');

    // Discard is deliberate, returns focus to the trigger, and the next draft starts clean.
    await page.keyboard.press('Escape');
    await confirm.getByRole('button', { name: 'Discard draft' }).click();
    await expect(draft).toHaveCount(0);
    await expect(trigger).toBeFocused();
    ({ draft } = await openDraft(page));
    await expect(draft.getByLabel('Scenario name')).toHaveValue('');
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('');
  });

  test('AC 23.8-7: details, errors and the confirmation stay usable at 200% zoom with text spacing, in both themes', async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await setupS1StaffedForecast(page);
    const { scenarios, draft, preview } = await openDraft(page);
    await draft.getByLabel('Scenario name').fill('Constrained');
    await draft.getByLabel('Assign Ada to Feature Alpha').check(); // named conflict on screen
    await expect(preview.getByRole('alert')).toContainText('Ada is assigned to Feature Alpha and Feature Beta');
    await preview.getByRole('button', { name: 'Show exact item timing for the draft' }).click();

    await page.addStyleTag({
      content:
        '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
    });
    for (const size of [
      { width: 640, height: 400 }, // 1280x800 at 200%
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const colorScheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme });
        const overflow = await scenarios.evaluate((el) => {
          const wide = Array.from(el.querySelectorAll<HTMLElement>("*")).filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible');
          return { region: el.scrollWidth - el.clientWidth, scrollers: wide.map((n) => n.className) };
        });
        expect(overflow.region, `horizontal overflow at ${size.width}px ${colorScheme}`).toBeLessThanOrEqual(1);
        expect(overflow.scrollers).toEqual([]);
        const axe = await new AxeBuilder({ page }).include('[aria-label="Scenarios"]').analyze();
        expect(axe.violations, `${size.width}px ${colorScheme}: ${JSON.stringify(axe.violations, null, 2)}`).toEqual([]);
        await scenarios.screenshot({ path: testInfo.outputPath(`scenario-explanations-${size.width}-${colorScheme}.png`) });
      }
    }

    // Keyboard reaches the confirmation and its actions stay in view.
    await draft.getByLabel('Scenario name').focus();
    await page.keyboard.press('Escape');
    const confirm = scenarios.getByRole('alertdialog', { name: 'Discard this scenario draft?' });
    const keep = confirm.getByRole('button', { name: 'Keep editing' });
    await expect(keep).toBeFocused();
    await expect(keep).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(confirm.getByRole('button', { name: 'Discard draft' })).toBeFocused();
    await expect(confirm.getByRole('button', { name: 'Discard draft' })).toBeInViewport();
    const axe = await new AxeBuilder({ page }).include('[aria-label="Scenarios"]').analyze();
    expect(axe.violations).toEqual([]);
    await scenarios.screenshot({ path: testInfo.outputPath('scenario-discard-confirmation-390.png') });
    expect(consoleErrors).toEqual([]);
  });
});

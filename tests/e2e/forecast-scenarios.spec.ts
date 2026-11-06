/**
 * Explanation & scenario certification — browser acceptance (Story 20.7,
 * AC 20.7-1..20.7-6; FR-14..FR-17).
 *
 * End-to-end: inline points → configure → select → block → save a historical
 * scenario → mutate the live plan → confirm the saved scenario still compares
 * against its own baseline → reload and confirm it survives. Uses merged
 * Playwright fixtures, deterministic seeded graphs, event-based
 * synchronisation, and no fixed sleeps.
 *
 * Passing this spec closes Epic 20's functional surface. Release
 * certification stays governed by the existing Gate A / Gate B contract —
 * this introduces no stronger durability claim.
 */

import { expect, test } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function openForecastWithTwoFeatures(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  const outline = page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  // The new project becomes current asynchronously; wait for it before opening a view.
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText('New Project', { timeout: 30_000 });
  // Open the Outline only once the new (empty) project is the selection;
  // clicking sooner can open the boot project, which already has a node.
  await expect(
    page.locator('.pm-side-nav__project[aria-current="true"]').filter({ hasText: 'New Project' }),
  ).toHaveCount(1);
  await expect(outline).toBeVisible();
  await outline.click();
  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  await expect(addFirstNode).toBeVisible();
  await addFirstNode.click();
  await expect(page.getByRole('button', { name: 'NO TYPE' }).first()).toBeVisible();
  // Type the seeded first node as a Feature; add a sibling and type it too.
  const noType = page.getByRole('button', { name: 'NO TYPE' }).first();
  if (await noType.isVisible()) {
    await noType.click();
    await page.getByRole('button', { name: 'Feature', exact: true }).click();
  }

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  // First-run entry is the Planning Level step (AC 21.5-2): Continue opens
  // plan configuration.
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('1');
  await page.getByLabel('First date').fill('2026-09-07');
  await page.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(page);

  // Add from the Backlog (AC 21.5-1). The ✕ remove control renders only once
  // the membership command is acknowledged, so waiting on it guarantees the
  // follow-up estimate command reads the post-membership revision — web-first
  // synchronization (AC 21.5-4), never a fixed sleep.
  await page.getByRole('button', { name: /Add .* to the priority list/ }).first().click();
  await expect(page.getByRole('button', { name: /Remove .* from the priority list/ }).first()).toBeVisible();
  const pointsInput = page.getByRole('spinbutton', { name: /Points for .*/ }).first();
  await pointsInput.fill('20');
  await pointsInput.blur();
  await expect(page.getByText('capacity-derived')).toBeVisible();
}

test('AC 20.7 — save a scenario, mutate the live plan, and the scenario still compares against its own baseline', async ({ page }) => {
  await openForecastWithTwoFeatures(page);

  // Save a capacity scenario from the current acknowledged forecast.
  await page.getByRole('button', { name: 'Create scenario…' }).click();
  await page.getByLabel('Scenario name').fill('Add capacity');
  await page.getByLabel('Scenario capacity override').fill('20');
  await page.getByRole('button', { name: 'Save scenario' }).click();

  const scenarioRow = page.getByRole('region', { name: 'Scenarios' });
  await expect(scenarioRow.getByText('Add capacity')).toBeVisible();
  await expect(scenarioRow.getByText(/Based on revision/)).toBeVisible();
  await expect(scenarioRow.getByText(/Capacity\/sprint \+10/)).toBeVisible();

  // Mutate the live plan — raise the Feature estimate. The saved scenario's
  // deltas must still reference its own captured baseline, not the new value.
  await page.getByRole('spinbutton', { name: /Points for .*/ }).first().fill('50');
  await expect(page.getByText('capacity-derived')).toBeVisible();
  await expect(scenarioRow.getByText(/Based on revision/)).toBeVisible();
  await expect(scenarioRow.getByText(/Capacity\/sprint \+10/)).toBeVisible();

  // Reload — the scenario survives.
  await page.reload();
  await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Scenarios' }).getByText('Add capacity')).toBeVisible();
});

test('AC 20.7 — the "What changed" section names the actual input, never invents a scope change for an estimate', async ({ page }) => {
  await openForecastWithTwoFeatures(page);
  const points = page.getByRole('spinbutton', { name: /Points for .*/ }).first();
  const completionValue = page.locator('.pm-forecast__completion-value');

  // Two settled changes so a retained comparison baseline exists.
  await points.fill('22');
  await expect(completionValue).toHaveText('Sprint 3');
  await points.fill('25');
  await expect(completionValue).toHaveText('Sprint 3');

  const whatChanged = page.getByRole('region', { name: 'What changed' });
  await expect(whatChanged.getByText(/Estimate increase/)).toBeVisible();
  await expect(whatChanged.getByText(/Scope added/)).toHaveCount(0);
});

test('AC 20.5-1/6 and 20.7-6 — all scenario levers remain keyboard-accessible and perceivable under constrained presentation', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await openForecastWithTwoFeatures(page);
  await page.setViewportSize({ width: 720, height: 800 });
  const scenarios = page.getByRole('region', { name: 'Scenarios' });
  const trigger = scenarios.getByRole('button', { name: 'Create scenario…' });

  /**
   * Every scenario lever is present, named, and reachable in order with Tab
   * alone. The lever group is found by its accessible name (the fieldset's
   * legend): Epic 23 renamed it "Scenario scope, order, estimates" and adds
   * ", and assignments" on a staffed plan, so the name is matched by intent,
   * not by one exact wording. One Feature is in scope, so "Move earlier" and
   * "Move later" are present but correctly disabled and out of the tab order.
   */
  async function expectLeversKeyboardReachable(): Promise<void> {
    const levers = scenarios.getByRole('group', { name: /^Scenario scope, order, estimates/ });
    await expect(levers).toBeVisible();
    await expect(scenarios.getByRole('checkbox')).toHaveCount(1);
    const include = levers.getByRole('checkbox', { name: /^Include .+ in scenario$/ });
    const earlier = levers.getByRole('button', { name: /^Move .+ earlier$/ });
    const later = levers.getByRole('button', { name: /^Move .+ later$/ });
    // Story 23.7: overrides are text fields with a numeric keyboard, so an
    // entry like "1.5x" stays visible with an error instead of being blanked.
    const points = levers.getByRole('textbox', { name: /^Point override for / });
    for (const lever of [include, earlier, later, points]) await expect(lever).toBeVisible();
    await expect(earlier).toBeDisabled();
    await expect(later).toBeDisabled();
    // The exact-timing disclosure exists once the draft preview has settled.
    await expect(scenarios.getByRole('button', { name: /exact item timing for the draft$/ })).toBeVisible();

    const tabOrder = [
      scenarios.getByRole('textbox', { name: 'Scenario name' }),
      include,
      points,
      scenarios.getByRole('textbox', { name: 'Scenario capacity override' }),
      // Story 23.8: the preview's exact-timing disclosure sits before the actions.
      scenarios.getByRole('button', { name: /exact item timing for the draft$/ }),
      scenarios.getByRole('button', { name: 'Save scenario' }),
      scenarios.getByRole('button', { name: 'Cancel' }),
    ];
    await tabOrder[0].focus();
    await expect(tabOrder[0]).toBeFocused();
    for (const next of tabOrder.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
      await expect(next).toBeInViewport();
    }
  }

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expectLeversKeyboardReachable();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.screenshot({ path: 'test-results/epic-20-scenario-editor.png', fullPage: true });

  await scenarios.getByLabel('Scenario capacity override').fill('-1');
  await scenarios.getByRole('button', { name: 'Save scenario' }).click();
  // The draft preview can raise its own alert for the same bad value; this is
  // the validation message the lever must announce.
  await expect(scenarios.getByRole('alert').filter({ hasText: 'whole non-negative' })).toBeVisible();

  // Story 23.8 (review D2): Cancel on a dirty draft (capacity -1) asks first.
  // Discarding is explicit, and focus still returns to the trigger.
  await scenarios.getByRole('button', { name: 'Cancel' }).click();
  await scenarios
    .getByRole('alertdialog', { name: 'Discard this scenario draft?' })
    .getByRole('button', { name: 'Discard draft' })
    .click();
  await expect(trigger).toBeFocused();

  // Constrained presentation: WCAG 1.4.12 text spacing plus 200% zoom. The UI
  // sizes text in px, so zoom is emulated as the CSS viewport 200% zoom gives
  // a 720x800 window (360x400), not by scaling the root font size.
  await page.addStyleTag({
    content:
      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
  await page.setViewportSize({ width: 360, height: 400 });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expectLeversKeyboardReachable();
  await scenarios.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();

  const results = await new AxeBuilder({ page }).include('[aria-label="Scenarios"]').analyze();
  expect(results.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test.describe('Epic 20 locale and time-zone determinism', () => {
  test.use({ locale: 'fr-FR', timezoneId: 'Pacific/Auckland' });

  test('canonical completion remains ISO and scenario evaluation remains available', async ({ page }) => {
    await openForecastWithTwoFeatures(page);
    await expect(page.locator('.pm-forecast__completion-date')).toHaveText('2026-10-04');
    await page.getByRole('button', { name: 'Create scenario…' }).click();
    await page.getByLabel('Scenario name').fill('Alternate environment');
    await page.getByLabel('Scenario capacity override').fill('20');
    await page.getByRole('button', { name: 'Save scenario' }).click();
    await expect(page.getByRole('region', { name: 'Scenarios' }).getByText('Alternate environment')).toBeVisible();
  });
});

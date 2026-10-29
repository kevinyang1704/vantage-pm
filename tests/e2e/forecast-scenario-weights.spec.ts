/**
 * Scenario weight overrides use the live People grammar and range
 * (Story 23.9, AC 23.9-1 and AC 23.9-3; review R9).
 *
 * Before the repair the draft took raw hundredths in a `type="number"` field
 * capped at 100000, so 1000.01 (100001 units, a valid live weight) could not
 * be entered and `1.001` was silently truncated or rejected with a generic
 * message. The editor now parses each override with the canonical staffing
 * parser, keeps the exact draft in the field with a field-specific error, and
 * saves and reloads 1000.01 exactly.
 */

import { expect, test } from '../support/fixtures';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';
import { createForecastConfiguration } from '../../src/domain/forecast/forecast-plan.entity';
import { evaluateScenario } from '../../src/domain/forecast/scenario-evaluate';

const ALPHA = '019ffe00-0000-7000-8000-00000000000a';
const BETA = '019ffe00-0000-7000-8000-00000000000b';
const ADA = '019ffe00-0000-7000-8000-0000000000a1';
const BEN = '019ffe00-0000-7000-8000-0000000000b1';

/** The exact S1 completion with Ben at `benUnits`, from the production evaluator. */
async function s1CompletionWithBen(benUnits: number): Promise<string> {
  const fact = (effortPoints: number) => ({ effortPoints, nodeType: 'Feature', projectId: ADA, ancestorIds: [] });
  const r = await evaluateScenario(
    {
      projectId: ADA,
      baselineRevision: 1,
      policyVersion: 'staffed-capacity-v1',
      planningLevel: 'Feature',
      orderedScope: [ALPHA, BETA],
      configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 12, startDate: '2026-09-07' }),
      parallelGroups: [{ featureIds: [ALPHA, BETA] }],
      blockedFeatureIds: [],
      factMap: { [ALPHA]: fact(30), [BETA]: fact(10) },
      roster: [
        { id: ADA, name: 'Ada', weightUnits: 300 },
        { id: BEN, name: 'Ben', weightUnits: 100 },
      ],
      assignments: { [ALPHA]: [BEN], [BETA]: [ADA] },
    },
    { weightOverrides: { [BEN]: benUnits } },
  );
  if (!r.ok || !r.variantResult.arithmetic) throw new Error('S1 oracle did not evaluate');
  return `Sprint ${r.variantResult.arithmetic.completionSprint} · ${r.variantResult.arithmetic.completionDate}`;
}

test.describe('Story 23.9 — scenario weight overrides share the live weight range', () => {
  test('AC 23.9-3: malformed overrides keep the draft, show a field error and never preview or save', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await setupS1StaffedForecast(page);

    const scenarios = page.getByRole('region', { name: 'Scenarios' });
    await scenarios.getByRole('button', { name: 'Create scenario…' }).click();
    await scenarios.getByLabel('Scenario name').fill('Rejected weights');
    const ben = scenarios.getByLabel('Ben weight override');
    await expect(ben).toHaveAttribute('placeholder', '1.00');

    for (const draft of ['1.001', '1e2', '0', '-1', '1.5x', 'Infinity']) {
      await ben.fill(draft);
      await ben.blur();
      await expect(ben).toHaveValue(draft);
      await expect(ben).toHaveAttribute('aria-invalid', 'true');
      const errorId = await ben.getAttribute('aria-describedby');
      await expect(page.locator(`[id="${errorId}"]`)).toContainText('Ben: Enter a weight greater than 0');
      await expect(scenarios.getByText('Preview paused until every weight override is valid.')).toBeVisible();

      // Save refuses, keeps the exact draft and returns focus to the field.
      await scenarios.getByRole('button', { name: 'Save scenario' }).click();
      await expect(ben).toBeFocused();
      await expect(ben).toHaveValue(draft);
      await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(0);
    }
    expect(pageErrors).toEqual([]);
  });

  test('AC 23.9-1: 1000.01 is entered, previewed, saved and reloaded exactly', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await setupS1StaffedForecast(page);
    const expected = await s1CompletionWithBen(100001);
    // The heavy weight moves the forecast: Ada's share of C shrinks to 300/100301.
    expect(expected).not.toBe('Sprint 17 · 2026-11-29');

    const scenarios = page.getByRole('region', { name: 'Scenarios' });
    await scenarios.getByRole('button', { name: 'Create scenario…' }).click();
    await scenarios.getByLabel('Scenario name').fill('Ben at 1000.01');
    const ben = scenarios.getByLabel('Ben weight override');
    await ben.fill('1000.01');
    await ben.blur();
    await expect(ben).not.toHaveAttribute('aria-invalid', 'true');

    const preview = scenarios.getByLabel('Draft scenario preview');
    await expect(preview).toContainText(expected);
    await scenarios.getByRole('button', { name: 'Save scenario' }).click();

    const card = scenarios.locator('li.pm-forecast__cause').filter({ hasText: 'Ben at 1000.01' });
    await expect(card).toContainText(expected);
    await expect(card).toContainText('Relative weight — Ben: 1.00 → 1000.01');

    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    const reloaded = page
      .getByRole('region', { name: 'Scenarios' })
      .locator('li.pm-forecast__cause')
      .filter({ hasText: 'Ben at 1000.01' });
    await expect(reloaded).toContainText(expected);
    await expect(reloaded).toContainText('Relative weight — Ben: 1.00 → 1000.01');
    expect(pageErrors).toEqual([]);
  });
});

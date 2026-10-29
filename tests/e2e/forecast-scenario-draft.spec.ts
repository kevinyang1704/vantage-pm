/**
 * Scenario drafts keep their captured baseline and evaluate in the worker
 * (Story 23.7, AC 23.7-1..7; review R2, R7). Real editor, real analysis
 * worker, real repository.
 *
 * Reply control: an init script wraps the page's `Worker` so the test can
 * hold `ScenarioEvaluationResult` messages from the real analysis worker and
 * deliver them in any order. Holding them also proves the editor does not
 * compute previews on the UI thread: nothing changes until a reply lands.
 */

import { expect, test } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';

declare global {
  interface Window {
    __scenarioReplies: {
      hold: boolean;
      held: Array<{ token: string; deliver: () => void }>;
      workers: Worker[];
    };
  }
}

/** Installed before the app boots: hold/release control over scenario replies. */
function installReplyControl(): void {
  const RealWorker = window.Worker;
  const state: Window['__scenarioReplies'] = { hold: false, held: [], workers: [] };
  window.__scenarioReplies = state;
  class ControlledWorker extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      state.workers.push(this);
    }
    get onmessage(): ((this: Worker, ev: MessageEvent) => unknown) | null {
      return super.onmessage;
    }
    set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
      super.onmessage =
        handler === null
          ? null
          : (event: MessageEvent) => {
              const data = event.data as { type?: string; requestToken?: string } | null;
              if (state.hold && data?.type === 'ScenarioEvaluationResult') {
                state.held.push({ token: String(data.requestToken), deliver: () => handler.call(this, event) });
                return;
              }
              handler.call(this, event);
            };
    }
  }
  window.Worker = ControlledWorker as unknown as typeof Worker;
}

async function holdReplies(page: Page, hold: boolean): Promise<void> {
  await page.evaluate((h) => {
    window.__scenarioReplies.hold = h;
  }, hold);
}

async function heldCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__scenarioReplies.held.length);
}

/**
 * Deliver held replies in the given order of arrival (indexes into the
 * currently held list), then drop the delivered ones from the list.
 */
async function releaseInOrder(page: Page, order: readonly number[]): Promise<void> {
  await page.evaluate((indexes) => {
    const held = window.__scenarioReplies.held;
    const delivered = indexes.map((i) => held[i]);
    for (const entry of delivered) entry.deliver();
    window.__scenarioReplies.held = held.filter((entry) => !delivered.includes(entry));
  }, [...order]);
}

/** The preview is current (not "Previous preview") and its variant row reads `text`. */
async function expectCurrentVariant(preview: import('@playwright/test').Locator, text: string): Promise<void> {
  await expect(preview.locator('.pm-forecast__scenario-outcomes dd').nth(1)).toHaveText(text);
  await expect(preview.locator('strong').first()).toHaveText('Preview:');
}

async function openDraft(page: Page) {
  const scenarios = page.getByRole('region', { name: 'Scenarios' });
  await scenarios.getByRole('button', { name: 'Create scenario…' }).click();
  const draft = scenarios.getByRole('group', { name: 'Scenario draft' });
  await expect(draft).toBeVisible();
  const preview = draft.getByLabel('Draft scenario preview');
  // The captured baseline's own preview settles first.
  await expect(preview).toContainText('Sprint 17 · 2026-11-29');
  return { scenarios, draft, preview };
}

async function swapS1Assignments(draft: import('@playwright/test').Locator): Promise<void> {
  await draft.getByLabel('Assign Ben to Feature Alpha').uncheck();
  await draft.getByLabel('Assign Ada to Feature Alpha').check();
  await draft.getByLabel('Assign Ada to Feature Beta').uncheck();
  await draft.getByLabel('Assign Ben to Feature Beta').check();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installReplyControl);
});

test.describe('Story 23.7 — captured drafts', () => {
  test('AC 23.7-1/-2/-3/-7: a live edit cannot reach the draft; save is refused as stale; refresh discloses, previews, then saves on request', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await setupS1StaffedForecast(page);
    const { scenarios, draft, preview } = await openDraft(page);
    const capturedRevision = await draft.locator('.pm-forecast__scenario-draft-context').textContent();
    expect(capturedRevision).toMatch(/captured at revision \d+/);

    await draft.getByLabel('Scenario name').fill('Swap after live edit');
    await swapS1Assignments(draft);
    await expectCurrentVariant(preview, 'Sprint 13 · 2026-10-04');

    // Live edit while the draft is open: Feature Alpha 30 -> 60 points.
    const livePoints = page.getByRole('spinbutton', { name: /Points for Feature Alpha/ });
    await livePoints.fill('60');
    await livePoints.blur();
    await expect(page.locator('.pm-forecast__completion-value')).not.toHaveText('Sprint 17');

    // The draft still shows its capture and its own preview.
    await expect(draft.locator('.pm-forecast__scenario-draft-context')).toHaveText(capturedRevision!);
    await expectCurrentVariant(preview, 'Sprint 13 · 2026-10-04');
    await expect(draft.getByLabel('Point override for Feature Alpha')).toHaveAttribute('placeholder', '30');

    // Save uses the captured expectations and is refused; every edit is kept.
    await draft.getByRole('button', { name: 'Save scenario' }).click();
    await expect(draft.getByRole('alert').filter({ hasText: 'Not saved: the live plan changed' })).toBeVisible();
    await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(0);
    await expect(draft.getByLabel('Scenario name')).toHaveValue('Swap after live edit');
    await expect(draft.getByLabel('Assign Ada to Feature Alpha')).toBeChecked();
    await expect(draft.getByLabel('Assign Ben to Feature Beta')).toBeChecked();

    // Refresh captures once, discloses the changed assumption, re-previews, and does not save.
    await draft.getByRole('button', { name: 'Refresh baseline' }).click();
    const notice = draft.getByRole('status').filter({ hasText: 'Baseline refreshed from revision' });
    await expect(notice).toContainText('Estimate — Feature Alpha: 30 → 60 points');
    await expect(draft.getByLabel('Point override for Feature Alpha')).toHaveAttribute('placeholder', '60');
    // Alpha 60 on Ada (15/sprint) = 4 sprints; Beta 10 on Ben (5/sprint) = 2: Sprint 15.
    await expectCurrentVariant(preview, 'Sprint 15 · 2026-11-01');
    await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(0);
    await expect(draft.getByLabel('Assign Ada to Feature Alpha')).toBeChecked();

    // An explicit save after the refreshed preview succeeds and reproduces it.
    await draft.getByRole('button', { name: 'Save scenario' }).click();
    const card = scenarios.locator('li.pm-forecast__cause').filter({ hasText: 'Swap after live edit' });
    await expect(card).toContainText('Sprint 15 · 2026-11-01');
    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Scenarios' }).locator('li.pm-forecast__cause').filter({ hasText: 'Swap after live edit' }),
    ).toContainText('Sprint 15 · 2026-11-01');
    // The scenario changed no live fact: Alpha is still assigned Ben live.
    await expect(page.getByRole('button', { name: 'Assigned to Feature Alpha: Ben. Click to edit.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assigned to Feature Beta: Ada. Click to edit.' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('AC 23.7-3: after refresh, an override for a removed person is a named error resolved only by an explicit action', async ({ page }) => {
    await setupS1StaffedForecast(page);
    const { scenarios, draft, preview } = await openDraft(page);
    await draft.getByLabel('Scenario name').fill('Ben heavier');
    await draft.getByLabel('Ben weight override').fill('2');
    await expectCurrentVariant(preview, 'Sprint 15 · 2026-11-01');

    // Live: remove Ben from the roster (his Alpha assignment goes with him).
    await page.getByRole('button', { name: /Add people…|Manage people…/ }).click();
    const people = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await people.getByRole('button', { name: 'Remove Ben' }).click();
    await page.getByRole('alertdialog', { name: 'Confirm person removal' }).getByRole('button', { name: 'Remove person' }).click();
    await expect(people.locator('.pm-people-editor__person-name', { hasText: 'Ben' })).toHaveCount(0);
    await people.getByRole('button', { name: 'Close people editor' }).click();

    // The draft still edits its capture: Ben is there, with the entered override.
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('2');
    await draft.getByRole('button', { name: 'Save scenario' }).click();
    // Focus moves to the notices region that now holds the conflict message.
    const notices = draft.locator('.pm-forecast__scenario-alerts');
    await expect(notices.getByRole('alert')).toContainText('Not saved: the live plan changed');
    await expect(notices).toBeFocused();

    await draft.getByRole('button', { name: 'Refresh baseline' }).click();
    const notice = draft.getByRole('status').filter({ hasText: 'Baseline refreshed' });
    await expect(notice).toContainText('Roster: removed Ben');
    await expect(notice).toContainText('Assignment — Feature Alpha: Ben → unassigned');
    const error = draft.getByRole('alert').filter({ hasText: 'Weight override for Ben: this person is no longer on the roster' });
    await expect(error).toBeVisible();
    await expect(preview).toContainText('Preview paused until the flagged fields are corrected.');
    await expect(draft.getByLabel('Ben weight override')).toHaveCount(0);
    await expect(draft.getByLabel('Scenario name')).toHaveValue('Ben heavier');

    // Save stays refused until the user removes the override themselves.
    await draft.getByRole('button', { name: 'Save scenario' }).click();
    await expect(scenarios.locator('li.pm-forecast__cause')).toHaveCount(0);
    await error.getByRole('button', { name: 'Remove override' }).click();
    await expect(error).toHaveCount(0);
    // Alpha is now unassigned live and in the capture: the preview says so.
    await expect(preview).toContainText('unavailable — inputs incomplete');
  });

  test('AC 23.7-4/-5: assignment edits — replies released newest-first and oldest-last show only the latest draft', async ({ page }) => {
    await setupS1StaffedForecast(page);
    const { draft, preview } = await openDraft(page);

    await holdReplies(page, true);
    await swapS1Assignments(draft); // four edits -> four worker requests
    await expect.poll(() => heldCount(page)).toBe(4);
    // Nothing has been evaluated on the UI thread: the old preview is labelled as earlier.
    await expect(preview).toContainText('Previous preview');
    await expect(preview).toContainText('Updating for your latest edits');
    await expect(preview).toContainText('Sprint 17 · 2026-11-29');

    await releaseInOrder(page, [3, 2, 1, 0]);
    await expect(preview).not.toContainText('Updating for your latest edits');
    await expectCurrentVariant(preview, 'Sprint 13 · 2026-10-04');
    await expect(preview).not.toContainText('Previous preview');
  });

  test('AC 23.7-4/-5: weight edits — a stale reply delivered after the newest never replaces it', async ({ page }) => {
    await setupS1StaffedForecast(page);
    const { draft, preview } = await openDraft(page);
    const ben = draft.getByLabel('Ben weight override');

    await holdReplies(page, true);
    await ben.fill('3'); // Ben 3.00: equal weights, Alpha 30 on Ben at 10/sprint -> 3 sprints: Sprint 14
    await expect.poll(() => heldCount(page)).toBe(1);
    await ben.fill('0.5'); // Ben 0.50: Alpha on Ben at 20*50/350 -> 10.5 -> 11 sprints: Sprint 22
    await expect.poll(() => heldCount(page)).toBe(2);

    await releaseInOrder(page, [1]);
    await expectCurrentVariant(preview, 'Sprint 22 · 2027-02-07');
    await releaseInOrder(page, [0]); // the older "3" reply, now the only one held
    await expectCurrentVariant(preview, 'Sprint 22 · 2027-02-07');
    await expect(preview).not.toContainText('Sprint 14');
  });

  test('AC 23.7-4/-5 (L5): a parent rerender during a pending captured preview neither rebases nor strands it', async ({ page }) => {
    await setupS1StaffedForecast(page);
    const { draft, preview } = await openDraft(page);

    // Hold the reply for the captured-weight variant.
    await holdReplies(page, true);
    await draft.getByLabel('Ben weight override').fill('2');
    await expect.poll(() => heldCount(page)).toBe(1);
    await expect(preview).toContainText('Previous preview');
    await expect(preview).toContainText('Updating for your latest edits');

    // A live edit rerenders the parent (Main recreates its inline callbacks).
    // The pending captured preview must not be cancelled by that rerender.
    const livePoints = page.getByRole('spinbutton', { name: /Points for Feature Alpha/ });
    await livePoints.fill('60');
    await livePoints.blur();

    // Releasing the held reply still resolves into the captured-weight variant
    // (Ben 2.00, captured Alpha 30): Sprint 15, not the stale Sprint 17.
    await releaseInOrder(page, [0]);
    await expect(preview).not.toContainText('Updating for your latest edits');
    await expect(preview).not.toContainText('Previous preview');
    await expectCurrentVariant(preview, 'Sprint 15 · 2026-11-01');
    // The live edit did not reach the draft.
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('2');
  });

  test('AC 23.7-6: closing, switching project and a worker failure cannot repopulate or strand the editor', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await setupS1StaffedForecast(page);
    let { scenarios, draft, preview } = await openDraft(page);

    // Close while a reply is in flight; the late reply cannot reopen or fill anything.
    await holdReplies(page, true);
    await draft.getByLabel('Ben weight override').fill('2');
    await expect.poll(() => heldCount(page)).toBe(1);
    // The draft is dirty, so Cancel asks first (Story 23.8); discarding is explicit.
    await draft.getByRole('button', { name: 'Cancel' }).click();
    await scenarios.getByRole('alertdialog', { name: 'Discard this scenario draft?' }).getByRole('button', { name: 'Discard draft' }).click();
    await releaseInOrder(page, [0]);
    await expect(scenarios.getByRole('group', { name: 'Scenario draft' })).toHaveCount(0);
    await expect(scenarios.getByRole('button', { name: 'Create scenario…' })).toBeFocused();

    // A new draft starts clean — no preview carried over from the closed one.
    await holdReplies(page, false);
    ({ scenarios, draft, preview } = await openDraft(page));
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('');

    // Worker failure: the draft is kept with a recoverable retry.
    await holdReplies(page, true);
    await draft.getByLabel('Ben weight override').fill('2');
    await expect.poll(() => heldCount(page)).toBe(1);
    await page.evaluate(() => {
      for (const w of window.__scenarioReplies.workers) w.onerror?.(new ErrorEvent('error'));
      window.__scenarioReplies.held = [];
    });
    await expect(preview.getByRole('alert')).toContainText('The preview could not be calculated. Your draft is kept.');
    await expect(draft.getByLabel('Ben weight override')).toHaveValue('2');
    await holdReplies(page, false);
    await preview.getByRole('button', { name: 'Retry preview' }).click();
    // Ben 2.00: Alpha 30 on Ben at 20*200/500 = 8/sprint -> 3.75 -> 4 sprints: Sprint 15.
    await expectCurrentVariant(preview, 'Sprint 15 · 2026-11-01');

    // Project switch while a reply is in flight: the draft is discarded, nothing lands elsewhere.
    await holdReplies(page, true);
    await draft.getByLabel('Ben weight override').fill('4');
    await expect.poll(() => heldCount(page)).toBe(1);
    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
    await page.locator('.pm-side-nav__item[aria-label="Outline"]').waitFor({ state: 'visible' });
    await releaseInOrder(page, [0]);
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Scenarios' }).getByRole('group', { name: 'Scenario draft' })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

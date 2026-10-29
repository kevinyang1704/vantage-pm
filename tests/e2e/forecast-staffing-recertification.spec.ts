/**
 * Complete M3 and S1 staffing journeys through the real UI (Story 23.10,
 * AC 23.10-1; review R12). Chrome and Edge.
 *
 * M3 (staffing-model.md): C=20, Ada 1.00 and Ben 1.00; one bucket with
 * Alpha=10/Ada and Beta=30/Ben. A finishes at 1, B at 3; Q=2, T=3, I=20;
 * completion Sprint 14 · 2026-10-18. The journey covers missing inputs,
 * a named concurrency conflict and its repair, the exact result, a level
 * switch and undo, a live estimate edit and undo, reload, and transfer.
 *
 * S1: the 23.6 authoring journey plus the missing transfer segment. The saved
 * scenario keeps its exact six-versus-two sprint comparison (Sprint 17 ·
 * 2026-11-29 against Sprint 13 · 2026-10-04) after live edits and after the
 * project is exported and imported into a fresh browser profile.
 *
 * Transfer: Export uses the real side-nav action (download strategy). The
 * browser build has no Import button (it is wired in the native composition
 * only), so the fresh profile imports the downloaded bytes through the same
 * application path the native button calls: `importProject` (full
 * validation) then `batchImportPortable` (one atomic import). Native backup /
 * restore and adapter parity are covered by the Rust and adapter tests cited
 * in the 23.10 evidence report.
 */

import { expect, test } from '../support/fixtures';
import type { Browser, Page } from '@playwright/test';
import { setupProjectWithTwoFeatures, setupS1StaffedForecast } from '../support/helpers/forecast-s1';
import { revealForecastMath } from '../support/helpers/forecast';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

function completion(page: Page) {
  return { value: page.locator('.pm-forecast__completion-value'), date: page.locator('.pm-forecast__completion-date') };
}

function arithmetic(page: Page, label: string) {
  return page.locator('.pm-forecast__arithmetic-row').filter({ hasText: label }).locator('.pm-forecast__arithmetic-value');
}

async function expectM3(page: Page): Promise<void> {
  await revealForecastMath(page);
  await expect(completion(page).value).toHaveText('Sprint 14');
  await expect(completion(page).date).toHaveText('2026-10-18');
  await expect(arithmetic(page, 'Work/capacity lower bound')).toHaveText('2 sprints');
  await expect(arithmetic(page, 'Elapsed staffing duration')).toHaveText('3 sprints');
  await expect(arithmetic(page, 'Idle capacity')).toHaveText('20 pts equivalent');
  await expect(page.getByRole('button', { name: 'Assigned to Feature Alpha: Ada. Click to edit.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assigned to Feature Beta: Ben. Click to edit.' })).toBeVisible();
}

async function assign(page: Page, item: string, person: string, required = true): Promise<void> {
  await page.getByRole('button', { name: required ? `Assign people to ${item} (required)` : new RegExp(`Assigned to ${item}`) }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign People' });
  await dialog.getByRole('checkbox', { name: `Assign ${person}` }).check();
  await dialog.getByRole('button', { name: 'Apply' }).click();
}

/** Export the open project through the real side-nav action; returns the file text. */
async function exportOpenProject(page: Page): Promise<string> {
  await page.evaluate(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-project-trigger').click();
  const download = await downloadPromise;
  let raw = '';
  for await (const chunk of await download.createReadStream()) raw += chunk.toString('utf8');
  return raw;
}

/** A fresh browser profile that imports `raw` through the application import path. */
async function importIntoFreshProfile(browser: Browser, raw: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Keep the injected evaluation date deterministic (Story 26.6, AC 26.6-4):
  // a fresh context does not inherit the fixture's init script.
  await page.addInitScript(() => {
    (globalThis as { __PMAPP_TODAY__?: string }).__PMAPP_TODAY__ = '2020-01-01';
  });
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  const outcome = await page.evaluate(async (fileText) => {
    const importerUrl = '/src/application/portable-file/import-project.ts';
    const repositoryUrl = '/src/adapters/persistence/repository-worker.client.ts';
    const importer = (await import(/* @vite-ignore */ importerUrl)) as {
      importProject: (raw: string, exists: (id: string) => boolean) => { ok: true; candidate: unknown } | { ok: false; error: unknown };
    };
    const repository = (await import(/* @vite-ignore */ repositoryUrl)) as {
      batchImportPortable: (candidate: unknown) => Promise<{ ok: boolean }>;
    };
    const imported = importer.importProject(fileText, () => false);
    if (!imported.ok) return { ok: false, detail: JSON.stringify(imported.error) };
    const result = await repository.batchImportPortable(imported.candidate);
    return { ok: result.ok, detail: JSON.stringify(result) };
  }, raw);
  expect(outcome.ok, outcome.detail).toBe(true);
  await page.reload();
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).first().click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  return page;
}

test.describe('Story 23.10 — complete staffing journeys', () => {
  test('AC 23.10-1: M3 — missing inputs, named conflict and repair, exact result, level switch/undo, live edit, reload, transfer', async ({ page, browser }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await setupProjectWithTwoFeatures(page);
    const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
    if (await continueBtn.isVisible()) await continueBtn.click();
    await page.getByLabel('Points per sprint').fill('20');
    await page.getByLabel('Sprint length (days)').fill('14');
    await page.getByLabel('Start sprint').fill('12');
    await page.getByLabel('First date').fill('2026-09-07');
    await page.getByRole('button', { name: 'Save' }).click();
    await revealForecastMath(page);
    await page.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
    await page.getByRole('button', { name: 'Add Feature Beta to the priority list' }).click();
    // Commit each estimate before typing the next: a commit re-renders the list.
    for (const [item, points, known] of [['Feature Alpha', '10', '10'], ['Feature Beta', '30', '40']] as const) {
      const field = page.getByRole('spinbutton', { name: `Points for ${item}`, exact: true });
      await field.fill(points);
      await field.blur();
      await expect(arithmetic(page, 'Known points')).toHaveText(known);
    }
    await page.getByRole('button', { name: 'Group parallel work…' }).click();
    await page.getByLabel('Select Feature Alpha for parallel group').check();
    await page.getByLabel('Select Feature Beta for parallel group').check();
    await page.getByRole('button', { name: 'Create parallel group', exact: true }).click();

    await page.getByRole('button', { name: /Add people…|Manage people…/ }).click();
    const people = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    for (const name of ['Ada', 'Ben']) {
      await page.locator('#pm-pe-new-name').fill(name);
      await page.locator('#pm-pe-new-weight').fill('1.00');
      await people.getByRole('button', { name: 'Add Person' }).click();
      await expect(people.locator('.pm-people-editor__person-name', { hasText: name })).toBeVisible();
    }
    await people.getByRole('button', { name: 'Close people editor' }).click();
    await page.locator('select.pm-forecast__mode-select').selectOption('staffed-capacity-v1');

    // Missing inputs (M7): named items, a resolving action, no current date.
    await expect(completion(page).value).toHaveText('Assignment needed');
    await expect(page.getByText('Feature Alpha, Feature Beta have work but nobody assigned.')).toBeVisible();
    await expect(completion(page).date).toHaveCount(0);
    await page.getByRole('button', { name: 'Assign people to Feature Alpha', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assign People' });
    await dialog.getByRole('checkbox', { name: 'Assign Ada' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();
    await expect(completion(page).value).toHaveText('Assignment needed');
    await expect(page.getByText('Feature Beta has work but nobody assigned.')).toBeVisible();

    // Named conflict (M5), then repair.
    await page.getByRole('button', { name: 'Assign people to Feature Beta (required)' }).click();
    await dialog.getByRole('checkbox', { name: 'Assign Ada' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      /Ada would be assigned to both Feature (Alpha|Beta) and Feature (Alpha|Beta) in one parallel bucket\. Change the assignments or keep the items sequential\./,
    );
    await dialog.getByRole('checkbox', { name: 'Assign Ada' }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Assign Ben' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();
    await expectM3(page);

    // Level switch clears assignments; undo restores the exact M3 state.
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    const levelDialog = page.getByRole('dialog', { name: 'Confirm planning level change' });
    await levelDialog.getByRole('radio', { name: 'Themes' }).check();
    await levelDialog.getByRole('button', { name: 'Switch level' }).click();
    await expect(page.getByText('▚ Level: Themes')).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(page.getByText('▚ Level: Features')).toBeVisible();
    await expectM3(page);

    // Live edit: Beta 30 -> 40 moves the finish to T=4 (Sprint 15); undo restores M3.
    const beta = page.getByRole('spinbutton', { name: 'Points for Feature Beta', exact: true });
    await beta.fill('40');
    await beta.blur();
    await expect(completion(page).value).toHaveText('Sprint 15');
    await expect(completion(page).date).toHaveText('2026-11-01');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expectM3(page);

    // Reload.
    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await expect(page.locator('select.pm-forecast__mode-select')).toHaveValue('staffed-capacity-v1');
    await expectM3(page);

    // Transfer into a fresh profile.
    const raw = await exportOpenProject(page);
    const moved = await importIntoFreshProfile(browser, raw);
    try {
      await expect(moved.locator('select.pm-forecast__mode-select')).toHaveValue('staffed-capacity-v1');
      await expectM3(moved);
    } finally {
      await moved.context().close();
    }
    expect(pageErrors).toEqual([]);
  });

  test('AC 23.10-1: S1 — saved comparison keeps exact six-versus-two sprints after live edits, reload and transfer', async ({ page, browser }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await setupS1StaffedForecast(page);

    const scenarios = page.getByRole('region', { name: 'Scenarios' });
    await scenarios.getByRole('button', { name: 'Create scenario…' }).click();
    const draft = scenarios.getByRole('group', { name: 'Scenario draft' });
    await draft.getByLabel('Scenario name').fill('S1 swap');
    await draft.getByLabel('Assign Ben to Feature Alpha').uncheck();
    await draft.getByLabel('Assign Ada to Feature Alpha').check();
    await draft.getByLabel('Assign Ada to Feature Beta').uncheck();
    await draft.getByLabel('Assign Ben to Feature Beta').check();
    await draft.getByRole('button', { name: 'Save scenario' }).click();

    const expectS1 = async (p: Page) => {
      const card = p.getByRole('region', { name: 'Scenarios' }).locator('li.pm-forecast__cause').filter({ hasText: 'S1 swap' });
      const rows = card.locator('.pm-forecast__scenario-outcomes dd');
      await expect(rows.nth(0)).toHaveText('Sprint 17 · 2026-11-29');
      await expect(rows.nth(1)).toHaveText('Sprint 13 · 2026-10-04');
      await card.getByRole('button', { name: /exact item timing for S1 swap$/ }).click();
      const timing = card.getByRole('list', { name: 'Exact item timing for S1 swap' });
      await expect(timing).toContainText('Baseline: Ben · rate 5 points/sprint · duration 6 sprints');
      await expect(timing).toContainText('Variant: Ada · rate 15 points/sprint · duration 2 sprints');
    };
    await expectS1(page);

    // Live edits: Cara joins, Alpha grows. The captured comparison does not move.
    await page.getByRole('button', { name: /Add people…|Manage people…/ }).click();
    const people = page.getByRole('dialog', { name: 'Manage project people and capacity' });
    await page.locator('#pm-pe-new-name').fill('Cara');
    await page.locator('#pm-pe-new-weight').fill('1.00');
    await people.getByRole('button', { name: 'Add Person' }).click();
    await people.getByRole('button', { name: 'Close people editor' }).click();
    const alpha = page.getByRole('spinbutton', { name: 'Points for Feature Alpha', exact: true });
    await alpha.fill('60');
    await alpha.blur();
    // Live: Ada 3, Ben 1, Cara 1 share C=20 (12/4/4); Alpha 60 on Ben takes 15 sprints.
    await expect(completion(page).value).toHaveText('Sprint 26');
    await expect(completion(page).date).toHaveText('2027-04-04');
    const liveValue = 'Sprint 26';
    const liveDate = '2027-04-04';
    await page.reload();
    await page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' }).last().click();
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await expectS1(page);

    const moved = await importIntoFreshProfile(browser, await exportOpenProject(page));
    try {
      await expectS1(moved);
      // The live plan travelled too, with its own current result.
      await expect(completion(moved).value).toHaveText(liveValue!);
      await expect(completion(moved).date).toHaveText(liveDate!);
    } finally {
      await moved.context().close();
    }
    expect(pageErrors).toEqual([]);
  });
});

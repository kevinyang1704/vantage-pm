/**
 * Story 23.11 AC 23.11-2 — the Forecast Priority list renders a bounded
 * window of rows, independent of the scope size, and the interactions that
 * depend on row identity keep working.
 *
 * The 5,000-item benchmark fixture (23.10) is imported through the app's own
 * portable path, exactly like the responsiveness harness. The assertions are
 * structural (DOM counts, focus identity, keyboard navigation), not
 * time-based, so they are stable on any machine; the timing budget lives in
 * the Lab `forecast-responsiveness` job.
 */

import { expect, test } from '../support/fixtures';
import type { Page } from '@playwright/test';
import { revealForecastMath } from '../support/helpers/forecast';
import {
  benchmarkProjectName,
  buildBenchmarkPortableFile,
} from '../perf/support/staffing-benchmark';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * Reply control for the analysis worker (Story 23.7 technique): hold
 * `ForecastResult` messages so a test can delay the result-driven re-render
 * deterministically — no fixed sleeps.
 */
declare global {
  interface Window {
    __forecastReplies: {
      hold: boolean;
      held: Array<{ token: string; deliver: () => void }>;
    };
  }
}

function installReplyControl(): void {
  const RealWorker = window.Worker;
  const state: Window['__forecastReplies'] = { hold: false, held: [] };
  window.__forecastReplies = state;
  class ControlledWorker extends RealWorker {
    get onmessage(): ((this: Worker, ev: MessageEvent) => unknown) | null {
      return super.onmessage;
    }
    set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
      super.onmessage =
        handler === null
          ? null
          : (event: MessageEvent) => {
              const data = event.data as { type?: string; requestToken?: string } | null;
              if (state.hold && data?.type === 'ForecastResult') {
                state.held.push({ token: String(data.requestToken), deliver: () => handler.call(this, event) });
                return;
              }
              handler.call(this, event);
            };
    }
  }
  window.Worker = ControlledWorker as unknown as typeof Worker;
}

async function setHold(page: Page, hold: boolean): Promise<void> {
  await page.evaluate((h) => { window.__forecastReplies.hold = h; }, hold);
}

async function heldCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__forecastReplies.held.length);
}

async function releaseAllHeld(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held = window.__forecastReplies.held;
    for (const entry of held) entry.deliver();
    window.__forecastReplies.held = [];
  });
}

/** Imports a portable file through the app's running repository worker. */
async function seed(page: Page, raw: string): Promise<void> {
  const result = await page.evaluate(async (fileText) => {
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
    const outcome = await repository.batchImportPortable(imported.candidate);
    return { ok: Boolean(outcome.ok), detail: JSON.stringify(outcome) };
  }, raw);
  expect(result.ok, result.detail).toBe(true);
}

/** Loads the benchmark project into the Forecast destination. */
async function openBenchmarkForecast(page: Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 60_000 });
  await seed(page, buildBenchmarkPortableFile('shared', 0));
  await page.reload();
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 60_000 });
  await page
    .locator('.pm-side-nav__project')
    .filter({ hasText: benchmarkProjectName('shared', 0) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
  await expect(page.locator('.pm-forecast__completion-value')).toBeVisible({ timeout: 120_000 });
}

test.describe('Story 23.11 — bounded Priority list at scale', () => {
  test.setTimeout(10 * 60_000);

  test('AC 23.11-2: the DOM holds a bounded window of slots for 5,000 items', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBenchmarkForecast(page);

    // The scope holds 5,000 selected items (the coverage table is folded
    // behind "Show the math" since Story 26.1).
    await revealForecastMath(page);
    const selected = page.locator('.pm-forecast__arithmetic-row').filter({ hasText: 'Selected' }).locator('.pm-forecast__arithmetic-value');
    await expect(selected).toHaveText('5000');

    // ...but only a bounded window of slots is mounted, plus overscan.
    const slotCount = await page.locator('.pm-forecast__slot').count();
    expect(slotCount).toBeGreaterThan(0);
    expect(slotCount).toBeLessThan(200);

    // The inner container still reserves the full scroll height, so the
    // scrollbar reflects the whole list.
    const innerHeight = await page.locator('.pm-forecast__rows-inner').evaluate((el) => el.getBoundingClientRect().height);
    expect(innerHeight).toBeGreaterThan(5000 * 40);

    // Total DOM size is far below the unbounded 80k+ elements the recert
    // report measured (Story 23.11 O1): the virtualized list and Backlog keep
    // the whole app in the low thousands.
    const totalElements = await page.evaluate(() => document.getElementsByTagName('*').length);
    expect(totalElements).toBeLessThan(3000);

    // The Backlog holds 0 unranked items once everything is ranked (all 5,000
    // are in the plan), so its bounded window is trivially small; the point
    // is that neither pane renders per-scope rows.
    const backlogRows = await page.locator('.pm-forecast__backlog-row').count();
    expect(backlogRows).toBeLessThan(200);
  });

  test('AC 23.11-2: windowing advances on scroll and keeps drag/keyboard/focus identity', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBenchmarkForecast(page);

    // The first rendered row is the scope's first item.
    const firstTitle = await page.locator('.pm-forecast__row-title').first().textContent();
    expect(firstTitle).toBe('Item 1');

    // Scrolling changes which rows are mounted (the window advances), while
    // the slot count stays bounded.
    const scroller = page.locator('.pm-forecast__list');
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await expect.poll(async () => page.locator('.pm-forecast__row-title').first().textContent()).not.toBe('Item 1');
    const midSlotCount = await page.locator('.pm-forecast__slot').count();
    expect(midSlotCount).toBeLessThan(200);

    // Scroll back to the top and wait for the window to settle there before
    // keyboard navigation: the virtualizer reacts to the scroll event
    // asynchronously, so grabbing `.first()` too early could focus a
    // mid-list row.
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.pm-forecast__row-title').first()).toHaveText('Item 1');
    const firstRow = page.locator('.pm-forecast__row').first();
    await firstRow.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
    const focused = page.locator('.pm-forecast__row:focus');
    await expect(focused).toHaveCount(1);
    await expect(focused.locator('.pm-forecast__row-title')).toHaveText('Item 31');
    // The focused row is within the viewport (the virtualizer scrolled it in).
    const box = await focused.boundingBox();
    expect(box).not.toBeNull();
    expect((box as { y: number }).y).toBeGreaterThanOrEqual(0);
    expect((box as { y: number }).y).toBeLessThan(800);
  });

  test('AC 23.11-2: an edited estimate keeps its draft while the list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBenchmarkForecast(page);

    const field = page.getByRole('spinbutton', { name: 'Points for Item 1', exact: true });
    await field.scrollIntoViewIfNeeded();
    await field.focus();
    // Type (not commit) — the draft must survive a scroll away and back.
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('7');

    const scroller = page.locator('.pm-forecast__list');
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // The edited row is pinned while it holds a draft, so it stays mounted
    // even though the scrolled window moved far away (AC 23.11-2).
    await expect(field).toHaveValue('7');

    // Scroll back: the uncommitted text is still there.
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await expect(field).toHaveValue('7');
  });
});

test.describe('Story 23.11 AC 23.11-5 — no lost input (O5)', () => {
  test.setTimeout(5 * 60_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installReplyControl);
  });

  test('an estimate typed while another row\'s commit reply is in flight is never discarded', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBenchmarkForecast(page);

    // Commit row 1's estimate, then hold the analysis worker's reply. The
    // list will re-render, but the result-driven refresh has not landed yet.
    await setHold(page, true);
    const row1Field = page.getByRole('spinbutton', { name: 'Points for Item 1', exact: true });
    await row1Field.scrollIntoViewIfNeeded();
    await row1Field.fill('12');
    await row1Field.blur();
    await expect.poll(() => heldCount(page)).toBeGreaterThan(0);

    // While that reply is held, type into another row's estimate (no commit).
    // Item 2 starts at 10 points: End, Backspace and '9' leave the local text
    // at "19" — the exact text must survive the acknowledged refresh.
    const row2Field = page.getByRole('spinbutton', { name: 'Points for Item 2', exact: true });
    await row2Field.scrollIntoViewIfNeeded();
    await row2Field.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('9');

    // Release the held reply: the refresh re-renders the list. The in-progress
    // edit survives it (this failed on the pre-23.11 code).
    await setHold(page, false);
    await releaseAllHeld(page);
    await expect(row1Field).toHaveValue('12');
    await expect(row2Field).toHaveValue('19');

    // Escape ends the overlay and shows the acknowledged value; the field
    // itself already dispatched per keystroke, so the committed value is 19.
    await row2Field.press('Escape');
    await expect(row2Field).toHaveValue('19');
  });
});

/** Fixed calendar horizons share geometry with every layer; Fit remains a full-project overview. */
import { expect, test } from '../support/fixtures';
import { importLumenDemo, readDemoProjectBackup } from '../support/helpers/demo-project';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

type PwPage = import('@playwright/test').Page;

async function seedLongProject(page: PwPage, range = '2025-05-01 to 2027-12-01'): Promise<void> {
  await openFirstProjectOutline(page);
  const input = page.locator('input.pm-outline-row__title-input').first();
  await input.fill('Multi-year initiative');
  await input.blur();

  await page.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]').first().click();
  const modal = page.locator('.pm-schedule-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#schedule-phrase-input').fill(range);
  await expect(modal.locator('.pm-schedule-modal__preview-value').first()).toContainText(range.slice(0, 10));
  await modal.getByRole('button', { name: /Apply/i }).click();
  await expect(modal).not.toBeVisible();

  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expect(page.locator('.pm-gantt-view')).toBeVisible();
}

const scale = (page: PwPage, name: string) => page.getByRole('group', { name: 'Timeline Granularity' }).getByRole('button', { name, exact: true });
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86400000;

/** Read actual rendered rectangles rather than repeating application zoom calculations. */
async function geometry(page: PwPage, count: number) {
  return page.locator('.pm-gantt-canvas').evaluate((canvas, visibleCount) => {
    const headers = Array.from(canvas.querySelectorAll<HTMLElement>('[role="columnheader"]'));
    const bar = canvas.querySelector<HTMLElement>('.pm-gantt-canvas__bar')!;
    const first = headers[0]!.getBoundingClientRect();
    const last = headers[visibleCount - 1]!.getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    return {
      viewport: canvas.clientWidth, overflow: canvas.scrollWidth - canvas.clientWidth,
      scroll: canvas.scrollLeft, span: last.right - first.left,
      start: canvas.getAttribute('data-axis-start')!, end: canvas.getAttribute('data-axis-end')!,
      horizonEnd: headers[visibleCount - 1]!.dataset.endDate!,
      barWidth: rect.width, barOffset: rect.left - first.left,
      barStart: bar.dataset.startDate!, barEnd: bar.dataset.endDate!,
    };
  }, count);
}

async function expectHorizon(page: PwPage, name: string, count: number, overflow = true) {
  await expect(scale(page, name)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const g = await geometry(page, count);
    return Math.abs(g.span - g.viewport);
  }).toBeLessThan(2);
  const g = await geometry(page, count);
  const ppd = g.viewport / (days(g.start, g.horizonEnd) + 1);
  expect(g.barWidth).toBeCloseTo((days(g.barStart < g.start ? g.start : g.barStart, g.barEnd > g.end ? g.end : g.barEnd) + 1) * ppd, 0);
  expect(g.barOffset).toBeCloseTo(Math.max(0, days(g.start, g.barStart)) * ppd, 0);
  if (overflow) expect(g.overflow).toBeGreaterThan(1);
  else expect(g.overflow).toBeLessThanOrEqual(1);
  await expect(page.getByLabel('Timeline Start Date')).toHaveValue(g.start);
  await expect(page.getByLabel('Timeline End Date')).toHaveValue(g.end);
  return g;
}

test.describe('Gantt fixed horizons and separate Fit', () => {
  test('12 weeks, six months and four quarters use actual calendar geometry and scroll longer plans', async ({ page }) => {
    await seedLongProject(page);
    await expectHorizon(page, 'month', 6);
    for (const [name, count] of [['week', 12], ['month', 6], ['quarter', 4]] as const) {
      await scale(page, name).click();
      const before = await expectHorizon(page, name, count);
      expect(before.scroll).toBe(0);
      await page.locator('.pm-gantt-canvas').evaluate(canvas => { canvas.scrollLeft = canvas.scrollWidth; });
      await expect.poll(async () => (await geometry(page, count)).scroll).toBeGreaterThan(0);
      const after = await geometry(page, count);
      expect(after.barWidth).toBeCloseTo(before.barWidth, 1);
      expect(after.span).toBeCloseTo(before.span, 1);
      await page.getByRole('button', { name: 'Fit', exact: true }).click();
      await expect.poll(async () => (await geometry(page, count)).overflow).toBeLessThanOrEqual(1);
      await expect(page.getByLabel('Timeline Start Date')).toHaveValue('2025-05-01');
      await expect(page.getByLabel('Timeline End Date')).toHaveValue('2027-12-01');
      await expect(scale(page, name)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  test('resizing the window and divider preserves horizon geometry and the viewed date', async ({ page }) => {
    await seedLongProject(page);
    await page.locator('.pm-gantt-canvas').evaluate(canvas => { canvas.scrollLeft = canvas.clientWidth; });
    await expect.poll(async () => (await geometry(page, 6)).scroll).toBeGreaterThan(0);
    const before = await geometry(page, 6);
    const viewed = before.scroll / before.viewport;
    for (const width of [1600, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const g = await expectHorizon(page, 'month', 6);
      expect(g.scroll / g.viewport).toBeCloseTo(viewed, 2);
    }
    await page.getByRole('separator', { name: 'Resize left panel' }).focus();
    await page.keyboard.press('ArrowRight');
    const resized = await expectHorizon(page, 'month', 6);
    expect(resized.scroll / resized.viewport).toBeCloseTo(viewed, 2);
    await page.locator('.pm-gantt-canvas').evaluate(canvas => { canvas.scrollLeft = canvas.scrollWidth; });
    await expect.poll(async () => (await geometry(page, 6)).scroll).toBeGreaterThan(resized.scroll);
    const right = await geometry(page, 6);
    for (const width of [1600, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const g = await expectHorizon(page, 'month', 6);
      expect(g.scroll / g.viewport).toBeCloseTo(right.scroll / right.viewport, 2);
    }
  });

  test('manual ranges fit explicitly and scale selection restores padded horizons', async ({ page }) => {
    await seedLongProject(page);
    await page.getByLabel('Timeline Start Date').fill('2026-01-01');
    await page.getByLabel('Timeline End Date').fill('2026-01-10');
    await expect.poll(async () => (await geometry(page, 1)).overflow).toBeLessThanOrEqual(1);
    await scale(page, 'month').click();
    const g = await expectHorizon(page, 'month', 6, false);
    expect(g.end).toBe('2026-06-30');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect(page.getByLabel('Timeline Start Date')).toHaveValue('2025-05-01');
    await expect(page.getByLabel('Timeline End Date')).toHaveValue('2027-12-01');
    await expect.poll(async () => (await geometry(page, 1)).overflow).toBeLessThanOrEqual(1);
  });
});


test('demo layers share date and row geometry after zoom and pan without changing authored work', async ({ page }) => {
  await importLumenDemo(page);
  const authored = await readDemoProjectBackup(page);
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  for (const name of ['week', 'month', 'quarter']) {
    await scale(page, name).click();
    await page.locator('.pm-gantt-canvas').evaluate(canvas => { canvas.scrollLeft = 150; canvas.scrollTop = 120; });
    await expect.poll(async () => page.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>('.pm-gantt-canvas')!;
      const header = canvas.querySelector<HTMLElement>('[role="columnheader"]')!.getBoundingClientRect();
      const origin = Date.parse(canvas.dataset.axisStart!);
      const ppd = Number(canvas.dataset.pixelsPerDay);
      const x = (date: string, end = false) => (Date.parse(date) - origin) / 86400000 * ppd + (end ? ppd : 0);
      const errors: number[] = [];
      const bars = Array.from(canvas.querySelectorAll<HTMLElement>('.pm-gantt-canvas__bar, .pm-gantt-canvas__derived'));
      for (const bar of bars) {
        const r = bar.getBoundingClientRect();
        errors.push(Math.abs(r.left - header.left - x(bar.dataset.startDate!)));
        errors.push(Math.abs(r.width - (x(bar.dataset.endDate!, true) - x(bar.dataset.startDate!))));
        const row = document.querySelector<HTMLElement>(`.pm-gantt-hierarchy__row[data-node-id="${bar.dataset.nodeId}"]`)!;
        const timelineRow = bar.closest<HTMLElement>('.pm-gantt-canvas__row')!;
        errors.push(Math.abs(row.getBoundingClientRect().top - timelineRow.getBoundingClientRect().top));
      }
      const phases = canvas.querySelectorAll<HTMLElement>('.pm-gantt-canvas__phase-band');
      for (const phase of Array.from(phases)) {
        errors.push(Math.abs(parseFloat(phase.style.left) - x(phase.dataset.startDate!)));
        errors.push(Math.abs(parseFloat(phase.style.width) - (x(phase.dataset.endDate!, true) - x(phase.dataset.startDate!))));
      }
      const paths = canvas.querySelectorAll<SVGPathElement>('path[data-source-id]');
      for (const path of Array.from(paths)) {
        const source = bars.find(b => b.dataset.nodeId === path.dataset.sourceId)!;
        const target = bars.find(b => b.dataset.nodeId === path.dataset.targetId)!;
        const start = path.getPointAtLength(0);
        const end = path.getPointAtLength(path.getTotalLength());
        errors.push(Math.abs(start.x - x(source.dataset.endDate!, true)), Math.abs(end.x - x(target.dataset.startDate!)));
      }
      return Math.max(...errors, bars.length > 0 && paths.length > 0 && phases.length > 0 ? 0 : 999);
    })).toBeLessThan(2);
  }
  const after = await readDemoProjectBackup(page);
  expect(after.nodes).toEqual(authored.nodes);
  expect(after.unlockEdges).toEqual(authored.unlockEdges);
});


test('a short authored plan pads every scale and survives restored project selection', async ({ page }) => {
  await seedLongProject(page, '2025-05-01 to 2025-05-10');
  const name = await page.locator('.pm-side-nav__current-title').textContent();
  for (const [unit, count] of [['week', 12], ['month', 6], ['quarter', 4]] as const) {
    await scale(page, unit).click();
    await expectHorizon(page, unit, count, false);
  }
  // Document preview acknowledges saved view preferences before a page reload.
  await page.getByTestId('export-trigger').click();
  await expect(page.getByTestId('export-preview-sentence')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await importLumenDemo(page);
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await scale(page, 'week').click();
  await page.locator('.pm-side-nav__project').filter({ hasText: name! }).click();
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await expectHorizon(page, 'quarter', 4, false);
});

test('editing one padded bound preserves the other displayed date', async ({ page }) => {
  await seedLongProject(page, '2025-05-01 to 2025-05-10');
  await expectHorizon(page, 'month', 6, false);
  await page.getByLabel('Timeline Start Date').fill('2025-06-01');
  await expect(page.getByLabel('Timeline End Date')).toHaveValue('2025-10-31');
  await expect(page.locator('.pm-gantt-canvas [role="columnheader"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await scale(page, 'quarter').click();
  await page.getByLabel('Timeline End Date').fill('2026-04-30');
  await expect(page.getByLabel('Timeline Start Date')).toHaveValue('2025-04-01');
  await expect(page.getByLabel('Timeline End Date')).toHaveValue('2026-04-30');
});

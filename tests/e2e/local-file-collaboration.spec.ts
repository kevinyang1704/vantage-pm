import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline, seedFirstNodeTitle } from '../support/helpers/outline-navigation';
import AxeBuilder from '@axe-core/playwright';

type Page = Parameters<typeof openFirstProjectOutline>[0];
const titles = (page: Page) => page.locator('input.pm-outline-row__title-input');
function portable(count = 2) {
  const id = (n: number) => `019a0000-0000-7000-8000-${n.toString().padStart(12, '0')}`;
  return JSON.stringify({ schemaVersion: 10, exportedAt: '2026-10-28T00:00:00.000Z', project: { id: id(1), name: 'Synthetic shared plan' },
    nodes: Array.from({ length: count }, (_, index) => index + 2).map(n => ({ id: id(n), parentId: null, title: n === 2 ? 'Original first' : n === 3 ? 'Original second' : `Branch item ${n}`, bodyText: null, position: String(n * 4294967296), nodeType: null, startDate: null, endDate: null, durationDays: null, scheduleSourceMode: 'none', completed: false, effortPoints: null, effortPointsDone: null, strategicWeight: null, phaseId: null, deliveryStatus: 'not_started' })),
    phases: [], nodeCustomFields: [], typeTemplateFields: [], unlockEdges: [], findingDismissals: [], affectedReasons: [], openQuestions: [] });
}
async function pick(page: Page, json: string, name = 'synthetic.pmapp.json') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-trigger').click();
  await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function importStandalone(page: Page, json: string) {
  await pick(page, json);
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.pm-side-nav__project').last().click();
  await expect(titles(page).first()).toBeVisible();
}
async function share(page: Page) {
  await page.evaluate(() => { delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const download = page.waitForEvent('download');
  await page.getByTestId('share-file-trigger').click();
  const file = await download;
  const path = await file.path();
  return readFile(path, 'utf8');
}

test.describe('local file collaboration', () => {
  test('reviews, partially approves, repeats and recovers a peer contribution offline', async ({ page, browser }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error' || entry.type() === 'warning') errors.push(entry.text()); });
    await page.addInitScript(() => {
      const metrics = { lcpMs: 0, cls: 0, maxInteractionMs: 0 };
      Object.assign(window, { localFileMetrics: metrics });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) metrics.lcpMs = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
          if (!shift.hadRecentInput) metrics.cls += shift.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEventTiming & { interactionId?: number };
          if (event.interactionId) metrics.maxInteractionMs = Math.max(metrics.maxInteractionMs, event.duration);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    });
    await openFirstProjectOutline(page);
    await importStandalone(page, portable());
    const initialShare = await share(page);
    const peerContext = await browser.newContext();
    try {
      const peer = await peerContext.newPage();
      await openFirstProjectOutline(peer);
      await importStandalone(peer, initialShare);
      await seedFirstNodeTitle(page, 'My first edit');
      await seedFirstNodeTitle(peer, 'Peer first edit');
      await titles(peer).nth(1).fill('Peer second edit');
      await titles(peer).nth(1).blur();
      const contribution = await share(peer);
      await pick(page, contribution, 'peer.vantage-share.json');
      await page.getByRole('radio', { name: 'Merge into existing project' }).check();
      await expect(page.getByText('Shared editing history found.', { exact: false })).toBeVisible();
      const conflicts = page.locator('.pm-local-file-dialog__change[data-conflict="true"]');
      await expect(conflicts).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Approve contribution' })).toBeDisabled();
      await conflicts.locator('summary').click();
      await expect(conflicts.locator('pre').first()).toContainText('My first edit');
      await page.screenshot({ path: testInfo.outputPath('merge-conflict.png'), fullPage: true });
      expect((await new AxeBuilder({ page }).include('.pm-local-file-dialog').analyze()).violations).toEqual([]);
      await conflicts.locator('select').selectOption('defer');
      await page.getByRole('button', { name: 'Approve contribution' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(titles(page).first()).toHaveValue('My first edit');
      await expect(titles(page).nth(1)).toHaveValue('Peer second edit');

      // Deferred conflicting edits remain pending on the same unchanged file.
      await pick(page, contribution, 'peer.vantage-share.json');
      await page.getByRole('radio', { name: 'Merge into existing project' }).check();
      await expect(conflicts).toHaveCount(1);
      await conflicts.locator('select').selectOption('accept');
      await page.getByRole('button', { name: 'Approve contribution' }).click();
      await expect(titles(page).first()).toHaveValue('Peer first edit');
      await page.screenshot({ path: testInfo.outputPath('merge-applied.png'), fullPage: true });

      await pick(page, contribution, 'peer.vantage-share.json');
      await page.getByRole('radio', { name: 'Merge into existing project' }).check();
      await expect(page.getByText('No new changes to apply.', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Approve contribution' }).click();
      await page.reload();
      await page.locator('.pm-side-nav__project').filter({ hasText: 'Synthetic shared plan' }).click();
      await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
      await page.getByTestId('recover-merge-trigger').click();
      await page.getByRole('button', { name: 'Restore recovery point' }).click();
      await expect(titles(page).first()).toHaveValue('My first edit');
      await expect(titles(page).nth(1)).toHaveValue('Peer second edit');
      await page.screenshot({ path: testInfo.outputPath('merge-recovered.png'), fullPage: true });
      const metrics = await page.evaluate(() => (window as unknown as { localFileMetrics: object }).localFileMetrics);
      await testInfo.attach('local-file-web-vitals-observation', { body: JSON.stringify(metrics), contentType: 'application/json' });
      expect(errors).toEqual([]);
    } finally { await peerContext.close(); }
  });

  test('adds an independent branch, cancels safely and remembers repeated imports', async ({ page }, testInfo) => {
    await openFirstProjectOutline(page);
    const before = await titles(page).count();
    await pick(page, portable());
    await page.getByRole('radio', { name: 'Merge into existing project' }).check();
    await expect(page.getByLabel('Add branch beneath')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(titles(page)).toHaveCount(before);
    await pick(page, portable());
    await page.getByRole('radio', { name: 'Merge into existing project' }).check();
    await expect(page.getByLabel('Add branch beneath')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('independent-branch-review.png'), fullPage: true });
    await page.getByRole('button', { name: 'Approve contribution' }).click();
    await expect(titles(page)).toHaveCount(before + 2);
    await pick(page, portable());
    await page.getByRole('radio', { name: 'Merge into existing project' }).check();
    await expect(page.getByText('No new changes to apply.', { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('import-trigger')).toBeFocused();
    await expect(titles(page)).toHaveCount(before + 2);
  });

  test('bounds large review rendering and supports explicit branch placement', async ({ page }) => {
    await openFirstProjectOutline(page);
    await pick(page, portable(120));
    await page.getByRole('radio', { name: 'Merge into existing project' }).check();
    const target = page.getByLabel('Destination project');
    const projectId = await target.inputValue();
    await target.selectOption('');
    await expect(page.getByRole('button', { name: 'Approve contribution' })).toBeDisabled();
    await target.selectOption(projectId);
    await expect(page.locator('.pm-local-file-dialog__change')).toHaveCount(100);
    await page.getByRole('button', { name: 'Show more changes', exact: false }).click();
    await expect(page.locator('.pm-local-file-dialog__change')).toHaveCount(120);
    await page.getByLabel('Add as a separate branch instead of matching shared items').check();
    await expect(page.getByLabel('Add branch beneath')).toBeEnabled();
    const parent = page.getByLabel('Add branch beneath');
    const value = await parent.locator('option').nth(1).getAttribute('value');
    expect(value).toBeTruthy();
    await parent.selectOption(value!);
    await expect(page.getByRole('button', { name: 'Approve contribution' })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept nonconflicting changes' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

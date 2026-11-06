import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { parsePortableFile, PORTABLE_FILE_SCHEMA_VERSION } from '../../../src/contracts/portable-file.schema';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const LUMEN_DEMO_PATH = resolve('public/demos/lumen-trade.json');

/** Import the bundled demo through the real file chooser and select it. */
export async function importLumenDemo(page: Page): Promise<void> {
  const demo = JSON.parse(await readFile(LUMEN_DEMO_PATH, 'utf8')) as { project: { name: string } };
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('import-trigger').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(LUMEN_DEMO_PATH);
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  const nav = page.locator('nav.pm-side-nav');
  await nav.getByRole('button', { name: demo.project.name, exact: true }).click();
  // The first-visit tour can open on the demo outline; dismiss it if present.
  await page.waitForTimeout(400);
  const skip = page.getByRole('button', { name: 'Skip tour', exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/** Read the real UI's portable backup; never reach into repository internals. */
export async function readDemoProjectBackup(page: Page) {
  // Use the browser's supported download path rather than an OS save dialog
  // in headless checks, matching the existing portable-export scenarios.
  await page.evaluate(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const downloadPromise = page.waitForEvent('download');
  await expect(async () => {
    await page.getByTestId('export-project-trigger').click();
    await expect(page.getByRole('status').filter({ hasText: 'Portable project file created:' })).toBeVisible(
      { timeout: 500 },
    );
  }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
  const file = await (await downloadPromise).path();
  if (!file) throw new Error('Portable download did not produce a file');
  const parsed = parsePortableFile(await readFile(file, 'utf8'));
  if (!parsed.ok || parsed.value.schemaVersion !== PORTABLE_FILE_SCHEMA_VERSION) {
    throw new Error('Expected a valid current portable project backup');
  }
  return parsed.value;
}

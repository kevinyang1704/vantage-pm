import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('demo tour guides a new browser once and stays dismissed after reload', async ({ page }) => {
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:5173');
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
  await expect(page.locator('.pm-demo-tour')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-trigger').click();
  await (await chooser).setFiles(resolve('public/demos/lumen-trade.json'));
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  const nav = page.locator('nav.pm-side-nav');
  await nav.getByRole('button', { name: 'Lumen Trade — fictional investing app', exact: true }).click();
  const outline = nav.getByRole('button', { name: 'Outline', exact: true });
  if (await outline.getAttribute('aria-current') !== 'page') await outline.click();
  await expect(page.getByRole('dialog', { name: 'Start with the why' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Connect work to outcomes' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Start with the why' })).toBeVisible();
  for (const name of ['Connect work to outcomes', 'See what unlocks what', 'Explore the same plan four ways']) {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('dialog', { name })).toBeVisible();
    await expect(page.locator('.pm-demo-tour__spotlight')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(page.locator('.pm-demo-tour')).toHaveCount(0);
  await page.reload();
  await nav.getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.locator('[role="tree"]')).toBeVisible();
  await expect(page.locator('.pm-demo-tour')).toHaveCount(0);
});

import { readFileSync } from 'node:fs';
import { expect, test } from '../support/fixtures';

const APP = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const DEMO = `${APP}/?demo=1`;
const DEMO_NAME = (JSON.parse(readFileSync('public/demos/lumen-trade.json', 'utf8')) as {
  project: { name: string };
}).project.name;

test.use({ serviceWorkers: 'block' });

test('startup holds until the workspace and the Lumen demo are ready', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()) && message.text() !== 'Service Worker registration blocked by Playwright') {
      errors.push(message.text());
    }
  });
  let releaseApp!: () => void;
  let releaseDemo!: () => void;
  let demoRequested!: () => void;
  const appGate = new Promise<void>((resolve) => { releaseApp = resolve; });
  const demoGate = new Promise<void>((resolve) => { releaseDemo = resolve; });
  const demoSeen = new Promise<void>((resolve) => { demoRequested = resolve; });
  await page.route(/(?:\/assets\/index-.*\.js$|\/src\/app\/main\.tsx$)/, async (route) => {
    await appGate;
    await route.continue();
  });
  await page.route(/\/demos\/lumen-trade\.json$/, async (route) => {
    demoRequested();
    await demoGate;
    await route.continue();
  });
  await page.goto(DEMO, { waitUntil: 'commit' });
  await expect(page.getByRole('status')).toContainText('Opening your workspace');
  await expect(page.locator('.pm-startup')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('initial-loading.png') });
  releaseApp();
  await demoSeen;
  await expect(page.getByRole('status')).toContainText('Opening your workspace');
  await expect(page.locator('.pm-project-card')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('preparing-demo.png') });
  releaseDemo();
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect(page.locator('.pm-startup')).toHaveCount(0);
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText(DEMO_NAME);
  await expect(page.locator('[role="tree"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ready.png') });
  await page.reload();
  await expect(page.locator('.pm-startup')).toHaveCount(0);
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText(DEMO_NAME);
  await expect(page.locator('[role="tree"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('failed storage startup replaces loading with a retry that recovers', async ({ page }) => {
  await page.route('**/*.wasm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/wasm', body: 'invalid wasm for synthetic failure' }),
  );
  await page.goto(DEMO);
  await expect(page.getByRole('alert')).toHaveText('Your workspace couldn’t be opened');
  await expect(page.locator('.pm-startup')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.pm-startup')).toContainText('couldn’t open local storage');
  await page.unroute('**/*.wasm');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect(page.locator('.pm-startup')).toHaveCount(0);
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText(DEMO_NAME);
  await expect(page.locator('[role="tree"]')).toBeVisible();
});

import { expect, test } from '../support/fixtures';
import { LUMEN_DEMO_NAME, readDemoProjectBackup } from '../support/helpers/demo-project';
import { seedFirstNodeTitle } from '../support/helpers/outline-navigation';

const APP = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const DEMO = `${APP}/?demo=1`;

async function openOverview(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
}

async function skipTour(page: import('@playwright/test').Page): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip tour', exact: true });
  await expect(skip).toBeVisible({ timeout: 15_000 });
  await skip.click();
}

test.describe('automatic Lumen Trade demo project', () => {
  test('loads the complete sample before the first-visit tour and adds independent fresh copies', async ({ page }) => {
    await page.goto(DEMO);
    await expect(page.getByRole('dialog', { name: 'Start with the why' })).toBeVisible();
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText(LUMEN_DEMO_NAME);
    await skipTour(page);
    const first = await readDemoProjectBackup(page);
    expect(first.nodes).toHaveLength(56);
    expect(first.unlockEdges).toHaveLength(25);
    expect(first.openQuestions).toHaveLength(5);
    expect(first.phases).toHaveLength(3);
    expect(first.forecastPlan?.roster).toHaveLength(4);

    await openOverview(page);
    await expect(page.locator('.pm-project-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'Add demo project', exact: true }).click();
    await expect(page.locator('.pm-project-card')).toHaveCount(2);
    const second = await readDemoProjectBackup(page);
    expect(second.project.id).not.toBe(first.project.id);
    expect(second.nodes).toHaveLength(56);
    const firstIds = new Set(first.nodes.map((node) => node.id));
    expect(second.nodes.every((node) => !firstIds.has(node.id))).toBe(true);

    await page.reload();
    await openOverview(page);
    await expect(page.locator('.pm-project-card')).toHaveCount(2);
  });

  test('keeps ordinary visits free of automatic samples and demo actions', async ({ page }) => {
    await page.goto(APP);
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText('My Project');
    await expect(page.locator('.pm-project-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Add demo project', exact: true })).toHaveCount(0);
  });

  test('adds the sample once without changing existing work', async ({ page }) => {
    await page.goto(APP);
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(page.locator('[role="tree"]')).toBeVisible();
    await seedFirstNodeTitle(page, 'Preserve this synthetic existing idea');
    const original = await readDemoProjectBackup(page);

    await page.goto(DEMO);
    await skipTour(page);
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText(LUMEN_DEMO_NAME);
    await page.locator('nav.pm-side-nav').getByRole('button', { name: 'My Project', exact: true }).click();
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    const preserved = await readDemoProjectBackup(page);
    expect(preserved.project.id).toBe(original.project.id);
    expect(preserved.nodes).toEqual(original.nodes);
  });

  test('preserves demo edits across reload without reinstalling it', async ({ page }) => {
    await page.goto(DEMO);
    await skipTour(page);
    await page.locator('.pm-side-nav').getByRole('button', { name: LUMEN_DEMO_NAME, exact: true }).click();
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    await seedFirstNodeTitle(page, 'An edited synthetic demo vision');
    const edited = await readDemoProjectBackup(page);

    await page.reload();
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText(LUMEN_DEMO_NAME);
    await page.getByRole('button', { name: 'Outline', exact: true }).click();
    const restored = await readDemoProjectBackup(page);
    expect(restored.project.id).toBe(edited.project.id);
    expect(restored.nodes).toEqual(edited.nodes);
  });

  test('does not recreate a deleted sample until a fresh copy is explicitly requested', async ({ page }) => {
    await page.goto(DEMO);
    await skipTour(page);
    const original = await readDemoProjectBackup(page);
    await openOverview(page);
    await page.getByRole('button', { name: `Delete project ${LUMEN_DEMO_NAME}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: 'Type project name to confirm deletion' }).fill(LUMEN_DEMO_NAME);
    await page.getByRole('dialog').getByRole('button', { name: 'Delete project', exact: true }).click();
    await expect(page.locator('.pm-project-card').filter({ hasText: LUMEN_DEMO_NAME })).toHaveCount(0);

    await page.reload();
    await openOverview(page);
    await expect(page.locator('.pm-project-card').filter({ hasText: LUMEN_DEMO_NAME })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add demo project', exact: true }).click();
    await expect(page.locator('.pm-project-card').filter({ hasText: LUMEN_DEMO_NAME })).toHaveCount(1);
    expect((await readDemoProjectBackup(page)).project.id).not.toBe(original.project.id);
  });

  test('keeps the destination workspace stable while a fresh demo is loading', async ({ page }) => {
    await page.goto(DEMO);
    await skipTour(page);
    await page.locator('.pm-side-nav__workspace-control').click();
    await page.getByRole('menuitem', { name: 'New workspace…' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Synthetic destination');
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.locator('.pm-project-card')).toHaveCount(0);
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      let held = false;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (!held && (message as { type?: string } | null)?.type === 'EnsureDemoProject') {
          held = true;
          (window as unknown as { __releaseSyntheticDemo: () => void }).__releaseSyntheticDemo = () => {
            Reflect.apply(original, this, transfer === undefined ? [message] : [message, transfer]);
          };
          return;
        }
        Reflect.apply(original, this, transfer === undefined ? [message] : [message, transfer]);
      };
    });
    await page.getByRole('button', { name: 'Add demo project', exact: true }).click();
    await page.waitForFunction(() => typeof (window as unknown as { __releaseSyntheticDemo?: () => void }).__releaseSyntheticDemo === 'function');
    await page.locator('.pm-side-nav__workspace-control').click();
    await page.getByRole('menuitemradio', { name: /My Workspace/ }).click();
    await expect(page.locator('.pm-workspace-status')).toContainText('The demo project is loading');
    await expect(page.locator('.pm-side-nav__workspace-control')).toHaveAttribute('aria-label', /^Workspace: Synthetic destination\./);
    await page.evaluate(() => (window as unknown as { __releaseSyntheticDemo: () => void }).__releaseSyntheticDemo());
    await expect(page.getByRole('button', { name: 'Add demo project', exact: true })).toBeEnabled();
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText(LUMEN_DEMO_NAME);
    await page.locator('.pm-side-nav__workspace-control').click();
    await page.getByRole('menuitemradio', { name: /My Workspace/ }).click();
    await expect(page.locator('.pm-side-nav__workspace-control')).toHaveAttribute('aria-label', /^Workspace: My Workspace\./);
    await expect(page.locator('.pm-project-card')).toHaveCount(1);
  });

  test('an explicit retry after failed automatic installation records the installation and avoids a duplicate on reload', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: unknown; protocolVersion?: unknown; requestId?: unknown } | null;
        if (request?.type === 'EnsureDemoProject' && sessionStorage.getItem('synthetic-demo-refusal') !== '1') {
          sessionStorage.setItem('synthetic-demo-refusal', '1');
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
            type: 'DemoProjectInstallResult',
            protocolVersion: request.protocolVersion,
            requestId: request.requestId,
            result: { kind: 'failed', code: 'SYNTHETIC_INSTALL_FAILURE' },
          } })));
          return;
        }
        Reflect.apply(original, this, transfer === undefined ? [message] : [message, transfer]);
      };
    });
    await page.goto(DEMO);
    await expect(page.locator('.pm-side-nav__current-title')).toHaveText('My Project');
    await expect(page.getByText('Use Add demo project to try again')).toBeVisible();
    await page.getByRole('button', { name: 'Add demo project', exact: true }).click();
    await openOverview(page);
    await expect(page.locator('.pm-project-card')).toHaveCount(2);
    const restored = await readDemoProjectBackup(page);
    expect(restored.nodes).toHaveLength(56);
    await page.reload();
    await openOverview(page);
    await expect(page.locator('.pm-project-card')).toHaveCount(2);
    expect((await readDemoProjectBackup(page)).project.id).toBe(restored.project.id);
  });
});

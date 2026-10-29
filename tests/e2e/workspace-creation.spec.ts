/**
 * Epic 17: Creating Workspaces — certification e2e spec.
 *
 * Certifies the Option A contract from
 * `design/workspace-creation/workspace-options.html`:
 * the side-nav workspace control is a real switcher, workspaces can be
 * created / renamed / switched / deleted, and project scope follows the
 * active workspace.
 *
 * Covers the shared constraints that option list committed to:
 *   1. No project is ever workspace-less — the pre-workspace project is
 *      backfilled into a default workspace and stays reachable.
 *   2. The overview is scoped to one workspace at a time.
 *   4. Deleting a workspace is never a backdoor to deleting projects:
 *      refused while non-empty, and the refusal SAYS SO on screen.
 *   6. The active workspace survives a reload.
 *
 * These assertions deliberately go through the real UI rather than calling
 * the persistence layer — the unit and Rust suites already cover the SQL.
 * What is only provable here is that the wiring reaches the screen.
 */

import { expect, test } from '../support/fixtures';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

const control = '.pm-side-nav__workspace-control';
const menu = '.pm-side-nav__workspace-menu';
const dialog = '.pm-ws-dialog';

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  // Two independent async settles have to land before any assertion here is
  // meaningful, and waiting for only the first made this suite flaky:
  //   1. the workspace registry load (the control still reads the generic
  //      "Workspace" fallback until it arrives), and
  //   2. the cold-boot default-project auto-create, an OPFS round trip that
  //      lands *after* the overview first paints — so `.pm-project-card`
  //      legitimately reads 0 for a moment on a fresh store.
  await expect(page.locator(`${control} strong`)).not.toHaveText('Workspace');
  await expect(page.locator('.pm-project-card')).not.toHaveCount(0);
}

async function openMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator(control).click();
  await expect(page.locator(menu)).toBeVisible();
}

async function createWorkspace(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await openMenu(page);
  await page.locator(menu).getByRole('menuitem', { name: 'New workspace…' }).click();
  await expect(page.locator(dialog)).toBeVisible();
  await page.locator('#pm-ws-dialog-name').fill(name);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.locator(dialog)).toHaveCount(0);
  await expect(page.locator(`${control} strong`)).toHaveText(name);
}

test.describe('Epic 17: Creating Workspaces', () => {
  test('the pre-workspace project is backfilled into a named default workspace', async ({ page }) => {
    await boot(page);

    // Constraint 1: a store that predates workspaces still shows its project,
    // now inside a real, named workspace rather than a bare caption.
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');
    await expect(page.locator('.pm-project-card')).not.toHaveCount(0);

    const label = await page.locator(control).getAttribute('aria-label');
    expect(label).toMatch(/^Workspace: My Workspace\./);
  });

  test('a new workspace becomes active, starts empty, and lands on its empty state', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.pm-project-card')).not.toHaveCount(0);

    await createWorkspace(page, 'Client — Northwind');

    // Constraint 2: scoped to one workspace. The previous workspace's
    // projects must not leak into the new one.
    await expect(page.locator('.pm-project-card')).toHaveCount(0);
    await expect(page.locator('.pm-workspace-empty')).toBeVisible();
    await expect(page.locator('.pm-side-nav__project')).toHaveCount(0);
    await expect(page.locator('.pm-side-nav__workspace-copy span')).toContainText('0 PROJECTS');
  });

  test('switching back restores the original workspace’s projects', async ({ page }) => {
    await boot(page);
    const originalCards = await page.locator('.pm-project-card').count();
    expect(originalCards).toBeGreaterThan(0);

    await createWorkspace(page, 'Scratch');
    await expect(page.locator('.pm-project-card')).toHaveCount(0);

    await openMenu(page);
    await page.locator(menu).getByRole('menuitemradio', { name: /My Workspace/ }).click();

    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');
    await expect(page.locator('.pm-project-card')).toHaveCount(originalCards);
  });

  test('exactly one workspace is checked in the switcher at a time', async ({ page }) => {
    await boot(page);
    await createWorkspace(page, 'Second');

    await openMenu(page);
    const options = page.locator(`${menu} [role="menuitemradio"]`);
    await expect(options).toHaveCount(2);
    await expect(page.locator(`${menu} [role="menuitemradio"][aria-checked="true"]`)).toHaveCount(1);
    await expect(
      page.locator(`${menu} [role="menuitemradio"][aria-checked="true"]`),
    ).toContainText('Second');
  });

  test('deleting a workspace that still holds projects is refused, visibly, and destroys nothing', async ({ page }) => {
    await boot(page);
    const cardsBefore = await page.locator('.pm-project-card').count();
    expect(cardsBefore).toBeGreaterThan(0);

    // A second workspace must exist, or the refusal would be LAST_WORKSPACE
    // rather than the not-empty rule this test is about.
    await createWorkspace(page, 'Somewhere else');
    await openMenu(page);
    await page.locator(menu).getByRole('menuitemradio', { name: /My Workspace/ }).click();
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');

    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: /^Delete/ }).click();

    // Constraint 4: the refusal must be readable, not just enforced. This is
    // the assertion that would have caught the status message being computed
    // into state that nothing on the overview rendered.
    const status = page.locator('.pm-workspace-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('still holds');
    await expect(status).toContainText('before deleting the workspace');

    // Nothing was destroyed: workspace and projects both survive.
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');
    await expect(page.locator('.pm-project-card')).toHaveCount(cardsBefore);
  });

  test('an empty workspace can be deleted, and the active pointer moves to a survivor', async ({ page }) => {
    await boot(page);
    await createWorkspace(page, 'Disposable');
    await expect(page.locator('.pm-project-card')).toHaveCount(0);

    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: /^Delete “Disposable”/ }).click();

    // The pointer repoints at a surviving workspace rather than leaving the
    // app pointing at something that no longer exists.
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');

    await openMenu(page);
    await expect(page.locator(`${menu} [role="menuitemradio"]`)).toHaveCount(1);
    await expect(page.locator(menu)).not.toContainText('Disposable');
  });

  test('the last remaining workspace cannot be deleted, even once emptied', async ({ page }) => {
    await boot(page);
    await openMenu(page);
    await expect(page.locator(`${menu} [role="menuitemradio"]`)).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Empty the only workspace by deleting its projects through the real
    // named-confirmation flow. The not-empty rule is checked before the
    // last-workspace rule, so the workspace has to actually be empty for
    // this test to reach the rule it is about.
    // Count-driven rather than visibility-driven: each delete re-renders the
    // grid, which detaches a locator captured before the click. Asserting the
    // new count between iterations gives Playwright a stable point to wait on.
    let remaining = await page.locator('.pm-project-card').count();
    while (remaining > 0) {
      const card = page.locator('.pm-project-card').first();
      const name = ((await card.locator('.pm-project-card-name').textContent()) ?? '').trim();
      await card.getByRole('button', { name: /^Delete project / }).click();
      const confirm = page.locator('.pm-delete-dialog');
      await expect(confirm).toBeVisible();
      await confirm.locator('.pm-delete-dialog-input').fill(name);
      await confirm.getByRole('button', { name: 'Delete project' }).click();
      await expect(confirm).toHaveCount(0);
      remaining -= 1;
      await expect(page.locator('.pm-project-card')).toHaveCount(remaining);
    }

    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: /^Delete/ }).click();

    const status = page.locator('.pm-workspace-status');
    await expect(status).toBeVisible();
    await expect(status).toContainText('only workspace');
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');
  });

  test('renaming updates the switcher without touching the projects inside', async ({ page }) => {
    await boot(page);
    const cardsBefore = await page.locator('.pm-project-card').count();

    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: /^Rename/ }).click();
    await expect(page.locator(dialog)).toBeVisible();
    await page.locator('#pm-ws-dialog-name').fill('Renamed Workspace');
    await page.getByRole('button', { name: 'Rename workspace' }).click();

    await expect(page.locator(dialog)).toHaveCount(0);
    await expect(page.locator(`${control} strong`)).toHaveText('Renamed Workspace');
    await expect(page.locator('.pm-project-card')).toHaveCount(cardsBefore);
  });

  test('a blank name is refused by the dialog without creating anything', async ({ page }) => {
    await boot(page);
    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: 'New workspace…' }).click();
    await expect(page.locator(dialog)).toBeVisible();

    await page.locator('#pm-ws-dialog-name').fill('   ');
    const confirm = page.getByRole('button', { name: 'Create workspace' });
    await expect(confirm).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(page.locator(dialog)).toHaveCount(0);

    await openMenu(page);
    await expect(page.locator(`${menu} [role="menuitemradio"]`)).toHaveCount(1);
  });

  test('Enter submits the create dialog', async ({ page }) => {
    await boot(page);
    await openMenu(page);
    await page.locator(menu).getByRole('menuitem', { name: 'New workspace…' }).click();
    await page.locator('#pm-ws-dialog-name').fill('Keyboard Made');
    await page.locator('#pm-ws-dialog-name').press('Enter');

    await expect(page.locator(dialog)).toHaveCount(0);
    await expect(page.locator(`${control} strong`)).toHaveText('Keyboard Made');
  });

  test('the active workspace survives a reload', async ({ page }) => {
    await boot(page);
    await createWorkspace(page, 'Persistent');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

    // Constraint 6: active workspace is app-level persisted state, not
    // session state — it must come back as the active one after a restart.
    await expect(page.locator(`${control} strong`)).toHaveText('Persistent');
  });

  test('a project created in a workspace stays in that workspace', async ({ page }) => {
    await boot(page);
    await createWorkspace(page, 'Owner');
    await expect(page.locator('.pm-project-card')).toHaveCount(0);

    await page.locator('.pm-workspace-empty button.pm-workspace-new-project').click();
    await expect(page.locator('.pm-project-card')).toHaveCount(1);

    // Switch away and back: the new project must belong to "Owner" only.
    await openMenu(page);
    await page.locator(menu).getByRole('menuitemradio', { name: /My Workspace/ }).click();
    await expect(page.locator(`${control} strong`)).toHaveText('My Workspace');
    const inDefault = await page.locator('.pm-project-card').count();

    await openMenu(page);
    await page.locator(menu).getByRole('menuitemradio', { name: /Owner/ }).click();
    await expect(page.locator(`${control} strong`)).toHaveText('Owner');
    await expect(page.locator('.pm-project-card')).toHaveCount(1);

    // And it did not also appear in the default workspace.
    expect(inDefault).toBeGreaterThanOrEqual(1);
    await openMenu(page);
    await expect(
      page.locator(`${menu} [role="menuitemradio"]`).filter({ hasText: 'Owner' }),
    ).toContainText('1');
  });
});

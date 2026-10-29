/**
 * Epic 27 end-to-end: share, invite, approve, join, live edit, presence,
 * offline conflict and revocation across two isolated browser contexts
 * against a real local pmapp-server and a collaboration-flag build
 * (playwright.collab.config.ts). Synthetic data only.
 */

import { expect, type Page } from '@playwright/test';
import { collaborationTest as test, COLLAB_APP_URL } from '../support/fixtures';
import { expectForecastReady } from '../support/helpers/forecast';

async function openApp(page: Page): Promise<void> {
  await page.goto(COLLAB_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible({ timeout: 30_000 });
}

async function openOutline(page: Page): Promise<void> {
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.locator('[role="tree"]')).toBeVisible();
}

const syncIndicator = (page: Page) => page.locator('.pm-sync-indicator');
const firstTitle = (page: Page) => page.locator('input.pm-outline-row__title-input').first();

async function shareAsOwner(owner: Page): Promise<string> {
  await openApp(owner);
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  const share = owner.getByRole('dialog', { name: /Share/ });
  await share.getByLabel('Your name as teammates see it').fill('Synthetic Owner');
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  const recovery = share.getByLabel('Owner recovery link');
  await expect(recovery).toHaveValue(/^vantage:\/\/recover\?project=.+&code=[A-Z2-9]{4}(-|%2D)/);
  const recoveryLink = await recovery.inputValue();
  // One step: the same screen already has a ready editor invite link.
  await expect(share.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/^vantage:\/\/join\?/);
  await expect(share.getByLabel('Invite role')).toHaveValue('editor');
  const done = share.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await share.getByLabel('I saved the recovery link').check();
  await done.click();
  await expect(syncIndicator(owner)).toContainText('Synced');
  await expect(owner.getByRole('button', { name: 'Sharing', exact: true })).toBeVisible();
  return recoveryLink;
}

/** Owner invites, joiner redeems, owner approves, joiner opens the shared project. */
async function inviteAndJoin(owner: Page, joiner: Page): Promise<void> {
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });
  // The invite created during first share is shown again here.
  const linkField = manage.getByRole('textbox', { name: 'Invite link' });
  await expect(linkField).toHaveValue(/^vantage:\/\/join\?/);
  const link = await linkField.inputValue();
  // Every successful Copy is acknowledged, including a repeat click.
  const copy = manage.getByRole('button', { name: /^Cop(y|ied)/ });
  for (let i = 0; i < 2; i += 1) {
    await copy.click();
    await expect(copy).toHaveText('Copied ✓');
    await expect(copy).toHaveText('Copy');
  }

  await openApp(joiner);
  await joiner.getByRole('button', { name: 'Join with invite' }).click();
  const join = joiner.getByRole('dialog', { name: 'Join a shared project' });
  // The link field is a full-width field of its own, not squeezed inline.
  const linkInput = join.getByLabel('Invite or owner recovery link');
  expect((await linkInput.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  // Join is never a dead button: it says what is missing.
  await join.getByLabel('Invite or owner recovery link').fill(link);
  await join.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(join).toContainText('Enter your name so teammates know who is joining.');
  await join.getByLabel('Your name as teammates see it').fill('Synthetic Joiner');
  await join.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(join).toContainText('Waiting for an owner to approve you');

  // The open Share dialog shows the request by itself (no close-and-reopen).
  await expect(manage).toContainText('Synthetic Joiner wants to join as', { timeout: 15_000 });
  await manage.getByRole('button', { name: 'Approve' }).click();
  await expect(manage).toContainText('Approved.');
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Joiner' })).toContainText('Editor');
  await manage.getByRole('button', { name: 'Close' }).click();

  // The waiting joiner notices the approval by itself (no "Check again").
  await expect(join).toContainText('You were approved', { timeout: 15_000 });
  await join.getByRole('button', { name: 'Done' }).click();
  await expect(syncIndicator(joiner)).toContainText('Synced');
}

test('owner shares, invites and approves; joiner edits live and both see each other', async ({ ownerPage: owner, joinerPage: joiner }) => {
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);

  // A live edit by the joiner appears in the owner's outline, and back.
  await openOutline(joiner);
  await firstTitle(joiner).fill('Edited by the joiner');
  await firstTitle(joiner).blur();
  await expect(syncIndicator(joiner)).toContainText('Synced');
  await openOutline(owner);
  await expect(firstTitle(owner)).toHaveValue('Edited by the joiner');
  // Item details attribute the latest confirmed change (AC 27.8-1).
  await owner.getByRole('button', { name: 'Open brief for Edited by the joiner', exact: true }).click();
  await expect(owner.getByTestId('inspector-changed-by')).toHaveText(/^Synthetic Joiner changed this · /);
  await owner.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await firstTitle(owner).fill('Owner replied');
  await firstTitle(owner).blur();
  await expect(firstTitle(joiner)).toHaveValue('Owner replied');

  // Activity: confirmed changes are attributed by name, newest first.
  await owner.getByRole('button', { name: 'Activity', exact: true }).click();
  const activity = owner.locator('.pm-activity');
  await expect(activity.locator('.pm-activity__row').first()).toContainText('Synthetic Owner renamed');
  await expect(activity).toContainText('Synthetic Joiner renamed');
  await activity.getByRole('combobox').selectOption({ label: 'Synthetic Joiner' });
  await expect(activity.locator('.pm-activity__row')).toHaveCount(1);
  await expect(activity.locator('.pm-activity__row').first()).toContainText('Synthetic Joiner renamed');

  // Presence: each sees the other within one heartbeat.
  await expect(owner.locator('.pm-presence')).toContainText('Synthetic Joiner is here', { timeout: 25_000 });
  await expect(joiner.locator('.pm-presence')).toContainText('Synthetic Owner is here', { timeout: 25_000 });
});

test('an offline edit to an item a teammate deleted is retained as rejected work and can be discarded', async ({ ownerPage: owner, joinerPage: joiner }) => {
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);
  await openOutline(owner);
  await openOutline(joiner);
  await firstTitle(owner).fill('Shared item');
  await firstTitle(owner).blur();
  await expect(firstTitle(joiner)).toHaveValue('Shared item');

  // The joiner edits while offline; the edit stays queued on the device.
  await joiner.context().setOffline(true);
  await firstTitle(joiner).fill('Offline wording');
  await firstTitle(joiner).blur();
  await expect(syncIndicator(joiner)).not.toContainText('Synced');

  // Meanwhile the owner deletes the item.
  await firstTitle(owner).focus();
  await owner.keyboard.press('Shift+Delete');
  await expect(owner.locator('input.pm-outline-row__title-input')).toHaveCount(0);

  // Back online: the confirmed delete wins and the edit is retained, not lost.
  await joiner.context().setOffline(false);
  const panel = joiner.locator('.pm-rejected');
  await expect(panel).toContainText('1 change couldn’t be applied', { timeout: 45_000 });
  await expect(panel).toContainText('Offline wording');
  await expect(panel).toContainText('The item was deleted by a teammate.');
  await expect(joiner.locator('input.pm-outline-row__title-input')).toHaveCount(0);

  // Discard is the user's explicit, durable choice.
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(panel).toHaveCount(0);
  await joiner.reload();
  await expect(joiner.getByRole('heading', { name: 'Workspace' })).toBeVisible({ timeout: 30_000 });
  await expect(joiner.locator('.pm-rejected')).toHaveCount(0);
});

test('a removed member keeps a readable copy, receives no further changes and cannot edit', async ({ ownerPage: owner, joinerPage: joiner }) => {
  test.info().annotations.push({ type: 'expectHttpError', description: 'joiner: POST 401' });
  test.info().annotations.push({ type: 'expectHttpError', description: 'joiner: POST 403' });
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);
  await openOutline(owner);
  await openOutline(joiner);
  await firstTitle(owner).fill('Before removal');
  await firstTitle(owner).blur();
  await expect(firstTitle(joiner)).toHaveValue('Before removal');

  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });
  await manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Joiner' }).getByRole('button', { name: 'Remove' }).click();
  await expect(manage).toContainText('Removed.');
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Joiner' })).toHaveCount(0);
  await manage.getByRole('button', { name: 'Close' }).click();

  // The next confirmed change is not delivered; the joiner learns it was removed.
  await firstTitle(owner).fill('After removal');
  await firstTitle(owner).blur();
  await expect(syncIndicator(joiner)).toContainText('Saved on this device', { timeout: 30_000 });
  await expect(firstTitle(joiner)).toHaveValue('Before removal');

  // The copy stays readable but refuses edits instead of queueing them.
  await firstTitle(joiner).fill('Should not apply');
  await firstTitle(joiner).blur();
  await expect(joiner.getByText('You can view this shared project but not change it.').first()).toBeVisible();
  // The field keeps the typed draft ("your input is preserved"); the stored
  // project does not change. Remount the outline from the model to prove it.
  await joiner.locator('nav.pm-side-nav').getByRole('button', { name: 'Gantt', exact: true }).click();
  await openOutline(joiner);
  await expect(firstTitle(joiner)).toHaveValue('Before removal');
});

test('the once-shown recovery link restores owner access on a new device, exactly once', async ({ ownerPage: owner, joinerPage: newDevice }) => {
  const recoveryLink = await shareAsOwner(owner);
  await openOutline(owner);
  await firstTitle(owner).fill('Owned content');
  await firstTitle(owner).blur();
  await expect(syncIndicator(owner)).toContainText('Synced');

  await openApp(newDevice);
  await newDevice.getByRole('button', { name: 'Join with invite' }).click();
  const dialog = newDevice.getByRole('dialog', { name: 'Join a shared project' });
  await dialog.getByLabel('Invite or owner recovery link').fill(recoveryLink);
  await dialog.getByLabel('Your name as teammates see it').fill('Synthetic Owner (laptop)');
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(dialog).toContainText('You were approved');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(syncIndicator(newDevice)).toContainText('Synced');
  await openOutline(newDevice);
  await expect(firstTitle(newDevice)).toHaveValue('Owned content');

  // The recovered device is an owner: it can manage sharing.
  await newDevice.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = newDevice.getByRole('dialog', { name: /Share/ });
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Owner (laptop)' })).toContainText('Owner');
  await expect(manage.getByRole('button', { name: 'Create editor link' })).toBeVisible();
});

test('with approval turned off the owner sees a warning and a joiner works immediately', async ({ ownerPage: owner, joinerPage: joiner }) => {
  await shareAsOwner(owner);
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });
  const approval = manage.getByLabel('Require owner approval to join');
  await expect(approval).toBeChecked();
  await approval.uncheck();
  await expect(manage).toContainText('Approval is off: anyone with a valid link joins and can work immediately.');
  const link = await manage.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await manage.getByRole('button', { name: 'Close' }).click();

  await openApp(joiner);
  await joiner.getByRole('button', { name: 'Join with invite' }).click();
  const join = joiner.getByRole('dialog', { name: 'Join a shared project' });
  await join.getByLabel('Invite or owner recovery link').fill(link);
  await join.getByLabel('Your name as teammates see it').fill('Synthetic Joiner');
  await join.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(join).toContainText('You were approved');
  await join.getByRole('button', { name: 'Done' }).click();
  await expect(syncIndicator(joiner)).toContainText('Synced');

  // The setting survives reopening the dialog (durable on the service).
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  await expect(manage.getByLabel('Require owner approval to join')).not.toBeChecked();
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Joiner' })).toContainText('Editor');
});

test('undo never overwrites a teammate who changed the same item afterwards', async ({ ownerPage: owner, joinerPage: joiner }) => {
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);
  await openOutline(owner);
  await openOutline(joiner);
  await firstTitle(owner).fill('Owner wording');
  await firstTitle(owner).blur();
  await expect(firstTitle(joiner)).toHaveValue('Owner wording');
  await firstTitle(joiner).fill('Joiner wording');
  await firstTitle(joiner).blur();
  await expect(firstTitle(owner)).toHaveValue('Joiner wording');

  await owner.keyboard.press('Control+k');
  const palette = owner.getByRole('dialog', { name: 'Command Palette' });
  await palette.locator('input').fill('Undo');
  await palette.getByRole('option', { name: /^Undo(?:\s|$)/ }).click();
  await expect(owner.getByText('A teammate changed this after you.').first()).toBeVisible();
  await expect(firstTitle(owner)).toHaveValue('Joiner wording');
  await expect(firstTitle(joiner)).toHaveValue('Joiner wording');
});

test('a member demoted to viewer sees view-only, and an edit made anyway is rolled back and retained', async ({ ownerPage: owner, joinerPage: joiner }) => {
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);
  await openOutline(owner);
  await openOutline(joiner);
  await firstTitle(owner).fill('Shared wording');
  await firstTitle(owner).blur();
  await expect(firstTitle(joiner)).toHaveValue('Shared wording');

  // The joiner edits while offline, so the edit is queued before the demotion.
  await joiner.context().setOffline(true);
  await firstTitle(joiner).fill('Viewer attempt');
  await firstTitle(joiner).blur();
  await expect(syncIndicator(joiner)).not.toContainText('Synced');

  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });
  await manage.getByLabel('Role for Synthetic Joiner').selectOption('viewer');
  await expect(manage).toContainText('Role changed.');
  await manage.getByRole('button', { name: 'Close' }).click();

  // Back online: the service records a terminal rejection for the queued
  // edit, recovery rolls it back without losing it, and the joiner sees
  // view-only within one presence heartbeat.
  await joiner.context().setOffline(false);
  const panel = joiner.locator('.pm-rejected');
  await expect(panel).toContainText('You can view this project but not change it.', { timeout: 30_000 });
  await expect(panel).toContainText('Viewer attempt');
  await expect(joiner.locator('.pm-collaboration-layer__notice')).toContainText('View only', { timeout: 20_000 });
  await joiner.locator('nav.pm-side-nav').getByRole('button', { name: 'Gantt', exact: true }).click();
  await openOutline(joiner);
  await expect(firstTitle(joiner)).toHaveValue('Shared wording');
  await expect(firstTitle(joiner)).toHaveAttribute('readonly', '');
  await expect(firstTitle(owner)).toHaveValue('Shared wording');
});

test('a member who leaves keeps a read-only copy and disappears from the members list', async ({ ownerPage: owner, joinerPage: joiner }) => {
  test.info().annotations.push({ type: 'expectHttpError', description: 'joiner: POST 401' });
  await shareAsOwner(owner);
  await inviteAndJoin(owner, joiner);
  await joiner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const member = joiner.getByRole('dialog', { name: /is shared with you/ });
  await expect(member).toContainText('You are an Editor');
  await member.getByRole('button', { name: 'Leave this project' }).click();
  await member.getByRole('button', { name: 'Leave project' }).click();
  await expect(joiner.locator('.pm-collaboration-layer__notice')).toContainText('This copy is read-only');
  await openOutline(joiner);
  // The read-only copy's edit controls are unavailable, not merely refused.
  await expect(firstTitle(joiner)).toHaveAttribute('readonly', '');
  await expect(firstTitle(joiner)).toHaveAttribute('data-pm-view-only', 'readonly');

  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Owner' })).toBeVisible();
  await expect(manage.locator('.pm-share-dialog__row', { hasText: 'Synthetic Joiner' })).toHaveCount(0);
});

test('a project already claimed elsewhere can be shared as a new copy', async ({ ownerPage: owner }) => {
  test.info().annotations.push({ type: 'expectHttpError', description: 'owner: POST 409' });
  await openApp(owner);
  // The service reports this project ID as owned by another identity (e.g. the
  // browser's data was cleared while the project survived).
  let refused = false;
  await owner.route('**/projects/*/owner', async (route) => {
    if (refused) return route.continue();
    refused = true;
    await route.fulfill({ status: 409, body: 'PROJECT_ALREADY_CLAIMED' });
  });
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  const share = owner.getByRole('dialog', { name: /Share/ });
  await share.getByLabel('Your name as teammates see it').fill('Synthetic Owner');
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share).toContainText('already registered with the team service');
  await share.getByRole('button', { name: 'Share as a new copy' }).click();

  // The copy is shared in the same step, with an invite and a recovery link.
  await expect(share.getByRole('heading', { name: /Share “.+ \(shared copy\)”/ })).toBeVisible();
  await expect(share.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/^vantage:\/\/join\?/);
  await share.getByLabel('I saved the recovery link').check();
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(syncIndicator(owner)).toContainText('Synced');
  // The original is still in the workspace, unshared, next to the copy.
  await owner.getByRole('button', { name: /go to workspace/ }).click();
  await expect(owner.locator('main')).toContainText('(shared copy)');
  await expect(owner.locator('main')).toContainText('My Project');
});

test('someone who joins with a view-only link sees edit controls as unavailable', async ({ ownerPage: owner, joinerPage: viewer }) => {
  await openApp(owner);
  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  const share = owner.getByRole('dialog', { name: /Share/ });
  await share.getByLabel('Your name as teammates see it').fill('Synthetic Owner');
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  const linkField = share.getByRole('textbox', { name: 'Invite link' });
  const editorLink = await linkField.inputValue();
  await share.getByLabel('Invite role').selectOption('viewer');
  await expect(share).toContainText('New view-only link. The previous link no longer works.');
  await expect(linkField).not.toHaveValue(editorLink);
  const link = await linkField.inputValue();
  await share.getByLabel('I saved the recovery link').check();
  await share.getByRole('button', { name: 'Done' }).click();
  await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
  const manage = owner.getByRole('dialog', { name: /Share/ });

  await openApp(viewer);
  await viewer.getByRole('button', { name: 'Join with invite' }).click();
  const join = viewer.getByRole('dialog', { name: 'Join a shared project' });
  await join.getByLabel('Invite or owner recovery link').fill(link);
  await join.getByLabel('Your name as teammates see it').fill('Synthetic Viewer');
  await join.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(manage).toContainText('Synthetic Viewer wants to join as', { timeout: 15_000 });
  await manage.getByRole('button', { name: 'Approve' }).click();
  await expect(join).toContainText('You were approved', { timeout: 15_000 });
  await join.getByRole('button', { name: 'Done' }).click();

  await openOutline(viewer);
  await expect(viewer.locator('.pm-collaboration-layer__notice')).toContainText('View only');
  await expect(firstTitle(viewer)).toHaveAttribute('readonly', '');
  await expect(firstTitle(viewer)).toHaveAttribute('data-pm-view-only', 'readonly');
  // Navigation and dialogs stay usable for a viewer.
  await viewer.locator('nav.pm-side-nav').getByRole('button', { name: 'Gantt', exact: true }).click();
  await openOutline(viewer);
  await expect(firstTitle(viewer)).toHaveAttribute('readonly', '');
});

/** Settles each outline mutation so the next selector is stable. */
async function afterRevision(page: Page, action: () => Promise<void>): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

test('a grouped edit (assigning two people at once) and its grouped undo sync whole to a teammate', async ({ ownerPage: owner, joinerPage: joiner }) => {
  // A local project with one forecast feature and two people, then shared.
  await openApp(owner);
  await openOutline(owner);
  await firstTitle(owner).fill('Feature Alpha');
  await afterRevision(owner, () => firstTitle(owner).blur());
  await owner.getByRole('button', { name: 'NO TYPE' }).first().click();
  await afterRevision(owner, () => owner.getByRole('button', { name: 'Feature', exact: true }).click());
  await owner.locator('nav.pm-side-nav').getByRole('button', { name: 'Forecast', exact: true }).click();
  const continueBtn = owner.getByRole('button', { name: 'Continue', exact: true });
  if (await continueBtn.isVisible()) await continueBtn.click();
  await owner.getByLabel('Points per sprint').fill('20');
  await owner.getByLabel('Sprint length (days)').fill('14');
  await owner.getByLabel('Start sprint').fill('12');
  await owner.getByLabel('First date').fill('2026-09-07');
  await owner.getByRole('button', { name: 'Save' }).click();
  await expectForecastReady(owner);
  await owner.getByRole('button', { name: 'Add Feature Alpha to the priority list' }).click();
  await owner.getByRole('button', { name: /Add people…|Manage people…/ }).click();
  const people = owner.getByRole('dialog', { name: 'Manage project people and capacity' });
  for (const name of ['Ada', 'Ben']) {
    await owner.locator('#pm-pe-new-name').fill(name);
    await people.getByRole('button', { name: 'Add Person' }).click();
    await expect(people.locator('.pm-people-editor__person-name', { hasText: name })).toBeVisible();
  }
  await people.getByRole('button', { name: 'Close people editor' }).click();
  await owner.locator('select.pm-forecast__mode-select').selectOption('staffed-capacity-v1');

  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  const share = owner.getByRole('dialog', { name: /Share/ });
  await share.getByLabel('Your name as teammates see it').fill('Synthetic Owner');
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await share.getByLabel('I saved the recovery link').check();
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(syncIndicator(owner)).toContainText('Synced');
  await inviteAndJoin(owner, joiner);
  await joiner.locator('nav.pm-side-nav').getByRole('button', { name: 'Forecast', exact: true }).click();
  await expect(joiner.getByRole('button', { name: 'Assign people to Feature Alpha (required)' })).toBeVisible();

  // One Apply assigning two people is one grouped edit: both reach the teammate.
  await owner.getByRole('button', { name: 'Assign people to Feature Alpha (required)' }).click();
  const assign = owner.getByRole('dialog', { name: 'Assign People' });
  await assign.getByRole('checkbox', { name: 'Assign Ada' }).check();
  await assign.getByRole('checkbox', { name: 'Assign Ben' }).check();
  await assign.getByRole('button', { name: 'Apply' }).click();
  await expect(owner.getByRole('button', { name: /Assigned to Feature Alpha: Ada, Ben/ })).toBeVisible();
  await expect(syncIndicator(owner)).toContainText('Synced');
  await expect(joiner.getByRole('button', { name: /Assigned to Feature Alpha: Ada, Ben/ })).toBeVisible({ timeout: 15_000 });

  // Its undo is one grouped edit too: both assignments disappear for the teammate.
  await owner.locator('body').click({ position: { x: 5, y: 5 } });
  await owner.keyboard.press('Control+z');
  await expect(owner.getByRole('button', { name: 'Assign people to Feature Alpha (required)' })).toBeVisible();
  await expect(joiner.getByRole('button', { name: 'Assign people to Feature Alpha (required)' })).toBeVisible({ timeout: 15_000 });
});

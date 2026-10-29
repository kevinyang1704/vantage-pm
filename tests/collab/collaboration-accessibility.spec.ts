/**
 * Epic 27 automated accessibility scan (axe) of every collaboration surface
 * in light and dark themes: first share (confirm and result), Sharing (invite,
 * approval, members), Join (entry, missing-input hint, waiting), the member
 * dialog, the Activity panel and the view-only notice. Automated rules only;
 * the manual screen-reader pass remains a separate release activity.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { collaborationTest as test, COLLAB_APP_URL } from '../support/fixtures';

async function openApp(page: Page): Promise<void> {
  await page.goto(COLLAB_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible({ timeout: 30_000 });
}

async function scan(page: Page, selector: string, label: string): Promise<void> {
  await expect(page.locator(selector).first()).toBeVisible();
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  expect(results.violations, `${label}: ${JSON.stringify(results.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })), null, 2)}`).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`collaboration surfaces have no automated accessibility violations (${colorScheme})`, async ({ ownerPage: owner, joinerPage: joiner }) => {
    await owner.emulateMedia({ colorScheme });
    await joiner.emulateMedia({ colorScheme });
    await openApp(owner);

    // First share: confirm, then the one-step result (invite + recovery link).
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await scan(owner, '[data-testid="first-share-dialog"]', 'first share confirm');
    const share = owner.getByRole('dialog', { name: /Share/ });
    await share.getByLabel('Your name as teammates see it').fill('Synthetic Owner');
    await share.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(share.getByRole('textbox', { name: 'Invite link' })).toBeVisible();
    await scan(owner, '[data-testid="first-share-dialog"]', 'first share result');
    const link = await share.getByRole('textbox', { name: 'Invite link' }).inputValue();
    await share.getByLabel('I saved the recovery link').check();
    await share.getByRole('button', { name: 'Done' }).click();

    // Sharing (owner): invite, approval and members.
    await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
    const manage = owner.getByRole('dialog', { name: /Share/ });
    await scan(owner, '.pm-share-dialog', 'sharing');

    // Join: entry, missing-input hint, waiting.
    await openApp(joiner);
    await joiner.getByRole('button', { name: 'Join with invite' }).click();
    const join = joiner.getByRole('dialog', { name: 'Join a shared project' });
    await scan(joiner, '[data-testid="join-dialog"]', 'join entry');
    await join.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(join).toContainText('Paste the invite link and enter your name.');
    await scan(joiner, '[data-testid="join-dialog"]', 'join missing input');
    await join.getByLabel('Invite or owner recovery link').fill(link);
    await join.getByLabel('Your name as teammates see it').fill('Synthetic Joiner');
    await join.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(join).toContainText('Waiting for an owner to approve you');
    await scan(joiner, '[data-testid="join-dialog"]', 'join waiting');

    // Owner approves (pending request visible in the scanned dialog first).
    await expect(manage).toContainText('Synthetic Joiner wants to join as', { timeout: 15_000 });
    await scan(owner, '.pm-share-dialog', 'sharing with a pending request');
    await manage.getByRole('button', { name: 'Approve' }).click();
    await expect(manage).toContainText('Approved.');
    await manage.getByRole('button', { name: 'Close' }).click();
    await expect(join).toContainText('You were approved', { timeout: 15_000 });
    await join.getByRole('button', { name: 'Done' }).click();

    // Member dialog (joiner) and the Activity panel.
    await joiner.getByRole('button', { name: 'Sharing', exact: true }).click();
    await scan(joiner, '.pm-share-dialog', 'member dialog');
    await joiner.getByRole('dialog', { name: /is shared with you/ }).getByRole('button', { name: 'Close' }).click();
    await owner.getByRole('button', { name: /Activity/ }).click();
    await scan(owner, '.pm-collaboration-layer', 'activity panel and sync status');

    // View-only notice after demotion.
    await owner.getByRole('button', { name: 'Sharing', exact: true }).click();
    await manage.getByLabel('Role for Synthetic Joiner').selectOption('viewer');
    await expect(manage).toContainText('Role changed.');
    await manage.getByRole('button', { name: 'Close' }).click();
    // The demoted member learns the new role within one presence heartbeat.
    await expect(joiner.locator('.pm-collaboration-layer__notice')).toContainText('View only', { timeout: 20_000 });
    await scan(joiner, '.pm-collaboration-layer', 'view-only notice');
  });
}

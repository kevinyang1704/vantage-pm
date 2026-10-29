import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline, seedFirstNodeTitle } from '../support/helpers/outline-navigation';

for (const bodyText of ['', 'Synthetic brief retained through deletion.']) {
  test(`read-only brief inspection preserves deletion Redo (${bodyText ? 'populated' : 'empty'} brief)`, async ({ page }) => {
    await openFirstProjectOutline(page);
    await seedFirstNodeTitle(page, 'Keep this node');

    const runAction = async (label: string): Promise<void> => {
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog', { name: 'Command Palette' });
      await expect(palette).toBeVisible();
      await palette.locator('input').fill(label);
      const action = palette.getByRole('option', { name: new RegExp(`^${label}(?:\\s|$)`) });
      await expect(action).toHaveAttribute('aria-disabled', 'false');
      await action.click();
      await expect(palette).not.toBeVisible();
    };

    await page.locator('input.pm-outline-row__title-input').first().focus();
    await runAction('Duplicate Subtree');
    const rows = page.locator('input.pm-outline-row__title-input');
    await expect(rows).toHaveCount(2);
    await rows.last().fill('Inspect then redo deletion');
    await rows.last().blur();

    const openBrief = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Open brief for Inspect then redo deletion', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Node brief', exact: true })).toBeVisible();
    };
    if (bodyText) {
      await openBrief();
      await page.getByRole('textbox', { name: 'Node brief', exact: true }).fill(bodyText);
      await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
      await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    }

    await rows.last().focus();
    await runAction('Delete Subtree');
    await expect(rows).toHaveCount(1);
    await runAction('Undo');
    await expect(rows).toHaveCount(2);

    await openBrief();
    const brief = page.getByRole('textbox', { name: 'Node brief', exact: true });
    await expect(brief).toHaveValue(bodyText);
    // Reverting a draft before committing must also leave command history alone.
    await brief.fill(`${bodyText} temporary draft`);
    await brief.fill(bodyText);
    await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();

    await runAction('Redo');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveValue('Keep this node');

    await runAction('Undo');
    await expect(rows).toHaveCount(2);
    await openBrief();
    await page.getByRole('textbox', { name: 'Node brief', exact: true }).fill('A genuine synthetic edit.');
    await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette.locator('input').fill('Redo');
    await expect(palette.getByRole('option', { name: /^Redo(?:\s|$)/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await runAction('Undo');
    await openBrief();
    await expect(page.getByRole('textbox', { name: 'Node brief', exact: true })).toHaveValue(bodyText);
  });
}

test('an unchanged persisted empty-string brief does not advance the project revision', async ({ page }) => {
  await openFirstProjectOutline(page);
  await page.evaluate(async () => {
    const clientPath = '/src/adapters/persistence/repository-worker.client.ts';
    const commandsPath = '/src/contracts/repository-commands.ts';
    const idsPath = '/spikes/phase-0-durability/src/command-receipt.ts';
    const client = await import(clientPath);
    const commands = await import(commandsPath);
    const ids = await import(idsPath);
    const [project] = await client.queryProjects();
    const model = await client.queryProjectNodes(project.id);
    const result = await client.applyProductCommand(commands.createSetNodeBodyTextWireCommand({
      type: 'SetNodeBodyText', commandId: ids.createUuidV7(), projectId: project.id,
      baseRevision: model.projectRevision, nodeId: model.nodes[0].id, bodyText: '',
    }));
    if (result.type !== 'ProductCommandApplied') throw new Error('Could not seed persisted empty brief');
  });
  await seedFirstNodeTitle(page, 'Persisted empty brief');
  const readRevision = () => page.evaluate(async () => {
    const clientPath = '/src/adapters/persistence/repository-worker.client.ts';
    const client = await import(clientPath);
    return (await client.queryProjects())[0].revision;
  });
  await page.getByRole('button', { name: 'Open brief for Persisted empty brief', exact: true }).click();
  const revision = await readRevision();
  await expect(page.getByRole('textbox', { name: 'Node brief', exact: true })).toHaveValue('');
  await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await expect.poll(readRevision).toBe(revision);
});

test('the same brief draft can be retried after an asynchronous save refusal', async ({ page }) => {
  await openFirstProjectOutline(page);
  await seedFirstNodeTitle(page, 'Retry refused brief');
  // Inject one refusal at the existing command port; the actual drawer,
  // application handler, repository refresh and second save remain in use.
  await page.evaluate(async () => {
    const queuePath = '/src/application/command-queue/command-queue-orchestrator.ts';
    const { CommandQueueOrchestrator } = await import(queuePath);
    const prototype = CommandQueueOrchestrator.prototype;
    const original = prototype.dispatchCommand;
    prototype.dispatchCommand = async function (this: unknown, command: { type: string; commandId: string; projectId: string; protocolVersion: number }) {
      if (command.type !== 'SetNodeBodyText') return original.call(this, command);
      prototype.dispatchCommand = original;
      return { type: 'CommandDispatched', commandId: command.commandId, projectId: command.projectId,
        result: { type: 'ProductCommandRejected', protocolVersion: command.protocolVersion,
          commandId: command.commandId, code: 'REVISION_CONFLICT' } };
    };
  });
  await page.getByRole('button', { name: 'Open brief for Retry refused brief', exact: true }).click();
  const brief = page.getByRole('textbox', { name: 'Node brief', exact: true });
  await brief.fill('Synthetic draft survives refusal.');
  await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'outdated version' })).toBeVisible();
  await page.getByRole('tab', { name: /Brief/ }).click();
  await expect(brief).toHaveValue('Synthetic draft survives refusal.');
  await brief.focus();
  await page.getByRole('tab', { name: /Questions & Decisions/ }).click();
  await expect.poll(() => page.evaluate(async () => {
    const clientPath = '/src/adapters/persistence/repository-worker.client.ts';
    const client = await import(clientPath);
    const [project] = await client.queryProjects();
    return (await client.queryProjectNodes(project.id)).nodes[0].bodyText;
  })).toBe('Synthetic draft survives refusal.');
});

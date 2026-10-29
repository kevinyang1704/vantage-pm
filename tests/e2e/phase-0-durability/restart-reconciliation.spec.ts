import { expect, test } from '../../support/fixtures';

const RUN_SEED = 'story-1-1-restart-seed-0001';
const COMMAND_ID = '0198a000-0000-7000-8000-000000000011';
const PROJECT_ID = '0198a000-0000-7000-8000-000000000002';
const BASE_REVISION = 7;
const PRE_COMMIT_BOUNDARIES = [
  'F1_BEFORE_JOURNAL_SYNC',
  'F2_AFTER_JOURNAL_SYNC',
  'F3_BEFORE_JOURNAL_DELETE_FORWARD',
] as const;

test.describe('Story 1.1 restart and exactly-once reconciliation', () => {
  for (const boundaryId of PRE_COMMIT_BOUNDARIES) {
    test(`[P0] leaves zero partial mutation after ${boundaryId}`, async ({ page }) => {
      const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }] =
        await Promise.all([
          import('../../../spikes/phase-0-durability/test-support/harness.port'),
          import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
        ]);
      const durabilityHarness = await createDurabilityHarnessTestPort(page);
      const knownProjectFixture = await loadKnownProjectFixture();
      const outcome = await durabilityHarness.runAndRestart({
        seed: RUN_SEED,
        boundaryId,
        terminationMechanism: 'worker-terminate',
        fixture: knownProjectFixture,
        command: {
          commandId: COMMAND_ID,
          projectId: PROJECT_ID,
          baseRevision: BASE_REVISION,
          safeValueLabel: 'fixture-value-b',
        },
      });

      expect(outcome.restartInspection.quickCheck).toBe('ok');
      expect(outcome.restartInspection.authoredFactCount).toBe(
        outcome.restartInspection.fixtureAuthoredFactCount,
      );
      expect(outcome.restartInspection.workflowFactCount).toBe(
        outcome.restartInspection.fixtureWorkflowFactCount,
      );
      expect(outcome.restartInspection.commandReceiptCount).toBe(0);
      expect(outcome.restartInspection.recordedResultCount).toBe(0);
      expect(outcome.restartInspection.storedRevision).toBe(BASE_REVISION);
      expect(outcome.restartInspection.partialMutation).toBe(false);
      expect(outcome.restartInspection.reconciliationAccepted).toBe(true);
      expect(outcome.restartInspection.recordedBaseRevision).toBe(0);
      expect(outcome.restartInspection.recordedTargetRevision).toBe(0);
      expect(outcome.result.observations.uiAcknowledgement).toBe('NotEmitted');
      expect(outcome.result.oracle.receiptCount).toBe(0);
    });
  }

  test('[P0] recovers an F5 commit by commandId exactly once when UI acknowledgement is lost', async ({ page }) => {
    const [{ createDurabilityHarnessTestPort }, { loadKnownProjectFixture }] =
      await Promise.all([
        import('../../../spikes/phase-0-durability/test-support/harness.port'),
        import('../../../spikes/phase-0-durability/test-support/known-project.fixture'),
      ]);
    const durabilityHarness = await createDurabilityHarnessTestPort(page);
    const knownProjectFixture = await loadKnownProjectFixture();
    const request = {
      seed: RUN_SEED,
      boundaryId: 'F5_AFTER_REPOSITORY_RESULT' as const,
      terminationMechanism: 'worker-terminate' as const,
      fixture: knownProjectFixture,
      command: {
        commandId: COMMAND_ID,
        projectId: PROJECT_ID,
        baseRevision: BASE_REVISION,
        safeValueLabel: 'fixture-value-b',
      },
    };

    const interrupted = await durabilityHarness.runAndRestart(request);
    expect(interrupted.restartInspection.quickCheck).toBe('ok');
    expect(interrupted.result.observations.repositoryResult).toBe('VfsCommitAccepted');
    expect(interrupted.result.observations.uiAcknowledgement).toBe('LostBeforeDelivery');
    expect(interrupted.restartInspection.commandReceiptCount).toBe(1);
    expect(interrupted.restartInspection.storedRevision).toBe(BASE_REVISION + 1);
    expect(interrupted.restartInspection.reconciliationAccepted).toBe(true);
    expect(interrupted.restartInspection.recordedBaseRevision).toBe(BASE_REVISION);
    expect(interrupted.restartInspection.recordedTargetRevision).toBe(BASE_REVISION + 1);

    const retry = await durabilityHarness.retryCommandById(request.command);
    expect(retry.disposition).toBe('StoredResultReturned');
    expect(retry.commandId).toBe(COMMAND_ID);
    expect(retry.resultHash).toBe(interrupted.restartInspection.recordedResultHash);
    expect(retry.commandReceiptCount).toBe(1);
    expect(retry.mutationCount).toBe(1);
    expect(retry.projectRevision).toBe(BASE_REVISION + 1);
    expect(retry.nextCommittedRevision).toBe(BASE_REVISION + 2);
  });
});

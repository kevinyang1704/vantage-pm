import { expect, test } from '../../support/fixtures';

const harnessModule = '../../../spikes/phase-0-durability/test-support/ownership-harness.port';

test.describe('Story 1.2 cooperative handoff (ATDD RED)', () => {
  test('[P0] Story 1.2 O3_COOPERATIVE_HANDOFF fences the old owner and resumes at the authoritative revision', async ({ page, context }) => {
    const { createOwnershipHarness } = await import(harnessModule);
    const result = await (await createOwnershipHarness({ caseId: 'O3_COOPERATIVE_HANDOFF', seed: 'ownership-seed-0002', page, browserContext: context })).runCooperativeHandoff();
    expect(result.events).toEqual(['IntakeStopped', 'QueueResolved', 'StatementsClosed', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'FormerOwnerFenced', 'WebLockAcquired', 'SAHAcquired', 'SQLiteOpened', 'IntegrityVerified', 'ReceiptsReconciled', 'RevisionReconciled']);
    expect(result.formerOwnerWrite).toMatchObject({ accepted: false, code: 'NOT_CURRENT_REPOSITORY_OWNER' });
    expect(result.successor).toMatchObject({ state: 'OwnerReady', quickCheck: 'ok', firstCommandBaseRevision: result.authoritativeRevision });
    expect(result.maximumSimultaneousOwners).toBe(1);
  });
});

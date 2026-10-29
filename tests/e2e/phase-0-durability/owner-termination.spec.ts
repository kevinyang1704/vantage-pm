import { expect, test } from '../../support/fixtures';

const harnessModule = '../../../spikes/phase-0-durability/test-support/ownership-harness.port';

test.describe('Story 1.2 unexpected owner death (ATDD RED)', () => {
  for (const caseId of ['O4_WORKER_DEATH', 'O5_OWNER_PAGE_CLOSE'] as const) {
    test(`[P0] Story 1.2 ${caseId} reconciles committed and uncommitted work before successor writes`, async ({ page, context }) => {
      const { createOwnershipHarness } = await import(harnessModule);
      const result = await (await createOwnershipHarness({ caseId, seed: `ownership-seed-${caseId}`, page, browserContext: context })).runOwnerDeath();
      expect(result.successor).toMatchObject({ legitimatelyAcquiredWebLock: true, legitimatelyAcquiredSah: true, quickCheck: 'ok', state: 'OwnerReady' });
      expect(result.committedCommand).toMatchObject({ mutationCount: 1, receiptCount: 1, reconciliation: 'VfsCommitAccepted' });
      expect(result.uncommittedCommand).toMatchObject({ mutationCount: 0, receiptCount: 0, partialMutation: false });
      expect(result.successor.firstCommandBaseRevision).toBe(result.authoritativeRevision);
      expect(result.maximumSimultaneousOwners).toBe(1);
    });
  }
});

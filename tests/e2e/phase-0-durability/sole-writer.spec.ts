import { expect, test } from '../../support/fixtures';

const harnessModule = '../../../spikes/phase-0-durability/test-support/ownership-harness.port';

test.describe('Story 1.2 sole writer fencing (ATDD RED)', () => {
  for (const caseId of ['O1_CONCURRENT_CONTENDER', 'O2_FROZEN_OWNER'] as const) {
    test(`[P0] Story 1.2 ${caseId} keeps the contender outside Web-Lock SAH and SQLite ownership`, async ({ page, context }) => {
      const { createOwnershipHarness } = await import(harnessModule);
      const harness = await createOwnershipHarness({ caseId, seed: `ownership-seed-${caseId}`, page, browserContext: context });
      const result = await harness.runContenderCase();
      expect(result.pagesShareBrowserContext).toBe(true);
      expect(result.pagesShareOriginAndNamespace).toBe(true);
      expect(result.owner.state).toBe('OwnerReady');
      expect(result.contender).toMatchObject({ type: 'StorageBusy', sahOpenAttempts: 0, sqliteOpenAttempts: 0, writeAttemptsAccepted: 0 });
      expect(result.maximumSimultaneousOwners).toBe(1);
      expect(result.oracle).toMatchObject({ quickCheck: 'ok', revisionChanged: false, receiptCountChanged: false, partialMutation: false });
    });
  }
});

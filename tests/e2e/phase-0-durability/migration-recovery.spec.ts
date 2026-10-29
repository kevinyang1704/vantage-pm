import { expect, test } from '../../support/fixtures';

const harnessModule = '../../../spikes/phase-0-durability/test-support/migration-harness.port';
const points = ['BEFORE_MIGRATION', 'BEFORE_STEP_EXPAND', 'AFTER_STEP_EXPAND', 'BEFORE_STEP_COPY', 'AFTER_STEP_COPY', 'BEFORE_ATOMIC_COMMIT', 'AFTER_SUCCESS_COMMIT'] as const;

test.describe('Story 1.3 migration recovery', () => {
  for (const faultPoint of points) {
    test(`[P0] recovers safely after ${faultPoint}`, async ({ page }) => {
      const { createMigrationHarness } = await import(harnessModule);
      const result = await (await createMigrationHarness({ faultPoint, seed: 'migration-seed-0001', page })).runAndRestart();
      expect(result.backup).toMatchObject({ createdBeforeMutation: true, restorable: true, quickCheck: 'ok', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(result.restart.mode).toMatch(/CandidateV2|VerifiedBackupV1/);
      expect(result.restart.writable).toBe(result.restart.mode === 'CandidateV2');
      expect(result.oracle).toMatchObject({ quickCheck: 'ok', partialSchemaWritable: false, partialMutation: false, duplicateReceipts: 0, revisionRegressed: false });
    });
  }
});

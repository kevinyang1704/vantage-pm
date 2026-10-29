import { expect, test } from '../../support/fixtures';

const harnessModule = '../../../spikes/phase-0-durability/test-support/update-harness.port';

test.describe('Story 1.3 service-worker update recovery', () => {
  for (const blockedCase of ['DIRTY_STATE', 'UNRESOLVED_COMMANDS', 'OWNERSHIP_UNRESOLVED', 'VERIFIED_BACKUP_UNAVAILABLE', 'INCOMPATIBLE_ASSET_SCHEMA', 'APPROVAL_REQUIRED'] as const) {
    test(`[P0] blocks ${blockedCase} before controller change`, async ({ page }) => {
      const { createUpdateHarness } = await import(harnessModule);
      const result = await (await createUpdateHarness({ caseId: blockedCase, seed: 'update-seed-0001', page })).requestActivation();
      expect(result).toMatchObject({ type: 'ActivationBlocked', code: blockedCase, controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true });
    });
  }

  test('[P0] performs the clean compatible update and reaches Active only after recovery oracles', async ({ page }) => {
    const { createUpdateHarness } = await import(harnessModule);
    const result = await (await createUpdateHarness({ caseId: 'CLEAN_COMPATIBLE_UPDATE', seed: 'update-seed-0002', page })).runToActive();
    expect(result.events).toEqual(['Idle', 'Prepared', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'ControllerChanged', 'Reloaded', 'WebLockAcquired', 'SAHAcquired', 'ReceiptsReconciled', 'RevisionReconciled', 'Migrating', 'MigrationSuccessCommitted', 'Active']);
    expect(result.active).toMatchObject({ root: result.expectedNewRoot, schema: result.expectedTargetSchema, quickCheck: 'ok', generalWritesEnabled: true });
  });

  for (const phase of ['BEFORE_PREPARED', 'AFTER_PREPARED', 'AFTER_SQLITE_CLOSE', 'AFTER_VFS_PAUSE', 'AFTER_LOCK_RELEASE', 'AFTER_CONTROLLER_CHANGE', 'AFTER_RELOAD', 'AFTER_REACQUIRE', 'DURING_MIGRATION', 'AFTER_SUCCESS_COMMIT', 'BEFORE_ACTIVE'] as const) {
    test(`[P0] interruption ${phase} never permits mixed writable assets`, async ({ page }) => {
      const { createUpdateHarness } = await import(harnessModule);
      const result = await (await createUpdateHarness({ caseId: phase, seed: 'update-seed-0003', page })).runAndRestart();
      expect(result.mixedAssetsWritable).toBe(false);
      expect(result.restart.mode).toBe(result.controllerChanged ? 'Recovery' : 'old-assets-active');
      expect(result.restart.writable).toBe(result.controllerChanged ? false : true);
      expect(result.oracle).toMatchObject({ partialSchemaWritable: false, dataLoss: false, duplicateReceipts: 0 });
    });
  }
});

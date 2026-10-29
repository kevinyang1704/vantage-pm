import { expect, test } from '@playwright/test';

const backupModule = '../../spikes/phase-0-durability/src/backup';
const migrationModule = '../../spikes/phase-0-durability/src/migration-runner';
const recoveryModule = '../../spikes/phase-0-durability/src/recovery-selector';

test.describe('Story 1.3 backup and migration contracts', () => {
  test('[P0] AC1 verifies a restorable backup before permitting mutation', async () => {
    const { verifyRecoveryBackup } = await import(backupModule);
    expect(await verifyRecoveryBackup({ backupDigest: 'a'.repeat(64), expectedSchema: '1.0.0', expectedRevision: 41, expectedSemanticHash: 'b'.repeat(64) })).toEqual({ status: 'PASS', quickCheck: 'ok', restorable: true, mutationPermitted: true });
  });

  test('[P0] AC1 blocks missing corrupt wrong-schema and unrestorable backup states', async () => {
    const { verifyRecoveryBackup } = await import(backupModule);
    for (const defect of ['missing', 'digest-mismatch', 'wrong-schema', 'unrestorable']) {
      expect(await verifyRecoveryBackup({ defect })).toMatchObject({ status: 'FAIL', code: 'VERIFIED_BACKUP_UNAVAILABLE', mutationPermitted: false });
    }
  });

  test('[P0] AC2 commits ordered migration and success marker atomically', async () => {
    const { runMigration } = await import(migrationModule);
    const result = await runMigration({ migrationId: 'v1-to-v2', sourceSchema: '1.0.0', targetSchema: '2.0.0', orderedSteps: ['expand', 'copy', 'contract'], backupVerified: true });
    expect(result).toMatchObject({ status: 'Committed', observedSteps: ['expand', 'copy', 'contract'], targetSchema: '2.0.0', successMarkerCommitted: true, sameTransaction: true });
  });

  test('[P0] AC2 makes completed migration replay an idempotent no-op', async () => {
    const { replayMigration } = await import(migrationModule);
    expect(await replayMigration({ migrationId: 'v1-to-v2', completed: true, revision: 41, receiptHash: 'a', semanticHash: 'b' })).toEqual({ disposition: 'StoredMigrationResultReturned', mutationCount: 0, revision: 41, receiptHash: 'a', semanticHash: 'b' });
  });

  test('[P0] AC3 selects writable candidate only when every atomic recovery oracle agrees', async () => {
    const { selectMigrationRecovery } = await import(recoveryModule);
    expect(selectMigrationRecovery({ successMarker: true, targetSchema: true, compatibility: true, semanticHash: true, quickCheck: 'ok', backupVerified: true })).toEqual({ type: 'CandidateV2', mode: 'read-write' });
    expect(selectMigrationRecovery({ successMarker: false, targetSchema: true, compatibility: true, semanticHash: true, quickCheck: 'ok', backupVerified: true })).toEqual({ type: 'VerifiedBackupV1', mode: 'read-only' });
  });
});

import { expect, test } from '@playwright/test';

const coordinatorModule = '../../spikes/phase-0-durability/src/update-coordinator';

test.describe('Story 1.3 application-update contracts', () => {
  test('[P0] AC4 returns a stable exact cause for every unsafe pre-controller state', async () => {
    const { prepareUpdate } = await import(coordinatorModule);
    const cases = [
      [{ clean: false }, 'DIRTY_STATE'], [{ clean: true, unresolvedCommands: 1 }, 'UNRESOLVED_COMMANDS'],
      [{ clean: true, unresolvedCommands: 0, ownershipResolved: false }, 'OWNERSHIP_UNRESOLVED'],
      [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: false }, 'VERIFIED_BACKUP_UNAVAILABLE'],
      [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: false }, 'INCOMPATIBLE_ASSET_SCHEMA'],
      [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: true, approved: false }, 'APPROVAL_REQUIRED'],
    ] as const;
    for (const [state, code] of cases) expect(prepareUpdate(state)).toMatchObject({ type: 'ActivationBlocked', code, controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true });
  });

  test('[P0] AC4 requires both asset sets to read and write pre-update and target schemas', async () => {
    const { validateAssetSchemaCompatibility } = await import(coordinatorModule);
    expect(validateAssetSchemaCompatibility({ old: { readSchemas: ['1','2'], writeSchemas: ['1','2'] }, next: { readSchemas: ['1','2'], writeSchemas: ['1','2'] }, fromSchema: '1', targetSchema: '2' })).toEqual({ status: 'PASS' });
    expect(validateAssetSchemaCompatibility({ old: { readSchemas: ['1'], writeSchemas: ['1'] }, next: { readSchemas: ['2'], writeSchemas: ['2'] }, fromSchema: '1', targetSchema: '2' })).toMatchObject({ status: 'FAIL', code: 'INCOMPATIBLE_ASSET_SCHEMA' });
  });

  test('[P0] AC5 accepts only the single legal update transition sequence', async () => {
    const { adjudicateUpdateTrace } = await import(coordinatorModule);
    const sequence = ['Idle', 'Prepared', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'ControllerChanged', 'Reloaded', 'WebLockAcquired', 'SAHAcquired', 'ReceiptsReconciled', 'RevisionReconciled', 'Migrating', 'MigrationSuccessCommitted', 'Active'];
    expect(adjudicateUpdateTrace(sequence)).toMatchObject({ status: 'PASS', terminalState: { type: 'Active', root: expect.any(String), targetSchema: expect.any(String) } });
    expect(adjudicateUpdateTrace([...sequence.slice(0, 5), 'Active'])).toMatchObject({ status: 'FAIL', code: 'ILLEGAL_UPDATE_TRANSITION' });
  });

  test('[P0] AC6 keeps pre-controller failure on old assets and post-controller failure read-only', async () => {
    const { selectUpdateFailureMode } = await import(coordinatorModule);
    expect(selectUpdateFailureMode({ controllerChanged: false })).toEqual({ mode: 'old-assets-active', writable: true });
    expect(selectUpdateFailureMode({ controllerChanged: true })).toEqual({ mode: 'Recovery', writable: false, mixedAssetsAllowed: false });
  });

  test('[P0] AC7 folds any migration or update violation into sticky engineering qualification failure', async () => {
    const evidenceModule = '../../spikes/phase-0-durability/src/evidence-contract';
    const { foldEngineeringQualification } = await import(evidenceModule);
    expect(foldEngineeringQualification([{ caseId: 'MIGRATION_AFTER_STEP_COPY', status: 'FAIL', code: 'PARTIAL_SCHEMA_WRITABLE' }, { caseId: 'UPDATE_CLEAN', status: 'PASS' }])).toMatchObject({ status: 'FAIL', retainedFailures: [{ caseId: 'MIGRATION_AFTER_STEP_COPY', code: 'PARTIAL_SCHEMA_WRITABLE' }] });
  });
});

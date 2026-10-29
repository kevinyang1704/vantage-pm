import { describe, expect, it } from 'vitest';
import { createRevisionProtocolTestPort } from '../src/revision-protocol';
import { evaluateOwnership, reduceOwnershipLifecycle, verifyCooperativeHandoff } from '../src/ownership-protocol';
import { selectMigrationRecovery } from '../src/migration-protocol';
import { decideUpdate } from '../src/update-gate';
import { RecoveryLockState } from '../src/recovery-safe-vfs';
import { executeCooperativeHandoff } from '../src/cooperative-handoff';
import { createKnownFixtureCommand } from '../src/command-receipt';
import { commandApplied, isResponseFromCurrentOwner } from '../src/repository-protocol';
import { verifyRecoveryBackup } from '../src/backup';
import { runMigration, replayMigration } from '../src/migration-runner';
import { selectMigrationRecovery as selectRecovery } from '../src/recovery-selector';
import { prepareUpdate, validateAssetSchemaCompatibility, adjudicateUpdateTrace, selectUpdateFailureMode } from '../src/update-coordinator';

describe('phase-0 protocols', () => {
  it('requires a replacement snapshot after a revision gap', async () => {
    const port = createRevisionProtocolTestPort();
    await port.replaceWithSnapshot({ projectId: 'p', revision: 7, safeStateHash: 'h' });
    expect((await port.acceptDelta({ projectId: 'p', baseRevision: 7, targetRevision: 9, safeResultHash: 'r' })).type).toBe('ResyncRequired');
    expect(await port.acceptDelta({ projectId: 'p', baseRevision: 7, targetRevision: 8, safeResultHash: 'r' })).toMatchObject({ code: 'FULL_SNAPSHOT_REQUIRED' });
  });
  it('never opens SQLite for a lock contender', () => expect(evaluateOwnership(false, [])).toMatchObject({ type: 'StorageBusy', mode: 'read-only-frozen' }));
  it('verifies only the exact cooperative handoff grammar', () => {
    const exact = ['IntakeStopped','QueueResolved','StatementsClosed','SQLiteClosed','VfsPaused','WebLockReleased','FormerOwnerFenced'] as const;
    expect(verifyCooperativeHandoff([...exact])).toMatchObject({ type: 'HandoffVerified', formerOwnerWritable: false });
    expect(() => verifyCooperativeHandoff([...exact, 'FormerOwnerFenced'])).toThrow('HANDOFF_EVENT_REPEATED');
    expect(() => verifyCooperativeHandoff(['IntakeStopped','QueueResolved','SQLiteClosed','StatementsClosed','VfsPaused','WebLockReleased','FormerOwnerFenced'])).toThrow('HANDOFF_ORDER');
  });
  it('rejects duplicates and post-release transitions in the global ownership grammar', () => {
    const identity = { contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 1 };
    const exact = ['WebLockAcquired','SAHAcquired','SQLiteOpened','IntegrityVerified','ReceiptsReconciled','RevisionReconciled','OwnerReady','IntakeStopped','QueueResolved','StatementsClosed','SQLiteClosed','VfsPaused','WebLockReleased','FormerOwnerFenced'] as const;
    expect(reduceOwnershipLifecycle([...exact], identity)).toMatchObject({ state: 'Released', writable: false });
    expect(() => reduceOwnershipLifecycle([...exact, 'OwnerReady'], identity)).toThrow('OWNERSHIP_EVENT_REPEATED');
  });
  it('awaits accepted work and records SQLiteClosed only after database close resolves', async () => {
    const events: string[] = [];
    let resolveQueue!: () => void;
    let resolveClose!: () => void;
    const resultPromise = executeCooperativeHandoff({
      identity: { contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 1 },
      stopIntake: () => events.push('stop'), resumeIntake: () => events.push('resume'),
      resolveQueue: () => new Promise<void>((resolve) => { resolveQueue = resolve; }),
      closeStatements: async () => undefined,
      closeDatabase: () => new Promise<void>((resolve) => { resolveClose = resolve; }),
      pauseVfs: async () => undefined, releaseWebLock: () => events.push('release'),
      record: (event) => events.push(event),
    });
    await Promise.resolve();
    expect(events).toEqual(['stop']);
    resolveQueue();
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(['stop', 'IntakeStopped', 'QueueResolved', 'StatementsClosed']);
    resolveClose();
    await expect(resultPromise).resolves.toMatchObject({ type: 'HandoffReleased', lockReleased: true });
    expect(events).toEqual(['stop','IntakeStopped','QueueResolved','StatementsClosed','SQLiteClosed','VfsPaused','release','WebLockReleased','FormerOwnerFenced']);
  });
  it('resumes intake after a transient queue drain failure so a later handoff may retry', async () => {
    let resumed = false;
    const result = await executeCooperativeHandoff({
      identity: { contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 1 },
      stopIntake: () => undefined, resumeIntake: () => { resumed = true; },
      resolveQueue: async () => { throw new Error('TRANSIENT'); }, closeStatements: async () => undefined,
      closeDatabase: async () => undefined, pauseVfs: async () => undefined, releaseWebLock: () => undefined,
    });
    expect(result).toMatchObject({ type: 'HandoffBlocked', exactCause: 'QUEUE_UNRESOLVED', lockReleased: false });
    expect(resumed).toBe(true);
  });
  it('fences a structurally valid late result from a former owner session', () => {
    const current = { contextId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', ownerSessionId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5', writerEpoch: 2 };
    const response = commandApplied({
      type: 'ApplyCommand', protocolVersion: '1.0.0', requestId: '01992f5c-7a10-7cc6-8b11-89ea06c8f9f6',
      contextId: current.contextId, ownerSessionId: '01992f5c-7a10-7cc7-8b11-89ea06c8f9f7', writerEpoch: 1,
      command: createKnownFixtureCommand({ baseRevision: 7, safeValueHash: 'a'.repeat(64) }),
    });
    expect(isResponseFromCurrentOwner(response, current)).toBe(false);
  });
  it('handles all migration recovery branches', () => {
    expect(selectMigrationRecovery({ backupVerified: false, candidateTransactionCommitted: true, successMarkerCommitted: true, candidateQuickCheck: 'ok', backupQuickCheck: 'ok' })).toEqual({ type: 'RecoveryBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', mode: 'closed' });
    expect(selectMigrationRecovery({ backupVerified: true, candidateTransactionCommitted: true, successMarkerCommitted: true, candidateQuickCheck: 'ok', backupQuickCheck: 'failed' })).toEqual({ type: 'RecoveryBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', mode: 'closed' });
    expect(selectMigrationRecovery({ backupVerified: true, candidateTransactionCommitted: true, successMarkerCommitted: true, candidateQuickCheck: 'ok', backupQuickCheck: 'ok' })).toEqual({ type: 'CandidateV2', mode: 'read-write' });
    expect(selectMigrationRecovery({ backupVerified: true, candidateTransactionCommitted: true, successMarkerCommitted: false, candidateQuickCheck: 'ok', backupQuickCheck: 'ok' })).toEqual({ type: 'VerifiedBackupV1', mode: 'read-only' });
    expect(selectMigrationRecovery({ backupVerified: true, candidateTransactionCommitted: true, successMarkerCommitted: true, candidateQuickCheck: 'failed', backupQuickCheck: 'ok' })).toEqual({ type: 'VerifiedBackupV1', mode: 'read-only' });
  });
  it.each([
    [{ clean: false, unresolvedCommands: 0, compatible: true, approved: true }, 'DIRTY_STATE'],
    [{ clean: true, unresolvedCommands: 1, compatible: true, approved: true }, 'UNRESOLVED_COMMANDS'],
    [{ clean: true, unresolvedCommands: 0, compatible: false, approved: true }, 'INCOMPATIBLE_ASSET_SCHEMA'],
    [{ clean: true, unresolvedCommands: 0, compatible: true, approved: false }, 'APPROVAL_REQUIRED'],
  ] as const)('blocks unsafe update state', (state, code) => expect(decideUpdate(state)).toMatchObject({ type: 'ActivationBlocked', code }));
  it('allows update when clean, compatible, resolved, and approved', () => {
    expect(decideUpdate({ clean: true, unresolvedCommands: 0, compatible: true, approved: true })).toEqual({
      type: 'ActivationAllowed',
      assets: 'phase0-v2-candidate',
      schema: '2.0.0',
    });
  });

  it('reports reserved ownership from successful tracked lock transitions after one downstream check', () => {
    const state = new RecoveryLockState({ initial: 0, ok: 0, reserved: 2 });
    let lockCalls = 0;
    let checkCalls = 0;
    let output = -1;

    expect(state.forwardLock(1, () => { lockCalls += 1; return 0; })).toBe(0);
    expect(state.forwardCheckReservedLock(
      () => { checkCalls += 1; output = 1; return 0; },
      (reserved) => { output = reserved; },
    )).toBe(0);
    expect({ lockCalls, checkCalls, output, current: state.current }).toEqual({
      lockCalls: 1, checkCalls: 1, output: 0, current: 1,
    });

    expect(state.forwardLock(2, () => { lockCalls += 1; return 0; })).toBe(0);
    expect(state.forwardCheckReservedLock(
      () => { checkCalls += 1; output = 0; return 0; },
      (reserved) => { output = reserved; },
    )).toBe(0);
    expect({ lockCalls, checkCalls, output, current: state.current }).toEqual({
      lockCalls: 2, checkCalls: 2, output: 1, current: 2,
    });

    expect(state.forwardUnlock(1, () => 0)).toBe(0);
    expect(state.current).toBe(1);
  });

  it('preserves lock truth and output when downstream lock callbacks fail', () => {
    const state = new RecoveryLockState({ initial: 1, ok: 0, reserved: 2 });
    expect(state.forwardLock(2, () => 10)).toBe(10);
    expect(state.current).toBe(1);
    expect(state.forwardUnlock(0, () => 10)).toBe(10);
    expect(state.current).toBe(1);

    let output = 7;
    let calls = 0;
    expect(state.forwardCheckReservedLock(
      () => { calls += 1; output = 1; return 10; },
      (reserved) => { output = reserved; },
    )).toBe(10);
    expect({ calls, output, current: state.current }).toEqual({ calls: 1, output: 1, current: 1 });
  });

  it('does not mutate tracked lock state when a downstream callback throws', () => {
    const state = new RecoveryLockState({ initial: 1, ok: 0, reserved: 2 });
    expect(() => state.forwardLock(4, () => { throw new Error('DOWNSTREAM_FAILURE'); })).toThrow('DOWNSTREAM_FAILURE');
    expect(state.current).toBe(1);
    expect(() => state.forwardUnlock(0, () => { throw new Error('DOWNSTREAM_FAILURE'); })).toThrow('DOWNSTREAM_FAILURE');
    expect(state.current).toBe(1);
  });

  it('verifies a restorable backup and permits mutation only on full success', async () => {
    expect(await verifyRecoveryBackup({ backupDigest: 'a'.repeat(64), expectedSchema: '1.0.0', expectedRevision: 7, expectedSemanticHash: 'b'.repeat(64) })).toMatchObject({ status: 'PASS', mutationPermitted: true });
    for (const defect of ['missing', 'digest-mismatch', 'wrong-schema', 'unrestorable'] as const) {
      expect(await verifyRecoveryBackup({ defect })).toMatchObject({ status: 'FAIL', code: 'VERIFIED_BACKUP_UNAVAILABLE', mutationPermitted: false });
    }
  });

  it('commits an ordered migration atomically with its success marker', async () => {
    expect(await runMigration({ migrationId: 'v1-to-v2', sourceSchema: '1.0.0', targetSchema: '2.0.0', orderedSteps: ['expand', 'copy', 'contract'], backupVerified: true })).toMatchObject({ status: 'Committed', successMarkerCommitted: true, sameTransaction: true });
    await expect(runMigration({ migrationId: 'm', sourceSchema: '1.0.0', targetSchema: '2.0.0', orderedSteps: ['expand'], backupVerified: false })).rejects.toThrow('VERIFIED_BACKUP_UNAVAILABLE');
  });

  it('replays a completed migration as an idempotent no-op', async () => {
    expect(await replayMigration({ migrationId: 'v1-to-v2', completed: true, revision: 41, receiptHash: 'a', semanticHash: 'b' })).toEqual({ disposition: 'StoredMigrationResultReturned', mutationCount: 0, revision: 41, receiptHash: 'a', semanticHash: 'b' });
    await expect(replayMigration({ migrationId: 'v1-to-v2', completed: false, revision: 41, receiptHash: 'a', semanticHash: 'b' })).rejects.toThrow('MIGRATION_NOT_COMPLETED');
  });

  it('selects read-write candidate only when every recovery oracle agrees', () => {
    expect(selectRecovery({ successMarker: true, targetSchema: true, compatibility: true, semanticHash: true, quickCheck: 'ok', backupVerified: true })).toEqual({ type: 'CandidateV2', mode: 'read-write' });
    expect(selectRecovery({ successMarker: false, targetSchema: true, compatibility: true, semanticHash: true, quickCheck: 'ok', backupVerified: true })).toEqual({ type: 'VerifiedBackupV1', mode: 'read-only' });
    expect(selectRecovery({ successMarker: true, targetSchema: true, compatibility: true, semanticHash: true, quickCheck: 'ok', backupVerified: false })).toEqual({ type: 'RecoveryBlocked', code: 'VERIFIED_BACKUP_UNAVAILABLE', mode: 'closed' });
  });

  it.each([
    [{ clean: false, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: true, approved: true }, 'DIRTY_STATE'],
    [{ clean: true, unresolvedCommands: 1, ownershipResolved: true, backupVerified: true, compatible: true, approved: true }, 'UNRESOLVED_COMMANDS'],
    [{ clean: true, unresolvedCommands: 0, ownershipResolved: false, backupVerified: true, compatible: true, approved: true }, 'OWNERSHIP_UNRESOLVED'],
    [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: false, compatible: true, approved: true }, 'VERIFIED_BACKUP_UNAVAILABLE'],
    [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: false, approved: true }, 'INCOMPATIBLE_ASSET_SCHEMA'],
    [{ clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: true, approved: false }, 'APPROVAL_REQUIRED'],
  ] as const)('update-coordinator blocks unsafe pre-controller state %s', (state, code) => expect(prepareUpdate(state)).toMatchObject({ type: 'ActivationBlocked', code, controllerChanged: false, databaseMutated: false, currentAssetsRemainActive: true }));

  it('validates asset schema compatibility requires both asset sets to read and write both schemas', () => {
    expect(validateAssetSchemaCompatibility({ old: { readSchemas: ['1', '2'], writeSchemas: ['1', '2'] }, next: { readSchemas: ['1', '2'], writeSchemas: ['1', '2'] }, fromSchema: '1', targetSchema: '2' })).toEqual({ status: 'PASS' });
    expect(validateAssetSchemaCompatibility({ old: { readSchemas: ['1'], writeSchemas: ['1'] }, next: { readSchemas: ['2'], writeSchemas: ['2'] }, fromSchema: '1', targetSchema: '2' })).toMatchObject({ status: 'FAIL', code: 'INCOMPATIBLE_ASSET_SCHEMA' });
  });

  it('adjudicates only the exact legal update transition sequence', () => {
    const legal = ['Idle', 'Prepared', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased', 'ControllerChanged', 'Reloaded', 'WebLockAcquired', 'SAHAcquired', 'ReceiptsReconciled', 'RevisionReconciled', 'Migrating', 'MigrationSuccessCommitted', 'Active'];
    expect(adjudicateUpdateTrace(legal)).toMatchObject({ status: 'PASS', terminalState: { type: 'Active' } });
    expect(adjudicateUpdateTrace([...legal.slice(0, 5), 'Active'])).toMatchObject({ status: 'FAIL', code: 'ILLEGAL_UPDATE_TRANSITION' });
  });

  it('keeps pre-controller failure on old assets and post-controller failure read-only', () => {
    expect(selectUpdateFailureMode({ controllerChanged: false })).toEqual({ mode: 'old-assets-active', writable: true });
    expect(selectUpdateFailureMode({ controllerChanged: true })).toEqual({ mode: 'Recovery', writable: false, mixedAssetsAllowed: false });
  });
});

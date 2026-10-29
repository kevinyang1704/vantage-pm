import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const RUN_ID = '01992f5c-7a10-7cd0-8b11-89ea06c8f9f0';
const ATTEMPT_ID = '01992f5c-7a10-7cd1-8b11-89ea06c8f9f1';
const PROJECT_ID = '0198a000-0000-7000-8000-000000000003';
const COMMAND_ID = '0198a000-0000-7000-8000-000000000004';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function cohort(overrides: Partial<{ appForm: 'browser-tab' | 'installed'; storageState: string }> = {}) {
  return {
    browserName: 'Google Chrome' as const,
    browserBuild: 'Chrome 151.0.0.0',
    browserChannel: 'stable' as const,
    appForm: overrides.appForm ?? 'browser-tab',
    storageState: overrides.storageState ?? 'persistence-granted',
  };
}

function logicalEvidence(input: { caseId?: 'F1_BEFORE_JOURNAL_SYNC' | 'F4_AFTER_COMMIT_RETURN'; status?: 'PASS' | 'FAIL'; appForm?: 'browser-tab' | 'installed' } = {}) {
  const caseId = input.caseId ?? 'F1_BEFORE_JOURNAL_SYNC';
  const committed = caseId === 'F4_AFTER_COMMIT_RETURN';
  const status = input.status ?? 'PASS';
  const oracle = {
    quickCheck: 'ok', mutationCount: committed ? 1 : 0, authoredFactCount: 0, workflowFactCount: 0,
    fixtureAuthoredFactCount: 0, fixtureWorkflowFactCount: 0, commandReceiptCount: committed ? 1 : 0,
    recordedResultCount: committed ? 1 : 0, storedRevision: committed ? 8 : 7, nextRevision: committed ? 9 : 8,
    recordedResultHash: committed ? HASH_B : null, safeValueHash: committed ? HASH_B : HASH_A,
    partialMutation: status === 'FAIL',
    semanticState: JSON.stringify({
      projectId: PROJECT_ID, revision: committed ? 8 : 7, safeValueHash: committed ? HASH_B : HASH_A,
      mutationCount: committed ? 1 : 0, receiptCount: committed ? 1 : 0, recordedResultCount: committed ? 1 : 0,
    }),
    semanticDatabaseHash: HASH_A, reconciliationAccepted: status !== 'FAIL',
    recordedBaseRevision: committed ? 7 : 0, recordedTargetRevision: committed ? 8 : 0,
  };
  return {
    schemaVersion: '1.4.0' as const,
    evidenceType: 'releaseCertification' as const,
    runId: RUN_ID, attemptId: ATTEMPT_ID, caseId, required: true as const, status,
    cohort: cohort({ appForm: input.appForm }),
    manifest: {
      seed: 'gate-b-seed',
      adapter: {
        sqliteVersion: '3.53.0', sqliteSourceId: 'source-id', vfs: 'pmapp-sah', recoveryVfs: 'pmapp-recovery',
        wrappedVfs: 'pmapp-wrap', journalMode: 'delete', synchronous: 3, foreignKeys: 1, quickCheck: 'ok',
        databasePath: `/pmapp-phase0/run-${RUN_ID}/repository.sqlite3`,
      },
      source: {
        lockfileHash: HASH_A, buildHash: HASH_A, headRevision: 'f'.repeat(40), worktreeState: 'dirty',
        worktreeStatusDigest: HASH_A, executableTreeDigest: HASH_A,
        sourceFiles: { 'src/recovery-safe-vfs.ts': HASH_A },
      },
      qualification: {
        qualificationSubjectDigest: HASH_A, productionCompositionRoot: HASH_A,
        instrumentedCompositionRoot: HASH_B, parityStatus: 'PASS', compositionDerivationStatus: 'PASS',
      },
      environment: {
        osBuild: 'Win32', browserName: 'chrome', browserBuild: 'Chrome 151', appForm: input.appForm ?? 'browser-tab',
        storageState: 'origin-private',
      },
      fixture: { projectId: PROJECT_ID, initialRevision: 7, safeStateHash: HASH_A },
      command: { commandId: COMMAND_ID, projectId: PROJECT_ID, baseRevision: 7, expectedRevision: 8, safeValueHash: HASH_B },
      injection: { boundaryId: caseId }, terminationMechanism: 'worker-terminate',
    },
    observations: {
      boundaryId: caseId,
      boundaryEvent: {
        type: 'BoundaryObserved', boundaryId: caseId, sequence: 2, runId: RUN_ID,
        connectionId: '01992f5c-7a10-7cd2-8b11-89ea06c8f9d2',
        databasePath: `/pmapp-phase0/run-${RUN_ID}/repository.sqlite3`,
        rollbackJournalPath: `/pmapp-phase0/run-${RUN_ID}/repository.sqlite3-journal`,
        commandId: COMMAND_ID, commitAttemptId: '01992f5c-7a10-7cd3-8b11-89ea06c8f9f3',
        forwardedBeforeTermination: false, physicalDirectorySync: 'Unobservable',
      },
      callbackTrace: [{
        type: 'VfsCallbackForwarded', method: 'xLock', role: 'database', sequence: 1,
        downstreamCalls: 1, argumentsEqual: true, productionReturnCode: 0, instrumentedReturnCode: 0,
      }],
      commandedValueHash: HASH_B,
    },
    oracle,
    failure: status === 'FAIL' ? {
      code: 'CONTRACT_FAILURE', cause: 'Technical contract failure', resultingState: oracle,
      architectureDecisionRequired: 'Correct the technical contract',
    } : null,
    artifactHashes: { semantic: HASH_A },
    immutableEvidenceUri: `reports/evidence/phase-0-durability/${ATTEMPT_ID}/runs/${RUN_ID}.json`,
  };
}

function degradedEvidence(input: {
  caseId?: 'DEGRADED_PERSISTENCE_DENIED' | 'DEGRADED_QUOTA_EXHAUSTED' | 'DEGRADED_PRIVATE_GUEST_PROFILE';
  status?: 'PASS' | 'FAIL';
} = {}) {
  const caseId = input.caseId ?? 'DEGRADED_PERSISTENCE_DENIED';
  const status = input.status ?? 'PASS';
  const deniedCapability = { DEGRADED_PERSISTENCE_DENIED: 'persist', DEGRADED_QUOTA_EXHAUSTED: 'quota', DEGRADED_PRIVATE_GUEST_PROFILE: 'private-profile' }[caseId];
  const signals = { persisted: false, quotaExhausted: caseId === 'DEGRADED_QUOTA_EXHAUSTED', isPrivateProfile: caseId === 'DEGRADED_PRIVATE_GUEST_PROFILE' };
  const resultCode = 'RepositoryRejected';
  const semanticHash = createHash('sha256').update(JSON.stringify({ signals, deniedCapability, resultCode })).digest('hex');
  return {
    schemaVersion: '1.4.0' as const,
    evidenceType: 'releaseCertification' as const,
    runId: RUN_ID, attemptId: ATTEMPT_ID, caseId, required: true as const, status,
    cohort: cohort({ storageState: caseId === 'DEGRADED_PERSISTENCE_DENIED' ? 'persistence-denied' : caseId === 'DEGRADED_QUOTA_EXHAUSTED' ? 'quota-exhausted' : 'private-guest-profile' }),
    manifest: {
      seed: 'gate-b-degraded-seed',
      source: {
        lockfileHash: HASH_A, buildHash: HASH_A, headRevision: 'f'.repeat(40), worktreeState: 'dirty',
        worktreeStatusDigest: HASH_A, executableTreeDigest: HASH_A,
        sourceFiles: { 'src/recovery-safe-vfs.ts': HASH_A },
      },
      qualification: {
        qualificationSubjectDigest: HASH_A, productionCompositionRoot: HASH_A,
        instrumentedCompositionRoot: HASH_B, parityStatus: 'PASS', compositionDerivationStatus: 'PASS',
      },
      signals, deniedCapability,
    },
    observations: { caseId, resultCode },
    oracle: { grantEvaluated: true, grantWithheld: true, durableAcknowledgedEmitted: false, recoverableInputPreserved: status === 'PASS' },
    failure: status === 'FAIL' ? { code: 'RECOVERABLE_INPUT_LOST', cause: 'Input was not preserved under denial' } : null,
    artifactHashes: { semantic: semanticHash },
    immutableEvidenceUri: `reports/evidence/phase-0-durability/${ATTEMPT_ID}/runs/${RUN_ID}.json`,
  };
}

function deferredEvidence(caseId: 'VM_POWER_LOSS' | 'PHYSICAL_POWER_INTERRUPTION' | 'UPDATE_MIGRATION_MATRIX' = 'VM_POWER_LOSS') {
  return {
    schemaVersion: '1.4.0' as const,
    evidenceType: 'releaseCertification' as const,
    runId: RUN_ID, attemptId: ATTEMPT_ID, caseId, required: true as const, status: 'FAIL' as const,
    cohort: cohort(),
    manifest: { deferralReason: 'Requires real VM/physical infrastructure, see gate-b-physical-and-vm-runbook.md' },
    observations: {},
    oracle: {},
    failure: { code: 'CASE_NOT_YET_EXECUTED', cause: 'No real VM/physical infrastructure available in this environment' },
    artifactHashes: { semantic: HASH_A },
    immutableEvidenceUri: `reports/evidence/phase-0-durability/${ATTEMPT_ID}/runs/${RUN_ID}.json`,
  };
}

test.describe('Story 1.4 Gate B evidence contract', () => {
  test('[P0] parses a reused F1-F6 logical cell under the releaseCertification envelope', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    const parsed = parseReleaseCertificationRun(logicalEvidence());
    expect(parsed.evidenceType).toBe('releaseCertification');
    expect(parsed.cohort.appForm).toBe('browser-tab');
  });

  test('[P0] accepts installed-PWA appForm in both cohort and environment', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(() => parseReleaseCertificationRun(logicalEvidence({ appForm: 'installed' }))).not.toThrow();
  });

  test('[P0] browser-tab (the pre-existing Story 1.1-1.3 literal) remains a valid appForm after the relax', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(() => parseReleaseCertificationRun(logicalEvidence({ appForm: 'browser-tab' }))).not.toThrow();
    expect(() => parseReleaseCertificationRun(logicalEvidence({ appForm: 'desktop-app' as never }))).toThrow('INVALID_EVIDENCE_VALUE');
  });

  test('[P0] rejects an evidenceType/caseId mismatch and unknown fields', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(() => parseReleaseCertificationRun({ ...logicalEvidence(), evidenceType: 'engineeringQualification' })).toThrow('INVALID_EVIDENCE_VALUE:evidenceType');
    expect(() => parseReleaseCertificationRun({ ...logicalEvidence(), extraField: 'nope' })).toThrow('UNKNOWN_EVIDENCE_FIELD');
  });

  test('[P0] degraded-mode cases pass only by confirming grant withholding and never DurableCommitAcknowledged', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    for (const caseId of ['DEGRADED_PERSISTENCE_DENIED', 'DEGRADED_QUOTA_EXHAUSTED', 'DEGRADED_PRIVATE_GUEST_PROFILE'] as const) {
      const parsed = parseReleaseCertificationRun(degradedEvidence({ caseId }));
      expect(parsed.oracle).toMatchObject({ durableAcknowledgedEmitted: false, grantWithheld: true });
    }
    const tampered = degradedEvidence();
    expect(() => parseReleaseCertificationRun({
      ...tampered, oracle: { ...tampered.oracle, durableAcknowledgedEmitted: true },
    })).toThrow('INVALID_EVIDENCE_VALUE:oracle.durableAcknowledgedEmitted');
  });

  test('[P0] deferred VM/physical/update cases accept only an honest documented FAIL, never a fabricated PASS', async () => {
    const { parseReleaseCertificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    for (const caseId of ['VM_POWER_LOSS', 'PHYSICAL_POWER_INTERRUPTION', 'UPDATE_MIGRATION_MATRIX'] as const) {
      const parsed = parseReleaseCertificationRun(deferredEvidence(caseId));
      expect(parsed.status).toBe('FAIL');
      expect(parsed.failure).toMatchObject({ code: 'CASE_NOT_YET_EXECUTED' });
    }
    expect(() => parseReleaseCertificationRun({ ...deferredEvidence(), status: 'PASS', failure: null })).toThrow();
  });

  test('[P0] foldReleaseCertification stays FAIL for the whole attempt while any deferred/degraded case is FAIL', async () => {
    const { foldReleaseCertification } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    const allPassExceptDeferred = [
      { caseId: 'F1_BEFORE_JOURNAL_SYNC' as const, status: 'PASS' as const },
      { caseId: 'DEGRADED_PERSISTENCE_DENIED' as const, status: 'PASS' as const },
      { caseId: 'VM_POWER_LOSS' as const, status: 'FAIL' as const, code: 'CASE_NOT_YET_EXECUTED' },
    ];
    expect(foldReleaseCertification(allPassExceptDeferred)).toMatchObject({
      status: 'FAIL', retainedFailures: [{ caseId: 'VM_POWER_LOSS', code: 'CASE_NOT_YET_EXECUTED' }],
    });
    expect(foldReleaseCertification([{ caseId: 'F1_BEFORE_JOURNAL_SYNC' as const, status: 'PASS' as const }])).toMatchObject({ status: 'PASS', retainedFailures: [] });
  });

  test('[P0] parseGateEvidenceRun dispatches on evidenceType, not caseId set membership', async () => {
    const { parseGateEvidenceRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(parseGateEvidenceRun(logicalEvidence()).evidenceType).toBe('releaseCertification');
    expect(() => parseGateEvidenceRun({ evidenceType: 'somethingElse' })).toThrow('INVALID_EVIDENCE_TYPE');
  });
});

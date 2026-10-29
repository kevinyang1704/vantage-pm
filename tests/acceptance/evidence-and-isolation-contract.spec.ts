import { expect, test } from '@playwright/test';

const RUN_ID = '01992f5c-7a10-7cc0-8b11-89ea06c8f9f0';
const ATTEMPT_ID = '01992f5c-7a10-7cc1-8b11-89ea06c8f9f1';
const PROJECT_ID = '0198a000-0000-7000-8000-000000000002';
const COMMAND_ID = '0198a000-0000-7000-8000-000000000001';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function evidence(input: {
  runId?: string;
  attemptId?: string;
  caseId?: 'F1_BEFORE_JOURNAL_SYNC' | 'F4_AFTER_COMMIT_RETURN';
  status?: 'PASS' | 'FAIL';
} = {}) {
  const runId = input.runId ?? RUN_ID;
  const attemptId = input.attemptId ?? ATTEMPT_ID;
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
    schemaVersion: '1.0.0' as const,
    evidenceType: 'engineeringQualification' as const,
    runId, attemptId, caseId, required: true as const, status,
    manifest: {
      seed: 'contract-seed',
      adapter: {
        sqliteVersion: '3.53.0', sqliteSourceId: 'source-id', vfs: 'pmapp-sah', recoveryVfs: 'pmapp-recovery',
        wrappedVfs: 'pmapp-wrap', journalMode: 'delete', synchronous: 3, foreignKeys: 1, quickCheck: 'ok',
        databasePath: `/pmapp-phase0/run-${runId}/repository.sqlite3`,
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
        osBuild: 'Win32', browserName: 'chrome', browserBuild: 'Chrome 151', appForm: 'browser-tab',
        storageState: 'origin-private',
      },
      fixture: { projectId: PROJECT_ID, initialRevision: 7, safeStateHash: HASH_A },
      command: { commandId: COMMAND_ID, projectId: PROJECT_ID, baseRevision: 7, expectedRevision: 8, safeValueHash: HASH_B },
      injection: { boundaryId: caseId }, terminationMechanism: 'worker-terminate',
    },
    observations: {
      boundaryId: caseId,
      boundaryEvent: {
        type: 'BoundaryObserved', boundaryId: caseId, sequence: 2, runId,
        connectionId: '01992f5c-7a10-7ca2-8b11-89ea06c8f9d2',
        databasePath: `/pmapp-phase0/run-${runId}/repository.sqlite3`,
        rollbackJournalPath: `/pmapp-phase0/run-${runId}/repository.sqlite3-journal`,
        commandId: COMMAND_ID, commitAttemptId: '01992f5c-7a10-7cc3-8b11-89ea06c8f9f3',
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
    immutableEvidenceUri: `reports/evidence/phase-0-durability/${attemptId}/runs/${runId}.json`,
  };
}

test.describe('Story 1.1 retained evidence and isolation contracts', () => {
  test('[P0] AC5 rejects unknown fields at every nested evidence level', async () => {
    const { parseEngineeringQualificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(() => parseEngineeringQualificationRun({ ...evidence(), authoredBody: 'forbidden' })).toThrow('UNKNOWN_EVIDENCE_FIELD');
    expect(() => parseEngineeringQualificationRun({
      ...evidence(), manifest: { ...evidence().manifest, command: { ...evidence().manifest.command, title: 'forbidden' } },
    })).toThrow(/UNKNOWN_EVIDENCE_FIELD:manifest.command.title/);
  });

  test('[P0] AC5 validates URI identity, hashes, PASS consistency, and failure consistency', async () => {
    const { parseEngineeringQualificationRun } = await import('../../spikes/phase-0-durability/src/evidence-contract');
    expect(() => parseEngineeringQualificationRun({ ...evidence(), immutableEvidenceUri: 'wrong' })).toThrow('INVALID_EVIDENCE_VALUE:immutableEvidenceUri');
    expect(() => parseEngineeringQualificationRun({ ...evidence(), artifactHashes: { semantic: 'bad' } })).toThrow('INVALID_EVIDENCE_HASH');
    expect(() => parseEngineeringQualificationRun({ ...evidence(), oracle: { ...evidence().oracle, storedRevision: 8 } })).toThrow('INVALID_EVIDENCE_VALUE:oracle.');
    expect(() => parseEngineeringQualificationRun({ ...evidence(), artifactHashes: { semantic: HASH_B } })).toThrow('INVALID_EVIDENCE_VALUE:artifactHashes.semantic');
    expect(() => parseEngineeringQualificationRun({ ...evidence({ status: 'FAIL' }), failure: null })).toThrow('INVALID_EVIDENCE_OBJECT:failure');
    const falseFailure = evidence({ status: 'FAIL' });
    expect(() => parseEngineeringQualificationRun({
      ...falseFailure,
      oracle: { ...falseFailure.oracle, partialMutation: false, reconciliationAccepted: true },
      failure: {
        ...falseFailure.failure,
        resultingState: { ...falseFailure.oracle, partialMutation: false, reconciliationAccepted: true },
      },
    })).toThrow('FAIL_STATUS_WITH_PASS_ORACLE');
  });

  test('[P0] AC5 retains failure append-only in an injected temporary evidence root', async ({}, testInfo) => {
    const { createUuidV7 } = await import('../../spikes/phase-0-durability/src/command-receipt');
    const { createEvidenceStore, deriveAttemptReport } = await import('../../spikes/phase-0-durability/src/evidence');
    const store = createEvidenceStore(testInfo.outputPath('evidence'));
    const attemptId = createUuidV7();
    const failed = evidence({ attemptId, runId: createUuidV7(), status: 'FAIL' });
    const passed = evidence({ attemptId, runId: createUuidV7() });
    await store.appendRunResult(failed);
    await store.appendRunResult(passed);
    const retained = await store.readAttemptResults(attemptId);
    expect(retained).toHaveLength(2);
    expect(deriveAttemptReport(retained)).toMatchObject({ status: 'FAIL', retainedRequiredFailures: [{ runId: failed.runId }] });
  });

  test('[P0] AC5 fails empty incomplete unknown and mismatched attempt identities', async () => {
    const { deriveAttemptReport } = await import('../../spikes/phase-0-durability/src/evidence');
    expect(deriveAttemptReport([])).toMatchObject({ status: 'FAIL', invalidReasons: ['EMPTY_ATTEMPT'] });
    expect(deriveAttemptReport([evidence()])).toMatchObject({
      status: 'FAIL', missingRequiredCases: expect.arrayContaining(['F2_AFTER_JOURNAL_SYNC', 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED']),
    });
    expect(deriveAttemptReport([
      evidence(), evidence({ attemptId: '01992f5c-7a10-7cc4-8b11-89ea06c8f9f4', runId: '01992f5c-7a10-7cc5-8b11-89ea06c8f9f5' }),
    ])).toMatchObject({ status: 'FAIL', invalidReasons: ['ATTEMPT_IDENTITY_MISMATCH'] });
  });

  test('[P0] AC5 rejects filename and attempt mismatch when reading retained runs', async ({}, testInfo) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { createEvidenceStore } = await import('../../spikes/phase-0-durability/src/evidence');
    const root = testInfo.outputPath('evidence');
    const store = createEvidenceStore(root);
    const wrongName = '01992f5c-7a10-7cc6-8b11-89ea06c8f9f6';
    const directory = path.join(root, ATTEMPT_ID, 'runs');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${wrongName}.json`), JSON.stringify(evidence()));
    await expect(store.readAttemptResults(ATTEMPT_ID)).rejects.toThrow('RUN_FILENAME_IDENTITY_MISMATCH');
  });

  test('[P0] AC5 rejects path traversal and conflicting immutable attempt metadata', async ({}, testInfo) => {
    const { createUuidV7 } = await import('../../spikes/phase-0-durability/src/command-receipt');
    const { createEvidenceStore } = await import('../../spikes/phase-0-durability/src/evidence');
    const store = createEvidenceStore(testInfo.outputPath('evidence'));
    await expect(store.writeAttemptManifest({
      attemptId: '../outside', campaignId: ATTEMPT_ID, seed: 'contract-seed', rootCause: 'a', correctiveChange: 'b', priorFailedEvidence: [],
    })).rejects.toThrow(/INVALID_UUID_V7/);
    const attemptId = createUuidV7();
    await store.writeAttemptManifest({ attemptId, campaignId: ATTEMPT_ID, seed: 'contract-seed', rootCause: 'a', correctiveChange: 'b', priorFailedEvidence: [] });
    await expect(store.writeAttemptManifest({
      attemptId, campaignId: ATTEMPT_ID, seed: 'contract-seed', rootCause: 'changed', correctiveChange: 'b', priorFailedEvidence: [],
    })).rejects.toThrow('ATTEMPT_MANIFEST_MISMATCH');
  });

  test('[P0] AC7 validates only the exact reset target without claiming browser deletion', async () => {
    const { createHarnessTestPort } = await import('../../spikes/phase-0-durability/src/harness');
    const harness = createHarnessTestPort({
      origin: 'http://127.0.0.1:4173', runId: RUN_ID,
      namespace: `/pmapp-phase0/run-${RUN_ID}`, seed: 4_271_905,
    });
    await expect(harness.resetRunNamespace(`/pmapp-phase0/run-${RUN_ID}`)).resolves.toEqual({
      code: 'RUN_NAMESPACE_TARGET_VALIDATED', target: `/pmapp-phase0/run-${RUN_ID}`,
    });
    await expect(harness.resetRunNamespace('/pmapp-phase0')).rejects.toThrow('RESET_TARGET_OUTSIDE_CURRENT_RUN');
  });

  test('[P0] AC6 inspects a fresh actual production bundle graph', async () => {
    const { inspectProductionBundleForForbiddenControls } = await import('../../spikes/phase-0-durability/src/harness');
    const result = await inspectProductionBundleForForbiddenControls();
    expect(result).toMatchObject({ status: 'PASS', matches: [] });
    expect(result.graphFiles.length).toBeGreaterThan(0);
    expect(result.scannedJavaScript.length).toBeGreaterThanOrEqual(result.graphFiles.length);
  });
});

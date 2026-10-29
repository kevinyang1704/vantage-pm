import { createHash } from 'node:crypto';
import { SHA256_LOWERCASE, assertUuidV7 } from './command-receipt';

export const LOGICAL_CASE_IDS = [
  'F1_BEFORE_JOURNAL_SYNC',
  'F2_AFTER_JOURNAL_SYNC',
  'F3_BEFORE_JOURNAL_DELETE_FORWARD',
  'F4_AFTER_COMMIT_RETURN',
  'F5_AFTER_REPOSITORY_RESULT',
  'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED',
] as const;
export type LogicalCaseId = typeof LOGICAL_CASE_IDS[number];
export const OWNERSHIP_CASE_IDS = [
  'O1_CONCURRENT_CONTENDER',
  'O2_FROZEN_OWNER',
  'O3_COOPERATIVE_HANDOFF',
  'O4_WORKER_DEATH',
  'O5_OWNER_PAGE_CLOSE',
] as const;
export type OwnershipCaseId = typeof OWNERSHIP_CASE_IDS[number];
export const DEGRADED_CASE_IDS = [
  'DEGRADED_PERSISTENCE_DENIED',
  'DEGRADED_QUOTA_EXHAUSTED',
  'DEGRADED_PRIVATE_GUEST_PROFILE',
] as const;
export type DegradedCaseId = typeof DEGRADED_CASE_IDS[number];
export const DEFERRED_CASE_IDS = [
  'VM_POWER_LOSS',
  'PHYSICAL_POWER_INTERRUPTION',
  'UPDATE_MIGRATION_MATRIX',
] as const;
export type DeferredCaseId = typeof DEFERRED_CASE_IDS[number];
export const RELEASE_CERTIFICATION_CASE_IDS = [
  ...LOGICAL_CASE_IDS,
  ...OWNERSHIP_CASE_IDS,
  ...DEGRADED_CASE_IDS,
  ...DEFERRED_CASE_IDS,
] as const;
export type ReleaseCertificationCaseId = typeof RELEASE_CERTIFICATION_CASE_IDS[number];
export type QualificationCaseId = LogicalCaseId | OwnershipCaseId;
export type EvidenceStatus = 'PASS' | 'FAIL';

export type ReleaseCertificationRun = Readonly<{
  schemaVersion: '1.4.0';
  evidenceType: 'releaseCertification';
  runId: string;
  attemptId: string;
  caseId: ReleaseCertificationCaseId;
  required: true;
  status: EvidenceStatus;
  cohort: Readonly<{
    browserName: string;
    browserBuild: string;
    browserChannel: string;
    appForm: 'browser-tab' | 'installed';
    storageState: string;
  }>;
  manifest: Readonly<Record<string, unknown>>;
  observations: Readonly<Record<string, unknown>>;
  oracle: Readonly<Record<string, unknown>>;
  failure: null | Readonly<Record<string, unknown>>;
  artifactHashes: Readonly<Record<string, string>>;
  immutableEvidenceUri: string;
}>;

export type LogicalEngineeringQualificationRun = Readonly<{
  schemaVersion: '1.0.0';
  evidenceType: 'engineeringQualification';
  runId: string;
  attemptId: string;
  caseId: LogicalCaseId;
  required: true;
  status: EvidenceStatus;
  manifest: Readonly<Record<string, unknown>>;
  observations: Readonly<Record<string, unknown>>;
  oracle: Readonly<Record<string, unknown>>;
  failure: null | Readonly<Record<string, unknown>>;
  artifactHashes: Readonly<{ semantic: string }>;
  immutableEvidenceUri: string;
}>;

export type OwnershipEvidenceEvent = Readonly<{
  sequence: number;
  runId: string;
  namespace: string;
  variant: 'primary' | 'result-lost-after-commit' | 'terminate-before-commit';
  actorId: string;
  contextId: string;
  ownerSessionId: string | null;
  writerEpoch: number;
  resource: 'web-lock' | 'sah-pool' | 'sqlite' | 'repository' | 'worker' | 'page';
  type: string;
  outcome: 'attempted' | 'acquired' | 'ready' | 'busy' | 'rejected' | 'released' | 'terminated' | 'failed';
  requestId: string | null;
  commandId: string | null;
  baseRevision: number | null;
  targetRevision: number | null;
  quickCheck: 'ok' | null;
  mutationCount: number | null;
  receiptCount: number | null;
  resultCount: number | null;
  partialMutation: boolean | null;
}>;

export type OwnershipEngineeringQualificationRun = Readonly<{
  schemaVersion: '1.2.0';
  evidenceType: 'engineeringQualification';
  runId: string;
  attemptId: string;
  caseId: OwnershipCaseId;
  required: true;
  status: EvidenceStatus;
  manifest: Readonly<Record<string, unknown>>;
  observations: Readonly<Record<string, unknown>>;
  oracle: Readonly<Record<string, unknown>>;
  failure: null | Readonly<Record<string, unknown>>;
  artifactHashes: Readonly<{ ownershipTrace: string; parityResult: string }>;
  immutableEvidenceUri: string;
}>;

export type EngineeringQualificationRun = LogicalEngineeringQualificationRun | OwnershipEngineeringQualificationRun;

type RecordValue = Record<string, unknown>;
const PRE_COMMIT = new Set<LogicalCaseId>(LOGICAL_CASE_IDS.slice(0, 3));
const TECHNICAL_TEXT = /^[A-Za-z0-9_./:\- ()@;=,+\[\]]+$/;

function object(value: unknown, path: string, allowed: readonly string[], required = allowed): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`INVALID_EVIDENCE_OBJECT:${path}`);
  const record = value as RecordValue;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`UNKNOWN_EVIDENCE_FIELD:${path}.${unknown}`);
  const missing = required.find((key) => !(key in record));
  if (missing) throw new Error(`MISSING_EVIDENCE_FIELD:${path}.${missing}`);
  return record;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value || !TECHNICAL_TEXT.test(value)) throw new Error(`INVALID_EVIDENCE_TEXT:${path}`);
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`INVALID_EVIDENCE_INTEGER:${path}`);
  return Number(value);
}

function hash(value: unknown, path: string): string {
  const result = String(value);
  if (!SHA256_LOWERCASE.test(result)) throw new Error(`INVALID_EVIDENCE_HASH:${path}`);
  return result;
}

function uuid(value: unknown, path: string): string {
  const result = String(value);
  assertUuidV7(result, path);
  return result;
}

function exact<T>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`INVALID_EVIDENCE_VALUE:${path}`);
  return expected;
}

function validateAdapter(value: unknown) {
  const record = object(value, 'manifest.adapter', [
    'sqliteVersion', 'sqliteSourceId', 'vfs', 'recoveryVfs', 'wrappedVfs', 'journalMode',
    'synchronous', 'foreignKeys', 'quickCheck', 'databasePath',
  ]);
  text(record.sqliteVersion, 'manifest.adapter.sqliteVersion');
  text(record.sqliteSourceId, 'manifest.adapter.sqliteSourceId');
  text(record.vfs, 'manifest.adapter.vfs');
  text(record.recoveryVfs, 'manifest.adapter.recoveryVfs');
  if (record.wrappedVfs !== null) text(record.wrappedVfs, 'manifest.adapter.wrappedVfs');
  exact(record.journalMode, 'delete', 'manifest.adapter.journalMode');
  exact(record.synchronous, 3, 'manifest.adapter.synchronous');
  exact(record.foreignKeys, 1, 'manifest.adapter.foreignKeys');
  exact(record.quickCheck, 'ok', 'manifest.adapter.quickCheck');
  text(record.databasePath, 'manifest.adapter.databasePath');
  return record;
}

function validateSource(value: unknown) {
  const record = object(value, 'manifest.source', [
    'lockfileHash', 'buildHash', 'headRevision', 'worktreeState', 'worktreeStatusDigest',
    'executableTreeDigest', 'sourceFiles',
  ]);
  hash(record.lockfileHash, 'manifest.source.lockfileHash');
  hash(record.buildHash, 'manifest.source.buildHash');
  hash(record.worktreeStatusDigest, 'manifest.source.worktreeStatusDigest');
  hash(record.executableTreeDigest, 'manifest.source.executableTreeDigest');
  if (record.headRevision !== 'unavailable' && !/^[0-9a-f]{40}$/.test(String(record.headRevision))) {
    throw new Error('INVALID_EVIDENCE_REVISION:manifest.source.headRevision');
  }
  if (record.worktreeState !== 'clean' && record.worktreeState !== 'dirty') throw new Error('INVALID_WORKTREE_STATE');
  const files = object(record.sourceFiles, 'manifest.source.sourceFiles', Object.keys(record.sourceFiles as RecordValue));
  if (!Object.keys(files).length) throw new Error('EMPTY_SOURCE_FILE_IDENTITY');
  for (const [file, digest] of Object.entries(files)) {
    if (!/^(src|fixtures|test-support)\/[A-Za-z0-9_.\-/]+$|^(build-identity\.ts|vite\.config\.ts|index\.html|qualification\.html|\.\.\/\.\.\/package(?:-lock)?\.json)$/.test(file)) {
      throw new Error(`INVALID_SOURCE_FILE_PATH:${file}`);
    }
    hash(digest, `manifest.source.sourceFiles.${file}`);
  }
  return record;
}

function validateQualification(value: unknown) {
  const record = object(value, 'manifest.qualification', [
    'qualificationSubjectDigest', 'productionCompositionRoot', 'instrumentedCompositionRoot',
    'parityStatus', 'compositionDerivationStatus',
  ]);
  hash(record.qualificationSubjectDigest, 'manifest.qualification.qualificationSubjectDigest');
  hash(record.productionCompositionRoot, 'manifest.qualification.productionCompositionRoot');
  hash(record.instrumentedCompositionRoot, 'manifest.qualification.instrumentedCompositionRoot');
  if (record.parityStatus !== 'PASS' && record.parityStatus !== 'FAIL') throw new Error('INVALID_PARITY_STATUS');
  if (record.compositionDerivationStatus !== 'PASS' && record.compositionDerivationStatus !== 'FAIL') {
    throw new Error('INVALID_COMPOSITION_DERIVATION_STATUS');
  }
  return record;
}

function validateManifest(value: unknown, caseId: LogicalCaseId, runId: string) {
  const record = object(value, 'manifest', [
    'seed', 'adapter', 'source', 'qualification', 'environment', 'fixture', 'command',
    'injection', 'terminationMechanism',
  ]);
  text(record.seed, 'manifest.seed');
  const adapter = validateAdapter(record.adapter);
  if (adapter.databasePath !== `/pmapp-phase0/run-${runId}/repository.sqlite3`) throw new Error('DATABASE_PATH_RUN_MISMATCH');
  const source = validateSource(record.source);
  const qualification = validateQualification(record.qualification);
  if (source.buildHash !== qualification.qualificationSubjectDigest) throw new Error('BUILD_SUBJECT_DIGEST_MISMATCH');
  const environment = object(record.environment, 'manifest.environment', [
    'osBuild', 'browserName', 'browserBuild', 'appForm', 'storageState',
  ]);
  for (const [key, nested] of Object.entries(environment)) text(nested, `manifest.environment.${key}`);
  const fixture = object(record.fixture, 'manifest.fixture', ['projectId', 'initialRevision', 'safeStateHash']);
  uuid(fixture.projectId, 'manifest.fixture.projectId');
  integer(fixture.initialRevision, 'manifest.fixture.initialRevision');
  hash(fixture.safeStateHash, 'manifest.fixture.safeStateHash');
  const command = object(record.command, 'manifest.command', [
    'commandId', 'projectId', 'baseRevision', 'expectedRevision', 'safeValueHash',
  ]);
  uuid(command.commandId, 'manifest.command.commandId');
  uuid(command.projectId, 'manifest.command.projectId');
  integer(command.baseRevision, 'manifest.command.baseRevision');
  integer(command.expectedRevision, 'manifest.command.expectedRevision');
  hash(command.safeValueHash, 'manifest.command.safeValueHash');
  if (command.projectId !== fixture.projectId || command.baseRevision !== fixture.initialRevision ||
      command.expectedRevision !== Number(command.baseRevision) + 1) throw new Error('COMMAND_FIXTURE_IDENTITY_MISMATCH');
  const injection = object(record.injection, 'manifest.injection', ['boundaryId']);
  exact(injection.boundaryId, caseId, 'manifest.injection.boundaryId');
  exact(record.terminationMechanism, 'worker-terminate', 'manifest.terminationMechanism');
  return { record, adapter, source, qualification, fixture, command };
}

function validateBoundaryEvent(value: unknown, caseId: LogicalCaseId, runId: string, commandId: string) {
  const base = object(value, 'observations.boundaryEvent', [
    'type', 'boundaryId', 'sequence', 'runId', 'connectionId', 'databasePath', 'rollbackJournalPath',
    'commandId', 'commitAttemptId', 'forwardedBeforeTermination', 'physicalDirectorySync',
    'downstreamDatabaseSyncReturn', 'nextCall', 'doSyncDir', 'purpose', 'signatureHash',
    // Ownership provenance, attached to the correlation by repository.worker.ts once an owner exists.
    'contextId', 'ownerSessionId', 'writerEpoch',
  ], ['type', 'boundaryId', 'runId', 'commandId']);
  if ('contextId' in base) uuid(base.contextId, 'observations.boundaryEvent.contextId');
  if ('ownerSessionId' in base) uuid(base.ownerSessionId, 'observations.boundaryEvent.ownerSessionId');
  if ('writerEpoch' in base) integer(Number(base.writerEpoch), 'observations.boundaryEvent.writerEpoch');
  exact(base.boundaryId, caseId, 'observations.boundaryEvent.boundaryId');
  exact(base.runId, runId, 'observations.boundaryEvent.runId');
  exact(base.commandId, commandId, 'observations.boundaryEvent.commandId');
  if (caseId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED') {
    exact(base.type, 'CandidateDurabilityBoundaryObserved', 'observations.boundaryEvent.type');
    exact(base.purpose, 'lab', 'observations.boundaryEvent.purpose');
    hash(base.signatureHash, 'observations.boundaryEvent.signatureHash');
    return base;
  }
  exact(base.type, 'BoundaryObserved', 'observations.boundaryEvent.type');
  integer(base.sequence, 'observations.boundaryEvent.sequence');
  uuid(base.connectionId, 'observations.boundaryEvent.connectionId');
  uuid(base.commitAttemptId, 'observations.boundaryEvent.commitAttemptId');
  text(base.databasePath, 'observations.boundaryEvent.databasePath');
  text(base.rollbackJournalPath, 'observations.boundaryEvent.rollbackJournalPath');
  exact(base.forwardedBeforeTermination, false, 'observations.boundaryEvent.forwardedBeforeTermination');
  exact(base.physicalDirectorySync, 'Unobservable', 'observations.boundaryEvent.physicalDirectorySync');
  if (caseId === 'F3_BEFORE_JOURNAL_DELETE_FORWARD') {
    exact(base.downstreamDatabaseSyncReturn, 'SQLITE_OK', 'observations.boundaryEvent.downstreamDatabaseSyncReturn');
    exact(base.nextCall, 'xDelete', 'observations.boundaryEvent.nextCall');
    exact(base.doSyncDir, true, 'observations.boundaryEvent.doSyncDir');
  }
  return base;
}

function validateTrace(value: unknown, caseId: LogicalCaseId, runId: string, commandId: string) {
  if (!Array.isArray(value) || !value.length) throw new Error('INVALID_CALLBACK_TRACE');
  let priorSequence = 0;
  for (const [index, item] of value.entries()) {
    const record = object(item, `observations.callbackTrace[${index}]`, [
      'type', 'method', 'role', 'sequence', 'downstreamCalls', 'argumentsEqual',
      'productionReturnCode', 'instrumentedReturnCode', 'boundaryId', 'runId', 'connectionId',
      'databasePath', 'rollbackJournalPath', 'commandId', 'commitAttemptId',
      'forwardedBeforeTermination', 'physicalDirectorySync', 'downstreamDatabaseSyncReturn', 'nextCall', 'doSyncDir',
      // Ownership provenance, attached to the correlation by repository.worker.ts once an owner exists.
      'contextId', 'ownerSessionId', 'writerEpoch',
    ], ['type', 'sequence']);
    const sequence = integer(record.sequence, `observations.callbackTrace[${index}].sequence`);
    if (sequence <= priorSequence) throw new Error('NON_MONOTONIC_CALLBACK_TRACE');
    priorSequence = sequence;
    if (record.type === 'VfsCallbackForwarded') {
      text(record.method, `observations.callbackTrace[${index}].method`);
      if (!['database', 'journal', 'other'].includes(String(record.role))) throw new Error('INVALID_TRACE_ROLE');
      exact(record.downstreamCalls, 1, `observations.callbackTrace[${index}].downstreamCalls`);
      exact(record.argumentsEqual, true, `observations.callbackTrace[${index}].argumentsEqual`);
      if (record.productionReturnCode !== record.instrumentedReturnCode) throw new Error('TRACE_RETURN_CODE_MISMATCH');
      if (typeof record.productionReturnCode !== 'number' && record.productionReturnCode !== 'void') {
        throw new Error('INVALID_TRACE_RETURN_CODE');
      }
    } else if (record.type === 'BoundaryObserved') {
      validateBoundaryEvent(record, caseId, runId, commandId);
    } else throw new Error('INVALID_TRACE_EVENT_TYPE');
  }
}

function validateOracle(value: unknown, path = 'oracle') {
  const record = object(value, path, [
    'quickCheck', 'mutationCount', 'authoredFactCount', 'workflowFactCount', 'fixtureAuthoredFactCount',
    'fixtureWorkflowFactCount', 'commandReceiptCount', 'recordedResultCount', 'storedRevision', 'nextRevision',
    'recordedResultHash', 'safeValueHash', 'partialMutation', 'semanticState', 'semanticDatabaseHash',
    'reconciliationAccepted', 'recordedBaseRevision', 'recordedTargetRevision',
  ]);
  text(record.quickCheck, `${path}.quickCheck`);
  for (const key of [
    'mutationCount', 'authoredFactCount', 'workflowFactCount', 'fixtureAuthoredFactCount',
    'fixtureWorkflowFactCount', 'commandReceiptCount', 'recordedResultCount', 'storedRevision',
    'nextRevision', 'recordedBaseRevision', 'recordedTargetRevision',
  ]) integer(record[key], `${path}.${key}`);
  if (record.recordedResultHash !== null) hash(record.recordedResultHash, `${path}.recordedResultHash`);
  hash(record.safeValueHash, `${path}.safeValueHash`);
  if (typeof record.partialMutation !== 'boolean' || typeof record.reconciliationAccepted !== 'boolean') {
    throw new Error(`INVALID_EVIDENCE_BOOLEAN:${path}`);
  }
  if (typeof record.semanticState !== 'string' || !record.semanticState) throw new Error(`INVALID_SEMANTIC_STATE:${path}`);
  const semanticState = record.semanticState;
  const semantic = object(JSON.parse(semanticState), `${path}.semanticState`, [
    'projectId', 'revision', 'safeValueHash', 'mutationCount', 'receiptCount', 'recordedResultCount',
  ]);
  uuid(semantic.projectId, `${path}.semanticState.projectId`);
  integer(semantic.revision, `${path}.semanticState.revision`);
  hash(semantic.safeValueHash, `${path}.semanticState.safeValueHash`);
  integer(semantic.mutationCount, `${path}.semanticState.mutationCount`);
  integer(semantic.receiptCount, `${path}.semanticState.receiptCount`);
  integer(semantic.recordedResultCount, `${path}.semanticState.recordedResultCount`);
  exact(semantic.revision, record.storedRevision, `${path}.semanticState.revision`);
  exact(semantic.safeValueHash, record.safeValueHash, `${path}.semanticState.safeValueHash`);
  exact(semantic.mutationCount, record.mutationCount, `${path}.semanticState.mutationCount`);
  exact(semantic.receiptCount, record.commandReceiptCount, `${path}.semanticState.receiptCount`);
  exact(semantic.recordedResultCount, record.recordedResultCount, `${path}.semanticState.recordedResultCount`);
  hash(record.semanticDatabaseHash, `${path}.semanticDatabaseHash`);
  return record;
}

function validatePassConsistency(input: {
  caseId: LogicalCaseId;
  qualification: RecordValue;
  fixture: RecordValue;
  command: RecordValue;
  oracle: RecordValue;
}) {
  exact(input.qualification.parityStatus, 'PASS', 'manifest.qualification.parityStatus');
  exact(input.qualification.compositionDerivationStatus, 'PASS', 'manifest.qualification.compositionDerivationStatus');
  exact(input.oracle.quickCheck, 'ok', 'oracle.quickCheck');
  exact(input.oracle.partialMutation, false, 'oracle.partialMutation');
  exact(input.oracle.reconciliationAccepted, true, 'oracle.reconciliationAccepted');
  const preCommit = PRE_COMMIT.has(input.caseId);
  const expectedRevision = preCommit ? input.fixture.initialRevision : input.command.expectedRevision;
  const expectedCount = preCommit ? 0 : 1;
  exact(input.oracle.storedRevision, expectedRevision, 'oracle.storedRevision');
  exact(input.oracle.nextRevision, Number(expectedRevision) + 1, 'oracle.nextRevision');
  for (const key of ['mutationCount', 'commandReceiptCount', 'recordedResultCount']) {
    exact(input.oracle[key], expectedCount, `oracle.${key}`);
  }
  exact(input.oracle.recordedBaseRevision, preCommit ? 0 : input.command.baseRevision, 'oracle.recordedBaseRevision');
  exact(input.oracle.recordedTargetRevision, preCommit ? 0 : input.command.expectedRevision, 'oracle.recordedTargetRevision');
  exact(input.oracle.recordedResultHash, preCommit ? null : input.command.safeValueHash, 'oracle.recordedResultHash');
  exact(input.oracle.safeValueHash, preCommit ? input.fixture.safeStateHash : input.command.safeValueHash, 'oracle.safeValueHash');
}

function parseLogicalEngineeringQualificationRun(input: unknown): LogicalEngineeringQualificationRun {
  const record = object(input, '$', [
    'schemaVersion', 'evidenceType', 'runId', 'attemptId', 'caseId', 'required', 'status',
    'manifest', 'observations', 'oracle', 'failure', 'artifactHashes', 'immutableEvidenceUri',
  ]);
  exact(record.schemaVersion, '1.0.0', 'schemaVersion');
  exact(record.evidenceType, 'engineeringQualification', 'evidenceType');
  const runId = uuid(record.runId, 'runId');
  const attemptId = uuid(record.attemptId, 'attemptId');
  if (!LOGICAL_CASE_IDS.includes(record.caseId as LogicalCaseId)) throw new Error('INVALID_EVIDENCE_CASE_ID');
  const caseId = record.caseId as LogicalCaseId;
  exact(record.required, true, 'required');
  if (record.status !== 'PASS' && record.status !== 'FAIL') throw new Error('INVALID_EVIDENCE_STATUS');
  const manifest = validateManifest(record.manifest, caseId, runId);
  const observations = object(record.observations, 'observations', [
    'boundaryId', 'boundaryEvent', 'callbackTrace', 'commandedValueHash',
  ]);
  exact(observations.boundaryId, caseId, 'observations.boundaryId');
  hash(observations.commandedValueHash, 'observations.commandedValueHash');
  exact(observations.commandedValueHash, manifest.command.safeValueHash, 'observations.commandedValueHash');
  validateBoundaryEvent(observations.boundaryEvent, caseId, runId, String(manifest.command.commandId));
  validateTrace(observations.callbackTrace, caseId, runId, String(manifest.command.commandId));
  const oracle = validateOracle(record.oracle);
  const hashes = object(record.artifactHashes, 'artifactHashes', ['semantic']);
  hash(hashes.semantic, 'artifactHashes.semantic');
  exact(hashes.semantic, oracle.semanticDatabaseHash, 'artifactHashes.semantic');
  const expectedUri = `reports/evidence/phase-0-durability/${attemptId}/runs/${runId}.json`;
  exact(record.immutableEvidenceUri, expectedUri, 'immutableEvidenceUri');
  if (record.status === 'PASS') {
    exact(record.failure, null, 'failure');
    validatePassConsistency({ caseId, qualification: manifest.qualification, fixture: manifest.fixture, command: manifest.command, oracle });
  } else {
    const failure = object(record.failure, 'failure', [
      'code', 'cause', 'resultingState', 'architectureDecisionRequired',
    ], ['code', 'cause', 'resultingState']);
    text(failure.code, 'failure.code');
    text(failure.cause, 'failure.cause');
    if (failure.architectureDecisionRequired !== undefined && failure.architectureDecisionRequired !== null) {
      text(failure.architectureDecisionRequired, 'failure.architectureDecisionRequired');
    }
    validateOracle(failure.resultingState, 'failure.resultingState');
    if (JSON.stringify(failure.resultingState) !== JSON.stringify(oracle)) throw new Error('FAILURE_ORACLE_MISMATCH');
    let passConsistent = true;
    try {
      validatePassConsistency({ caseId, qualification: manifest.qualification, fixture: manifest.fixture, command: manifest.command, oracle });
    } catch {
      passConsistent = false;
    }
    if (passConsistent) throw new Error('FAIL_STATUS_WITH_PASS_ORACLE');
  }
  return Object.freeze(record) as LogicalEngineeringQualificationRun;
}

const OWNERSHIP_RESOURCES = ['web-lock', 'sah-pool', 'sqlite', 'repository', 'worker', 'page'] as const;
const OWNERSHIP_OUTCOMES = ['attempted', 'acquired', 'ready', 'busy', 'rejected', 'released', 'terminated', 'failed'] as const;
const OWNERSHIP_VARIANTS = ['primary', 'result-lost-after-commit', 'terminate-before-commit'] as const;
const OWNERSHIP_EVENT_FIELDS = [
  'sequence', 'runId', 'namespace', 'variant', 'actorId', 'contextId', 'ownerSessionId', 'writerEpoch',
  'resource', 'type', 'outcome', 'requestId', 'commandId', 'baseRevision', 'targetRevision', 'quickCheck',
  'mutationCount', 'receiptCount', 'resultCount', 'partialMutation',
] as const;

function nullableInteger(value: unknown, path: string): number | null {
  return value === null ? null : integer(value, path);
}

function nullableUuid(value: unknown, path: string): string | null {
  return value === null ? null : uuid(value, path);
}

function ownershipTraceHash(events: readonly OwnershipEvidenceEvent[]) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function validateOwnershipEvents(value: unknown, runs: ReadonlyMap<string, string>): OwnershipEvidenceEvent[] {
  if (!Array.isArray(value) || !value.length) throw new Error('INVALID_OWNERSHIP_EVENT_JOURNAL');
  let priorSequence = 0;
  return value.map((item, index) => {
    const path = `observations.events[${index}]`;
    const record = object(item, path, OWNERSHIP_EVENT_FIELDS);
    const sequence = integer(record.sequence, `${path}.sequence`);
    if (sequence !== priorSequence + 1) throw new Error('NON_CONTIGUOUS_GLOBAL_OWNERSHIP_CHRONOLOGY');
    priorSequence = sequence;
    const runId = uuid(record.runId, `${path}.runId`);
    const namespace = text(record.namespace, `${path}.namespace`);
    if (runs.get(runId) !== namespace) throw new Error('OWNERSHIP_EVENT_RUN_NAMESPACE_MISMATCH');
    if (!OWNERSHIP_VARIANTS.includes(record.variant as typeof OWNERSHIP_VARIANTS[number])) throw new Error('INVALID_OWNERSHIP_VARIANT');
    text(record.actorId, `${path}.actorId`);
    uuid(record.contextId, `${path}.contextId`);
    nullableUuid(record.ownerSessionId, `${path}.ownerSessionId`);
    integer(record.writerEpoch, `${path}.writerEpoch`);
    if (!OWNERSHIP_RESOURCES.includes(record.resource as typeof OWNERSHIP_RESOURCES[number])) throw new Error('INVALID_OWNERSHIP_RESOURCE');
    text(record.type, `${path}.type`);
    if (!OWNERSHIP_OUTCOMES.includes(record.outcome as typeof OWNERSHIP_OUTCOMES[number])) throw new Error('INVALID_OWNERSHIP_OUTCOME');
    nullableUuid(record.requestId, `${path}.requestId`);
    nullableUuid(record.commandId, `${path}.commandId`);
    nullableInteger(record.baseRevision, `${path}.baseRevision`);
    nullableInteger(record.targetRevision, `${path}.targetRevision`);
    if (record.quickCheck !== null && record.quickCheck !== 'ok') throw new Error('INVALID_OWNERSHIP_QUICK_CHECK');
    nullableInteger(record.mutationCount, `${path}.mutationCount`);
    nullableInteger(record.receiptCount, `${path}.receiptCount`);
    nullableInteger(record.resultCount, `${path}.resultCount`);
    if (record.partialMutation !== null && typeof record.partialMutation !== 'boolean') throw new Error('INVALID_OWNERSHIP_PARTIAL_MUTATION');
    return Object.freeze(record) as OwnershipEvidenceEvent;
  });
}

function deriveMaximum(events: readonly OwnershipEvidenceEvent[], resource: 'web-lock' | 'sah-pool' | 'sqlite') {
  const active = new Set<string>();
  let maximum = 0;
  for (const event of events) {
    const key = `${event.runId}:${event.contextId}:${event.ownerSessionId ?? 'none'}`;
    if (event.resource === resource && event.outcome === 'acquired') {
      if (event.ownerSessionId === null || active.has(key)) throw new Error('INVALID_RESOURCE_ACQUISITION');
      active.add(key);
      maximum = Math.max(maximum, active.size);
    }
    if (event.resource === resource && event.outcome === 'released') active.delete(key);
    if ((event.resource === 'worker' || event.resource === 'page') && event.outcome === 'terminated') {
      for (const candidate of [...active]) if (candidate.startsWith(`${event.runId}:${event.contextId}:`)) active.delete(candidate);
    }
  }
  return maximum;
}

const HANDOFF_TRANSITIONS = [
  'IntakeStopped', 'QueueResolved', 'StatementsClosed', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased',
  'FormerOwnerFenced', 'WebLockAcquired', 'SAHAcquired', 'SQLiteOpened', 'IntegrityVerified',
  'ReceiptsReconciled', 'RevisionReconciled',
] as const;

export function adjudicateOwnershipJournal(caseId: OwnershipCaseId, events: readonly OwnershipEvidenceEvent[]) {
  const maximumSimultaneousOwners = deriveMaximum(events, 'web-lock');
  const maximumSimultaneousSahOwners = deriveMaximum(events, 'sah-pool');
  const maximumSimultaneousSqliteOwners = deriveMaximum(events, 'sqlite');
  const busy = events.filter((event) => event.type === 'StorageBusy' && event.outcome === 'busy');
  const busyContexts = new Set(busy.map((event) => event.contextId));
  const busyLowerLayer = events.some((event) => busyContexts.has(event.contextId) && ['sah-pool', 'sqlite'].includes(event.resource));
  const freeze = events.find((event) => event.type === 'PageFrozenObserved' && event.resource === 'page');
  const transitionNames = events.filter((event) => (HANDOFF_TRANSITIONS as readonly string[]).includes(event.type)).map((event) => event.type);
  const handoffStart = transitionNames.indexOf('IntakeStopped');
  const handoff = handoffStart < 0 ? [] : transitionNames.slice(handoffStart, handoffStart + HANDOFF_TRANSITIONS.length);
  const exactHandoff = JSON.stringify(handoff) === JSON.stringify(HANDOFF_TRANSITIONS);
  const successorCommands = events.filter((event) => event.type === 'SuccessorCommandApplied');
  const successorInspections = events.filter((event) => event.type === 'SuccessorCommandInspected');
  const successorCommandVerified = successorCommands.length > 0 && successorCommands.every((command) => successorInspections.some((inspection) =>
    inspection.runId === command.runId && inspection.commandId === command.commandId &&
    inspection.baseRevision === command.baseRevision && inspection.targetRevision === command.targetRevision &&
    inspection.quickCheck === 'ok' && inspection.targetRevision === Number(command.baseRevision) + 1 &&
    inspection.partialMutation === false,
  ));
  const variants = new Set(events.map((event) => event.variant));
  const deathType = caseId === 'O4_WORKER_DEATH' ? 'WorkerTerminatedObserved' : 'OwnerPageClosedObserved';
  const deathVariantsVerified = (caseId !== 'O4_WORKER_DEATH' && caseId !== 'O5_OWNER_PAGE_CLOSE') ||
    ['result-lost-after-commit', 'terminate-before-commit'].every((variant) => {
      const variantEvents = events.filter((event) => event.variant === variant);
      const barrier = variantEvents.find((event) => event.type === 'OwnershipLossBarrierObserved');
      const death = variantEvents.find((event) => event.type === deathType && event.outcome === 'terminated');
      const recovery = variantEvents.find((event) => event.type === 'RecoveryInspected' && event.quickCheck === 'ok');
      const command = variantEvents.find((event) => event.type === 'SuccessorCommandApplied');
      return Boolean(barrier && death && recovery && command && barrier.sequence < death.sequence && death.sequence < recovery.sequence && recovery.sequence < command.sequence &&
        (variant === 'result-lost-after-commit'
          ? recovery.mutationCount === 1 && recovery.receiptCount === 1 && recovery.resultCount === 1
          : recovery.mutationCount === 0 && recovery.receiptCount === 0 && recovery.resultCount === 0 && recovery.partialMutation === false));
    });
  const valid = maximumSimultaneousOwners === 1 && maximumSimultaneousSahOwners === 1 && maximumSimultaneousSqliteOwners === 1 &&
    (caseId === 'O1_CONCURRENT_CONTENDER' || caseId === 'O2_FROZEN_OWNER' ? busy.length >= 3 && busyContexts.size >= 3 && !busyLowerLayer : true) &&
    (caseId === 'O2_FROZEN_OWNER' ? Boolean(freeze && busy.every((event) => freeze.sequence < event.sequence)) : true) &&
    (caseId === 'O3_COOPERATIVE_HANDOFF' ? exactHandoff && successorCommandVerified : true) &&
    (caseId === 'O4_WORKER_DEATH' || caseId === 'O5_OWNER_PAGE_CLOSE' ? variants.has('result-lost-after-commit') && variants.has('terminate-before-commit') && deathVariantsVerified && successorCommandVerified : true);
  return Object.freeze({
    maximumSimultaneousOwners, maximumSimultaneousSahOwners, maximumSimultaneousSqliteOwners,
    repeatedBusyCount: busy.length, freezeObserved: Boolean(freeze), exactHandoff, successorCommandVerified,
    deathVariantsVerified, status: valid ? 'PASS' as const : 'FAIL' as const,
  });
}

function parseOwnershipEngineeringQualificationRun(input: unknown): OwnershipEngineeringQualificationRun {
  const record = object(input, '$', [
    'schemaVersion', 'evidenceType', 'runId', 'attemptId', 'caseId', 'required', 'status',
    'manifest', 'observations', 'oracle', 'failure', 'artifactHashes', 'immutableEvidenceUri',
  ]);
  exact(record.schemaVersion, '1.2.0', 'schemaVersion');
  exact(record.evidenceType, 'engineeringQualification', 'evidenceType');
  const runId = uuid(record.runId, 'runId');
  const attemptId = uuid(record.attemptId, 'attemptId');
  if (!OWNERSHIP_CASE_IDS.includes(record.caseId as OwnershipCaseId)) throw new Error('INVALID_EVIDENCE_CASE_ID');
  const caseId = record.caseId as OwnershipCaseId;
  exact(record.required, true, 'required');
  if (record.status !== 'PASS' && record.status !== 'FAIL') throw new Error('INVALID_EVIDENCE_STATUS');

  const manifest = object(record.manifest, 'manifest', [
    'seed', 'campaignId', 'lockName', 'runs', 'source', 'qualification', 'environment', 'persistence',
  ]);
  text(manifest.seed, 'manifest.seed');
  uuid(manifest.campaignId, 'manifest.campaignId');
  exact(manifest.lockName, 'pmapp-repository-write', 'manifest.lockName');
  if (!Array.isArray(manifest.runs)) throw new Error('INVALID_OWNERSHIP_RUNS');
  const expectedVariants = caseId === 'O4_WORKER_DEATH' || caseId === 'O5_OWNER_PAGE_CLOSE'
    ? ['result-lost-after-commit', 'terminate-before-commit'] : ['primary'];
  const runMap = new Map<string, string>();
  const variants: string[] = [];
  for (const [index, item] of manifest.runs.entries()) {
    const nested = object(item, `manifest.runs[${index}]`, ['variant', 'runId', 'namespace']);
    if (!OWNERSHIP_VARIANTS.includes(nested.variant as typeof OWNERSHIP_VARIANTS[number])) throw new Error('INVALID_OWNERSHIP_VARIANT');
    const nestedRunId = uuid(nested.runId, `manifest.runs[${index}].runId`);
    const namespace = text(nested.namespace, `manifest.runs[${index}].namespace`);
    exact(namespace, `/pmapp-phase0/run-${nestedRunId}`, `manifest.runs[${index}].namespace`);
    if (runMap.has(nestedRunId)) throw new Error('DUPLICATE_OWNERSHIP_RUN');
    runMap.set(nestedRunId, namespace);
    variants.push(String(nested.variant));
  }
  if (JSON.stringify([...variants].sort()) !== JSON.stringify([...expectedVariants].sort())) throw new Error('OWNERSHIP_VARIANT_SET_MISMATCH');
  const source = validateSource(manifest.source);
  const qualification = validateQualification(manifest.qualification);
  exact(source.buildHash, qualification.qualificationSubjectDigest, 'manifest.source.buildHash');
  exact(qualification.parityStatus, 'PASS', 'manifest.qualification.parityStatus');
  const environment = object(manifest.environment, 'manifest.environment', [
    'osPlatform', 'osBuild', 'browserName', 'browserBuild', 'userAgent', 'appForm', 'headless',
  ]);
  exact(environment.osPlatform, 'win32', 'manifest.environment.osPlatform');
  text(environment.osBuild, 'manifest.environment.osBuild');
  if (environment.browserName !== 'Google Chrome' && environment.browserName !== 'Microsoft Edge') {
    throw new Error('INVALID_BROWSER_NAME');
  }
  text(environment.browserBuild, 'manifest.environment.browserBuild');
  text(environment.userAgent, 'manifest.environment.userAgent');
  if (environment.appForm !== 'browser-tab' && environment.appForm !== 'installed') {
    throw new Error('INVALID_EVIDENCE_VALUE:manifest.environment.appForm');
  }
  exact(environment.headless, false, 'manifest.environment.headless');
  if (String(environment.userAgent).includes('Headless')) throw new Error('HEADLESS_BROWSER_EVIDENCE_FORBIDDEN');
  const persistence = object(manifest.persistence, 'manifest.persistence', ['persisted', 'observedBy']);
  exact(persistence.persisted, true, 'manifest.persistence.persisted');
  exact(persistence.observedBy, 'navigator.storage.persisted', 'manifest.persistence.observedBy');

  const observations = object(record.observations, 'observations', ['caseId', 'events']);
  exact(observations.caseId, caseId, 'observations.caseId');
  const events = validateOwnershipEvents(observations.events, runMap);
  const derived = adjudicateOwnershipJournal(caseId, events);
  const oracle = object(record.oracle, 'oracle', Object.keys(derived));
  if (JSON.stringify(oracle) !== JSON.stringify(derived)) throw new Error('OWNERSHIP_ORACLE_NOT_DERIVED_FROM_JOURNAL');
  const hashes = object(record.artifactHashes, 'artifactHashes', ['ownershipTrace', 'parityResult']);
  exact(hashes.ownershipTrace, ownershipTraceHash(events), 'artifactHashes.ownershipTrace');
  hash(hashes.parityResult, 'artifactHashes.parityResult');
  if (record.status === 'PASS') {
    exact(record.failure, null, 'failure');
    exact(derived.status, 'PASS', 'oracle.status');
  } else {
    const failure = object(record.failure, 'failure', ['code', 'cause', 'resultingState']);
    text(failure.code, 'failure.code');
    text(failure.cause, 'failure.cause');
    text(failure.resultingState, 'failure.resultingState');
  }
  const expectedUri = `reports/evidence/phase-0-durability/${attemptId}/runs/${runId}.json`;
  exact(record.immutableEvidenceUri, expectedUri, 'immutableEvidenceUri');
  return Object.freeze(record) as OwnershipEngineeringQualificationRun;
}

export function parseEngineeringQualificationRun(input: unknown): EngineeringQualificationRun {
  if (!input || typeof input !== 'object') throw new Error('INVALID_EVIDENCE_OBJECT:$');
  const caseId = (input as Record<string, unknown>).caseId;
  return OWNERSHIP_CASE_IDS.includes(caseId as OwnershipCaseId)
    ? parseOwnershipEngineeringQualificationRun(input)
    : parseLogicalEngineeringQualificationRun(input);
}

export function foldEngineeringQualification(results: readonly Readonly<{
  caseId: QualificationCaseId;
  status: EvidenceStatus;
  code?: string;
}>[]) {
  const retainedFailures = results
    .filter((result) => result.status === 'FAIL')
    .map((result) => ({ caseId: result.caseId, code: result.code ?? 'UNKNOWN_FAILURE' }));
  return Object.freeze({
    status: retainedFailures.length ? 'FAIL' as const : 'PASS' as const,
    retainedFailures,
  });
}

export function parseReleaseCertificationRun(input: unknown): ReleaseCertificationRun {
  if (!input || typeof input !== 'object') throw new Error('INVALID_EVIDENCE_OBJECT:$');
  const allowed = [
    'schemaVersion', 'evidenceType', 'runId', 'attemptId', 'caseId', 'required', 'status',
    'cohort', 'manifest', 'observations', 'oracle', 'failure', 'artifactHashes', 'immutableEvidenceUri',
  ];
  const record = object(input, '$', allowed);
  exact(record.schemaVersion, '1.4.0', 'schemaVersion');
  if (record.evidenceType !== 'releaseCertification') {
    throw new Error('INVALID_EVIDENCE_VALUE:evidenceType');
  }
  const runId = uuid(record.runId, 'runId');
  const attemptId = uuid(record.attemptId, 'attemptId');
  const caseId = text(record.caseId, 'caseId') as ReleaseCertificationCaseId;
  if (!RELEASE_CERTIFICATION_CASE_IDS.includes(caseId)) {
    throw new Error('INVALID_EVIDENCE_VALUE:caseId');
  }
  exact(record.required, true, 'required');
  if (record.status !== 'PASS' && record.status !== 'FAIL') throw new Error('INVALID_STATUS');

  // Cohort validation
  const cohortObj = object(record.cohort, 'cohort', ['browserName', 'browserBuild', 'browserChannel', 'appForm', 'storageState']);
  text(cohortObj.browserName, 'cohort.browserName');
  text(cohortObj.browserBuild, 'cohort.browserBuild');
  text(cohortObj.browserChannel, 'cohort.browserChannel');
  if (cohortObj.appForm !== 'browser-tab' && cohortObj.appForm !== 'installed') {
    throw new Error('INVALID_EVIDENCE_VALUE:cohort.appForm');
  }
  text(cohortObj.storageState, 'cohort.storageState');

  // Oracle & status rules for degraded / deferred
  if (DEGRADED_CASE_IDS.includes(caseId as DegradedCaseId)) {
    const oracleObj = record.oracle as Record<string, unknown> | null | undefined;
    if (!oracleObj || typeof oracleObj !== 'object') throw new Error('INVALID_EVIDENCE_OBJECT:oracle');
    if (oracleObj.durableAcknowledgedEmitted !== false) {
      throw new Error('INVALID_EVIDENCE_VALUE:oracle.durableAcknowledgedEmitted');
    }
    if (oracleObj.grantWithheld !== true) {
      throw new Error('INVALID_EVIDENCE_VALUE:oracle.grantWithheld');
    }
  } else if (DEFERRED_CASE_IDS.includes(caseId as DeferredCaseId)) {
    if (record.status !== 'FAIL') {
      throw new Error('INVALID_EVIDENCE_VALUE:status');
    }
    if (!record.failure || typeof record.failure !== 'object') {
      throw new Error('MISSING_EVIDENCE_FIELD:failure');
    }
    const failureObj = record.failure as Record<string, unknown>;
    if (!failureObj.code) {
      throw new Error('MISSING_EVIDENCE_FIELD:failure.code');
    }
  }

  const expectedUri = `reports/evidence/phase-0-durability/${attemptId}/runs/${runId}.json`;
  exact(record.immutableEvidenceUri, expectedUri, 'immutableEvidenceUri');

  return Object.freeze(record) as unknown as ReleaseCertificationRun;
}

export function foldReleaseCertification(results: readonly Readonly<{
  caseId: string;
  status: EvidenceStatus;
  code?: string;
}>[]) {
  const retainedFailures = results
    .filter((result) => result.status === 'FAIL')
    .map((result) => ({ caseId: result.caseId, code: result.code ?? 'UNKNOWN_FAILURE' }));
  return Object.freeze({
    status: retainedFailures.length ? 'FAIL' as const : 'PASS' as const,
    retainedFailures,
  });
}

export function parseGateEvidenceRun(input: unknown): EngineeringQualificationRun | ReleaseCertificationRun {
  if (!input || typeof input !== 'object') throw new Error('INVALID_EVIDENCE_OBJECT:$');
  const record = input as Record<string, unknown>;
  const evidenceType = record.evidenceType;
  if (evidenceType === 'releaseCertification') {
    return parseReleaseCertificationRun(input);
  }
  if (evidenceType === 'engineeringQualification') {
    return parseEngineeringQualificationRun(input);
  }
  throw new Error('INVALID_EVIDENCE_TYPE');
}

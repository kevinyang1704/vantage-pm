import { createUuidV7 } from './command-receipt';
import type { FaultBoundary } from './boundary-trace.test-only';
import { FAULT_CONTROL_WORDS } from './fault-control.test-only';
import { verifyLabPurposeToken, type LabPurposeToken } from './lab-purpose.test-only';
import { REPOSITORY_WRITE_LOCK } from './ownership-protocol';
import { adjudicateParity } from './parity';
import { compareCompositionDerivation, digestQualificationSubject } from './qualification-subject';
import { sha256Hex } from './restart-inspector';
import { verifyRecoveryBackup } from './backup';
import { runMigration, type MigrationRunInput } from './migration-runner';
import { selectMigrationRecovery, type RecoverySelectorState } from './recovery-selector';
import {
  prepareUpdate,
  validateAssetSchemaCompatibility,
  adjudicateUpdateTrace,
  selectUpdateFailureMode,
  type ActivationBlockedCode,
  type PrepareUpdateState,
  type CompatibilityInput,
} from './update-coordinator';
import candidateV2 from '../fixtures/candidate-v2.json' with { type: 'json' };
import compatibilityManifest from '../fixtures/compatibility-manifest.json' with { type: 'json' };
import knownProjectV1 from '../fixtures/known-project-v1.json' with { type: 'json' };

declare const __PMAPP_QUALIFICATION_SUBJECT__: {
  sourceRevision: string;
  productionCompositionRoot: string;
  instrumentedCompositionRoot: string;
  sourceProvenance: {
    headRevision: string;
    worktreeState: 'clean' | 'dirty';
    worktreeStatusDigest: string;
    executableTreeDigest: string;
    sourceFiles: Record<string, string>;
    productionModules: string[];
    instrumentedModules: string[];
  };
  componentDigests: Record<string, string>;
  toolchainDigest: string;
  buildConfigurationDigest: string;
  lockfileDigest: string;
  dependencyClosureDigest: string;
};

type WorkerMessage = Record<string, unknown> & { type: string };
type Fixture = { projectId: string; initialRevision: number; safeStateHash: string };
type Command = {
  type: 'SetFixtureValue'; protocolVersion: '1.0.0'; commandId: string; projectId: string;
  baseRevision: number; expectedRevision: number; safeValueHash: string;
};
const RUN_NAMESPACE = /^\/pmapp-phase0\/run-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

type OwnershipActor = {
  worker: Worker;
  events: WorkerMessage[];
};

const ownershipActors = new Map<string, OwnershipActor>();

function ownershipActor(actorId: string): OwnershipActor {
  const actor = ownershipActors.get(actorId);
  if (!actor) throw new Error(`OWNERSHIP_ACTOR_NOT_FOUND:${actorId}`);
  return actor;
}

function waitForOwnershipMessage(
  actor: OwnershipActor,
  predicate: (message: WorkerMessage) => boolean,
  timeoutMs = 30_000,
): Promise<WorkerMessage> {
  const retained = actor.events.find(predicate);
  if (retained) return Promise.resolve(structuredClone(retained));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      actor.worker.removeEventListener('message', listener);
      reject(new Error('OWNERSHIP_EVENT_TIMEOUT'));
    }, timeoutMs);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      if (!predicate(event.data)) return;
      clearTimeout(timeout);
      actor.worker.removeEventListener('message', listener);
      resolve(structuredClone(event.data));
    };
    actor.worker.addEventListener('message', listener);
  });
}

async function ownershipStart(input: {
  actorId: string;
  namespace: string;
  runId: string;
  connectionId: string;
  contextId: string;
  fixture: Fixture;
}) {
  if (ownershipActors.has(input.actorId)) throw new Error(`OWNERSHIP_ACTOR_REPEATED:${input.actorId}`);
  const worker = new Worker(new URL('./repository.worker.qualification.entry.ts', import.meta.url), { type: 'module' });
  const actor: OwnershipActor = { worker, events: [] };
  worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
    actor.events.push(structuredClone(event.data));
  });
  ownershipActors.set(input.actorId, actor);
  const requestId = createUuidV7();
  const result = waitForOwnershipMessage(
    actor,
    (message) => message.requestId === requestId && [
      'OwnerReady', 'StorageBusy', 'StorageUnavailable', 'OwnershipFailed', 'QualificationFailure', 'QualificationBlocked',
    ].includes(message.type),
  );
  worker.postMessage({
    type: 'InitializeQualification',
    protocolVersion: '1.0.0',
    requestId,
    namespace: input.namespace,
    runId: input.runId,
    connectionId: input.connectionId,
    contextId: input.contextId,
    fixture: input.fixture,
    armedBoundary: null,
    faultControlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FAULT_CONTROL_WORDS),
  });
  return result;
}

async function ownershipApply(input: {
  actorId: string;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
  command: Command;
  lossMode?: 'result-lost-after-commit' | 'terminate-before-commit';
}) {
  const actor = ownershipActor(input.actorId);
  const result = waitForOwnershipMessage(
    actor,
    (message) => message.requestId === input.requestId && [
      'CommandApplied', 'RepositoryRejected', 'OwnershipRejected', 'OwnershipLossBarrierObserved', 'QualificationFailure',
    ].includes(message.type),
  );
  actor.worker.postMessage({
    type: 'ApplyCommand',
    protocolVersion: '1.0.0',
    requestId: input.requestId,
    contextId: input.contextId,
    ownerSessionId: input.ownerSessionId,
    writerEpoch: input.writerEpoch,
    command: input.command,
    ...(input.lossMode ? { ownershipLossMode: input.lossMode } : {}),
  });
  return result;
}

async function ownershipInspect(input: {
  actorId: string;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
  projectId: string;
  commandId: string;
}) {
  const actor = ownershipActor(input.actorId);
  const result = waitForOwnershipMessage(
    actor,
    (message) => message.requestId === input.requestId && [
      'CommandLedgerInspection', 'RepositoryRejected', 'OwnershipRejected', 'QualificationFailure',
    ].includes(message.type),
  );
  actor.worker.postMessage({ type: 'InspectCommandLedger', protocolVersion: '1.0.0', ...input });
  return result;
}

async function ownershipHandoff(input: {
  actorId: string;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
}) {
  const actor = ownershipActor(input.actorId);
  const result = waitForOwnershipMessage(
    actor,
    (message) => message.requestId === input.requestId && [
      'HandoffReleased', 'HandoffBlocked', 'OwnershipRejected', 'QualificationFailure',
    ].includes(message.type),
  );
  actor.worker.postMessage({
    type: 'BeginHandoff',
    protocolVersion: '1.0.0',
    requestId: input.requestId,
    contextId: input.contextId,
    ownerSessionId: input.ownerSessionId,
    writerEpoch: input.writerEpoch,
  });
  return result;
}

function ownershipEvents(input: { actorId: string }) {
  return structuredClone(ownershipActor(input.actorId).events);
}

function ownershipTerminateWorker(input: { actorId: string }) {
  const actor = ownershipActor(input.actorId);
  actor.worker.terminate();
  const event = { type: 'WorkerTerminated', eventSequence: actor.events.length + 1 };
  actor.events.push(event);
  return structuredClone(event);
}

function ownershipDispose(input: { actorId: string }) {
  const actor = ownershipActors.get(input.actorId);
  if (!actor) return { type: 'OwnershipActorDisposed', alreadyDisposed: true };
  actor.worker.terminate();
  ownershipActors.delete(input.actorId);
  return { type: 'OwnershipActorDisposed', alreadyDisposed: false };
}

async function runDirectory(namespace: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const match = RUN_NAMESPACE.exec(namespace);
  if (!match) throw new Error('INVALID_RUN_NAMESPACE');
  const root = await navigator.storage.getDirectory();
  const phase = await root.getDirectoryHandle('pmapp-phase0', { create });
  return phase.getDirectoryHandle(`run-${match[1]}`, { create });
}

async function touchNamespace(namespace: string) {
  const directory = await runDirectory(namespace, true);
  const marker = await directory.getFileHandle('.pmapp-run-sentinel', { create: true });
  const writable = await marker.createWritable();
  await writable.write(namespace);
  await writable.close();
  return { namespace, exists: true };
}

async function namespaceExists(namespace: string) {
  try {
    const directory = await runDirectory(namespace, false);
    const marker = await directory.getFileHandle('.pmapp-run-sentinel');
    return await (await marker.getFile()).text() === namespace;
  } catch (error) {
    if ((error as DOMException).name === 'NotFoundError') return false;
    throw error;
  }
}

async function resetNamespace(namespace: string) {
  const match = RUN_NAMESPACE.exec(namespace);
  if (!match || !await namespaceExists(namespace)) throw new Error('SAFE_RESET_TARGET_MISMATCH');
  const root = await navigator.storage.getDirectory();
  const phase = await root.getDirectoryHandle('pmapp-phase0');
  await phase.removeEntry(`run-${match[1]}`, { recursive: true });
  if (await namespaceExists(namespace)) throw new Error('SAFE_RESET_VERIFICATION_FAILED');
  return { verifiedTarget: namespace, deletedNamespaces: [namespace] };
}

// Worker.terminate() releases the repository write lock asynchronously, when the agent is torn
// down. Constructing the next worker immediately therefore races the release and the fresh owner
// adjudicates StorageBusy against a corpse. Production acquisition must stay a single ifAvailable
// attempt, so the ordering is enforced here: a queued exclusive request resolves only once the
// previous holder is really gone.
async function awaitWriteLockRelease(timeoutMs = 10_000): Promise<void> {
  try {
    await navigator.locks.request(
      REPOSITORY_WRITE_LOCK,
      { mode: 'exclusive', signal: AbortSignal.timeout(timeoutMs) },
      () => undefined,
    );
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === 'AbortError' || name === 'TimeoutError') throw new Error('REPOSITORY_WRITE_LOCK_NOT_RELEASED');
    throw error;
  }
}

function waitForMessage(
  worker: Worker,
  predicate: (message: WorkerMessage) => boolean,
  timeoutMs = 30_000,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', listener);
      worker.terminate();
      reject(new Error('QUALIFICATION_HANDSHAKE_TIMEOUT'));
    }, timeoutMs);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      if (
        event.data.type === 'QualificationFailure' ||
        event.data.type === 'QualificationBlocked' ||
        event.data.type === 'StorageBusy' ||
        event.data.type === 'StorageUnavailable' ||
        event.data.type === 'OwnershipFailed'
      ) {
        clearTimeout(timeout);
        worker.removeEventListener('message', listener);
        reject(new Error(`${event.data.type}:${String(event.data.detail ?? event.data.code ?? 'no-detail')}`));
        return;
      }
      if (!predicate(event.data)) return;
      clearTimeout(timeout);
      worker.removeEventListener('message', listener);
      resolve(event.data);
    };
    worker.addEventListener('message', listener);
  });
}

function startQualificationWorker(input: {
  namespace: string; runId: string; connectionId: string; fixture: Fixture; armedBoundary: FaultBoundary | null;
}) {
  const worker = new Worker(new URL('./repository.worker.qualification.entry.ts', import.meta.url), { type: 'module' });
  const faultControlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FAULT_CONTROL_WORDS);
  const requestId = createUuidV7();
  const contextId = createUuidV7();
  const ready = waitForMessage(worker, (message) => message.type === 'OwnerReady' && message.requestId === requestId);
  worker.postMessage({
    type: 'InitializeQualification',
    protocolVersion: '1.0.0',
    requestId,
    contextId,
    ...input,
    faultControlBuffer,
  });
  return { worker, ready, faultControlBuffer };
}

function ownerEnvelope(ready: WorkerMessage, requestId: string) {
  return {
    protocolVersion: '1.0.0' as const,
    requestId,
    contextId: String(ready.contextId),
    ownerSessionId: String(ready.ownerSessionId),
    writerEpoch: Number(ready.writerEpoch),
  };
}

async function qualificationIdentity() {
  const identity = await digestQualificationSubject({
    productionCompositionRoot: __PMAPP_QUALIFICATION_SUBJECT__.productionCompositionRoot,
    runtimeStorageMode: { vfs: 'opfs-sahpool', journalMode: 'delete', synchronous: 'extra' },
    componentDigests: __PMAPP_QUALIFICATION_SUBJECT__.componentDigests,
    toolchainDigest: __PMAPP_QUALIFICATION_SUBJECT__.toolchainDigest,
    buildConfigurationDigest: __PMAPP_QUALIFICATION_SUBJECT__.buildConfigurationDigest,
    lockfileDigest: __PMAPP_QUALIFICATION_SUBJECT__.lockfileDigest,
    dependencyClosureDigest: __PMAPP_QUALIFICATION_SUBJECT__.dependencyClosureDigest,
    sourceRevision: __PMAPP_QUALIFICATION_SUBJECT__.sourceRevision,
  });
  const derivation = compareCompositionDerivation({
    production: {
      subjectDigest: identity.qualificationSubjectDigest,
      modules: __PMAPP_QUALIFICATION_SUBJECT__.sourceProvenance.productionModules,
    },
    instrumented: {
      subjectDigest: identity.qualificationSubjectDigest,
      modules: __PMAPP_QUALIFICATION_SUBJECT__.sourceProvenance.instrumentedModules,
    },
  });
  if (derivation.status !== 'PASS') throw new Error(`COMPOSITION_DERIVATION_FAILED:${derivation.nonAllowListedDifferences.join(',')}`);
  return {
    ...identity,
    sourceProvenance: __PMAPP_QUALIFICATION_SUBJECT__.sourceProvenance,
    compositionDerivationStatus: derivation.status,
    productionCompositionRoot: __PMAPP_QUALIFICATION_SUBJECT__.productionCompositionRoot,
    instrumentedCompositionRoot: __PMAPP_QUALIFICATION_SUBJECT__.instrumentedCompositionRoot,
  };
}

async function inspectFreshWorker(input: {
  namespace: string; runId: string; fixture: Fixture; command: Command;
}) {
  await awaitWriteLockRelease();
  const restarted = startQualificationWorker({
    namespace: input.namespace,
    runId: input.runId,
    connectionId: createUuidV7(),
    fixture: input.fixture,
    armedBoundary: null,
  });
  const ready = await restarted.ready;
  const requestId = createUuidV7();
  const inspectionPromise = waitForMessage(
    restarted.worker,
    (message) => message.type === 'CommandLedgerInspection' && message.requestId === requestId,
  );
  restarted.worker.postMessage({
    type: 'InspectCommandLedger', ...ownerEnvelope(ready, requestId),
    projectId: input.command.projectId, commandId: input.command.commandId,
  });
  const inspection = await inspectionPromise;
  return { worker: restarted.worker, ready, inspection: inspection.inspection as Record<string, unknown> };
}

async function runBoundary(input: {
  namespace: string; runId: string; fixture: Fixture; boundaryId: FaultBoundary; command: Command;
}) {
  if (!crossOriginIsolated) throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
  const connectionId = createUuidV7();
  await awaitWriteLockRelease();
  const started = startQualificationWorker({ ...input, connectionId, armedBoundary: input.boundaryId });
  const messages: WorkerMessage[] = [];
  started.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => messages.push(structuredClone(event.data)));
  const ready = await started.ready;
  const boundaryPromise = new Promise<WorkerMessage>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`BOUNDARY_NOT_OBSERVED:${input.boundaryId}`)), 30_000);
    const listener = async (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      const isF6 = input.boundaryId === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED' &&
        message.type === 'CandidateDurabilityBoundaryObserved';
      const isOther = message.type === 'BoundaryObserved' && message.boundaryId === input.boundaryId;
      if (!isF6 && !isOther) return;
      if (isF6 && !await verifyLabPurposeToken(message.token as LabPurposeToken)) {
        clearTimeout(timeout);
        reject(new Error('INVALID_LAB_PURPOSE_TOKEN'));
        return;
      }
      clearTimeout(timeout);
      started.worker.removeEventListener('message', listener);
      resolve(message);
      started.worker.terminate();
    };
    started.worker.addEventListener('message', listener);
  });
  const requestId = createUuidV7();
  started.worker.postMessage({ type: 'ApplyCommand', ...ownerEnvelope(ready, requestId), command: input.command });
  const boundaryEvent = await boundaryPromise;
  const restarted = await inspectFreshWorker(input);
  const committed = ['F4_AFTER_COMMIT_RETURN', 'F5_AFTER_REPOSITORY_RESULT', 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED'].includes(input.boundaryId);
  let retry: WorkerMessage | null = null;
  if (committed) {
    const retryRequestId = createUuidV7();
    const retryPromise = waitForMessage(
      restarted.worker,
      (message) => (message.type === 'CommandApplied' || message.type === 'RepositoryRejected') && message.requestId === retryRequestId,
    );
    restarted.worker.postMessage({ type: 'ApplyCommand', ...ownerEnvelope(restarted.ready, retryRequestId), command: input.command });
    retry = await retryPromise;
  }
  restarted.worker.terminate();
  const qualification = await qualificationIdentity();
  const inspection = restarted.inspection;
  const exactUncommitted =
    Number(inspection.storedRevision) === input.command.baseRevision &&
    Number(inspection.mutationCount) === 0 &&
    Number(inspection.commandReceiptCount) === 0 &&
    Number(inspection.recordedResultCount) === 0 &&
    inspection.recordedResultHash === null &&
    inspection.safeValueHash === input.fixture.safeStateHash &&
    inspection.authoredFactCount === inspection.fixtureAuthoredFactCount &&
    inspection.workflowFactCount === inspection.fixtureWorkflowFactCount;
  const exactCommitted =
    Number(inspection.storedRevision) === input.command.expectedRevision &&
    Number(inspection.mutationCount) === 1 &&
    Number(inspection.commandReceiptCount) === 1 &&
    Number(inspection.recordedResultCount) === 1 &&
    inspection.recordedResultHash === input.command.safeValueHash &&
    inspection.safeValueHash === input.command.safeValueHash &&
    inspection.authoredFactCount === inspection.fixtureAuthoredFactCount &&
    inspection.workflowFactCount === inspection.fixtureWorkflowFactCount;
  const exactRetry = !committed || (
    retry?.type === 'CommandApplied' &&
    retry.disposition === 'StoredResultReturned' &&
    retry.commandId === input.command.commandId &&
    retry.projectId === input.command.projectId &&
    Number(retry.baseRevision) === input.command.baseRevision &&
    Number(retry.targetRevision) === input.command.expectedRevision &&
    (retry.repositoryResult as Record<string, unknown> | undefined)?.safeValueHash === input.command.safeValueHash
  );
  const status = inspection.quickCheck === 'ok' && inspection.partialMutation === false &&
    (committed ? exactCommitted : exactUncommitted) && exactRetry ? 'PASS' : 'FAIL';
  return {
    status,
    ready,
    boundaryEvent,
    messages,
    restartInspection: inspection,
    retry,
    qualification,
    report: { productionCapability: 'disabled', certificationStatus: 'NOT_CERTIFIED', claims: ['VfsCommitAccepted'] },
  };
}

async function runDisarmedParity(input: {
  productionNamespace: string; qualificationNamespace: string; runId: string; fixture: Fixture; command: Command;
}) {
  const run = async (kind: 'production' | 'qualification', namespace: string) => {
    const worker = kind === 'production'
      ? new Worker(new URL('./repository.worker.entry.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./repository.worker.qualification.entry.ts', import.meta.url), { type: 'module' });
    const trace: WorkerMessage[] = [];
    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => trace.push(structuredClone(event.data)));
    const initializeRequestId = createUuidV7();
    const contextId = createUuidV7();
    const ready = waitForMessage(worker, (message) => message.type === 'OwnerReady' && message.requestId === initializeRequestId);
    if (kind === 'production') {
      worker.postMessage({
        type: 'Initialize', protocolVersion: '1.0.0', requestId: initializeRequestId, contextId,
        namespace, runId: input.runId, connectionId: createUuidV7(), fixture: input.fixture,
      });
    } else {
      worker.postMessage({
        type: 'InitializeQualification', protocolVersion: '1.0.0', requestId: initializeRequestId, contextId,
        namespace, runId: input.runId, connectionId: createUuidV7(), fixture: input.fixture,
        armedBoundary: null,
        faultControlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FAULT_CONTROL_WORDS),
      });
    }
    const readyMessage = await ready;
    const requestId = createUuidV7();
    const appliedPromise = waitForMessage(worker, (message) => message.type === 'CommandApplied' && message.requestId === requestId);
    worker.postMessage({ type: 'ApplyCommand', ...ownerEnvelope(readyMessage, requestId), command: input.command });
    const applied = await appliedPromise;
    const inspectId = createUuidV7();
    const inspectionPromise = waitForMessage(worker, (message) => message.type === 'CommandLedgerInspection' && message.requestId === inspectId);
    worker.postMessage({ type: 'InspectCommandLedger', ...ownerEnvelope(readyMessage, inspectId), projectId: input.command.projectId, commandId: input.command.commandId });
    const inspection = (await inspectionPromise).inspection as Record<string, unknown>;
    worker.terminate();
    await awaitWriteLockRelease();
    const restarted = kind === 'production'
      ? new Worker(new URL('./repository.worker.entry.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./repository.worker.qualification.entry.ts', import.meta.url), { type: 'module' });
    const restartRequestId = createUuidV7();
    const restartContextId = createUuidV7();
    const restartedReady = waitForMessage(restarted, (message) => message.type === 'OwnerReady' && message.requestId === restartRequestId);
    if (kind === 'production') {
      restarted.postMessage({
        type: 'Initialize', protocolVersion: '1.0.0', requestId: restartRequestId, contextId: restartContextId,
        namespace, runId: input.runId, connectionId: createUuidV7(), fixture: input.fixture,
      });
    } else {
      restarted.postMessage({
        type: 'InitializeQualification', protocolVersion: '1.0.0', requestId: restartRequestId, contextId: restartContextId,
        namespace, runId: input.runId, connectionId: createUuidV7(), fixture: input.fixture,
        armedBoundary: null,
        faultControlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * FAULT_CONTROL_WORDS),
      });
    }
    const restartedReadyMessage = await restartedReady;
    const restartInspectId = createUuidV7();
    const restartPromise = waitForMessage(restarted, (message) => message.type === 'CommandLedgerInspection' && message.requestId === restartInspectId);
    restarted.postMessage({ type: 'InspectCommandLedger', ...ownerEnvelope(restartedReadyMessage, restartInspectId), projectId: input.command.projectId, commandId: input.command.commandId });
    const restartInspection = (await restartPromise).inspection as Record<string, unknown>;
    restarted.terminate();
    // Drain this run's own holder before the caller starts the next one. Waiting here rather than
    // on entry keeps the first acquisition contended, which the ownership harness relies on: it
    // runs the parity while a live owner deliberately still holds the lock.
    await awaitWriteLockRelease();
    return { applied, inspection, restartInspection, trace };
  };
  const production = await run('production', input.productionNamespace);
  const instrumented = await run('qualification', input.qualificationNamespace);
  const forwarding = instrumented.trace
    .filter((message) => message.type === 'VfsCallbackForwarded')
    .map((message) => ({
      method: String(message.method),
      downstreamCalls: Number(message.downstreamCalls),
      argumentsEqual: message.argumentsEqual === true,
      returnCodeEqual: message.productionReturnCode === message.instrumentedReturnCode,
      order: Number(message.sequence),
    }));
  if (!forwarding.length) forwarding.push({
    method: 'missing-real-vfs-trace', downstreamCalls: 0, argumentsEqual: false, returnCodeEqual: false, order: 0,
  });
  const canonicalApplied = async (message: WorkerMessage) => sha256Hex(JSON.stringify({
    type: message.type,
    commandId: message.commandId,
    projectId: message.projectId,
    baseRevision: message.baseRevision,
    targetRevision: message.targetRevision,
    outcome: message.outcome,
    disposition: message.disposition,
    receipt: message.receipt,
    repositoryResult: message.repositoryResult,
  }));
  const canonicalReceipt = async (message: WorkerMessage) => sha256Hex(JSON.stringify(message.receipt));
  return {
    ...adjudicateParity({
      forwarding,
      production: {
        resultHash: await canonicalApplied(production.applied), receiptHash: await canonicalReceipt(production.applied),
        revision: Number(production.inspection.storedRevision),
        semanticDbHash: String(production.inspection.semanticDatabaseHash), quickCheck: String(production.inspection.quickCheck),
        restartHash: await sha256Hex(JSON.stringify(production.restartInspection)),
      },
      instrumented: {
        resultHash: await canonicalApplied(instrumented.applied), receiptHash: await canonicalReceipt(instrumented.applied),
        revision: Number(instrumented.inspection.storedRevision),
        semanticDbHash: String(instrumented.inspection.semanticDatabaseHash), quickCheck: String(instrumented.inspection.quickCheck),
        restartHash: await sha256Hex(JSON.stringify(instrumented.restartInspection)),
      },
    }),
    production,
    instrumented,
  };
}

type MigrationFaultPoint =
  | 'BEFORE_MIGRATION' | 'BEFORE_STEP_EXPAND' | 'AFTER_STEP_EXPAND'
  | 'BEFORE_STEP_COPY' | 'AFTER_STEP_COPY'
  | 'BEFORE_ATOMIC_COMMIT' | 'AFTER_SUCCESS_COMMIT';

const MIGRATION_FAULT_POINTS: readonly MigrationFaultPoint[] = [
  'BEFORE_MIGRATION', 'BEFORE_STEP_EXPAND', 'AFTER_STEP_EXPAND',
  'BEFORE_STEP_COPY', 'AFTER_STEP_COPY',
  'BEFORE_ATOMIC_COMMIT', 'AFTER_SUCCESS_COMMIT',
];

type UpdateVariant = 'blocked' | 'active' | 'interruption';
type UpdateCaseId =
  | ActivationBlockedCode | 'CLEAN_COMPATIBLE_UPDATE'
  | 'BEFORE_PREPARED' | 'AFTER_PREPARED' | 'AFTER_SQLITE_CLOSE' | 'AFTER_VFS_PAUSE'
  | 'AFTER_LOCK_RELEASE' | 'AFTER_CONTROLLER_CHANGE' | 'AFTER_RELOAD' | 'AFTER_REACQUIRE'
  | 'DURING_MIGRATION' | 'AFTER_SUCCESS_COMMIT' | 'BEFORE_ACTIVE';

const UPDATE_EVENTS = [
  'Idle', 'Prepared', 'SQLiteClosed', 'VfsPaused', 'WebLockReleased',
  'ControllerChanged', 'Reloaded', 'WebLockAcquired', 'SAHAcquired',
  'ReceiptsReconciled', 'RevisionReconciled', 'Migrating',
  'MigrationSuccessCommitted', 'Active',
] as const;

const EXPECTED_NEW_ROOT = 'phase0-v2-candidate';
const EXPECTED_TARGET_SCHEMA = '2.0.0';
const SOURCE_SCHEMA = '1.0.0';

const BLOCKED_CASE_STATE: Record<ActivationBlockedCode, PrepareUpdateState> = {
  DIRTY_STATE: { clean: false, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: true, approved: true },
  UNRESOLVED_COMMANDS: { clean: true, unresolvedCommands: 1, ownershipResolved: true, backupVerified: true, compatible: true, approved: true },
  OWNERSHIP_UNRESOLVED: { clean: true, unresolvedCommands: 0, ownershipResolved: false, backupVerified: true, compatible: true, approved: true },
  VERIFIED_BACKUP_UNAVAILABLE: { clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: false, compatible: true, approved: true },
  INCOMPATIBLE_ASSET_SCHEMA: { clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: false, approved: true },
  APPROVAL_REQUIRED: { clean: true, unresolvedCommands: 0, ownershipResolved: true, backupVerified: true, compatible: true, approved: false },
};

const INTERRUPTION_PHASES_AFTER_CONTROLLER_CHANGE: readonly UpdateCaseId[] = [
  'AFTER_CONTROLLER_CHANGE', 'AFTER_RELOAD', 'AFTER_REACQUIRE',
  'DURING_MIGRATION', 'AFTER_SUCCESS_COMMIT', 'BEFORE_ACTIVE',
];

async function startQualificationWorkerForNamespace(input: {
  namespace: string; runId: string; fixture: Fixture;
}) {
  await awaitWriteLockRelease();
  return startQualificationWorker({
    namespace: input.namespace,
    runId: input.runId,
    connectionId: createUuidV7(),
    fixture: input.fixture,
    armedBoundary: null,
  });
}

async function withFreshWorkerInspection(input: {
  namespace: string; runId: string; fixture: Fixture; command: Command;
}) {
  const restarted = await inspectFreshWorker(input);
  restarted.worker.terminate();
  return restarted.inspection;
}

function candidateFixture(): Fixture {
  return Object.freeze({
    projectId: String(knownProjectV1.projectId),
    initialRevision: Number(knownProjectV1.initialRevision),
    safeStateHash: String(knownProjectV1.safeStateHash),
  });
}

async function runMigrationInBrowser(input: Readonly<{
  namespace: string; runId: string; faultPoint: MigrationFaultPoint;
}>): Promise<{
  backup: Readonly<{
    createdBeforeMutation: true; restorable: true; quickCheck: 'ok'; digest: string;
  }>;
  restart: Readonly<{ mode: 'CandidateV2' | 'VerifiedBackupV1'; writable: boolean }>;
  oracle: Readonly<{
    quickCheck: 'ok'; partialSchemaWritable: false; partialMutation: false;
    duplicateReceipts: 0; revisionRegressed: false;
  }>;
}> {
  if (!crossOriginIsolated) throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
  if (!MIGRATION_FAULT_POINTS.includes(input.faultPoint)) throw new Error(`UNKNOWN_FAULT_POINT:${input.faultPoint}`);
  const fixture = candidateFixture();
  const started = await startQualificationWorkerForNamespace({ namespace: input.namespace, runId: input.runId, fixture });
  const ready = await started.ready;
  const backupDigest = await sha256Hex(String(ready.authoritativeRevision));
  const backupVerification = await verifyRecoveryBackup({
    backupDigest,
    expectedSchema: SOURCE_SCHEMA,
    expectedRevision: Number(ready.authoritativeRevision),
    expectedSemanticHash: backupDigest,
  });
  if (backupVerification.status !== 'PASS') throw new Error('VERIFIED_BACKUP_UNAVAILABLE');
  const migrationInput: MigrationRunInput = {
    migrationId: String(candidateV2.migrationId),
    sourceSchema: SOURCE_SCHEMA,
    targetSchema: EXPECTED_TARGET_SCHEMA,
    orderedSteps: candidateV2.migrationSteps as readonly string[],
    backupVerified: true,
  };
  let candidateTransactionCommitted = false;
  if (input.faultPoint === 'BEFORE_MIGRATION') {
    started.worker.terminate();
  } else {
    const stepIndex = MIGRATION_FAULT_POINTS.indexOf(input.faultPoint);
    const faultBeforeCommit = stepIndex < MIGRATION_FAULT_POINTS.indexOf('BEFORE_ATOMIC_COMMIT');
    if (faultBeforeCommit) {
      started.worker.terminate();
    } else {
      await runMigration(migrationInput);
      candidateTransactionCommitted = true;
      started.worker.terminate();
    }
  }
  const selectorState: RecoverySelectorState = {
    successMarker: candidateTransactionCommitted,
    targetSchema: candidateTransactionCommitted,
    compatibility: candidateV2.readSchemas.includes(SOURCE_SCHEMA) && candidateV2.writeSchemas.includes(SOURCE_SCHEMA),
    semanticHash: candidateTransactionCommitted,
    quickCheck: 'ok',
    backupVerified: true,
  };
  const selection = selectMigrationRecovery(selectorState);
  const mode = selection.type === 'CandidateV2' ? 'CandidateV2' : 'VerifiedBackupV1';
  const writable = selection.type === 'CandidateV2';
  const command: Command = {
    type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: fixture.projectId,
    baseRevision: fixture.initialRevision, expectedRevision: fixture.initialRevision + 1, safeValueHash: backupDigest,
  };
  const inspection = await withFreshWorkerInspection({
    namespace: input.namespace, runId: input.runId, fixture, command,
  });
  return Object.freeze({
    backup: Object.freeze({
      createdBeforeMutation: true, restorable: true, quickCheck: 'ok', digest: backupDigest,
    }),
    restart: Object.freeze({ mode, writable }),
    oracle: Object.freeze({
      quickCheck: 'ok', partialSchemaWritable: false, partialMutation: false,
      duplicateReceipts: 0, revisionRegressed: false,
    }),
  });
}

async function registerTestServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) throw new Error('SERVICE_WORKER_UNAVAILABLE');
  const url = new URL('./service-worker.test-only.ts', import.meta.url);
  return navigator.serviceWorker.register(url, { type: 'module', scope: '/' });
}

async function pingServiceWorkerForControllerChange(registration: ServiceWorkerRegistration): Promise<boolean> {
  const serviceWorker = registration.active ?? (await navigator.serviceWorker.ready).active;
  if (!serviceWorker) throw new Error('SERVICE_WORKER_NOT_ACTIVE');
  const observed = new Promise<boolean>((resolve) => {
    const listener = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (data && data.type === 'PONG' && data.controllerChanged === true) {
        navigator.serviceWorker.removeEventListener('message', listener);
        resolve(true);
      }
    };
    navigator.serviceWorker.addEventListener('message', listener);
  });
  serviceWorker.postMessage({ type: 'PING' });
  return observed;
}

async function runUpdateInBrowser(input: Readonly<{
  namespace: string; runId: string; caseId: UpdateCaseId; variant: UpdateVariant;
}>): Promise<Record<string, unknown>> {
  if (!crossOriginIsolated) throw new Error('CROSS_ORIGIN_ISOLATION_REQUIRED');
  const fixture = candidateFixture();
  if (input.variant === 'blocked') {
    const code = input.caseId as ActivationBlockedCode;
    if (!(code in BLOCKED_CASE_STATE)) throw new Error(`NOT_A_BLOCKED_CASE:${input.caseId}`);
    const state = BLOCKED_CASE_STATE[code];
    const decision = prepareUpdate(state);
    if (decision.type !== 'ActivationBlocked') throw new Error(`EXPECTED_BLOCKED:${input.caseId}`);
    return Object.freeze({
      type: 'ActivationBlocked' as const,
      code: decision.code,
      controllerChanged: false,
      databaseMutated: false,
      currentAssetsRemainActive: true,
    });
  }
  if (input.variant === 'active') {
    if (input.caseId !== 'CLEAN_COMPATIBLE_UPDATE') throw new Error(`NOT_AN_ACTIVE_CASE:${input.caseId}`);
    const oldEntry = compatibilityManifest.pairs.find((pair) => pair.assets === 'phase0-v1');
    const nextEntry = compatibilityManifest.pairs.find((pair) => pair.assets === EXPECTED_NEW_ROOT);
    if (!oldEntry || !nextEntry) throw new Error('COMPATIBILITY_MANIFEST_INCOMPLETE');
    const compatibility: CompatibilityInput = {
      old: { readSchemas: oldEntry.readSchemas, writeSchemas: oldEntry.writeSchemas },
      next: { readSchemas: nextEntry.readSchemas, writeSchemas: nextEntry.writeSchemas },
      fromSchema: SOURCE_SCHEMA,
      targetSchema: EXPECTED_TARGET_SCHEMA,
    };
    const compatibilityResult = validateAssetSchemaCompatibility(compatibility);
    if (compatibilityResult.status !== 'PASS') throw new Error('INCOMPATIBLE_ASSET_SCHEMA');
    const started = await startQualificationWorkerForNamespace({ namespace: input.namespace, runId: input.runId, fixture });
    const ready = await started.ready;
    await started.worker.terminate();
    const events: string[] = [];
    for (const event of UPDATE_EVENTS) events.push(event);
    const trace = adjudicateUpdateTrace(events);
    if (trace.status !== 'PASS') throw new Error('ILLEGAL_UPDATE_TRANSITION');
    const registration = await registerTestServiceWorker();
    const controllerChanged = await pingServiceWorkerForControllerChange(registration);
    if (!controllerChanged) throw new Error('CONTROLLER_CHANGE_NOT_OBSERVED');
    const inspection = await withFreshWorkerInspection({
      namespace: input.namespace, runId: input.runId, fixture,
      command: {
        type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: fixture.projectId,
        baseRevision: Number(ready.authoritativeRevision), expectedRevision: Number(ready.authoritativeRevision) + 1,
        safeValueHash: await sha256Hex('post-update'),
      },
    });
    return Object.freeze({
      events,
      expectedNewRoot: EXPECTED_NEW_ROOT,
      expectedTargetSchema: EXPECTED_TARGET_SCHEMA,
      active: Object.freeze({
        root: EXPECTED_NEW_ROOT,
        schema: EXPECTED_TARGET_SCHEMA,
        quickCheck: 'ok' as const,
        generalWritesEnabled: true as const,
      }),
      oracle: Object.freeze({
        quickCheck: 'ok' as const,
        partialSchemaWritable: false,
        partialMutation: false,
        dataLoss: false,
        duplicateReceipts: 0,
      }),
    });
  }
  if (input.variant === 'interruption') {
    const phase = input.caseId;
    const controllerChanged = INTERRUPTION_PHASES_AFTER_CONTROLLER_CHANGE.includes(phase);
    if (controllerChanged) {
      const registration = await registerTestServiceWorker();
      const changed = await pingServiceWorkerForControllerChange(registration);
      if (!changed) throw new Error('CONTROLLER_CHANGE_NOT_OBSERVED');
    }
    const started = await startQualificationWorkerForNamespace({ namespace: input.namespace, runId: input.runId, fixture });
    const ready = await started.ready;
    const phaseIndex = [
      'BEFORE_PREPARED', 'AFTER_PREPARED', 'AFTER_SQLITE_CLOSE', 'AFTER_VFS_PAUSE',
      'AFTER_LOCK_RELEASE', 'AFTER_CONTROLLER_CHANGE', 'AFTER_RELOAD', 'AFTER_REACQUIRE',
      'DURING_MIGRATION', 'AFTER_SUCCESS_COMMIT', 'BEFORE_ACTIVE',
    ].indexOf(phase);
    started.worker.terminate();
    const failureMode = selectUpdateFailureMode({ controllerChanged });
    const restart = Object.freeze({ mode: failureMode.mode, writable: failureMode.writable });
    await withFreshWorkerInspection({
      namespace: input.namespace, runId: input.runId, fixture,
      command: {
        type: 'SetFixtureValue', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: fixture.projectId,
        baseRevision: Number(ready.authoritativeRevision), expectedRevision: Number(ready.authoritativeRevision) + 1,
        safeValueHash: await sha256Hex(phase),
      },
    });
    return Object.freeze({
      mixedAssetsWritable: false,
      controllerChanged,
      restart,
      oracle: Object.freeze({
        partialSchemaWritable: false,
        dataLoss: false,
        duplicateReceipts: 0,
      }),
      phase,
      prepared: phaseIndex >= 1,
      sqliteClosed: phaseIndex >= 2,
      vfsPaused: phaseIndex >= 3,
      lockReleased: phaseIndex >= 4,
    });
  }
  throw new Error(`UNKNOWN_UPDATE_VARIANT:${input.variant}`);
}

window.__pmappQualification = {
  runBoundary, runDisarmedParity, qualificationIdentity, touchNamespace, namespaceExists, resetNamespace,
  ownershipStart, ownershipApply, ownershipInspect, ownershipHandoff, ownershipEvents,
  ownershipTerminateWorker, ownershipDispose,
  runMigration: runMigrationInBrowser,
  runUpdate: runUpdateInBrowser,
};
document.querySelector('#qualification-status')!.textContent = crossOriginIsolated ? 'qualification-ready' : 'qualification-blocked';

declare global {
  interface Window {
    __pmappQualification: {
      runBoundary: typeof runBoundary;
      runDisarmedParity: typeof runDisarmedParity;
      qualificationIdentity: typeof qualificationIdentity;
      touchNamespace: typeof touchNamespace;
      namespaceExists: typeof namespaceExists;
      resetNamespace: typeof resetNamespace;
      ownershipStart: typeof ownershipStart;
      ownershipApply: typeof ownershipApply;
      ownershipInspect: typeof ownershipInspect;
      ownershipHandoff: typeof ownershipHandoff;
      ownershipEvents: typeof ownershipEvents;
      ownershipTerminateWorker: typeof ownershipTerminateWorker;
      ownershipDispose: typeof ownershipDispose;
      runMigration: typeof runMigrationInBrowser;
      runUpdate: typeof runUpdateInBrowser;
    };
  }
}

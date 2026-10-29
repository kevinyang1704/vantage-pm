/// <reference lib="webworker" />
import { PROTOCOL_VERSION, assertUuidV7 } from './command-receipt';
import { createBoundaryTraceSink, type BoundaryCorrelation, type FaultBoundary } from './boundary-trace.test-only';
import { createFaultControl, correlatedBoundary } from './fault-control.test-only';
import { installInterposingVfs } from './interposing-vfs.test-only';
import { issueLabPurposeToken } from './lab-purpose.test-only';
import { acquireRepositoryOwnership, type RepositoryOwnership } from './repository-ownership';
import { RepositoryService } from './repository.worker';
import {
  ownershipRejected,
  typedValidationRejection,
  validateApplyCommandRequest,
  validateBeginHandoffRequest,
  validateInspectLedgerRequest,
} from './repository-protocol';

type InitializeQualification = Readonly<{
  type: 'InitializeQualification';
  protocolVersion?: typeof PROTOCOL_VERSION;
  requestId?: string;
  contextId?: string;
  namespace: string;
  runId: string;
  connectionId: string;
  armedBoundary: FaultBoundary | null;
  faultControlBuffer: SharedArrayBuffer;
  fixture: { projectId: string; initialRevision: number; safeStateHash: string };
}>;

type OwnershipLossMode = 'result-lost-after-commit' | 'terminate-before-commit';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ownership: RepositoryOwnership | null = null;
let repository: RepositoryService | null = null;
let initialize: InitializeQualification | null = null;
let faultControl: ReturnType<typeof createFaultControl> | null = null;
let initializationStarted = false;

function correlationFor(record: Readonly<Record<string, string>>): BoundaryCorrelation {
  if (!initialize) throw new Error('QUALIFICATION_NOT_INITIALIZED');
  const databasePath = `${initialize.namespace}/repository.sqlite3`;
  return {
    runId: record.runId!, connectionId: record.connectionId!, databasePath,
    rollbackJournalPath: `${databasePath}-journal`, commandId: record.commandId!, commitAttemptId: record.commitAttemptId!,
  };
}

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
});

async function dispatch(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const message = data as Readonly<Record<string, unknown>>;
  if (message.type === 'InitializeQualification') {
    if (initializationStarted) {
      scope.postMessage({ type: 'RepositoryRejected', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, code: 'INITIALIZATION_ALREADY_STARTED' });
      return;
    }
    initializationStarted = true;
    const init = message as unknown as InitializeQualification;
    initialize = init;
    const requestId = init.requestId ?? init.runId;
    const contextId = init.contextId ?? init.connectionId;
    try {
      assertUuidV7(requestId, 'requestId');
      assertUuidV7(contextId, 'contextId');
      if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        scope.postMessage({ type: 'QualificationBlocked', protocolVersion: PROTOCOL_VERSION, requestId, contextId, code: 'CROSS_ORIGIN_ISOLATION_REQUIRED' });
        return;
      }
      const trace = createBoundaryTraceSink((traceEvent) => scope.postMessage(traceEvent));
      faultControl = createFaultControl({
        armedBoundary: init.armedBoundary,
        sharedBuffer: init.faultControlBuffer,
        postBoundary: trace.record,
      });
      const result = await acquireRepositoryOwnership({
        locks: navigator.locks,
        requestId,
        contextId,
        namespace: init.namespace,
        fixture: init.fixture,
        record(eventName, eventSequence) {
          scope.postMessage({ type: 'OwnershipStateChanged', requestId, contextId, eventName, eventSequence });
        },
        instrumentation: {
          install(sqlite3, downstreamName) {
            const installed = installInterposingVfs({
              sqlite3, downstreamName,
              wrapperName: `pmapp-wrap-${init.runId.slice(-12).replaceAll('-', '')}`,
              faultControl: faultControl!, trace: trace.record,
            });
            return {
              name: installed.name,
              setCorrelation(correlation: unknown) { installed.setCorrelation(correlation as BoundaryCorrelation); },
              dispose: installed.dispose,
            };
          },
        },
      });
      if (result.type !== 'OwnerReady') {
        scope.postMessage(result);
        return;
      }
      ownership = result.owner;
      repository = new RepositoryService(
        ownership.adapter,
        { runId: init.runId, connectionId: init.connectionId },
        {
          afterCommit(boundary, _response, correlation) {
            faultControl!.publish(correlatedBoundary(boundary, 1_000_001, correlationFor(correlation)));
          },
          repositoryResultEmitted(response) {
            if (repository?.responseIsCurrent(response)) {
              scope.postMessage({ type: 'RepositoryResultEmitted', response, ...ownership!.identity });
            } else {
              scope.postMessage(ownershipRejected(response.requestId, response));
            }
          },
          afterRepositoryResult(boundary, _response, correlation) {
            faultControl!.publish(correlatedBoundary(boundary, 1_000_002, correlationFor(correlation)));
          },
        },
        ownership,
      );
      const ready = {
        state: 'OwnerReady' as const,
        protocolVersion: PROTOCOL_VERSION, requestId, ...ownership.identity,
        eventSequence: ownership.lifecycleEvents.length, configuration: ownership.configuration,
        authoritativeRevision: ownership.authoritativeRevision, lifecycleEvents: ownership.lifecycleEvents,
        trace: trace.retained(),
      };
      scope.postMessage({ type: 'OwnerReady', ...ready });
      scope.postMessage({ type: 'RepositoryReady', ...ready });
    } catch (error) {
      scope.postMessage(typedValidationRejection(message, error) ?? {
        type: 'QualificationFailure', protocolVersion: PROTOCOL_VERSION, requestId, contextId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  if (!repository || !initialize || !ownership) {
    scope.postMessage({ type: 'RepositoryRejected', protocolVersion: PROTOCOL_VERSION, requestId, code: 'STORAGE_NOT_READY', resultingState: 'read-only-frozen', mutated: false });
    return;
  }
  try {
    if (message.type === 'ApplyCommand') {
      const request = validateApplyCommandRequest(message);
      const lossMode = message.ownershipLossMode as OwnershipLossMode | undefined;
      if (lossMode === 'terminate-before-commit') {
        const authorization = ownership.authorize(request);
        if (authorization.type === 'OwnershipRejected') {
          scope.postMessage(ownershipRejected(request.requestId, request));
          return;
        }
        scope.postMessage(lossBarrier(lossMode, request));
        return;
      }
      const response = repository.apply(message);
      if (lossMode === 'result-lost-after-commit' && response.type === 'CommandApplied') {
        scope.postMessage(lossBarrier(lossMode, request));
        return;
      }
      scope.postMessage(repository.responseIsCurrent(response)
        ? response
        : ownershipRejected(request.requestId, request));
      if (response.type === 'CommandApplied' && initialize.armedBoundary === 'F6_AFTER_CANDIDATE_BOUNDARY_OBSERVED') {
        scope.postMessage({
          type: 'CandidateDurabilityBoundaryObserved',
          token: await issueLabPurposeToken(initialize.runId, response.commandId), response,
        });
      }
      return;
    }
    if (message.type === 'InspectCommandLedger') {
      const request = validateInspectLedgerRequest(message);
      const authorized = ownership.authorize(request);
      if (authorized.type === 'OwnershipRejected') {
        scope.postMessage(ownershipRejected(request.requestId, request));
        return;
      }
      scope.postMessage({
        type: 'CommandLedgerInspection', protocolVersion: PROTOCOL_VERSION, requestId: request.requestId,
        ...ownership.identity, inspection: await repository.inspect(request.projectId, request.commandId),
      });
      return;
    }
    if (message.type === 'BeginHandoff') {
      const request = validateBeginHandoffRequest(message);
      const result = await ownership.beginHandoff(request);
      scope.postMessage({ ...result, protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ...ownership.identity });
    }
  } catch (error) {
    scope.postMessage(typedValidationRejection(message, error) ?? {
      type: 'QualificationFailure', protocolVersion: PROTOCOL_VERSION, requestId,
      ...ownership.identity, detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function lossBarrier(mode: OwnershipLossMode, request: ReturnType<typeof validateApplyCommandRequest>) {
  if (!ownership) throw new Error('OWNERSHIP_NOT_READY');
  return {
    type: 'OwnershipLossBarrierObserved', protocolVersion: PROTOCOL_VERSION, mode,
    requestId: request.requestId, commandId: request.command.commandId,
    ...ownership.identity, eventSequence: ownership.lifecycleEvents.length,
  };
}

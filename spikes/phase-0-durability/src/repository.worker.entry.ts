/// <reference lib="webworker" />
import { PROTOCOL_VERSION, assertUuidV7 } from './command-receipt';
import { acquireRepositoryOwnership, type RepositoryOwnership } from './repository-ownership';
import { RepositoryService } from './repository.worker';
import {
  ownershipRejected,
  typedValidationRejection,
  validateBeginHandoffRequest,
  validateInspectLedgerRequest,
} from './repository-protocol';

type InitializeMessage = Readonly<{
  type: 'Initialize';
  protocolVersion?: typeof PROTOCOL_VERSION;
  requestId?: string;
  contextId?: string;
  namespace: string;
  runId: string;
  connectionId: string;
  fixture: { projectId: string; initialRevision: number; safeStateHash: string };
}>;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ownership: RepositoryOwnership | null = null;
let repository: RepositoryService | null = null;
let initializationStarted = false;

scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  void dispatch(event.data);
});

async function dispatch(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return;
  const message = data as Readonly<Record<string, unknown>>;
  if (message.type === 'Initialize') {
    if (initializationStarted) {
      scope.postMessage({ type: 'RepositoryRejected', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, code: 'INITIALIZATION_ALREADY_STARTED' });
      return;
    }
    initializationStarted = true;
    const initialize = message as unknown as InitializeMessage;
    const requestId = initialize.requestId ?? initialize.runId;
    const contextId = initialize.contextId ?? initialize.connectionId;
    try {
      assertUuidV7(requestId, 'requestId');
      assertUuidV7(contextId, 'contextId');
      const result = await acquireRepositoryOwnership({
        locks: navigator.locks,
        requestId,
        contextId,
        namespace: initialize.namespace,
        fixture: initialize.fixture,
        record(eventName, eventSequence) {
          scope.postMessage({ type: 'OwnershipStateChanged', requestId, contextId, eventName, eventSequence });
        },
      });
      if (result.type !== 'OwnerReady') {
        scope.postMessage(result);
        return;
      }
      ownership = result.owner;
      repository = new RepositoryService(
        ownership.adapter,
        { runId: initialize.runId, connectionId: initialize.connectionId },
        {},
        ownership,
      );
      const ready = {
        state: 'OwnerReady' as const,
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ...ownership.identity,
        eventSequence: ownership.lifecycleEvents.length,
        configuration: ownership.configuration,
        authoritativeRevision: ownership.authoritativeRevision,
        lifecycleEvents: ownership.lifecycleEvents,
      };
      scope.postMessage({ type: 'OwnerReady', ...ready });
      scope.postMessage({ type: 'RepositoryReady', ...ready });
    } catch (error) {
      scope.postMessage(typedValidationRejection(message, error) ?? {
        type: 'StorageUnavailable', protocolVersion: PROTOCOL_VERSION, requestId, contextId,
        code: 'SQLITE_OPEN_FAILED', mode: 'read-only-frozen', detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  if (!repository || !ownership) {
    scope.postMessage({ type: 'RepositoryRejected', protocolVersion: PROTOCOL_VERSION, requestId, code: 'STORAGE_NOT_READY', resultingState: 'read-only-frozen', mutated: false });
    return;
  }
  try {
    if (message.type === 'ApplyCommand') {
      const response = repository.apply(message);
      scope.postMessage(repository.responseIsCurrent(response)
        ? response
        : ownershipRejected(String(message.requestId), message));
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
      type: 'RepositoryFailure', protocolVersion: PROTOCOL_VERSION, requestId,
      ...ownership.identity, detail: error instanceof Error ? error.message : String(error),
    });
  }
}

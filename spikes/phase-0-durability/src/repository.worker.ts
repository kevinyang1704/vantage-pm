import { createUuidV7 } from './command-receipt';
import type { FaultBoundary } from './boundary-trace.test-only';
import type { ApplyCommandRequest, RepositoryResponse } from './repository-protocol';
import { typedValidationRejection, validateApplyCommandRequest } from './repository-protocol';
import type { SqliteOpfsAdapter } from './sqlite-opfs.adapter';
import type { RepositoryOwnership } from './repository-ownership';
import { ownershipRejected } from './repository-protocol';
import { isResponseFromCurrentOwner } from './repository-protocol';

export type RepositoryBoundaryHooks = Readonly<{
  afterCommit?: (boundary: FaultBoundary, response: RepositoryResponse, correlation: Readonly<Record<string, string>>) => void;
  repositoryResultEmitted?: (response: RepositoryResponse, correlation: Readonly<Record<string, string>>) => void;
  afterRepositoryResult?: (boundary: FaultBoundary, response: RepositoryResponse, correlation: Readonly<Record<string, string>>) => void;
}>;

export class RepositoryService {
  constructor(
    private readonly adapter: SqliteOpfsAdapter,
    private readonly identity: Readonly<{ runId: string; connectionId: string }>,
    private readonly hooks: RepositoryBoundaryHooks = {},
    private readonly ownership?: RepositoryOwnership,
  ) {}

  apply(input: unknown): RepositoryResponse {
    let request: ApplyCommandRequest;
    try { request = validateApplyCommandRequest(input); }
    catch (error) {
      const rejection = typedValidationRejection(input, error);
      if (rejection) return rejection;
      throw error;
    }
    const authorization = this.ownership?.beginCommand(request);
    if (authorization?.type === 'OwnershipRejected') {
      return ownershipRejected(request.requestId, request);
    }
    const correlation = {
      runId: this.identity.runId,
      connectionId: this.identity.connectionId,
      databasePath: '',
      rollbackJournalPath: '',
      commandId: request.command.commandId,
      commitAttemptId: createUuidV7(),
      ...(this.ownership ? {
        contextId: this.ownership.identity.contextId,
        ownerSessionId: this.ownership.identity.ownerSessionId,
        writerEpoch: String(this.ownership.identity.writerEpoch),
      } : {}),
    };
    this.adapter.setCorrelation(correlation);
    try {
      const response = this.adapter.apply(request as ApplyCommandRequest);
      const mutated = response.type === 'CommandApplied' && response.disposition === 'NewCommit';
      if (this.ownership && this.ownership.acceptResult(request).type === 'OwnershipRejected') {
        return ownershipRejected(request.requestId, request, mutated);
      }
      if (response.type === 'CommandApplied' && response.disposition === 'NewCommit') {
        this.hooks.afterCommit?.('F4_AFTER_COMMIT_RETURN', response, correlation);
      }
      this.hooks.repositoryResultEmitted?.(response, correlation);
      this.hooks.afterRepositoryResult?.('F5_AFTER_REPOSITORY_RESULT', response, correlation);
      return response;
    } finally {
      authorization?.completion?.();
    }
  }

  inspect(projectId: string, commandId: string) {
    return this.adapter.inspectRestart(projectId, commandId);
  }

  responseIsCurrent(response: RepositoryResponse): boolean {
    if (!this.ownership || response.type !== 'CommandApplied') return true;
    return isResponseFromCurrentOwner(response, this.ownership.identity) &&
      this.ownership.acceptResult(response).type === 'OwnershipAuthorized';
  }

  productionCapabilities() {
    return ['VfsCommitAccepted'] as const;
  }
}

/** Browser-backed SQLite is the only authority for this story. */
export function createRepositoryWorkerTestPort(): never {
  throw new Error('REAL_BROWSER_SQLITE_WORKER_REQUIRED');
}

import {
  PROTOCOL_VERSION,
  assertSafeHash,
  assertUuidV7,
  type CommandReceipt,
  type FixtureCommand,
  type RepositoryResult,
  UUID_V7_LOWERCASE,
} from './command-receipt';

export type ApplyCommandRequest = Readonly<{
  type: 'ApplyCommand';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
  command: FixtureCommand;
}>;

export type InspectLedgerRequest = Readonly<{
  type: 'InspectCommandLedger';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
  projectId: string;
  commandId: string;
}>;

export type BeginHandoffRequest = Readonly<{
  type: 'BeginHandoff';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
}>;

export type CommandApplied = Readonly<{
  type: 'CommandApplied';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
  commandId: string;
  projectId: string;
  baseRevision: number;
  targetRevision: number;
  outcome: 'VfsCommitAccepted';
  disposition: 'NewCommit' | 'StoredResultReturned';
  receipt: CommandReceipt;
  repositoryResult: RepositoryResult;
}>;

export type RepositoryRejected = Readonly<{
  type: 'RepositoryRejected';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  code:
    | 'PROTOCOL_VERSION_MISMATCH'
    | 'INVALID_COMMAND'
    | 'REVISION_CONFLICT'
    | 'COMMAND_IDENTITY_CONFLICT'
    | 'STORAGE_NOT_READY'
    | 'NOT_CURRENT_REPOSITORY_OWNER';
  expectedRevision?: number;
  contextId?: string;
  ownerSessionId?: string;
  writerEpoch?: number;
  resultingState?: 'read-only-frozen';
  mutated?: boolean;
}>;

export type RepositoryResponse = CommandApplied | RepositoryRejected;

export function validateApplyCommandRequest(input: unknown): ApplyCommandRequest {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const request = input as Partial<ApplyCommandRequest>;
  if (request.type !== 'ApplyCommand' || request.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(request.requestId), 'requestId');
  validateOwnershipEnvelope(request);
  if (!request.command || request.command.type !== 'SetFixtureValue') throw new Error('INVALID_COMMAND');
  const command = request.command;
  if (command.protocolVersion !== PROTOCOL_VERSION) throw new Error('PROTOCOL_VERSION_MISMATCH');
  assertUuidV7(command.commandId, 'commandId');
  assertUuidV7(command.projectId, 'projectId');
  assertSafeHash(command.safeValueHash, 'safeValueHash');
  if (!Number.isSafeInteger(command.baseRevision) || command.baseRevision < 0 || command.baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('INVALID_COMMAND');
  }
  if (command.expectedRevision !== command.baseRevision + 1) throw new Error('INVALID_COMMAND');
  return request as ApplyCommandRequest;
}

export function validateInspectLedgerRequest(input: unknown): InspectLedgerRequest {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const request = input as Partial<InspectLedgerRequest>;
  if (request.type !== 'InspectCommandLedger' || request.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(request.requestId), 'requestId');
  validateOwnershipEnvelope(request);
  assertUuidV7(String(request.projectId), 'projectId');
  assertUuidV7(String(request.commandId), 'commandId');
  return request as InspectLedgerRequest;
}

export function validateBeginHandoffRequest(input: unknown): BeginHandoffRequest {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND');
  const request = input as Partial<BeginHandoffRequest>;
  if (request.type !== 'BeginHandoff' || request.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('PROTOCOL_VERSION_MISMATCH');
  }
  assertUuidV7(String(request.requestId), 'requestId');
  assertUuidV7(String(request.contextId), 'contextId');
  assertUuidV7(String(request.ownerSessionId), 'ownerSessionId');
  if (!Number.isSafeInteger(request.writerEpoch) || Number(request.writerEpoch) < 1) throw new Error('INVALID_WRITER_EPOCH');
  return request as BeginHandoffRequest;
}

export function validateOwnershipEnvelope(request: Readonly<{
  contextId?: string;
  ownerSessionId?: string;
  writerEpoch?: number;
}>): void {
  assertUuidV7(String(request.contextId), 'contextId');
  assertUuidV7(String(request.ownerSessionId), 'ownerSessionId');
  if (!Number.isSafeInteger(request.writerEpoch) || Number(request.writerEpoch) < 1) throw new Error('INVALID_WRITER_EPOCH');
}

export function validateCommandApplied(input: unknown): CommandApplied {
  if (!input || typeof input !== 'object') throw new Error('INVALID_COMMAND_APPLIED');
  const response = input as Partial<CommandApplied>;
  if (response.type !== 'CommandApplied' || response.protocolVersion !== PROTOCOL_VERSION) throw new Error('INVALID_COMMAND_APPLIED');
  assertUuidV7(String(response.requestId), 'requestId');
  validateOwnershipEnvelope(response);
  assertUuidV7(String(response.commandId), 'commandId');
  assertUuidV7(String(response.projectId), 'projectId');
  if (!Number.isSafeInteger(response.baseRevision) || !Number.isSafeInteger(response.targetRevision) || response.targetRevision !== Number(response.baseRevision) + 1) {
    throw new Error('INVALID_COMMAND_APPLIED');
  }
  if (response.outcome !== 'VfsCommitAccepted' || !['NewCommit', 'StoredResultReturned'].includes(String(response.disposition))) {
    throw new Error('INVALID_COMMAND_APPLIED');
  }
  const receipt = response.receipt;
  const result = response.repositoryResult;
  if (!receipt || !result || receipt.commandId !== response.commandId || receipt.projectId !== response.projectId ||
    receipt.appliedRevision !== response.targetRevision || receipt.resultCode !== 'VFS_COMMIT_ACCEPTED' ||
    result.code !== 'VFS_COMMIT_ACCEPTED' || result.resultingRevision !== response.targetRevision) {
    throw new Error('INVALID_COMMAND_APPLIED');
  }
  assertSafeHash(result.safeValueHash, 'repositoryResult.safeValueHash');
  return response as CommandApplied;
}

export function isResponseFromCurrentOwner(
  response: Pick<CommandApplied, 'contextId' | 'ownerSessionId' | 'writerEpoch'>,
  current: Readonly<{ contextId: string; ownerSessionId: string; writerEpoch: number }>,
): boolean {
  return response.contextId === current.contextId &&
    response.ownerSessionId === current.ownerSessionId && response.writerEpoch === current.writerEpoch;
}

export function typedValidationRejection(input: unknown, error: unknown): RepositoryRejected | null {
  if (!input || typeof input !== 'object') return null;
  const requestId = (input as Record<string, unknown>).requestId;
  if (typeof requestId !== 'string' || !UUID_V7_LOWERCASE.test(requestId)) return null;
  const code = error instanceof Error && error.message === 'PROTOCOL_VERSION_MISMATCH'
    ? 'PROTOCOL_VERSION_MISMATCH' : 'INVALID_COMMAND';
  return repositoryRejected(requestId, code);
}

export function commandApplied(
  request: ApplyCommandRequest,
  disposition: CommandApplied['disposition'] = 'NewCommit',
): CommandApplied {
  const { command } = request;
  return {
    type: 'CommandApplied',
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    contextId: request.contextId,
    ownerSessionId: request.ownerSessionId,
    writerEpoch: request.writerEpoch,
    commandId: command.commandId,
    projectId: command.projectId,
    baseRevision: command.baseRevision,
    targetRevision: command.expectedRevision,
    outcome: 'VfsCommitAccepted',
    disposition,
    receipt: {
      commandId: command.commandId,
      projectId: command.projectId,
      appliedRevision: command.expectedRevision,
      resultCode: 'VFS_COMMIT_ACCEPTED',
    },
    repositoryResult: {
      code: 'VFS_COMMIT_ACCEPTED',
      resultingRevision: command.expectedRevision,
      safeValueHash: command.safeValueHash,
    },
  };
}

export function repositoryRejected(
  requestId: string,
  code: RepositoryRejected['code'],
  expectedRevision?: number,
  owner?: Readonly<{ contextId?: string; ownerSessionId?: string; writerEpoch?: number }>,
): RepositoryRejected {
  return {
    type: 'RepositoryRejected',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    code,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(owner?.contextId === undefined ? {} : { contextId: owner.contextId }),
    ...(owner?.ownerSessionId === undefined ? {} : { ownerSessionId: owner.ownerSessionId }),
    ...(owner?.writerEpoch === undefined ? {} : { writerEpoch: owner.writerEpoch }),
  };
}

export function ownershipRejected(
  requestId: string,
  input: Readonly<{ contextId?: string; ownerSessionId?: string; writerEpoch?: number }>,
  mutated = false,
): RepositoryRejected {
  return {
    type: 'RepositoryRejected',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    code: 'NOT_CURRENT_REPOSITORY_OWNER',
    resultingState: 'read-only-frozen',
    mutated,
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    ...(input.ownerSessionId === undefined ? {} : { ownerSessionId: input.ownerSessionId }),
    ...(input.writerEpoch === undefined ? {} : { writerEpoch: input.writerEpoch }),
  };
}

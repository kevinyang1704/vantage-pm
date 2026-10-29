/**
 * UnlockEdge domain commands (Story 3.8, AD-4, AD-7).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type CreateUnlockEdgeCommand = Readonly<{
  type: 'CreateUnlockEdge';
  commandId: string;
  projectId: string;
  baseRevision: number;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
}>;

export type DeleteUnlockEdgeCommand = Readonly<{
  type: 'DeleteUnlockEdge';
  commandId: string;
  projectId: string;
  baseRevision: number;
  edgeId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
}>;

export function createCreateUnlockEdgeCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
}): CreateUnlockEdgeCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.edgeId, 'edgeId must be a valid UUIDv7');
  assertUuidV7(params.sourceNodeId, 'sourceNodeId must be a valid UUIDv7');
  assertUuidV7(params.targetNodeId, 'targetNodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  if (params.sourceNodeId === params.targetNodeId) {
    throw new Error('SELF_REFERENTIAL_EDGE');
  }

  return Object.freeze({
    type: 'CreateUnlockEdge',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    edgeId: params.edgeId,
    sourceNodeId: params.sourceNodeId,
    targetNodeId: params.targetNodeId,
  });
}

export function createDeleteUnlockEdgeCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  edgeId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
}): DeleteUnlockEdgeCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.edgeId, 'edgeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'DeleteUnlockEdge',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    edgeId: params.edgeId,
    sourceNodeId: params.sourceNodeId,
    targetNodeId: params.targetNodeId,
  });
}

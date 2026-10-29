/**
 * UnlockEdge domain entity (Story 3.8, AD-4, AD-7).
 *
 * Directional relationship: sourceNodeId unlocks targetNodeId.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type UnlockEdge = Readonly<{
  id: string; // lowercase UUIDv7
  projectId: string; // project scope (AD-7 forbids cross-project references)
  sourceNodeId: string;
  targetNodeId: string;
}>;

export function createUnlockEdge(params: {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
}): UnlockEdge {
  assertUuidV7(params.id, 'UnlockEdge.id must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'UnlockEdge.projectId must be a valid UUIDv7');
  assertUuidV7(params.sourceNodeId, 'UnlockEdge.sourceNodeId must be a valid UUIDv7');
  assertUuidV7(params.targetNodeId, 'UnlockEdge.targetNodeId must be a valid UUIDv7');

  if (params.sourceNodeId === params.targetNodeId) {
    throw new Error('Self-referential unlock edge is not allowed');
  }

  return Object.freeze({
    id: params.id,
    projectId: params.projectId,
    sourceNodeId: params.sourceNodeId,
    targetNodeId: params.targetNodeId,
  });
}

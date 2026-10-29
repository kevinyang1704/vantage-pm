/**
 * MoveNode domain command (Story 2.4 Task 1, AD-4).
 *
 * One parameterized command representing all structural movement
 * (indent, outdent, reorder among siblings).
 * Closed under inversion for undo/redo.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type MoveNodeCommand = Readonly<{
  type: 'MoveNode';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  newParentId: string | null;
  newPosition: bigint;
}>;

export function createMoveNodeCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  newParentId: string | null;
  newPosition: bigint;
}): MoveNodeCommand {
  assertUuidV7(input.commandId, 'MoveNodeCommand.commandId');
  assertUuidV7(input.projectId, 'MoveNodeCommand.projectId');
  assertUuidV7(input.nodeId, 'MoveNodeCommand.nodeId');
  if (input.newParentId !== null && input.newParentId !== undefined) {
    assertUuidV7(input.newParentId, 'MoveNodeCommand.newParentId');
  }
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof input.newPosition !== 'bigint') {
    throw new Error('INVALID_POSITION');
  }

  return Object.freeze({
    type: 'MoveNode',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    newParentId: input.newParentId ?? null,
    newPosition: input.newPosition,
  });
}

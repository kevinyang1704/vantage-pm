/**
 * CreateNode domain command (Story 2.3 Task 4, AD-4).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type CreateNodeCommand = Readonly<{
  type: 'CreateNode';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  parentId: string | null;
  position: bigint;
  title: string;
}>;

export function createCreateNodeCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  parentId?: string | null;
  position: bigint;
  title?: string;
}): CreateNodeCommand {
  assertUuidV7(input.commandId, 'CreateNodeCommand.commandId');
  assertUuidV7(input.projectId, 'CreateNodeCommand.projectId');
  assertUuidV7(input.nodeId, 'CreateNodeCommand.nodeId');
  if (input.parentId !== null && input.parentId !== undefined) {
    assertUuidV7(input.parentId, 'CreateNodeCommand.parentId');
  }
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }

  return Object.freeze({
    type: 'CreateNode',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    parentId: input.parentId ?? null,
    position: input.position,
    title: input.title ?? '',
  });
}

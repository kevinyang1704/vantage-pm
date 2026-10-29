/**
 * DeleteSubtree command (Story 2.6, FR-13, AD-4).
 * Single typed command to atomically delete an entire subtree.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export interface DeleteSubtreeCommand {
  readonly type: 'DeleteSubtree';
  readonly commandId: string;
  readonly projectId: string;
  readonly nodeId: string;
}

export function createDeleteSubtreeCommand(input: {
  commandId: string;
  projectId: string;
  nodeId: string;
}): DeleteSubtreeCommand {
  assertUuidV7(input.commandId, 'DeleteSubtreeCommand.commandId');
  assertUuidV7(input.projectId, 'DeleteSubtreeCommand.projectId');
  assertUuidV7(input.nodeId, 'DeleteSubtreeCommand.nodeId');

  return Object.freeze({
    type: 'DeleteSubtree',
    commandId: input.commandId,
    projectId: input.projectId,
    nodeId: input.nodeId,
  });
}

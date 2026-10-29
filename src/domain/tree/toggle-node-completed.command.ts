/**
 * ToggleNodeCompleted domain command (Story 3.5, AD-4).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type ToggleNodeCompletedCommand = Readonly<{
  type: 'ToggleNodeCompleted';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  completed: boolean;
}>;

export function createToggleNodeCompletedCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  completed: boolean;
}): ToggleNodeCompletedCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'ToggleNodeCompleted',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    completed: params.completed,
  });
}

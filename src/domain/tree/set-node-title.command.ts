/**
 * SetNodeTitle domain command (Story 2.3 Task 4, AD-4).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetNodeTitleCommand = Readonly<{
  type: 'SetNodeTitle';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  title: string;
}>;

export function createSetNodeTitleCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  title: string;
}): SetNodeTitleCommand {
  assertUuidV7(input.commandId, 'SetNodeTitleCommand.commandId');
  assertUuidV7(input.projectId, 'SetNodeTitleCommand.projectId');
  assertUuidV7(input.nodeId, 'SetNodeTitleCommand.nodeId');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof input.title !== 'string') {
    throw new Error('INVALID_TITLE');
  }

  return Object.freeze({
    type: 'SetNodeTitle',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    title: input.title,
  });
}

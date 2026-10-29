/**
 * SetNodeBodyText domain command (Story 2.3 Task 4, AD-4).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetNodeBodyTextCommand = Readonly<{
  type: 'SetNodeBodyText';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  bodyText: string | null;
}>;

export function createSetNodeBodyTextCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  bodyText: string | null;
}): SetNodeBodyTextCommand {
  assertUuidV7(input.commandId, 'SetNodeBodyTextCommand.commandId');
  assertUuidV7(input.projectId, 'SetNodeBodyTextCommand.projectId');
  assertUuidV7(input.nodeId, 'SetNodeBodyTextCommand.nodeId');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }

  return Object.freeze({
    type: 'SetNodeBodyText',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    nodeId: input.nodeId,
    bodyText: input.bodyText ?? null,
  });
}

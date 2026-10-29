/**
 * SetNodeCustomField domain command (Story 3.2, AD-4, AD-8).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetNodeCustomFieldCommand = Readonly<{
  type: 'SetNodeCustomField';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}>;

export function createSetNodeCustomFieldCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}): SetNodeCustomFieldCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'SetNodeCustomField',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    fieldKey: params.fieldKey,
    fieldValue: params.fieldValue,
  });
}

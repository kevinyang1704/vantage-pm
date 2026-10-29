/**
 * SetNodeType domain command (Story 3.1, AD-4, AD-16).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { NodeType } from './node.entity';

export type SetNodeTypeCommand = Readonly<{
  type: 'SetNodeType';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  nodeType: NodeType | null;
}>;

export function createSetNodeTypeCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  nodeType: NodeType | null;
}): SetNodeTypeCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'SetNodeType',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    nodeType: params.nodeType,
  });
}

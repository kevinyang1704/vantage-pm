/**
 * PromoteFieldToTemplate domain command (Story 3.2, AD-4, AD-8).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { NodeType } from './node.entity';

export type PromoteFieldToTemplateCommand = Readonly<{
  type: 'PromoteFieldToTemplate';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeType: NodeType;
  fieldKey: string;
  fieldLabel: string;
}>;

export function createPromoteFieldToTemplateCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeType: NodeType;
  fieldKey: string;
  fieldLabel: string;
}): PromoteFieldToTemplateCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'PromoteFieldToTemplate',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeType: params.nodeType,
    fieldKey: params.fieldKey,
    fieldLabel: params.fieldLabel,
  });
}

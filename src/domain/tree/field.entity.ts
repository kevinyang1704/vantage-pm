/**
 * Field domain entities (Story 3.2, AD-8).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { NodeType } from './node.entity';

export type CustomField = Readonly<{
  projectId: string;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}>;

export type TypeTemplateField = Readonly<{
  projectId: string;
  nodeType: NodeType;
  fieldKey: string;
  fieldLabel: string;
  position: number;
}>;

export function createCustomField(params: {
  projectId: string;
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}): CustomField {
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  return Object.freeze({
    projectId: params.projectId,
    nodeId: params.nodeId,
    fieldKey: params.fieldKey,
    fieldValue: params.fieldValue,
  });
}

export function createTypeTemplateField(params: {
  projectId: string;
  nodeType: NodeType;
  fieldKey: string;
  fieldLabel: string;
  position: number;
}): TypeTemplateField {
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');

  return Object.freeze({
    projectId: params.projectId,
    nodeType: params.nodeType,
    fieldKey: params.fieldKey,
    fieldLabel: params.fieldLabel,
    position: params.position,
  });
}

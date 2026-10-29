/**
 * SetThemeWeight domain command (Story 3.6, AD-4, AD-9).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetThemeWeightCommand = Readonly<{
  type: 'SetThemeWeight';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  strategicWeight: number | null;
}>;

export function createSetThemeWeightCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  strategicWeight: number | null;
}): SetThemeWeightCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  if (params.strategicWeight !== null) {
    if (!Number.isInteger(params.strategicWeight) || params.strategicWeight < 1 || params.strategicWeight > 100) {
      throw new Error('strategicWeight must be an integer between 1 and 100 or null');
    }
  }

  return Object.freeze({
    type: 'SetThemeWeight',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    strategicWeight: params.strategicWeight,
  });
}

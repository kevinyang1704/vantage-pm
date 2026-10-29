/**
 * SetNodeEffort domain command (Story 3.6, AD-4, AD-9).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetNodeEffortCommand = Readonly<{
  type: 'SetNodeEffort';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  effortPoints: number | null;
  restoredAssignments?: readonly string[];
}>;

export function createSetNodeEffortCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  effortPoints: number | null;
  restoredAssignments?: readonly string[];
}): SetNodeEffortCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  if (params.effortPoints !== null) {
    if (!Number.isInteger(params.effortPoints) || params.effortPoints < 0) {
      throw new Error('effortPoints must be a non-negative integer or null');
    }
  }

  if (params.restoredAssignments !== undefined) {
    for (const pid of params.restoredAssignments) {
      assertUuidV7(pid, 'restoredAssignments member must be a valid UUIDv7');
    }
  }

  return Object.freeze({
    type: 'SetNodeEffort',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    effortPoints: params.effortPoints,
    ...(params.restoredAssignments ? { restoredAssignments: Object.freeze([...params.restoredAssignments]) } : {}),
  });
}

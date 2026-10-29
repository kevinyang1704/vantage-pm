/**
 * SetNodeSchedule domain command (Story 3.4, AD-4, AD-8).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ScheduleSourceMode } from './node.entity';

export type SetNodeScheduleCommand = Readonly<{
  type: 'SetNodeSchedule';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  sourceMode: ScheduleSourceMode;
}>;

export function createSetNodeScheduleCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  sourceMode: ScheduleSourceMode;
}): SetNodeScheduleCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  return Object.freeze({
    type: 'SetNodeSchedule',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    startDate: params.startDate,
    endDate: params.endDate,
    durationDays: params.durationDays,
    sourceMode: params.sourceMode,
  });
}

/**
 * Phase domain commands (Story 3.7, AD-4, AD-7).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type CreatePhaseCommand = Readonly<{
  type: 'CreatePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  name: string;
  position: bigint;
}>;

export type RenamePhaseCommand = Readonly<{
  type: 'RenamePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  name: string;
}>;

export type ReorderPhasesCommand = Readonly<{
  type: 'ReorderPhases';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phases: readonly Readonly<{ phaseId: string; position: bigint }>[];
}>;

export type AssignNodePhaseCommand = Readonly<{
  type: 'AssignNodePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  phaseId: string | null;
}>;

export type DeletePhaseCommand = Readonly<{
  type: 'DeletePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  reassignments: Readonly<Record<string, string | null>>; // nodeId -> newPhaseId or null
}>;

export type RestorePhaseCommand = Readonly<{
  type: 'RestorePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  name: string;
  position: bigint;
  priorAssignments: Readonly<Record<string, string | null>>; // nodeId -> priorPhaseId
}>;

/**
 * Move one phase to a new place among its siblings (Story 27.2, D8(c), R3).
 * Carries both intended neighbours ("after Y, before Z", either null at an end)
 * and the intended index. Replaces the whole-list `ReorderPhases` on the shared
 * path, so a concurrent reorder keeps its meaning.
 */
export type MovePhaseCommand = Readonly<{
  type: 'MovePhase';
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}>;

export function createMovePhaseCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  phaseId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
}): MovePhaseCommand {
  assertUuidV7(params.commandId, 'MovePhaseCommand.commandId');
  assertUuidV7(params.projectId, 'MovePhaseCommand.projectId');
  assertUuidV7(params.phaseId, 'MovePhaseCommand.phaseId');
  if (params.afterId !== null) assertUuidV7(params.afterId, 'MovePhaseCommand.afterId');
  if (params.beforeId !== null) assertUuidV7(params.beforeId, 'MovePhaseCommand.beforeId');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!Number.isSafeInteger(params.intendedIndex) || params.intendedIndex < 0) {
    throw new Error('INVALID_INTENDED_INDEX');
  }
  return Object.freeze({
    type: 'MovePhase',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    phaseId: params.phaseId,
    afterId: params.afterId,
    beforeId: params.beforeId,
    intendedIndex: params.intendedIndex,
  });
}

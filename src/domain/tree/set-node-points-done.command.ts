/**
 * SetNodePointsDone domain command (Story 26.5, FC-FR5, FC-NFR5).
 *
 * Records how many points of an in-progress item are done, so the forecast
 * can count only the remaining work (Story 26.6). The value lives beside
 * `effortPoints` and never flips `deliveryStatus`.
 *
 * Validation here is shape-only (mirrors `SetNodeEffort`): the cross-field
 * rule `0 <= done <= effortPoints` needs the stored estimate, so it is
 * enforced at the repository boundary (the applier). A value without an
 * estimate, or above it, is refused with a named rejection — never clamped.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type SetNodePointsDoneCommand = Readonly<{
  type: 'SetNodePointsDone';
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  /** null clears the recorded value ("not recorded"). */
  effortPointsDone: number | null;
}>;

export function createSetNodePointsDoneCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  nodeId: string;
  effortPointsDone: number | null;
}): SetNodePointsDoneCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.nodeId, 'nodeId must be a valid UUIDv7');

  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('baseRevision must be a non-negative integer');
  }

  if (params.effortPointsDone !== null) {
    if (!Number.isInteger(params.effortPointsDone) || params.effortPointsDone < 0) {
      throw new Error('effortPointsDone must be a non-negative integer or null');
    }
  }

  return Object.freeze({
    type: 'SetNodePointsDone',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    nodeId: params.nodeId,
    effortPointsDone: params.effortPointsDone,
  });
}

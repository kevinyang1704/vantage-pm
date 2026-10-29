/**
 * RenameProject command (Story 1.6 Task 3).
 *
 * Renames an existing project. The caller must supply the current
 * baseRevision for optimistic concurrency control. The repository
 * rejects the command if the project's revision has advanced.
 *
 * AD-1: Pure domain type — no I/O, no framework imports.
 * AD-4: Commands are Readonly<> + Object.freeze().
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type RenameProjectCommand = Readonly<{
  type: 'RenameProject';
  commandId: string;
  projectId: string;
  baseRevision: number;
  name: string;
}>;

/**
 * Construct a RenameProjectCommand.
 * The caller must supply a valid UUIDv7 commandId and projectId,
 * and a non-negative baseRevision.
 * Name validation is handled by project.policy.ts before construction.
 */
export function createRenameProjectCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  name: string;
}): RenameProjectCommand {
  assertUuidV7(input.commandId, 'commandId');
  assertUuidV7(input.projectId, 'projectId');
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof input.name !== 'string') {
    throw new Error('INVALID_PROJECT_NAME');
  }
  return Object.freeze({
    type: 'RenameProject',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
    name: input.name,
  });
}

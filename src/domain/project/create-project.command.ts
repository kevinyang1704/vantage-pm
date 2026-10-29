/**
 * CreateProject command (Story 1.6 Task 2).
 *
 * The first command in a project's lifecycle. The client generates
 * the projectId as a UUIDv7 before dispatching. baseRevision is
 * always 0 — there is no prior state for a new project.
 *
 * AD-1: Pure domain type — no I/O, no framework imports.
 * AD-4: Commands are Readonly<> + Object.freeze().
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type CreateProjectCommand = Readonly<{
  type: 'CreateProject';
  commandId: string;
  projectId: string;
  baseRevision: 0;
  name: string;
}>;

/**
 * Construct a CreateProjectCommand.
 * The caller must supply a valid UUIDv7 commandId and projectId.
 * Name validation is handled by project.policy.ts before construction.
 */
export function createCreateProjectCommand(input: {
  commandId: string;
  projectId: string;
  name: string;
}): CreateProjectCommand {
  assertUuidV7(input.commandId, 'commandId');
  assertUuidV7(input.projectId, 'projectId');
  if (typeof input.name !== 'string') {
    throw new Error('INVALID_PROJECT_NAME');
  }
  return Object.freeze({
    type: 'CreateProject',
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: 0 as const,
    name: input.name,
  });
}

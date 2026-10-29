/**
 * Project domain entity (Story 1.6 Task 1).
 *
 * The Project is the root aggregate for the product domain.
 * It carries only the fields that are authored facts:
 *   - id: client-generated UUIDv7 (the project's identity)
 *   - name: the project's display name
 *   - revision: the repository-local revision counter
 *
 * No description, createdAt, or updatedAt fields — those are
 * either derived (revision) or belong in a separate audit log.
 *
 * AD-1: Pure domain entity — no I/O, no framework imports.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type Project = Readonly<{
  id: string;
  name: string;
  revision: number;
}>;

/**
 * Construct a Project entity.
 * The caller must supply a valid UUIDv7 id and a non-negative revision.
 * Name validation is handled by project.policy.ts before construction.
 */
export function createProject(input: {
  id: string;
  name: string;
  revision: number;
}): Project {
  assertUuidV7(input.id, 'project.id');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error('INVALID_PROJECT_REVISION');
  }
  if (typeof input.name !== 'string') {
    throw new Error('INVALID_PROJECT_NAME');
  }
  return Object.freeze({
    id: input.id,
    name: input.name,
    revision: input.revision,
  });
}

/**
 * Produce a new Project with an updated name and incremented revision.
 * Pure function — returns a new frozen object, does not mutate the input.
 */
export function withName(project: Project, name: string): Project {
  return Object.freeze({
    id: project.id,
    name,
    revision: project.revision + 1,
  });
}

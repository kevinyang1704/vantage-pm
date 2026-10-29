/**
 * Workspace domain entity (Epic 17 Task 1).
 *
 * A Workspace is a named group of projects inside one local store. It is
 * organizational metadata, not product content:
 *   - id: client-generated UUIDv7 (the workspace's identity)
 *   - name: the workspace's display name
 *   - position: sort order within the store
 *
 * Deliberately carries no revision counter. Revisions exist to give the
 * per-project command pipeline its optimistic-concurrency check
 * (baseRevision -> expectedRevision); workspace mutations never enter that
 * pipeline, never appear in a ChangeSet, are never undoable, and are never
 * written to the portable file. See workspace-operations.ts for why they
 * follow the view-state precedent rather than the ProductCommand one.
 *
 * AD-1: Pure domain entity — no I/O, no framework imports.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type Workspace = Readonly<{
  id: string;
  name: string;
  position: number;
}>;

/**
 * Construct a Workspace entity.
 * The caller must supply a valid UUIDv7 id and a non-negative position.
 * Name validation is handled by workspace.policy.ts before construction.
 */
export function createWorkspace(input: {
  id: string;
  name: string;
  position: number;
}): Workspace {
  assertUuidV7(input.id, 'workspace.id');
  if (!Number.isSafeInteger(input.position) || input.position < 0) {
    throw new Error('INVALID_WORKSPACE_POSITION');
  }
  if (typeof input.name !== 'string') {
    throw new Error('INVALID_WORKSPACE_NAME');
  }
  return Object.freeze({
    id: input.id,
    name: input.name,
    position: input.position,
  });
}

/**
 * Produce a new Workspace with an updated name.
 * Pure function — returns a new frozen object, does not mutate the input.
 */
export function withWorkspaceName(workspace: Workspace, name: string): Workspace {
  return Object.freeze({
    id: workspace.id,
    name,
    position: workspace.position,
  });
}

/**
 * Workspace registry contract (Epic 17).
 *
 * The list of workspaces in this local store plus the pointer to the active
 * one. Distinct from `workspace-overview.ts`, which is the derived projection
 * of the *projects inside* a workspace — this file is the workspace list
 * itself.
 *
 * Workspace mutations deliberately do NOT flow through `ProductCommand`.
 * Every ProductCommand is keyed `{projectId, baseRevision}` and lands a row in
 * the `product_command_receipt` idempotency ledger; a workspace is not a
 * project and has no revision, so forcing it through that pipeline would mean
 * inventing a synthetic projectId and writing meaningless receipts. Workspace
 * operations follow the `view_state` precedent instead: their own worker
 * messages, applied directly. Consequences, all intended — workspace edits are
 * not undoable, never appear in a ChangeSet, and are never written to the
 * portable file.
 */

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  /** Projects currently homed in this workspace. Drives the switcher count. */
  readonly projectCount: number;
}

export interface WorkspaceRegistry {
  readonly workspaces: readonly WorkspaceRow[];
  /**
   * The workspace whose projects are currently in scope.
   *
   * Never null once the store has been opened — `ensureDefaultWorkspace()`
   * guarantees at least one workspace exists and that the pointer resolves to
   * it, including when a previously-active workspace has been deleted.
   */
  readonly activeWorkspaceId: string;
}

/** Typed outcome of a workspace mutation. */
export type WorkspaceMutationResult =
  | Readonly<{ type: 'WorkspaceMutationApplied'; registry: WorkspaceRegistry }>
  | Readonly<{
      type: 'WorkspaceMutationRejected';
      code:
        | 'WORKSPACE_NOT_FOUND'
        | 'PROJECT_NOT_FOUND'
        | 'INVALID_WORKSPACE_NAME'
        | 'WORKSPACE_NOT_EMPTY'
        | 'LAST_WORKSPACE';
      /** Present for WORKSPACE_NOT_EMPTY — how many projects blocked it. */
      projectCount?: number;
    }>;

export function createWorkspaceRegistry(
  workspaces: readonly WorkspaceRow[],
  activeWorkspaceId: string,
): WorkspaceRegistry {
  return Object.freeze({
    workspaces: Object.freeze(workspaces.map((w) => Object.freeze({ ...w }))),
    activeWorkspaceId,
  });
}

/** Settings key under which the active workspace pointer is persisted. */
export const ACTIVE_WORKSPACE_SETTING_KEY = 'active_workspace_id';

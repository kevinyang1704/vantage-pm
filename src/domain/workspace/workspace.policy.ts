/**
 * Workspace policy — pure validation functions (Epic 17 Task 2).
 *
 * Encodes the business rules for workspaces:
 *   - Names follow the same contract as project names (trim, non-empty,
 *     <= 200 code points, internal whitespace preserved, duplicates allowed)
 *   - A workspace may only be deleted when it holds no projects
 *   - The last remaining workspace may never be deleted
 *
 * Returns typed validation results — never throws for expected validation
 * failures (AD-1: pure function, no I/O, no framework imports).
 */

/** Typed validation result for workspace names. */
export type WorkspaceNameValidation =
  | Readonly<{ valid: true; trimmed: string }>
  | Readonly<{ valid: false; cause: 'EMPTY_NAME' | 'NAME_TOO_LONG' }>;

/** Maximum code points for a workspace name. */
export const MAX_WORKSPACE_NAME_LENGTH = 200;

/** The name given to the workspace created by the one-time backfill. */
export const DEFAULT_WORKSPACE_NAME = 'My Workspace';

/**
 * Validate a workspace name.
 *
 * Intentionally identical in contract to validateProjectName — the create
 * dialog and the rename path share this one function so a name that is
 * acceptable in one place is acceptable in the other. Duplicates are allowed,
 * matching projects.
 */
export function validateWorkspaceName(raw: string): WorkspaceNameValidation {
  if (typeof raw !== 'string') {
    return Object.freeze({ valid: false, cause: 'EMPTY_NAME' } as const);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Object.freeze({ valid: false, cause: 'EMPTY_NAME' } as const);
  }
  // Count code points, not UTF-16 code units
  const codePointCount = [...trimmed].length;
  if (codePointCount > MAX_WORKSPACE_NAME_LENGTH) {
    return Object.freeze({ valid: false, cause: 'NAME_TOO_LONG' } as const);
  }
  return Object.freeze({ valid: true, trimmed });
}

/** Typed decision for whether a workspace may be deleted. */
export type WorkspaceDeleteDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      cause: 'WORKSPACE_NOT_EMPTY' | 'LAST_WORKSPACE';
      /** How many projects still live in the workspace (0 for LAST_WORKSPACE). */
      projectCount: number;
    }>;

/**
 * Decide whether a workspace may be deleted.
 *
 * Deleting a workspace must never become a shortcut to deleting projects, so
 * a non-empty workspace is refused outright rather than cascading. The user
 * moves its projects elsewhere (or deletes them individually, through the
 * existing named-confirmation project delete) and then deletes the empty
 * workspace.
 *
 * The store must also always retain at least one workspace, so that every
 * project has somewhere to live and the switcher is never empty.
 */
export function decideWorkspaceDelete(input: {
  projectCount: number;
  totalWorkspaceCount: number;
}): WorkspaceDeleteDecision {
  if (input.projectCount > 0) {
    return Object.freeze({
      allowed: false,
      cause: 'WORKSPACE_NOT_EMPTY',
      projectCount: input.projectCount,
    } as const);
  }
  if (input.totalWorkspaceCount <= 1) {
    return Object.freeze({
      allowed: false,
      cause: 'LAST_WORKSPACE',
      projectCount: 0,
    } as const);
  }
  return Object.freeze({ allowed: true } as const);
}

/**
 * Human-readable explanation for a refused delete.
 *
 * Lives here rather than in the component so the wording is testable and the
 * copy stays consistent between the switcher menu and the command palette.
 */
export function formatWorkspaceDeleteRefusal(
  decision: Extract<WorkspaceDeleteDecision, { allowed: false }>,
  workspaceName: string,
): string {
  if (decision.cause === 'LAST_WORKSPACE') {
    return `“${workspaceName}” is your only workspace, so it can’t be deleted. Create another one first.`;
  }
  const noun = decision.projectCount === 1 ? 'project' : 'projects';
  return `“${workspaceName}” still holds ${decision.projectCount} ${noun}. Move ${
    decision.projectCount === 1 ? 'it' : 'them'
  } to another workspace, or delete ${
    decision.projectCount === 1 ? 'it' : 'them'
  }, before deleting the workspace.`;
}

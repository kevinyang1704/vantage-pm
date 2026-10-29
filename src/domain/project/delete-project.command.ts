/**
 * DeleteProject domain command (Story 1.10 Task 1, AD-4).
 *
 * Same shape discipline as RenameProjectCommand (Story 1.6):
 * no `name` field on the command itself — the typed-name match
 * is a UI-side confirmation gate (FR-61), not a fact the backend
 * re-validates.
 */

export type DeleteProjectCommand = Readonly<{
  type: 'DeleteProject';
  commandId: string;
  projectId: string;
  baseRevision: number;
}>;

export function createDeleteProjectCommand(input: {
  commandId: string;
  projectId: string;
  baseRevision: number;
}): DeleteProjectCommand {
  return Object.freeze({
    type: 'DeleteProject' as const,
    commandId: input.commandId,
    projectId: input.projectId,
    baseRevision: input.baseRevision,
  });
}

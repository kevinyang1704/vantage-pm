/**
 * Workspace domain barrel export (Epic 17 Task 3).
 */

export type { Workspace } from './workspace.entity';
export { createWorkspace, withWorkspaceName } from './workspace.entity';

export type {
  WorkspaceNameValidation,
  WorkspaceDeleteDecision,
} from './workspace.policy';
export {
  validateWorkspaceName,
  decideWorkspaceDelete,
  formatWorkspaceDeleteRefusal,
  MAX_WORKSPACE_NAME_LENGTH,
  DEFAULT_WORKSPACE_NAME,
} from './workspace.policy';

/**
 * Project domain barrel export (Story 1.6 Task 8).
 */

export type { Project } from './project.entity';
export { createProject, withName } from './project.entity';

export type { CreateProjectCommand } from './create-project.command';
export { createCreateProjectCommand } from './create-project.command';

export type { RenameProjectCommand } from './rename-project.command';
export { createRenameProjectCommand } from './rename-project.command';

export type {
  ProjectNameValidation,
  ProjectExistenceCheck,
} from './project.policy';
export { validateProjectName, MAX_PROJECT_NAME_LENGTH } from './project.policy';

/**
 * Project policy — pure validation functions (Story 1.6 Task 4).
 *
 * Encodes the business rules for project names:
 *   - Reject empty-after-trim names
 *   - Reject names > 200 code points
 *   - Trim leading/trailing whitespace before persisting
 *   - Do NOT collapse internal whitespace
 *
 * Returns typed validation results — never throws for expected
 * validation failures (AD-1: pure function, no I/O, no framework imports).
 */

/** Typed validation result for project names. */
export type ProjectNameValidation =
  | Readonly<{ valid: true; trimmed: string }>
  | Readonly<{ valid: false; cause: 'EMPTY_NAME' | 'NAME_TOO_LONG' }>;

/** Maximum code points for a project name. */
export const MAX_PROJECT_NAME_LENGTH = 200;

/**
 * Validate a project name.
 * Trims leading/trailing whitespace. Does NOT collapse internal whitespace.
 * Returns a typed result — never throws.
 */
export function validateProjectName(raw: string): ProjectNameValidation {
  if (typeof raw !== 'string') {
    return Object.freeze({ valid: false, cause: 'EMPTY_NAME' } as const);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Object.freeze({ valid: false, cause: 'EMPTY_NAME' } as const);
  }
  // Count code points, not UTF-16 code units
  const codePointCount = [...trimmed].length;
  if (codePointCount > MAX_PROJECT_NAME_LENGTH) {
    return Object.freeze({ valid: false, cause: 'NAME_TOO_LONG' } as const);
  }
  return Object.freeze({ valid: true, trimmed });
}

/**
 * Validate that a project exists for a given command.
 * Used by the repository to reject RenameProject commands
 * targeting non-existent projects.
 */
export type ProjectExistenceCheck =
  | Readonly<{ exists: true; currentRevision: number }>
  | Readonly<{ exists: false }>;

/**
 * Node content validation policy (Story 2.3 Task 2).
 *
 * Pure validation logic for node title and body text.
 * Note: Empty title is permanently valid per AD-16 / FR-16.
 */

export const MAX_NODE_TITLE_LENGTH = 500;
export const MAX_NODE_BODY_LENGTH = 20_000;

export type NodeTitleValidationResult =
  | Readonly<{ valid: true; title: string }>
  | Readonly<{ valid: false; cause: 'TITLE_TOO_LONG' }>;

export type NodeBodyTextValidationResult =
  | Readonly<{ valid: true; bodyText: string | null }>
  | Readonly<{ valid: false; cause: 'BODY_TOO_LONG' }>;

export function validateNodeTitle(raw: string): NodeTitleValidationResult {
  const trimmed = raw.trim();
  const codePoints = [...trimmed].length;

  if (codePoints > MAX_NODE_TITLE_LENGTH) {
    return Object.freeze({ valid: false, cause: 'TITLE_TOO_LONG' });
  }

  return Object.freeze({ valid: true, title: trimmed });
}

export function validateNodeBodyText(raw: string | null): NodeBodyTextValidationResult {
  if (raw === null || raw === undefined) {
    return Object.freeze({ valid: true, bodyText: null });
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return Object.freeze({ valid: true, bodyText: null });
  }

  const codePoints = [...trimmed].length;
  if (codePoints > MAX_NODE_BODY_LENGTH) {
    return Object.freeze({ valid: false, cause: 'BODY_TOO_LONG' });
  }

  return Object.freeze({ valid: true, bodyText: trimmed });
}

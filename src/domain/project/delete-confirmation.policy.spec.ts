/**
 * Unit tests for delete-confirmation.policy.ts (Story 1.10 Task 6).
 */

import { describe, expect, it } from 'vitest';
import { isDeleteConfirmationValid } from './delete-confirmation.policy';

describe('delete-confirmation policy', () => {
  it('returns true for exact match', () => {
    expect(isDeleteConfirmationValid('My Project', 'My Project')).toBe(true);
  });

  it('returns false for case mismatch', () => {
    expect(isDeleteConfirmationValid('my project', 'My Project')).toBe(false);
  });

  it('returns false for trailing whitespace', () => {
    expect(isDeleteConfirmationValid('My Project ', 'My Project')).toBe(false);
  });

  it('returns false for leading whitespace', () => {
    expect(isDeleteConfirmationValid(' My Project', 'My Project')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isDeleteConfirmationValid('', 'My Project')).toBe(false);
  });

  it('returns false for partial substring', () => {
    expect(isDeleteConfirmationValid('My', 'My Project')).toBe(false);
  });

  it('returns false for completely different name', () => {
    expect(isDeleteConfirmationValid('Other Project', 'My Project')).toBe(false);
  });

  it('returns true for empty name matching empty name', () => {
    expect(isDeleteConfirmationValid('', '')).toBe(true);
  });
});

/**
 * Workspace policy — pure-function unit tests.
 *
 * These rules were previously exercised only indirectly, through
 * workspace-operations.spec.ts driving real SQLite. That covered the happy
 * paths but left several branches untested — including the singular/plural
 * refusal copy and the non-string name guard — which the coverage gate
 * caught. Testing the pure functions directly is both cheaper and stricter:
 * the refusal wording is user-facing copy, and it should not be possible to
 * change it accidentally without a test noticing.
 */

import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceName,
  decideWorkspaceDelete,
  formatWorkspaceDeleteRefusal,
  MAX_WORKSPACE_NAME_LENGTH,
  DEFAULT_WORKSPACE_NAME,
} from './workspace.policy';

describe('validateWorkspaceName', () => {
  it('trims surrounding whitespace and accepts the result', () => {
    const result = validateWorkspaceName('  Client — Northwind  ');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.trimmed).toBe('Client — Northwind');
  });

  it('preserves internal whitespace rather than collapsing it', () => {
    const result = validateWorkspaceName('Q3   Planning');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.trimmed).toBe('Q3   Planning');
  });

  it('rejects an empty string', () => {
    const result = validateWorkspaceName('');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.cause).toBe('EMPTY_NAME');
  });

  it('rejects a whitespace-only name', () => {
    const result = validateWorkspaceName('   \t  ');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.cause).toBe('EMPTY_NAME');
  });

  it('rejects a non-string input as EMPTY_NAME rather than throwing', () => {
    // Reachable from the Tauri boundary and from persisted data, neither of
    // which the type system actually guarantees at runtime.
    for (const bad of [null, undefined, 42, {}, []]) {
      const result = validateWorkspaceName(bad as unknown as string);
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.cause).toBe('EMPTY_NAME');
    }
  });

  it('accepts a name of exactly the maximum length', () => {
    const result = validateWorkspaceName('a'.repeat(MAX_WORKSPACE_NAME_LENGTH));
    expect(result.valid).toBe(true);
  });

  it('rejects a name one code point over the maximum', () => {
    const result = validateWorkspaceName('a'.repeat(MAX_WORKSPACE_NAME_LENGTH + 1));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.cause).toBe('NAME_TOO_LONG');
  });

  it('counts code points, not UTF-16 code units', () => {
    // Each of these emoji is a surrogate pair — 2 code units, 1 code point.
    // A .length check would reject at half the real limit.
    const name = '🌍'.repeat(MAX_WORKSPACE_NAME_LENGTH);
    expect(name.length).toBe(MAX_WORKSPACE_NAME_LENGTH * 2);
    expect(validateWorkspaceName(name).valid).toBe(true);
    expect(validateWorkspaceName('🌍'.repeat(MAX_WORKSPACE_NAME_LENGTH + 1)).valid).toBe(false);
  });

  it('measures length after trimming, not before', () => {
    const padded = `   ${'a'.repeat(MAX_WORKSPACE_NAME_LENGTH)}   `;
    expect(validateWorkspaceName(padded).valid).toBe(true);
  });

  it('accepts the default workspace name it ships with', () => {
    expect(validateWorkspaceName(DEFAULT_WORKSPACE_NAME).valid).toBe(true);
  });
});

describe('decideWorkspaceDelete', () => {
  it('allows deleting an empty workspace when others remain', () => {
    expect(decideWorkspaceDelete({ projectCount: 0, totalWorkspaceCount: 3 })).toEqual({
      allowed: true,
    });
  });

  it('refuses while the workspace still holds projects', () => {
    const decision = decideWorkspaceDelete({ projectCount: 4, totalWorkspaceCount: 3 });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.cause).toBe('WORKSPACE_NOT_EMPTY');
    expect(decision.projectCount).toBe(4);
  });

  it('refuses the last remaining workspace even when it is empty', () => {
    const decision = decideWorkspaceDelete({ projectCount: 0, totalWorkspaceCount: 1 });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.cause).toBe('LAST_WORKSPACE');
  });

  it('reports not-empty before last-workspace when both apply', () => {
    // Order matters for the message the user sees: "move your projects out"
    // is actionable, "this is your only workspace" is not.
    const decision = decideWorkspaceDelete({ projectCount: 2, totalWorkspaceCount: 1 });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.cause).toBe('WORKSPACE_NOT_EMPTY');
  });

  it('treats a zero-workspace store as last-workspace rather than allowing', () => {
    // Unreachable once ensureDefaultWorkspace has run, but the guard is <= 1
    // rather than === 1 precisely so a corrupt count cannot authorise a delete.
    const decision = decideWorkspaceDelete({ projectCount: 0, totalWorkspaceCount: 0 });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.cause).toBe('LAST_WORKSPACE');
  });
});

describe('formatWorkspaceDeleteRefusal', () => {
  it('explains the last-workspace refusal and what to do about it', () => {
    const message = formatWorkspaceDeleteRefusal(
      { allowed: false, cause: 'LAST_WORKSPACE', projectCount: 0 },
      'My Workspace',
    );
    expect(message).toContain('My Workspace');
    expect(message).toContain('only workspace');
    expect(message).toContain('Create another one first');
  });

  it('uses singular wording for exactly one project', () => {
    const message = formatWorkspaceDeleteRefusal(
      { allowed: false, cause: 'WORKSPACE_NOT_EMPTY', projectCount: 1 },
      'Checkout Program',
    );
    expect(message).toContain('still holds 1 project.');
    expect(message).not.toContain('1 projects');
    expect(message).toContain('Move it to another workspace');
    expect(message).not.toContain('Move them');
  });

  it('uses plural wording for more than one project', () => {
    const message = formatWorkspaceDeleteRefusal(
      { allowed: false, cause: 'WORKSPACE_NOT_EMPTY', projectCount: 3 },
      'Checkout Program',
    );
    expect(message).toContain('still holds 3 projects.');
    expect(message).toContain('Move them to another workspace');
    expect(message).not.toContain('Move it ');
  });

  it('always names the workspace, so the message is unambiguous mid-switch', () => {
    for (const decision of [
      { allowed: false, cause: 'LAST_WORKSPACE', projectCount: 0 },
      { allowed: false, cause: 'WORKSPACE_NOT_EMPTY', projectCount: 2 },
    ] as const) {
      expect(formatWorkspaceDeleteRefusal(decision, 'Personal')).toContain('Personal');
    }
  });
});

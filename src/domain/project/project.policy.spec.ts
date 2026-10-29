/**
 * Unit tests for project.policy.ts (Story 1.6 Task 9).
 *
 * Tests the pure validation functions:
 *   - validateProjectName: table test for empty, whitespace-only,
 *     over-length, and valid names
 *   - Command construction and validation
 */

import { describe, expect, it } from 'vitest';
import { validateProjectName, MAX_PROJECT_NAME_LENGTH } from './project.policy';
import { createProject, withName } from './project.entity';
import { createCreateProjectCommand } from './create-project.command';
import { createRenameProjectCommand } from './rename-project.command';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

describe('project.policy', () => {
  describe('validateProjectName', () => {
    it.each([
      // [input, expected valid, expected trimmed or cause]
      ['My Project', true, 'My Project'],
      ['  Leading spaces', true, 'Leading spaces'],
      ['Trailing spaces  ', true, 'Trailing spaces'],
      ['  Both sides  ', true, 'Both sides'],
      ['Internal   spaces', true, 'Internal   spaces'], // NOT collapsed
      ['', false, 'EMPTY_NAME'],
      ['   ', false, 'EMPTY_NAME'],
      ['\t\n\r', false, 'EMPTY_NAME'],
      ['a', true, 'a'],
      ['a'.repeat(MAX_PROJECT_NAME_LENGTH), true, 'a'.repeat(MAX_PROJECT_NAME_LENGTH)],
      ['a'.repeat(MAX_PROJECT_NAME_LENGTH + 1), false, 'NAME_TOO_LONG'],
    ] as const)('validates "%s" → %s', (input, expectedValid, expected) => {
      const result = validateProjectName(input as string);
      if (expectedValid) {
        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.trimmed).toBe(expected);
        }
      } else {
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.cause).toBe(expected);
        }
      }
    });

    it('rejects non-string input', () => {
      const result = validateProjectName(undefined as unknown as string);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.cause).toBe('EMPTY_NAME');
      }
    });

    it('counts code points, not UTF-16 code units', () => {
      // '😀' is 1 code point but 2 UTF-16 code units
      const emoji = '😀'.repeat(MAX_PROJECT_NAME_LENGTH);
      const result = validateProjectName(emoji);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.trimmed).toBe(emoji);
      }

      const tooMany = '😀'.repeat(MAX_PROJECT_NAME_LENGTH + 1);
      const tooManyResult = validateProjectName(tooMany);
      expect(tooManyResult.valid).toBe(false);
      if (!tooManyResult.valid) {
        expect(tooManyResult.cause).toBe('NAME_TOO_LONG');
      }
    });

    it('preserves internal whitespace', () => {
      const result = validateProjectName('hello   world');
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.trimmed).toBe('hello   world');
      }
    });
  });
});

describe('project.entity', () => {
  it('constructs a frozen Project', () => {
    const id = createUuidV7();
    const project = createProject({ id, name: 'Test', revision: 0 });
    expect(project.id).toBe(id);
    expect(project.name).toBe('Test');
    expect(project.revision).toBe(0);
    expect(Object.isFrozen(project)).toBe(true);
  });

  it('rejects invalid UUIDv7', () => {
    expect(() => createProject({ id: 'not-a-uuid', name: 'Test', revision: 0 }))
      .toThrow('INVALID_UUID_V7');
  });

  it('rejects negative revision', () => {
    const id = createUuidV7();
    expect(() => createProject({ id, name: 'Test', revision: -1 }))
      .toThrow('INVALID_PROJECT_REVISION');
  });

  it('rejects non-integer revision', () => {
    const id = createUuidV7();
    expect(() => createProject({ id, name: 'Test', revision: 1.5 }))
      .toThrow('INVALID_PROJECT_REVISION');
  });

  it('withName returns new frozen object with incremented revision', () => {
    const id = createUuidV7();
    const project = createProject({ id, name: 'Old', revision: 3 });
    const renamed = withName(project, 'New');
    expect(renamed.id).toBe(id);
    expect(renamed.name).toBe('New');
    expect(renamed.revision).toBe(4);
    expect(Object.isFrozen(renamed)).toBe(true);
    // Original is unchanged
    expect(project.name).toBe('Old');
    expect(project.revision).toBe(3);
  });
});

describe('create-project.command', () => {
  it('constructs a frozen CreateProjectCommand', () => {
    const commandId = createUuidV7();
    const projectId = createUuidV7();
    const cmd = createCreateProjectCommand({ commandId, projectId, name: 'My Project' });
    expect(cmd.type).toBe('CreateProject');
    expect(cmd.commandId).toBe(commandId);
    expect(cmd.projectId).toBe(projectId);
    expect(cmd.baseRevision).toBe(0);
    expect(cmd.name).toBe('My Project');
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it('rejects invalid commandId', () => {
    const projectId = createUuidV7();
    expect(() => createCreateProjectCommand({ commandId: 'bad', projectId, name: 'X' }))
      .toThrow('INVALID_UUID_V7');
  });

  it('rejects invalid projectId', () => {
    const commandId = createUuidV7();
    expect(() => createCreateProjectCommand({ commandId, projectId: 'bad', name: 'X' }))
      .toThrow('INVALID_UUID_V7');
  });
});

describe('rename-project.command', () => {
  it('constructs a frozen RenameProjectCommand', () => {
    const commandId = createUuidV7();
    const projectId = createUuidV7();
    const cmd = createRenameProjectCommand({ commandId, projectId, baseRevision: 5, name: 'Renamed' });
    expect(cmd.type).toBe('RenameProject');
    expect(cmd.commandId).toBe(commandId);
    expect(cmd.projectId).toBe(projectId);
    expect(cmd.baseRevision).toBe(5);
    expect(cmd.name).toBe('Renamed');
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it('rejects negative baseRevision', () => {
    const commandId = createUuidV7();
    const projectId = createUuidV7();
    expect(() => createRenameProjectCommand({ commandId, projectId, baseRevision: -1, name: 'X' }))
      .toThrow('INVALID_BASE_REVISION');
  });

  it('rejects non-integer baseRevision', () => {
    const commandId = createUuidV7();
    const projectId = createUuidV7();
    expect(() => createRenameProjectCommand({ commandId, projectId, baseRevision: 1.5, name: 'X' }))
      .toThrow('INVALID_BASE_REVISION');
  });
});

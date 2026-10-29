import { describe, expect, it } from 'vitest';
import { formatCommandRejection } from './command-feedback';
import type { ProductCommandRejected } from '../../contracts/repository-commands';

function rejection(code: ProductCommandRejected['code']): ProductCommandRejected {
  return Object.freeze({
    type: 'ProductCommandRejected',
    protocolVersion: '1.0.0' as const,
    commandId: '019ffe00-0000-7000-8000-000000000001',
    code,
  });
}

describe('command-feedback (Story 6.3 Task 4)', () => {
  it('maps REVISION_CONFLICT to a human-safe cause + resulting state', () => {
    const fb = formatCommandRejection(rejection('REVISION_CONFLICT'));
    expect(fb.cause).toContain('outdated');
    expect(fb.resultingState).toContain('preserved');
  });

  it('maps NODE_NOT_FOUND and PARENT_NOT_FOUND', () => {
    expect(formatCommandRejection(rejection('NODE_NOT_FOUND')).cause).toContain('no longer exists');
    expect(formatCommandRejection(rejection('PARENT_NOT_FOUND')).cause).toContain('parent');
  });

  it('maps CYCLE_DETECTED distinctly', () => {
    expect(formatCommandRejection(rejection('CYCLE_DETECTED')).cause).toContain('cycle');
  });

  it('maps FORECAST_PLAN_CORRUPT to the canonical explanation', () => {
    const fb = formatCommandRejection(rejection('FORECAST_PLAN_CORRUPT'));
    expect(fb.cause).toBe('Stored forecast inputs could not be read.');
    expect(fb.resultingState).toBe('Reopen the project or restore from a backup.');
  });

  it('maps UNSUPPORTED_NEWER_SCHEMA to the canonical reload explanation', () => {
    const fb = formatCommandRejection(rejection('UNSUPPORTED_NEWER_SCHEMA'));
    expect(fb.cause).toBe('This project data was saved by a newer version of the app.');
    expect(fb.resultingState).toBe('Reload to update.');
    expect(`${fb.cause} ${fb.resultingState}`).toBe('This project data was saved by a newer version of the app. Reload to update.');
  });

  it('every code in the union produces a non-empty cause and resultingState', () => {
    const codes: ProductCommandRejected['code'][] = [
      'REVISION_CONFLICT', 'PROJECT_NOT_FOUND', 'COMMAND_IDENTITY_CONFLICT',
      'NODE_NOT_FOUND', 'PARENT_NOT_FOUND', 'CYCLE_DETECTED',
      'PHASE_NOT_FOUND', 'EDGE_CONFLICT', 'FIELD_CONFLICT', 'HIERARCHY_CONFLICT',
      'FORECAST_PLAN_CORRUPT', 'UNSUPPORTED_NEWER_SCHEMA',
    ];
    for (const code of codes) {
      const fb = formatCommandRejection(rejection(code));
      expect(fb.cause.length).toBeGreaterThan(0);
      expect(fb.resultingState.length).toBeGreaterThan(0);
    }
  });
});
import { describe, expect, it } from 'vitest';
import {
  buildDraftPatch,
  canRunTogether,
  EMPTY_DRAFT_FIELDS,
  isDraftDirty,
  runTogetherGroup,
  type ScenarioDraftFields,
} from './scenario-draft';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';

function context(overrides: Partial<ScenarioDraftContext> = {}): ScenarioDraftContext {
  return Object.freeze({
    draftId: 'draft-1',
    projectId: 'p1',
    baselineRevision: 5,
    materialFingerprint: 'a'.repeat(64),
    policyVersion: 'shared-capacity-v1',
    planningLevel: 'Feature',
    baseline: Object.freeze({
      projectId: 'p1',
      baselineRevision: 5,
      policyVersion: 'shared-capacity-v1',
      planningLevel: 'Feature',
      orderedScope: Object.freeze(['f1', 'f2']),
      configuration: Object.freeze({ pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      parallelGroups: Object.freeze([]),
      blockedFeatureIds: Object.freeze([]),
      factMap: Object.freeze({}),
    }),
    items: Object.freeze([]),
    ...overrides,
  });
}

describe('scenario-draft levers (Story 26.4)', () => {
  it('AC 26.4-1: builds a policy patch when pacing changes', () => {
    const fields: ScenarioDraftFields = { ...EMPTY_DRAFT_FIELDS, policyVersion: 'staffed-capacity-v1' };
    const { patch } = buildDraftPatch(fields, context());
    expect(patch.policyVersion).toBe('staffed-capacity-v1');
  });

  it('AC 26.4-1: omits the policy patch when it equals the captured policy', () => {
    const fields: ScenarioDraftFields = { ...EMPTY_DRAFT_FIELDS, policyVersion: 'shared-capacity-v1' };
    const { patch } = buildDraftPatch(fields, context());
    expect(patch.policyVersion).toBeUndefined();
  });

  it('AC 26.4-1: builds a parallel-group patch from the run-together lever', () => {
    const fields: ScenarioDraftFields = {
      ...EMPTY_DRAFT_FIELDS,
      parallelGroups: Object.freeze([Object.freeze({ featureIds: Object.freeze(['f1', 'f2']) })]),
    };
    const { patch } = buildDraftPatch(fields, context());
    expect(patch.parallelGroups).toEqual([{ featureIds: ['f1', 'f2'] }]);
  });

  it('runTogetherGroup groups the first two included items', () => {
    expect(runTogetherGroup(EMPTY_DRAFT_FIELDS, context())).toEqual({ featureIds: ['f1', 'f2'] });
  });

  it('AC 26.4-1: canRunTogether is valid in shared mode, and blocked when staffed members share a person', () => {
    expect(canRunTogether(EMPTY_DRAFT_FIELDS, context())).toBe(true);
    const staffed = context({
      policyVersion: 'staffed-capacity-v1',
      baseline: Object.freeze({
        ...context().baseline,
        policyVersion: 'staffed-capacity-v1',
        assignments: Object.freeze({ f1: ['ada'], f2: ['ada'] }),
      }) as never,
    });
    expect(canRunTogether(EMPTY_DRAFT_FIELDS, staffed)).toBe(false);
  });

  it('counts the pacing lever as dirty', () => {
    expect(isDraftDirty({ ...EMPTY_DRAFT_FIELDS, policyVersion: 'staffed-capacity-v1' })).toBe(true);
    expect(isDraftDirty({ ...EMPTY_DRAFT_FIELDS, parallelGroups: Object.freeze([]) })).toBe(true);
    expect(isDraftDirty(EMPTY_DRAFT_FIELDS)).toBe(false);
  });
});

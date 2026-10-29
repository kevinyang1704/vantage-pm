/**
 * Whole-set forecast — code-review follow-ups (Epic 18 review, 2026-09-06).
 *
 * Covers gaps found in review:
 *  - safe-integer overflow is a distinct typed state, never a throw (AC 18.3-4)
 *  - a well-formed but impossible calendar date is a typed `invalid`, never a
 *    thrown RangeError (AC 18.1-2, AC 18.3-4)
 *  - a well-formed non-empty parallel group is preserved and reported
 *    `UNSUPPORTED_GROUPS`, never silently flattened to sequential
 *  - graph-level scope issues supplied by normalization (overlap / foreign /
 *    non-Feature) reach the result envelope and withhold every timeline (AR-4)
 *  - determinism is asserted against canonical bytes, not JSON.stringify
 */

import { describe, expect, it } from 'vitest';
import { calculateForecast } from './whole-set.policy';
import { canonicalizeForecast } from './forecast-canonical';
import type { ForecastInputs } from './forecast-result';
import type { ForecastIssue } from './forecast-validators';

const PID = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';

function inputs(over: Partial<ForecastInputs>): ForecastInputs {
  return Object.freeze({
    projectId: PID,
    projectRevision: 1,
    policyVersion: 'shared-capacity-v1',
    selectedFeatureIds: Object.freeze([A, B]),
    estimates: Object.freeze({ [A]: 15, [B]: 10 }),
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    ...over,
  });
}

describe('overflow is a typed state, never a throw (AC 18.3-4)', () => {
  it('a summed point total beyond MAX_SAFE_INTEGER yields state "overflow"', async () => {
    const big = Number.MAX_SAFE_INTEGER - 1;
    const res = await calculateForecast(
      inputs({ selectedFeatureIds: [A, B], estimates: { [A]: big, [B]: big } }),
    );
    expect(res.state).toBe('overflow');
    expect(res.arithmetic).toBeNull();
    expect(res.issues.some((i) => i.code === 'OVERFLOW')).toBe(true);
  });

  it('an enormous sprint span is "overflow", not a thrown Temporal RangeError', async () => {
    const res = await calculateForecast(
      inputs({ selectedFeatureIds: [A], estimates: { [A]: 10_000_000 }, pointsPerSprint: 1 }),
    );
    expect(res.state).toBe('overflow');
    expect(res.arithmetic).toBeNull();
  });
});

describe('impossible dates are typed, never thrown (AC 18.1-2)', () => {
  it('2026-02-30 produces state "invalid" with INVALID_START_DATE', async () => {
    const res = await calculateForecast(inputs({ startDate: '2026-02-30' }));
    expect(res.state).toBe('invalid');
    expect(res.issues.some((i) => i.code === 'INVALID_START_DATE')).toBe(true);
  });
});

describe('non-empty parallel groups are activated (Epic 19 Story 19.1)', () => {
  it('a well-formed group is active: ready result has bounded-parallel premise and allocation', async () => {
    const res = await calculateForecast(
      inputs({
        selectedFeatureIds: [A, B, C],
        estimates: { [A]: 10, [B]: 10, [C]: 10 },
        parallelGroups: [{ featureIds: [A, B] }],
      }),
    );
    expect(res.state).toBe('ready');
    // Whole-set duration is unchanged by grouping (AR-7): 30 / 10 = 3 sprints.
    expect(res.arithmetic?.occupiedSprints).toBe(3);
    expect(res.assumptions.groupingPremise).toBe('bounded-parallel-equal-share');
    expect(res.allocation).not.toBeNull();
  });

  it('a malformed group is still a hard INVALID_GROUP, not an advisory', async () => {
    const res = await calculateForecast(
      inputs({
        selectedFeatureIds: [A, B, C],
        estimates: { [A]: 10, [B]: 10, [C]: 10 },
        parallelGroups: [{ featureIds: [A, C] }], // non-contiguous
      }),
    );
    expect(res.state).toBe('invalid');
    expect(res.issues.some((i) => i.code === 'INVALID_GROUP')).toBe(true);
  });
});

describe('graph-level scope issues reach the result and withhold timelines (AR-4)', () => {
  it('an OVERLAPPING_SCOPE issue from normalization forces invalid, not a double-counted ready', async () => {
    const overlap: ForecastIssue = Object.freeze({
      code: 'OVERLAPPING_SCOPE',
      field: 'selectedFeatureIds',
      message: 'B overlaps selected ancestor A.',
      featureIds: Object.freeze([B, A]),
    });
    const res = await calculateForecast(inputs({}), [overlap]);
    expect(res.state).toBe('invalid');
    expect(res.arithmetic).toBeNull();
    expect(res.issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });

  it('a FOREIGN_FEATURE reference is reported as such, not as MISSING_ESTIMATE', async () => {
    const foreign: ForecastIssue = Object.freeze({
      code: 'FOREIGN_FEATURE',
      field: 'selectedFeatureIds',
      message: 'C does not exist in this project.',
      featureIds: Object.freeze([C]),
    });
    const res = await calculateForecast(inputs({}), [foreign]);
    expect(res.state).toBe('invalid');
    expect(res.issues.some((i) => i.code === 'FOREIGN_FEATURE')).toBe(true);
    expect(res.issues.some((i) => i.code === 'MISSING_ESTIMATE')).toBe(false);
  });
});

describe('determinism is byte-identical against canonical serialization (NFR-1)', () => {
  it('two runs with reordered estimate keys produce identical canonical result bytes', async () => {
    const a = await calculateForecast(
      inputs({ selectedFeatureIds: [A, B], estimates: { [A]: 15, [B]: 10 } }),
    );
    const b = await calculateForecast(
      inputs({ selectedFeatureIds: [A, B], estimates: { [B]: 10, [A]: 15 } }),
    );
    expect(canonicalizeForecast(a)).toBe(canonicalizeForecast(b));
    // Independent oracle for the worked example.
    expect(a.arithmetic?.completionSprint).toBe(14);
    expect(a.arithmetic?.completionDate).toBe('2026-10-18');
    expect(a.arithmetic?.requiredSprints).toEqual({ numerator: 5, denominator: 2 });
  });

  it('group array order does not change the material fingerprint', async () => {
    const base = {
      selectedFeatureIds: [A, B, C],
      estimates: { [A]: 10, [B]: 10, [C]: 10 },
    };
    const one = await calculateForecast(
      inputs({ ...base, parallelGroups: [{ featureIds: [A, B] }] }),
    );
    const two = await calculateForecast(
      inputs({ ...base, parallelGroups: [{ featureIds: [B, A] }] }),
    );
    expect(one.materialFingerprint).toBe(two.materialFingerprint);
  });
});

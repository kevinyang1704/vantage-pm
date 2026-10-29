/**
 * Forecast-owned blocker behaviour (Story 20.1, AC 20.1-1..20.1-6, AR-12).
 *
 * These assert the pure calculator: an explicitly-blocked in-scope Feature
 * turns an otherwise ready/zero-work result `conditional` with no assumed
 * delay, keeps the exact same arithmetic, stays visible alongside a
 * missing-estimate diagnostic, and never forces order or suppresses
 * calculation. Blockers are never inferred — the calculator only ever sees
 * the explicit `blockedFeatureIds` array.
 */

import { describe, it, expect } from 'vitest';
import { calculateForecast } from './whole-set.policy';
import { computeForecastFingerprint } from './forecast-canonical';
import { createForecastPlan } from './forecast-plan.entity';
import type { ForecastInputs } from './forecast-result';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-00000000000a';
const B = '019ffe00-0000-7000-8000-00000000000b';
const C = '019ffe00-0000-7000-8000-00000000000c';

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return Object.freeze({
    projectId: PROJECT_ID,
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

describe('Story 20.1 — an explicit blocker makes a ready result conditional (AC 20.1-1)', () => {
  it('keeps the identical numeric timeline, names the Feature, states no delay assumed', async () => {
    const ready = await calculateForecast(inputs());
    const blocked = await calculateForecast(inputs({ blockedFeatureIds: [A] }));

    expect(ready.state).toBe('ready');
    expect(blocked.state).toBe('conditional');
    // Same arithmetic — the blocker invents no delay.
    expect(blocked.arithmetic).toEqual(ready.arithmetic);
    expect(blocked.allocation).toEqual(ready.allocation);

    const issue = blocked.issues.find((i) => i.code === 'CONDITIONAL_BLOCKER');
    expect(issue).toBeDefined();
    expect(issue?.featureIds).toEqual([A]);
    expect(issue?.message).toContain('No delay duration was assumed');
  });

  it('clearing the blocker removes only the conditional fact/cause (AC 20.1-2)', async () => {
    const blocked = await calculateForecast(inputs({ blockedFeatureIds: [A] }));
    const cleared = await calculateForecast(inputs({ blockedFeatureIds: [] }));

    expect(cleared.state).toBe('ready');
    expect(cleared.issues.some((i) => i.code === 'CONDITIONAL_BLOCKER')).toBe(false);
    expect(cleared.arithmetic).toEqual(blocked.arithmetic);
    expect(cleared.coverage).toEqual(blocked.coverage);
  });
});

describe('Story 20.1 — a blocker never suppresses calculation or forces order (AC 20.1-3)', () => {
  it('an out-of-scope blocked ID has no effect', async () => {
    const withGhost = await calculateForecast(inputs({ blockedFeatureIds: [C] }));
    const plain = await calculateForecast(inputs());
    expect(withGhost.state).toBe('ready');
    expect(withGhost.issues).toEqual(plain.issues);
    expect(withGhost.materialFingerprint).toBe(plain.materialFingerprint);
  });

  it('order is unchanged — allocation still follows scope priority', async () => {
    const blocked = await calculateForecast(inputs({ blockedFeatureIds: [B] }));
    expect(blocked.state).toBe('conditional');
    expect(blocked.allocation?.timelines.map((t) => t.featureId)).toEqual([A, B]);
  });
});

describe('Story 20.1 — missing estimate + blocker coexist (AC 20.1-4)', () => {
  it('missing-estimate state withholds timelines while both diagnostics stay visible', async () => {
    const result = await calculateForecast(
      inputs({ estimates: { [A]: null, [B]: 10 }, blockedFeatureIds: [B] }),
    );
    expect(result.state).toBe('incomplete');
    expect(result.arithmetic).toBeNull();
    expect(result.issues.some((i) => i.code === 'MISSING_ESTIMATE' && i.featureIds?.[0] === A)).toBe(true);
    expect(result.issues.some((i) => i.code === 'CONDITIONAL_BLOCKER' && i.featureIds?.[0] === B)).toBe(true);
  });
});

describe('Story 20.1 — the blocked set is a material input (FR-4)', () => {
  it('marking a blocker changes the material fingerprint', async () => {
    const plain = await calculateForecast(inputs());
    const blocked = await calculateForecast(inputs({ blockedFeatureIds: [A] }));
    expect(blocked.materialFingerprint).not.toBe(plain.materialFingerprint);
  });

  it('the fingerprint is independent of blocked-array order and scope-order re-derived', async () => {
    const one = await calculateForecast(
      inputs({ selectedFeatureIds: [A, B, C], estimates: { [A]: 5, [B]: 5, [C]: 5 }, blockedFeatureIds: [A, C] }),
    );
    const two = await calculateForecast(
      inputs({ selectedFeatureIds: [A, B, C], estimates: { [A]: 5, [B]: 5, [C]: 5 }, blockedFeatureIds: [C, A] }),
    );
    expect(one.materialFingerprint).toBe(two.materialFingerprint);
  });
});

describe('Story 20.1 — zero-work with a blocker is conditional, not zero-work', () => {
  it('reports the configured anchor, labelled conditional', async () => {
    const result = await calculateForecast(
      inputs({ estimates: { [A]: 0, [B]: 0 }, blockedFeatureIds: [A] }),
    );
    expect(result.state).toBe('conditional');
    expect(result.arithmetic?.completionSprint).toBe(12);
    expect(result.issues.some((i) => i.code === 'CONDITIONAL_BLOCKER')).toBe(true);
  });
});

describe('Story 20.1 — plan canonicalization keeps the blocked set in scope-priority order', () => {
  it('drops out-of-scope IDs, dedupes, and orders by scope priority', () => {
    const plan = createForecastPlan({
      projectId: PROJECT_ID,
      selectedFeatureIds: [A, B, C],
      blockedFeatureIds: [C, A, A, '019ffe00-0000-7000-8000-0000000000ff'],
    });
    expect(plan.blockedFeatureIds).toEqual([A, C]);
  });
});

// Sanity: an independent fingerprint oracle would hash the same canonical
// facts; here we assert stability across repeated computation (NFR-1).
it('Story 20.1 — repeated computation is byte-stable', async () => {
  const a = await computeForecastFingerprint({ x: 1 });
  const b = await computeForecastFingerprint({ x: 1 });
  expect(a).toBe(b);
});

import { describe, expect, it, vi } from 'vitest';
import { reconcileScenarioEvaluations, scenarioContentKey, type ScenarioEvaluationCache } from './scenario-evaluation-cache';
import type { PersistedForecastScenario } from '../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../domain/forecast/scenario-evaluate';

function scenario(id: string, pointOverride: number): PersistedForecastScenario {
  // A real material patch field (pointOverrides) so the content key changes
  // when the marker changes.
  return {
    scenarioId: id,
    patch: { pointOverrides: { '019ffe00-0000-7000-8000-0000000000f1': pointOverride } },
  } as unknown as PersistedForecastScenario;
}

const evaluation = (id: string): ScenarioEvaluation => ({ scenarioId: id } as unknown as ScenarioEvaluation);

describe('scenario evaluation cache (Story 25.1 AC 25.1-1)', () => {
  it('reuses an unchanged scenario without re-hashing or re-requesting', async () => {
    const cache: ScenarioEvaluationCache = new Map();
    const s = scenario('s1', 1);
    const fingerprintOf = vi.fn(async () => 'fp-a');
    const evaluate = vi.fn(async () => evaluation('s1'));

    const first = await reconcileScenarioEvaluations(cache, [s], fingerprintOf, evaluate);
    expect(first.hashed).toBe(1);
    expect(first.requested).toBe(1);

    // Same content (identity is irrelevant now): no hash, no request.
    const second = await reconcileScenarioEvaluations(cache, [s], fingerprintOf, evaluate);
    expect(second.hashed).toBe(0);
    expect(second.requested).toBe(0);
    expect(fingerprintOf).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('produces the same content key for a semantically identical patch with different key order', () => {
    const a = { scenarioId: 's1', patch: { pointOverrides: { b: 2, a: 1 } } } as unknown as PersistedForecastScenario;
    const b = { scenarioId: 's1', patch: { pointOverrides: { a: 1, b: 2 } } } as unknown as PersistedForecastScenario;
    expect(scenarioContentKey(a)).toBe(scenarioContentKey(b));
  });

  it('does not write the cache when the pass is stale', async () => {
    const cache: ScenarioEvaluationCache = new Map();
    let stale = false;
    await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 1)],
      async () => 'fp-a',
      async () => evaluation('s1'),
      () => stale,
    );
    expect(cache.size).toBe(1);
    stale = true;
    await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 2)],
      async () => 'fp-b',
      async () => evaluation('s1'),
      () => stale,
    );
    // The stale pass did not clobber the cache with its older content.
    expect(cache.get('s1')?.contentKey).toBe(scenarioContentKey(scenario('s1', 1)));
  });

  it('reuses a new identity with identical content without re-hashing or re-requesting', async () => {
    const cache: ScenarioEvaluationCache = new Map();
    await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 1)],
      async () => 'fp-a',
      async () => evaluation('s1'),
    );

    // New object (e.g. a refresh rebuilt the array from the worker) but same
    // content: the cheap content key hits, so no hash and no request.
    const fingerprintOf = vi.fn(async () => 'fp-a');
    const evaluate = vi.fn(async () => evaluation('s1'));
    const result = await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 1)],
      fingerprintOf,
      evaluate,
    );
    expect(result.hashed).toBe(0);
    expect(result.requested).toBe(0);
    expect(fingerprintOf).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('re-evaluates a changed scenario exactly once', async () => {
    const cache: ScenarioEvaluationCache = new Map();
    await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 1)],
      async () => 'fp-a',
      async () => evaluation('s1'),
    );

    const evaluate = vi.fn(async () => evaluation('s1'));
    const result = await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 2)],
      async () => 'fp-b',
      evaluate,
    );
    expect(result.hashed).toBe(1);
    expect(result.requested).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('drops a removed scenario from the cache', async () => {
    const cache: ScenarioEvaluationCache = new Map();
    await reconcileScenarioEvaluations(
      cache,
      [scenario('s1', 1), scenario('s2', 1)],
      async () => 'fp-a',
      async (s) => evaluation(s.scenarioId),
    );
    expect(cache.size).toBe(2);

    await reconcileScenarioEvaluations(cache, [scenario('s1', 1)], async () => 'fp-a', async () => evaluation('s1'));
    expect(cache.has('s1')).toBe(true);
    expect(cache.has('s2')).toBe(false);
  });
});

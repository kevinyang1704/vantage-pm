/**
 * Forecast worker freshness specs (Story 18.4, AC 18.4-1..18.4-6).
 *
 * Covers the result envelope contract (project, revision, policy, material
 * fingerprint, request token), out-of-order response rejection, policy-version
 * matching, delta-gap resync, unrelated-revision fingerprint reuse, and the
 * recoverable "forecast unavailable" path when the Worker cannot be built.
 */

import { describe, expect, it, vi } from 'vitest';
import { AnalysisEngine } from './analysis-engine';
import {
  AnalysisWorkerClient,
  isCurrentForecastResult,
  WORKER_RECREATE_MAX_ATTEMPTS,
} from '../../adapters/platform/analysis-worker.client';
import type { Node } from '../../domain/tree/node.entity';
import type { ForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import { createForecastPlan, createForecastConfiguration } from '../../domain/forecast/forecast-plan.entity';
import type { AnalysisSnapshotRequest, ForecastRequest, ForecastResultResponse, ScenarioEvaluationRequest, ScenarioEvaluationResponse } from '../../contracts/analysis-protocol';
import { scenarioFingerprint, type ForecastScenarioBaseline, type PersistedForecastScenario } from '../../domain/forecast/scenario';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';

function featureNode(id: string, effortPoints: number | null): Node {
  return Object.freeze({
    id,
    projectId: PROJECT_ID,
    parentId: null,
    title: `Feature ${id}`,
    bodyText: null,
    position: 4294967296n,
    nodeType: 'Feature',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  });
}

function makeSnapshot(plan: ForecastPlan | null, revision: number): AnalysisSnapshotRequest {
  return Object.freeze({
    type: 'AnalysisSnapshot',
    projectId: PROJECT_ID,
    projectRevision: revision,
    nodes: Object.freeze([featureNode(FEATURE_A, 15), featureNode(FEATURE_B, 10)]),
    phases: Object.freeze([]),
    unlockEdges: Object.freeze([]),
    dismissals: Object.freeze([]),
    ...(plan ? { forecastPlan: plan } : {}),
  });
}

function makePlan(pointsPerSprint: number | null = 10): ForecastPlan {
  return createForecastPlan({
    projectId: PROJECT_ID,
    selectedFeatureIds: [FEATURE_A, FEATURE_B],
    configuration: createForecastConfiguration({
      pointsPerSprint,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    }),
  });
}

function request(projectRevision: number, requestToken: string): ForecastRequest {
  return Object.freeze({
    type: 'ForecastRequest',
    projectId: PROJECT_ID,
    projectRevision,
    policyVersion: 'shared-capacity-v1',
    requestToken,
  });
}

describe('Forecast result envelope (Story 18.4 AC1)', () => {
  it('carries project, revision, policy, material fingerprint, request token, and canonical result', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(), 7));
    const res = await engine.computeForecast(request(7, 'tok-1'));
    expect(res.type).toBe('ForecastResult');
    if (res.type !== 'ForecastResult') return;
    expect(res.projectId).toBe(PROJECT_ID);
    expect(res.projectRevision).toBe(7);
    expect(res.policyVersion).toBe('shared-capacity-v1');
    expect(res.requestToken).toBe('tok-1');
    expect(res.result).not.toBeNull();
    expect(res.result?.policyVersion).toBe('shared-capacity-v1');
    expect(res.result?.materialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(res.result?.state).toBe('ready');
    expect(res.result?.arithmetic?.completionSprint).toBe(14);
    expect(res.result?.arithmetic?.completionDate).toBe('2026-10-18');
  });

  it('a project without a plan yields the explicit empty state, not a fabricated default', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(null, 3));
    const res = await engine.computeForecast(request(3, 'tok-2'));
    expect(res.type).toBe('ForecastResult');
    if (res.type !== 'ForecastResult') return;
    expect(res.result?.state).toBe('empty');
  });
});

function mockResultResponse(
  projectRevision: number,
  requestToken: string,
  policyVersion = 'shared-capacity-v1',
): ForecastResultResponse {
  return Object.freeze({
    type: 'ForecastResult',
    projectId: PROJECT_ID,
    projectRevision,
    policyVersion,
    requestToken,
    historicalAttributionAvailable: false,
    result: Object.freeze({
      state: 'ready',
      projectId: PROJECT_ID,
      projectRevision,
      policyVersion: 'shared-capacity-v1',
      materialFingerprint: '0'.repeat(64),
      coverage: Object.freeze({ selectedCount: 2, estimatedCount: 2, ratio: Object.freeze({ numerator: 1, denominator: 1 }) }),
      totalKnownPoints: 25,
      arithmetic: null,
      assumptions: Object.freeze({
        policyVersion: 'shared-capacity-v1',
        cadence: 'fixed-contiguous',
        groupingPremise: 'sequential-only',
        rounding: 'ceil-once',
      }),
      issues: Object.freeze([]),
      allocation: null,
    }),
  });
}

describe('Stale-result rejection (Story 18.4 AC2)', () => {
  it('rejects a response whose carried material fingerprint differs from the acknowledged context', () => {
    const latest = Object.freeze({ ...request(7, 'current'), materialFingerprint: 'a'.repeat(64) });
    const response = Object.freeze({ ...mockResultResponse(7, 'current'), materialFingerprint: 'b'.repeat(64) });
    expect(isCurrentForecastResult(latest, response)).toBe(false);
  });

  it('only the response matching the current project, revision, policy, and token may become current', () => {
    const latest = request(8, 'new');
    expect(isCurrentForecastResult(latest, mockResultResponse(7, 'old'))).toBe(false);
    expect(isCurrentForecastResult(latest, mockResultResponse(8, 'new'))).toBe(true);
  });

  it('a same-revision response with a mismatched token is rejected', () => {
    const latest = request(7, 'current');
    expect(isCurrentForecastResult(latest, mockResultResponse(7, 'other'))).toBe(false);
  });

  it('a matching token but a different policy version is rejected', () => {
    const latest = request(7, 'current');
    expect(isCurrentForecastResult(latest, mockResultResponse(7, 'current', 'shared-capacity-v2'))).toBe(false);
  });

  it('no latest request means no result may become current', () => {
    expect(isCurrentForecastResult(null, mockResultResponse(7, 'x'))).toBe(false);
  });
});

describe('Delta gaps and resync (Story 18.4 AC3)', () => {
  it('a delta gap returns AnalysisResyncRequired and never a stale forecast', () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(), 5));
    const res = engine.applyDelta(
      Object.freeze({
        type: 'AnalysisDelta',
        projectId: PROJECT_ID,
        baseRevision: 3,
        targetRevision: 4,
        changeSet: Object.freeze({
          protocolVersion: '1.0.0',
          projectId: PROJECT_ID,
          baseRevision: 3,
          targetRevision: 4,
          changes: Object.freeze([]),
        }),
      }),
    );
    expect(res.type).toBe('AnalysisResyncRequired');
  });

  it('forecast computation after a gap requires a full snapshot bootstrap', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(), 5));
    engine.applyDelta(
      Object.freeze({
        type: 'AnalysisDelta',
        projectId: PROJECT_ID,
        baseRevision: 3,
        targetRevision: 4,
        changeSet: Object.freeze({
          protocolVersion: '1.0.0',
          projectId: PROJECT_ID,
          baseRevision: 3,
          targetRevision: 4,
          changes: Object.freeze([]),
        }),
      }),
    );
    engine.initialize(makeSnapshot(makePlan(), 6));
    const forecast = await engine.computeForecast(request(6, 'tok-3'));
    expect(forecast.type).toBe('ForecastResult');
  });
});

describe('Unrelated revisions and fingerprint reuse (Story 18.4 AC4)', () => {
  it('unchanged material inputs share a fingerprint across revisions', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(), 7));
    const a = await engine.computeForecast(request(7, 't1'));
    engine.initialize(makeSnapshot(makePlan(), 8));
    const b = await engine.computeForecast(request(8, 't2'));
    if (a.type !== 'ForecastResult' || b.type !== 'ForecastResult') return;
    expect(a.result?.materialFingerprint).toBe(b.result?.materialFingerprint);
    expect(a.result?.projectRevision).toBe(7);
    expect(b.result?.projectRevision).toBe(8);
  });

  it('a material input change changes the fingerprint', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 7));
    const a = await engine.computeForecast(request(7, 't1'));
    engine.initialize(makeSnapshot(makePlan(20), 8));
    const b = await engine.computeForecast(request(8, 't2'));
    if (a.type !== 'ForecastResult' || b.type !== 'ForecastResult') return;
    expect(a.result?.materialFingerprint).not.toBe(b.result?.materialFingerprint);
  });
});

describe('Worker failure and no synchronous fallback (Story 18.4 AC6)', () => {
  it('the client never exposes a synchronous compute API', () => {
    const client = new AnalysisWorkerClient();
    expect(typeof (client as unknown as { computeForecastSync?: unknown }).computeForecastSync).toBe('undefined');
    client.terminate();
  });

  it('a browser Worker that fails to construct yields a recoverable unavailable response, not a main-thread computation', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;
    class ThrowingWorker {
      constructor() {
        throw new Error('worker blocked');
      }
    }
    (globalThis as { Worker?: unknown }).Worker = ThrowingWorker as unknown as typeof Worker;
    try {
      const client = new AnalysisWorkerClient();
      const seen: ForecastResultResponse[] = [];
      client.onForecastResult((r) => seen.push(r));
      client.requestForecast(request(1, 'tok'));
      await vi.waitFor(() => expect(seen.length).toBe(1));
      expect(seen[0].result).toBeNull();
      expect(seen[0].error?.code).toBe('FORECAST_WORKER_UNAVAILABLE');
      client.terminate();
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });

  it('bounds worker reconstruction on a persistent script-load failure (Story 25.1 AC 25.1-2)', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;
    let constructions = 0;
    class FailingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor() {
        constructions += 1;
        // Fire a load error asynchronously so the client marks the worker failed.
        queueMicrotask(() => this.onerror?.(new Event('error')));
      }
      postMessage() {}
      terminate() {}
    }
    (globalThis as { Worker?: unknown }).Worker = FailingWorker as unknown as typeof Worker;
    try {
      const client = new AnalysisWorkerClient();
      const seen: ForecastResultResponse[] = [];
      client.onForecastResult((r) => seen.push(r));
      // Many requests: each triggers a lazy recreate attempt after the failure.
      for (let i = 0; i < 40; i += 1) {
        client.requestForecast(request(i + 1, `tok-${i}`));
        await Promise.resolve();
      }
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      // One initial construction plus at most WORKER_RECREATE_MAX_ATTEMPTS —
      // never one per request (which would be 40+).
      expect(constructions).toBeLessThanOrEqual(1 + WORKER_RECREATE_MAX_ATTEMPTS);
      client.terminate();
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });
});

describe('Epic 19 deltas and feature allocation (Story 19.3)', () => {
  it('a restarted worker reconstructs current scope before accepting results and rejects the pre-restart envelope (AC 19.3-2)', async () => {
    const first = new AnalysisEngine();
    first.initialize(makeSnapshot(makePlan(10), 1));
    const stale = await first.computeForecast(request(1, 'before-restart'));

    const restarted = new AnalysisEngine();
    const reordered = createForecastPlan({
      ...makePlan(10),
      selectedFeatureIds: [FEATURE_B, FEATURE_A],
    });
    restarted.initialize(makeSnapshot(reordered, 2));
    const currentRequest = request(2, 'after-restart');
    const current = await restarted.computeForecast(currentRequest);
    expect(current.type).toBe('ForecastResult');
    if (current.type !== 'ForecastResult' || stale.type !== 'ForecastResult') return;
    expect(current.result?.allocation?.timelines.map((item) => item.featureId)).toEqual([FEATURE_B, FEATURE_A]);
    expect(isCurrentForecastResult(currentRequest, stale)).toBe(false);
    expect(isCurrentForecastResult(currentRequest, current)).toBe(true);
  });

  it('clearing an estimate immediately withholds every current item window (AC 19.3-3)', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 1));
    const before = await engine.computeForecast(request(1, 'before-clear'));
    expect(before.type === 'ForecastResult' && before.result?.allocation).not.toBeNull();

    const delta = engine.applyDelta(Object.freeze({
      type: 'AnalysisDelta', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
      changeSet: Object.freeze({
        protocolVersion: '1.0.0', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
        changes: Object.freeze([{
          type: 'NodeEffortSet' as const,
          nodeId: FEATURE_A,
          effortPoints: null,
          priorEffortPoints: 15,
        }]),
      }),
    }));
    expect(delta.type).toBe('AnalysisResult');
    const after = await engine.computeForecast(request(2, 'after-clear'));
    expect(after.type).toBe('ForecastResult');
    if (after.type !== 'ForecastResult') return;
    expect(after.result?.state).toBe('incomplete');
    expect(after.result?.allocation).toBeNull();
  });

  it('Story 20.2 — the engine attributes change against the previously-settled forecast', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 1));

    const first = await engine.computeForecast(request(1, 'attr-1'));
    if (first.type !== 'ForecastResult') throw new Error('expected result');
    // First computation has no retained baseline.
    expect(first.historicalAttributionAvailable).toBe(false);
    expect(first.comparison).toBeUndefined();

    engine.applyDelta(Object.freeze({
      type: 'AnalysisDelta', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
      changeSet: Object.freeze({
        protocolVersion: '1.0.0', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
        changes: Object.freeze([{
          type: 'NodeEffortSet' as const, nodeId: FEATURE_A, effortPoints: 20, priorEffortPoints: 15,
        }]),
      }),
    }));
    const second = await engine.computeForecast(request(2, 'attr-2'));
    if (second.type !== 'ForecastResult') throw new Error('expected result');
    expect(second.historicalAttributionAvailable).toBe(true);
    expect(second.comparison?.causes).toEqual([
      { kind: 'EstimateIncreased', field: 'estimate', featureId: FEATURE_A, before: 15, after: 20 },
    ]);

    // A re-bootstrap of the SAME project keeps the attribution baseline (the
    // app re-snapshots on every forecast refresh).
    engine.initialize(makeSnapshot(makePlan(10), 5));
    const afterReSnapshot = await engine.computeForecast(request(5, 'attr-3'));
    if (afterReSnapshot.type !== 'ForecastResult') throw new Error('expected result');
    expect(afterReSnapshot.historicalAttributionAvailable).toBe(true);

    // A genuine restart — a fresh engine instance — has no retained history
    // (AC 20.2-6).
    const restarted = new AnalysisEngine();
    restarted.initialize(makeSnapshot(makePlan(10), 5));
    const afterRestart = await restarted.computeForecast(request(5, 'attr-4'));
    if (afterRestart.type !== 'ForecastResult') throw new Error('expected result');
    expect(afterRestart.historicalAttributionAvailable).toBe(false);
  });

  it('ForecastOrderSet delta updates feature timelines with whole-set date invariance', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 1));
    const initial = await engine.computeForecast(request(1, 'tok-1'));
    if (initial.type !== 'ForecastResult' || !initial.result?.allocation) {
      throw new Error('expected initial allocation');
    }
    const initialTimelines = initial.result.allocation.timelines;
    expect(initialTimelines[0].featureId).toBe(FEATURE_A);
    expect(initialTimelines[1].featureId).toBe(FEATURE_B);
    const initialWholeSetDate = initial.result.arithmetic?.completionDate;

    // Apply ForecastOrderSet delta from rev 1 -> 2
    const deltaRes = engine.applyDelta(
      Object.freeze({
        type: 'AnalysisDelta',
        projectId: PROJECT_ID,
        baseRevision: 1,
        targetRevision: 2,
        changeSet: Object.freeze({
          protocolVersion: '1.0.0',
          projectId: PROJECT_ID,
          baseRevision: 1,
          targetRevision: 2,
          changes: Object.freeze([
            {
              type: 'ForecastOrderSet' as const,
              selectedFeatureIds: Object.freeze([FEATURE_B, FEATURE_A]),
              priorSelectedFeatureIds: Object.freeze([FEATURE_A, FEATURE_B]),
            },
          ]),
        }),
      }),
    );
    expect(deltaRes.type).toBe('AnalysisResult');

    const updated = await engine.computeForecast(request(2, 'tok-2'));
    if (updated.type !== 'ForecastResult' || !updated.result?.allocation) {
      throw new Error('expected updated allocation');
    }
    const updatedTimelines = updated.result.allocation.timelines;
    expect(updatedTimelines[0].featureId).toBe(FEATURE_B);
    expect(updatedTimelines[1].featureId).toBe(FEATURE_A);
    // Whole-set date is invariant under reordering!
    expect(updated.result.arithmetic?.completionDate).toBe(initialWholeSetDate);
  });

  it('ForecastParallelGroupsSet delta updates capacity sharing and grouping premise', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 2));

    // Apply ForecastParallelGroupsSet delta from rev 2 -> 3
    const deltaRes = engine.applyDelta(
      Object.freeze({
        type: 'AnalysisDelta',
        projectId: PROJECT_ID,
        baseRevision: 2,
        targetRevision: 3,
        changeSet: Object.freeze({
          protocolVersion: '1.0.0',
          projectId: PROJECT_ID,
          baseRevision: 2,
          targetRevision: 3,
          changes: Object.freeze([
            {
              type: 'ForecastParallelGroupsSet' as const,
              parallelGroups: Object.freeze([{ featureIds: Object.freeze([FEATURE_A, FEATURE_B]) }]),
              priorParallelGroups: Object.freeze([]),
            },
          ]),
        }),
      }),
    );
    expect(deltaRes.type).toBe('AnalysisResult');

    const updated = await engine.computeForecast(request(3, 'tok-3'));
    if (updated.type !== 'ForecastResult' || !updated.result?.allocation) {
      throw new Error('expected updated allocation');
    }
    expect(updated.result.assumptions.groupingPremise).toBe('bounded-parallel-equal-share');
    expect(updated.result.allocation.timelines.length).toBe(2);
    expect(updated.result.allocation.timelines[0].parallelGroupIndex).toBe(0);
    expect(updated.result.allocation.timelines[1].parallelGroupIndex).toBe(0);
    expect(updated.result.allocation.events.length).toBeGreaterThanOrEqual(1);
    expect(updated.result.allocation.events[0].activeCount).toBe(2);
  });

  it('ForecastSequenceSet updates order and grouping in one revision and identifies changed item timing (AC 19.3-4, AC 19.3-6)', async () => {
    const engine = new AnalysisEngine();
    engine.initialize(makeSnapshot(makePlan(10), 1));
    const before = await engine.computeForecast(request(1, 'sequence-before'));
    if (before.type !== 'ForecastResult' || !before.result?.allocation) throw new Error('expected initial allocation');
    const priorFinish = before.result.allocation.timelines.find((item) => item.featureId === FEATURE_B)?.finishOffset;

    const delta = engine.applyDelta(Object.freeze({
      type: 'AnalysisDelta', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
      changeSet: Object.freeze({
        protocolVersion: '1.0.0', projectId: PROJECT_ID, baseRevision: 1, targetRevision: 2,
        changes: Object.freeze([{
          type: 'ForecastSequenceSet' as const,
          selectedFeatureIds: Object.freeze([FEATURE_B, FEATURE_A]),
          parallelGroups: Object.freeze([{ featureIds: Object.freeze([FEATURE_B, FEATURE_A]) }]),
          priorSelectedFeatureIds: Object.freeze([FEATURE_A, FEATURE_B]),
          priorParallelGroups: Object.freeze([]),
        }]),
      }),
    }));
    expect(delta.type).toBe('AnalysisResult');
    const after = await engine.computeForecast(request(2, 'sequence-after'));
    if (after.type !== 'ForecastResult' || !after.result?.allocation) throw new Error('expected updated allocation');
    expect(after.result.arithmetic?.completionDate).toBe(before.result.arithmetic?.completionDate);
    expect(after.result.allocation.timelines.map((item) => item.featureId)).toEqual([FEATURE_B, FEATURE_A]);
    expect(after.result.allocation.timelines.find((item) => item.featureId === FEATURE_B)?.finishOffset)
      .not.toEqual(priorFinish);
    expect(after.result.projectRevision).toBe(2);
  });
});

describe('Staffed scenario draft freshness & out-of-order rejection (AC 23.4-7)', () => {
  const ADA = '019ffe00-0000-7000-8000-0000000000c1';
  const BEN = '019ffe00-0000-7000-8000-0000000000d2';

  const staffedBaseline: ForecastScenarioBaseline = Object.freeze({
    projectId: PROJECT_ID,
    baselineRevision: 5,
    policyVersion: 'staffed-capacity-v1',
    planningLevel: 'Feature',
    orderedScope: Object.freeze([FEATURE_A, FEATURE_B]),
    configuration: createForecastConfiguration({
      pointsPerSprint: 20,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    }),
    parallelGroups: Object.freeze([{ featureIds: Object.freeze([FEATURE_A, FEATURE_B]) }]),
    blockedFeatureIds: Object.freeze([]),
    factMap: Object.freeze({
      [FEATURE_A]: { effortPoints: 30, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
      [FEATURE_B]: { effortPoints: 10, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
    }),
    roster: Object.freeze([
      { id: ADA, name: 'Ada Lovelace', weightUnits: 300 },
      { id: BEN, name: 'Ben Bitdiddle', weightUnits: 100 },
    ]),
    assignments: Object.freeze({
      [FEATURE_A]: Object.freeze([BEN]),
      [FEATURE_B]: Object.freeze([ADA]),
    }),
  });

  it('rejects stale preview reply when draft B supersedes draft A differing in assignment overrides (AC 23.4-7)', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;

    let workerOnMessage: ((event: MessageEvent) => void) | null = null;
    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        workerOnMessage = (e) => this.onmessage?.(e);
      }
      postMessage() {}
      terminate() {}
    }
    (globalThis as { Worker?: unknown }).Worker = MockWorker as unknown as typeof Worker;

    try {
      const client = new AnalysisWorkerClient();
      const scenarioId = '019ffe00-0000-7000-8000-000000000099';

      // Draft A: assignment override A -> ADA
      const scenarioA: PersistedForecastScenario = {
        projectId: PROJECT_ID,
        scenarioId,
        label: 'Draft A',
        baselineRevision: 5,
        baselineFingerprint: 'mock-baseline-fingerprint',
        policyVersion: 'staffed-capacity-v1',
        createdAtISO: '2026-09-24T20:00:00.000Z',
        baseline: staffedBaseline,
        patch: { assignmentOverrides: { [FEATURE_A]: [ADA] } },
      };
      // Draft B: assignment override A -> BEN
      const scenarioB: PersistedForecastScenario = {
        projectId: PROJECT_ID,
        scenarioId,
        label: 'Draft B',
        baselineRevision: 5,
        baselineFingerprint: 'mock-baseline-fingerprint',
        policyVersion: 'staffed-capacity-v1',
        createdAtISO: '2026-09-24T20:00:00.000Z',
        baseline: staffedBaseline,
        patch: { assignmentOverrides: { [FEATURE_A]: [BEN] } },
      };

      const fpA = await scenarioFingerprint(staffedBaseline, scenarioA.patch);
      const fpB = await scenarioFingerprint(staffedBaseline, scenarioB.patch);
      expect(fpA).not.toBe(fpB);

      // Request A then B at the same revision and policy
      const promiseA = client.requestScenarioEvaluation({
        type: 'ScenarioEvaluationRequest',
        projectId: PROJECT_ID,
        scenarioId,
        requestToken: 'tok-A',
        scenarioFingerprint: fpA,
        baselineRevision: 5,
        policyVersion: 'staffed-capacity-v1',
        scenario: scenarioA,
      });
      const promiseB = client.requestScenarioEvaluation({
        type: 'ScenarioEvaluationRequest',
        projectId: PROJECT_ID,
        scenarioId,
        requestToken: 'tok-B',
        scenarioFingerprint: fpB,
        baselineRevision: 5,
        policyVersion: 'staffed-capacity-v1',
        scenario: scenarioB,
      });

      // Worker replies to B FIRST
      workerOnMessage!({
        data: {
          type: 'ScenarioEvaluationResult',
          projectId: PROJECT_ID,
          scenarioId,
          requestToken: 'tok-B',
          scenarioFingerprint: fpB,
          baselineRevision: 5,
          policyVersion: 'staffed-capacity-v1',
          evaluation: { ok: true } as unknown as import('../../domain/forecast/scenario-evaluate').ScenarioEvaluation,
        },
      } as MessageEvent);

      const resB = await promiseB;
      expect(resB.requestToken).toBe('tok-B');
      expect(resB.scenarioFingerprint).toBe(fpB);

      // A was superseded by B the moment B was requested (Story 23.7).
      await expect(promiseA).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_SUPERSEDED' });

      // Worker replies to A LATER (out-of-order)
      let aResolved = false;
      void promiseA.then(
        () => {
          aResolved = true;
        },
        () => undefined,
      );

      workerOnMessage!({
        data: {
          type: 'ScenarioEvaluationResult',
          projectId: PROJECT_ID,
          scenarioId,
          requestToken: 'tok-A',
          scenarioFingerprint: fpA,
          baselineRevision: 5,
          policyVersion: 'staffed-capacity-v1',
          evaluation: { ok: true } as unknown as import('../../domain/forecast/scenario-evaluate').ScenarioEvaluation,
        },
      } as MessageEvent);

      // A's response is rejected by client and does not resolve promiseA
      expect(aResolved).toBe(false);
      client.terminate();
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });

  it('rejects stale preview reply when draft D supersedes draft C differing in weight overrides (AC 23.4-7)', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;

    let workerOnMessage: ((event: MessageEvent) => void) | null = null;
    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        workerOnMessage = (e) => this.onmessage?.(e);
      }
      postMessage() {}
      terminate() {}
    }
    (globalThis as { Worker?: unknown }).Worker = MockWorker as unknown as typeof Worker;

    try {
      const client = new AnalysisWorkerClient();
      const scenarioId = '019ffe00-0000-7000-8000-000000000088';

      // Draft C: weight override Ada -> 150
      const scenarioC: PersistedForecastScenario = {
        projectId: PROJECT_ID,
        scenarioId,
        label: 'Draft C',
        baselineRevision: 5,
        baselineFingerprint: 'mock-baseline-fingerprint',
        policyVersion: 'staffed-capacity-v1',
        createdAtISO: '2026-09-24T20:00:00.000Z',
        baseline: staffedBaseline,
        patch: { weightOverrides: { [ADA]: 150 } },
      };
      // Draft D: weight override Ada -> 250
      const scenarioD: PersistedForecastScenario = {
        projectId: PROJECT_ID,
        scenarioId,
        label: 'Draft D',
        baselineRevision: 5,
        baselineFingerprint: 'mock-baseline-fingerprint',
        policyVersion: 'staffed-capacity-v1',
        createdAtISO: '2026-09-24T20:00:00.000Z',
        baseline: staffedBaseline,
        patch: { weightOverrides: { [ADA]: 250 } },
      };

      const fpC = await scenarioFingerprint(staffedBaseline, scenarioC.patch);
      const fpD = await scenarioFingerprint(staffedBaseline, scenarioD.patch);
      expect(fpC).not.toBe(fpD);

      const promiseC = client.requestScenarioEvaluation({
        type: 'ScenarioEvaluationRequest',
        projectId: PROJECT_ID,
        scenarioId,
        requestToken: 'tok-C',
        scenarioFingerprint: fpC,
        baselineRevision: 5,
        policyVersion: 'staffed-capacity-v1',
        scenario: scenarioC,
      });
      const promiseD = client.requestScenarioEvaluation({
        type: 'ScenarioEvaluationRequest',
        projectId: PROJECT_ID,
        scenarioId,
        requestToken: 'tok-D',
        scenarioFingerprint: fpD,
        baselineRevision: 5,
        policyVersion: 'staffed-capacity-v1',
        scenario: scenarioD,
      });

      // Worker replies to D FIRST
      workerOnMessage!({
        data: {
          type: 'ScenarioEvaluationResult',
          projectId: PROJECT_ID,
          scenarioId,
          requestToken: 'tok-D',
          scenarioFingerprint: fpD,
          baselineRevision: 5,
          policyVersion: 'staffed-capacity-v1',
          evaluation: { ok: true } as unknown as import('../../domain/forecast/scenario-evaluate').ScenarioEvaluation,
        },
      } as MessageEvent);

      const resD = await promiseD;
      expect(resD.requestToken).toBe('tok-D');
      expect(resD.scenarioFingerprint).toBe(fpD);

      // Worker replies to C LATER
      await expect(promiseC).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_SUPERSEDED' });
      let cResolved = false;
      void promiseC.then(
        () => {
          cResolved = true;
        },
        () => undefined,
      );

      workerOnMessage!({
        data: {
          type: 'ScenarioEvaluationResult',
          projectId: PROJECT_ID,
          scenarioId,
          requestToken: 'tok-C',
          scenarioFingerprint: fpC,
          baselineRevision: 5,
          policyVersion: 'staffed-capacity-v1',
          evaluation: { ok: true } as unknown as import('../../domain/forecast/scenario-evaluate').ScenarioEvaluation,
        },
      } as MessageEvent);

      expect(cResolved).toBe(false);
      client.terminate();
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });

  it('cancels pending evaluation when client terminates and discards late responses (AC 23.4-7)', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;

    let workerOnMessage: ((event: MessageEvent) => void) | null = null;
    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        workerOnMessage = (e) => this.onmessage?.(e);
      }
      postMessage() {}
      terminate() {}
    }
    (globalThis as { Worker?: unknown }).Worker = MockWorker as unknown as typeof Worker;

    try {
      const client = new AnalysisWorkerClient();
      const scenarioId = '019ffe00-0000-7000-8000-000000000077';

      const scenario: PersistedForecastScenario = {
        projectId: PROJECT_ID,
        scenarioId,
        label: 'Draft E',
        baselineRevision: 5,
        baselineFingerprint: 'mock-baseline-fingerprint',
        policyVersion: 'staffed-capacity-v1',
        createdAtISO: '2026-09-24T20:00:00.000Z',
        baseline: staffedBaseline,
        patch: { weightOverrides: { [ADA]: 180 } },
      };

      const fp = await scenarioFingerprint(staffedBaseline, scenario.patch);
      const promise = client.requestScenarioEvaluation({
        type: 'ScenarioEvaluationRequest',
        projectId: PROJECT_ID,
        scenarioId,
        requestToken: 'tok-E',
        scenarioFingerprint: fp,
        baselineRevision: 5,
        policyVersion: 'staffed-capacity-v1',
        scenario,
      });

      // User cancels / navigates away: terminate client. The pending
      // evaluation settles as cancelled instead of hanging (AC 23.7-6).
      client.terminate();
      await expect(promise).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_CANCELLED' });

      let resolved = false;
      void promise.then(
        () => {
          resolved = true;
        },
        () => undefined,
      );

      // Late message arrives after cancellation
      workerOnMessage!({
        data: {
          type: 'ScenarioEvaluationResult',
          projectId: PROJECT_ID,
          scenarioId,
          requestToken: 'tok-E',
          scenarioFingerprint: fp,
          baselineRevision: 5,
          policyVersion: 'staffed-capacity-v1',
          evaluation: { ok: true } as unknown as import('../../domain/forecast/scenario-evaluate').ScenarioEvaluation,
        },
      } as MessageEvent);

      expect(resolved).toBe(false);
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });
});

describe('Story 23.7 — draft evaluation identities and lifecycle (AC 23.7-5, AC 23.7-6)', () => {
  const DRAFT = '019ffe00-0000-7000-8000-0000000000d7';
  const OTHER_PROJECT = '019ffe00-0000-7000-8000-0000000000f1';

  const request = (token: string, over: Partial<ScenarioEvaluationRequest> = {}): ScenarioEvaluationRequest => ({
    type: 'ScenarioEvaluationRequest',
    projectId: PROJECT_ID,
    scenarioId: DRAFT,
    requestToken: token,
    scenarioFingerprint: `fp-${token}`,
    baselineRevision: 5,
    policyVersion: 'staffed-capacity-v1',
    scenario: {} as PersistedForecastScenario,
    ...over,
  });
  const reply = (req: ScenarioEvaluationRequest, over: Partial<ScenarioEvaluationResponse> = {}): ScenarioEvaluationResponse => ({
    type: 'ScenarioEvaluationResult',
    projectId: req.projectId,
    scenarioId: req.scenarioId,
    requestToken: req.requestToken,
    scenarioFingerprint: req.scenarioFingerprint,
    baselineRevision: req.baselineRevision,
    policyVersion: req.policyVersion,
    evaluation: { ok: false, issues: [] },
    ...over,
  });

  /** A client over a mock Worker whose replies the test delivers by hand. */
  function withMockWorker(run: (client: AnalysisWorkerClient, deliver: (msg: ScenarioEvaluationResponse) => void, fail: () => void) => Promise<void>) {
    return async () => {
      const realWindow = (globalThis as { window?: unknown }).window;
      const realWorker = (globalThis as { Worker?: unknown }).Worker;
      (globalThis as { window?: unknown }).window = globalThis;
      let instance: { onmessage: ((e: MessageEvent) => void) | null; onerror: ((e: Event) => void) | null } | null = null;
      class MockWorker {
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        constructor() {
          // The client assigns its handlers after construction.
          instance = this;
        }
        postMessage() {}
        terminate() {}
      }
      (globalThis as { Worker?: unknown }).Worker = MockWorker as unknown as typeof Worker;
      const client = new AnalysisWorkerClient();
      try {
        await run(
          client,
          (msg) => instance!.onmessage?.({ data: msg } as MessageEvent),
          () => instance!.onerror?.(new Event('error')),
        );
      } finally {
        client.terminate();
        if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else (globalThis as { window?: unknown }).window = realWindow;
        if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
        else (globalThis as { Worker?: unknown }).Worker = realWorker;
      }
    };
  }

  it.each([
    ['project', { projectId: OTHER_PROJECT }],
    ['draft identity', { scenarioId: '019ffe00-0000-7000-8000-0000000000d8' }],
    ['captured revision', { baselineRevision: 6 }],
    ['policy', { policyVersion: 'shared-capacity-v1' as const }],
    ['request token', { requestToken: 'tok-other' }],
    ['fingerprint', { scenarioFingerprint: 'fp-other' }],
  ])('a reply with a mismatched %s is rejected; the matching reply still resolves', (_field, mismatch) =>
    withMockWorker(async (client, deliver) => {
      const req = request('tok-1');
      let settled = false;
      const pending = client.requestScenarioEvaluation(req).then((r) => {
        settled = true;
        return r;
      });
      deliver(reply(req, mismatch));
      await Promise.resolve();
      expect(settled).toBe(false);
      deliver(reply(req));
      await expect(pending).resolves.toMatchObject({ requestToken: 'tok-1' });
    })(),
  );

  it('an older reply that arrives after the newer one never resolves; the older request is superseded', () =>
    withMockWorker(async (client, deliver) => {
      const older = request('tok-older');
      const newer = request('tok-newer');
      const olderPending = client.requestScenarioEvaluation(older);
      const newerPending = client.requestScenarioEvaluation(newer);
      await expect(olderPending).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_SUPERSEDED' });
      deliver(reply(newer));
      await expect(newerPending).resolves.toMatchObject({ requestToken: 'tok-newer' });
      deliver(reply(older)); // late: no pending request carries this identity
    })(),
  );

  it('a cancelled draft settles as cancelled and its late reply is ignored', () =>
    withMockWorker(async (client, deliver) => {
      const req = request('tok-1');
      const pending = client.requestScenarioEvaluation(req);
      client.cancelScenarioEvaluation(DRAFT);
      await expect(pending).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_CANCELLED' });
      deliver(reply(req));
      const next = request('tok-2');
      const nextPending = client.requestScenarioEvaluation(next);
      deliver(reply(req)); // the cancelled request's reply cannot satisfy the new one
      deliver(reply(next));
      await expect(nextPending).resolves.toMatchObject({ requestToken: 'tok-2' });
    })(),
  );

  it('a failed evaluation reply rejects recoverably instead of resolving to nothing', () =>
    withMockWorker(async (client, deliver) => {
      const req = request('tok-1');
      const pending = client.requestScenarioEvaluation(req);
      deliver(reply(req, { evaluation: null, error: { code: 'SCENARIO_EVALUATION_FAILED', message: 'boom' } }));
      await expect(pending).rejects.toMatchObject({ code: 'SCENARIO_EVALUATION_FAILED' });
    })(),
  );

  it('a worker failure rejects every pending draft evaluation', () =>
    withMockWorker(async (client, _deliver, fail) => {
      const draft = client.requestScenarioEvaluation(request('tok-1'));
      const saved = client.requestScenarioEvaluation(request('tok-2', { scenarioId: '019ffe00-0000-7000-8000-0000000000e1' }));
      fail();
      await expect(draft).rejects.toMatchObject({ code: 'SCENARIO_WORKER_ERROR' });
      await expect(saved).rejects.toMatchObject({ code: 'SCENARIO_WORKER_ERROR' });
    })(),
  );

  // Review L7: an error while the worker's script is loading is terminal for
  // that worker. It is torn down and a fresh worker is created, so a retry can
  // recover; and a reply that never arrives still settles recoverably instead
  // of hanging forever.
  it('a retry after a terminal worker failure settles (recreated worker can answer)', () =>
    withMockWorker(async (client, deliver, fail) => {
      const first = client.requestScenarioEvaluation(request('tok-1'));
      fail();
      await expect(first).rejects.toMatchObject({ code: 'SCENARIO_WORKER_ERROR' });
      // The client recreated its worker; a retry reaches the new instance and
      // resolves rather than posting into a dead worker.
      const retry = request('tok-2');
      const retryPending = client.requestScenarioEvaluation(retry);
      deliver(reply(retry));
      await expect(retryPending).resolves.toMatchObject({ requestToken: 'tok-2' });
    })(),
  );

  it('a scenario evaluation whose reply never arrives settles as a timeout', async () => {
    const realWindow = (globalThis as { window?: unknown }).window;
    const realWorker = (globalThis as { Worker?: unknown }).Worker;
    (globalThis as { window?: unknown }).window = globalThis;
    class SilentWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    (globalThis as { Worker?: unknown }).Worker = SilentWorker as unknown as typeof Worker;
    try {
      const client = new AnalysisWorkerClient({ scenarioTimeoutMs: 20 });
      await expect(client.requestScenarioEvaluation(request('tok-hang'))).rejects.toMatchObject({
        code: 'SCENARIO_EVALUATION_TIMEOUT',
      });
      client.terminate();
    } finally {
      if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = realWindow;
      if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else (globalThis as { Worker?: unknown }).Worker = realWorker;
    }
  });

  it('the engine replies with an error envelope when evaluation throws, echoing every identity', async () => {
    const engine = new AnalysisEngine();
    const req = request('tok-1', { scenario: { baseline: null } as unknown as PersistedForecastScenario });
    const response = await engine.evaluateScenario(req);
    expect(response).toMatchObject({
      type: 'ScenarioEvaluationResult',
      projectId: PROJECT_ID,
      scenarioId: DRAFT,
      requestToken: 'tok-1',
      baselineRevision: 5,
      policyVersion: 'staffed-capacity-v1',
      evaluation: null,
      error: { code: 'SCENARIO_EVALUATION_FAILED' },
    });
  });
});

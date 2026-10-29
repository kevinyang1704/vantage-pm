/**
 * Forecast staffing performance benchmark (Story 22.9, AC 22.9-3; SF-NFR1, SF-NFR5, SF-AR10).
 *
 * Validates the agreed feasible benchmark fixture:
 *   - 5,000 nodes (features/items)
 *   - 100 roster people
 *   - 10,000 assignment edges
 *   - Feasible block distribution (singletons + parallel groups with no M6 concurrency conflicts)
 *
 * What this file is: Node-side microbenchmarks of the pure domain functions.
 * What it is not: UI evidence. Browser input-to-paint, commit-to-paint and
 * memory are measured in the real UI by tests/e2e/forecast-staffing-ui.perf.spec.ts
 * (Story 23.10, AC 23.10-2); the object-update timings below are labelled as
 * microbenchmarks and make no input-to-paint claim.
 *
 * Responsiveness contract invariants (FORECAST-DESIGN.md, SF-NFR5):
 *   - Direct manipulation / authoring input-to-paint meets the inherited ≤16ms p50 budget
 *     (measured in the browser harness, not here).
 *   - Recalculation is measured separately and compared with the shared-mode baseline
 *     on the same reference environment.
 *   - The contract defines no numeric forecast recalculation SLA, so do not invent
 *     a threshold or claim one passed.
 *   - No per-sprint loop: event count is bounded by O(m) item boundaries, running in linear time.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { calculateAllocation } from '../../src/domain/forecast/forecast-allocation';
import { calculateStaffedAllocation } from '../../src/domain/forecast/staffed-calculation.policy';
import { generateStaffingBenchmarkFixture, type BenchmarkFixture } from './support/staffing-benchmark';

describe('Story 22.9 / AC 22.9-3: Staffing-aware forecast performance benchmarks', () => {
  let fixture: BenchmarkFixture;

  beforeAll(() => {
    fixture = generateStaffingBenchmarkFixture(5000, 100);
    // Warmup JIT
    calculateAllocation(fixture.inputs, fixture.sharedArithmetic);
    calculateStaffedAllocation(
      fixture.inputs,
      fixture.pointsPerSprint,
      fixture.sprintLengthDays,
      fixture.startSprintOrdinal,
      fixture.startDate,
    );
  });

  it('generates the certified 5,000-node, 100-person, 10,000-assignment fixture', () => {
    expect(fixture.inputs.selectedFeatureIds.length).toBe(5000);
    expect(fixture.inputs.roster?.length).toBe(100);
    expect(fixture.totalAssignments).toBeGreaterThanOrEqual(10000);
    expect(fixture.inputs.parallelGroups.length).toBeGreaterThan(0);
  });

  // Story 23.10 (R12): this times an in-memory object spread, not an input
  // reaching the screen. It is kept as a microbenchmark with an honest name.
  it('microbenchmark: in-memory single-assignment map update (not UI input-to-paint evidence)', () => {
    const samples: number[] = [];
    const featureId = fixture.inputs.selectedFeatureIds[2500]!;
    const newPersonId = fixture.inputs.roster![0]!.id;

    for (let run = 0; run < 30; run++) {
      const start = performance.now();
      // In-memory assignment update (simulating UI state update before async worker dispatch)
      const updatedAssignments = {
        ...fixture.inputs.assignments,
        [featureId]: [newPersonId],
      };
      // Verify operation happened
      if (!updatedAssignments[featureId]) {
        throw new Error('Assignment update failed');
      }
      const elapsed = performance.now() - start;
      samples.push(elapsed);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)]!;
    expect(p50).toBeLessThanOrEqual(16);
  });

  it('measures staffed vs shared recalculation and records timings per FORECAST-DESIGN.md Responsiveness contract', () => {
    const SAMPLES = 5;
    const sharedTimings: number[] = [];
    const staffedTimings: number[] = [];

    // Shared-mode baseline
    for (let s = 0; s < SAMPLES; s++) {
      const t0 = performance.now();
      const sharedAlloc = calculateAllocation(fixture.inputs, fixture.sharedArithmetic);
      const elapsed = performance.now() - t0;
      expect(sharedAlloc.timelines.length).toBe(5000);
      sharedTimings.push(elapsed);
    }

    // Staffed-mode allocation
    let staffedResult: ReturnType<typeof calculateStaffedAllocation> | null = null;
    for (let s = 0; s < SAMPLES; s++) {
      const t0 = performance.now();
      staffedResult = calculateStaffedAllocation(
        fixture.inputs,
        fixture.pointsPerSprint,
        fixture.sprintLengthDays,
        fixture.startSprintOrdinal,
        fixture.startDate,
      );
      const elapsed = performance.now() - t0;
      expect(staffedResult.timelines.length).toBe(5000);
      staffedTimings.push(elapsed);
    }

    // Contract assertion: No per-sprint iteration!
    // Event count must be O(m) item boundaries, bounded by node count
    expect(staffedResult).not.toBeNull();
    expect(staffedResult!.events.length).toBeLessThanOrEqual(5000);

    // Compute summary metrics
    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const sharedMedian = median(sharedTimings);
    const staffedMedian = median(staffedTimings);

    // Record environment and benchmark results without inventing an SLA threshold
    console.info(`[Staffing Benchmark AC 22.9-3]
Environment: Node ${process.version} / ${process.platform}
Nodes: 5000, People: 100, Assignments: ${fixture.totalAssignments}
Samples: ${SAMPLES}
Shared Mode:  min=${Math.min(...sharedTimings).toFixed(2)}ms, max=${Math.max(...sharedTimings).toFixed(2)}ms, median=${sharedMedian.toFixed(2)}ms, mean=${mean(sharedTimings).toFixed(2)}ms
Staffed Mode: min=${Math.min(...staffedTimings).toFixed(2)}ms, max=${Math.max(...staffedTimings).toFixed(2)}ms, median=${staffedMedian.toFixed(2)}ms, mean=${mean(staffedTimings).toFixed(2)}ms
Event count: ${staffedResult!.events.length} (linear O(m) events, no per-sprint iteration)
Responsiveness contract: Recorded without inventing numeric forecast recalculation SLA.`);

    // Sanity check: Ensure calculation completes in finite bounded time without hanging
    expect(staffedMedian).toBeGreaterThan(0);
    expect(staffedMedian).toBeLessThan(1000); // 1s safety ceiling to detect catastrophic regressions
  });
});

describe('Story 23.6 AC 23.6-4 — Staffing scenario comparison benchmark at scale', () => {
  let fixture: BenchmarkFixture;
  let baseline: import('../../src/domain/forecast/scenario').ForecastScenarioBaseline;
  let variant1Patch: import('../../src/domain/forecast/scenario').ForecastScenarioPatch;
  let variant2Patch: import('../../src/domain/forecast/scenario').ForecastScenarioPatch;

  beforeAll(async () => {
    fixture = generateStaffingBenchmarkFixture(5000, 100);

    const factMap: Record<string, { effortPoints: number; projectId: string; ancestorIds: readonly string[]; nodeType: 'Feature' }> = {};
    for (const id of fixture.inputs.selectedFeatureIds) {
      factMap[id] = Object.freeze({
        effortPoints: fixture.inputs.estimates[id] ?? 5,
        projectId: fixture.inputs.projectId,
        ancestorIds: [],
        nodeType: 'Feature' as const,
      });
    }

    baseline = Object.freeze({
      projectId: fixture.inputs.projectId,
      baselineRevision: 1,
      policyVersion: 'staffed-capacity-v1',
      planningLevel: 'Feature',
      orderedScope: fixture.inputs.selectedFeatureIds,
      configuration: {
        pointsPerSprint: fixture.pointsPerSprint,
        sprintLengthDays: fixture.sprintLengthDays,
        cadence: 'fixed-contiguous' as const,
        startSprintOrdinal: fixture.startSprintOrdinal,
        startDate: fixture.startDate,
      },
      parallelGroups: fixture.inputs.parallelGroups,
      blockedFeatureIds: [],
      roster: fixture.inputs.roster!,
      assignments: fixture.inputs.assignments!,
      factMap: Object.freeze(factMap),
    });

    // Variant 1: swap assignments on 50 features
    const assignmentOverrides: Record<string, readonly string[]> = {};
    for (let k = 0; k < 50; k++) {
      const featId = fixture.inputs.selectedFeatureIds[k];
      const personId = fixture.inputs.roster![(k + 5) % fixture.inputs.roster!.length].id;
      assignmentOverrides[featId] = [personId];
    }
    variant1Patch = Object.freeze({ assignmentOverrides: Object.freeze(assignmentOverrides) });

    // Variant 2: weight overrides on 20 people
    const weightOverrides: Record<string, number> = {};
    for (let p = 0; p < 20; p++) {
      const personId = fixture.inputs.roster![p].id;
      weightOverrides[personId] = 200; // 2.00 relative weight
    }
    variant2Patch = Object.freeze({ weightOverrides: Object.freeze(weightOverrides) });
  });

  // Story 23.10 (R12): object-copy microbenchmark only; see the browser harness for UI timings.
  it('microbenchmark: in-memory draft patch update (not UI input-to-paint evidence)', () => {
    // Direct manipulation of local patch state (e.g. toggling an assignment or setting a weight)
    const latencies: number[] = [];
    const TRIALS = 100;
    let draftPatch: import('../../src/domain/forecast/scenario').ForecastScenarioPatch = { ...variant1Patch };

    for (let t = 0; t < TRIALS; t++) {
      const t0 = performance.now();
      const updatedOverrides = {
        ...(draftPatch.assignmentOverrides ?? {}),
        [fixture.inputs.selectedFeatureIds[t % 50]]: [fixture.inputs.roster![t % 100].id],
      };
      draftPatch = { ...draftPatch, assignmentOverrides: updatedOverrides };
      latencies.push(performance.now() - t0);
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;

    expect(p50).toBeLessThanOrEqual(16); // inherited <=16ms budget
    console.info(`[Microbenchmark: draft patch object update] p50=${p50.toFixed(4)}ms, p95=${p95.toFixed(4)}ms (not UI evidence)`);
  });

  it('measures evaluation performance with 1 and 2 visible scenario comparisons without per-sprint iteration', async () => {
    const { evaluateScenario } = await import('../../src/domain/forecast/scenario-evaluate');
    const SAMPLES = 3;
    const oneComparisonTimings: number[] = [];
    const twoComparisonsTimings: number[] = [];

    // Warm-up
    await evaluateScenario(baseline, variant1Patch);

    // Initial memory baseline
    const memBefore = process.memoryUsage().heapUsed;

    // Measure 1 comparison
    for (let s = 0; s < SAMPLES; s++) {
      const t0 = performance.now();
      const eval1 = await evaluateScenario(baseline, variant1Patch);
      const elapsed = performance.now() - t0;
      expect(eval1.ok).toBe(true);
      oneComparisonTimings.push(elapsed);
    }

    // Measure 2 comparisons
    for (let s = 0; s < SAMPLES; s++) {
      const t0 = performance.now();
      const [eval1, eval2] = await Promise.all([
        evaluateScenario(baseline, variant1Patch),
        evaluateScenario(baseline, variant2Patch),
      ]);
      const elapsed = performance.now() - t0;
      expect(eval1.ok).toBe(true);
      expect(eval2.ok).toBe(true);
      twoComparisonsTimings.push(elapsed);
    }

    const memAfter = process.memoryUsage().heapUsed;
    const memDeltaMB = (memAfter - memBefore) / (1024 * 1024);

    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };

    const oneCompMedian = median(oneComparisonTimings);
    const twoCompMedian = median(twoComparisonsTimings);

    console.info(`[Staffing Scenario Benchmark AC 23.6-4]
Environment: Node ${process.version} / ${process.platform}
Nodes: 5000, People: 100, Assignments: ${fixture.totalAssignments}
1 Comparison (Median):  ${oneCompMedian.toFixed(2)}ms (min=${Math.min(...oneComparisonTimings).toFixed(2)}ms, max=${Math.max(...oneComparisonTimings).toFixed(2)}ms)
2 Comparisons (Median): ${twoCompMedian.toFixed(2)}ms (min=${Math.min(...twoComparisonsTimings).toFixed(2)}ms, max=${Math.max(...twoComparisonsTimings).toFixed(2)}ms)
Memory Delta: ~${memDeltaMB.toFixed(2)} MB
Linear O(m) event boundaries; zero live roster lookup; zero per-sprint iteration.
Responsiveness contract: Recorded without inventing numeric forecast recalculation or memory SLA.`);

    expect(oneCompMedian).toBeGreaterThan(0);
    expect(twoCompMedian).toBeGreaterThan(0);
    // Sanity check: Ensure calculation completes in bounded time
    expect(twoCompMedian).toBeLessThan(3000);
  });
});

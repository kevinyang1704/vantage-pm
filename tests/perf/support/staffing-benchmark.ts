/**
 * The feasible staffing benchmark fixture (Story 22.9 AC 22.9-3; Story 23.10
 * AC 23.10-2/-3) and its portable-file form for real-browser measurement.
 *
 * Distribution (unchanged from Story 22.9): 5,000 selected Feature items, 100
 * people of weight 1.00, one parallel group of three items every 25 items
 * (two distinct people per member, no concurrency conflict), a 0-point
 * milestone every 100 items, two people on every other item, then a third
 * person on ungrouped items until 10,000 assignment edges exist.
 *
 * `buildBenchmarkPortableFile` turns that fixture into an importable
 * portable project (schema 8 staffed, or schema 6 shared so the pre-staffing
 * build 9af96a2 can import the identical bytes), with 0-2 saved scenarios
 * whose baseline fingerprints are computed by the production functions the
 * importer re-checks.
 */

import type { ForecastPerson } from '../../../src/domain/forecast/forecast-plan.entity';
import type { ForecastInputs, ForecastArithmetic } from '../../../src/domain/forecast/forecast-result';
import { forecastMaterialFacts } from '../../../src/domain/forecast/whole-set.policy';
import { computeForecastFingerprintSync } from '../../../src/domain/forecast/forecast-canonical';

export interface BenchmarkFixture {
  readonly inputs: ForecastInputs;
  readonly sharedArithmetic: ForecastArithmetic;
  readonly pointsPerSprint: number;
  readonly sprintLengthDays: number;
  readonly startSprintOrdinal: number;
  readonly startDate: string;
  readonly totalAssignments: number;
}

export function generateStaffingBenchmarkFixture(nodeCount = 5000, personCount = 100): BenchmarkFixture {
  const roster: ForecastPerson[] = [];
  for (let i = 0; i < personCount; i++) {
    roster.push({
      id: `019ffe00-0001-7000-8000-${i.toString(16).padStart(12, '0')}`,
      name: `Engineer ${i}`,
      weightUnits: 100, // 1.00 relative weight
    });
  }

  const selectedFeatureIds: string[] = [];
  const estimates: Record<string, number> = {};
  const assignments: Record<string, string[]> = {};
  const parallelGroups: { featureIds: string[] }[] = [];

  let i = 0;
  let personCursor = 0;
  let totalAssignments = 0;

  while (i < nodeCount) {
    // Every 25 items, form a parallel group of 3 features
    if (i % 25 === 0 && i + 3 <= nodeCount) {
      const groupIds: string[] = [];
      for (let g = 0; g < 3; g++) {
        const id = `019ffe00-0002-7000-8000-${(i + g).toString(16).padStart(12, '0')}`;
        groupIds.push(id);
        selectedFeatureIds.push(id);
        estimates[id] = 8 + g * 4; // 8, 12, 16 points
        // Assign 2 distinct people per feature in the group (6 distinct people total)
        const p1 = roster[personCursor++ % personCount]!.id;
        const p2 = roster[personCursor++ % personCount]!.id;
        assignments[id] = [p1, p2];
        totalAssignments += 2;
      }
      parallelGroups.push({ featureIds: groupIds });
      i += 3;
    } else {
      const id = `019ffe00-0002-7000-8000-${i.toString(16).padStart(12, '0')}`;
      selectedFeatureIds.push(id);
      // Mostly 10-point features, occasional 0-point milestone
      if (i % 100 === 0) {
        estimates[id] = 0; // milestone
        assignments[id] = [];
      } else {
        estimates[id] = 10;
        const p1 = roster[personCursor++ % personCount]!.id;
        const p2 = roster[personCursor++ % personCount]!.id;
        assignments[id] = [p1, p2];
        totalAssignments += 2;
      }
      i++;
    }
  }

  // If milestones left us slightly under 10,000, add assignments to reach exactly >= 10,000
  // by assigning a 3rd person to non-grouped items
  let fillIdx = 0;
  while (totalAssignments < 10000 && fillIdx < selectedFeatureIds.length) {
    const id = selectedFeatureIds[fillIdx]!;
    if (estimates[id]! > 0 && assignments[id]!.length === 2) {
      const thirdPerson = roster[personCursor++ % personCount]!.id;
      if (!assignments[id]!.includes(thirdPerson)) {
        assignments[id]!.push(thirdPerson);
        totalAssignments++;
      }
    }
    fillIdx++;
  }

  const pointsPerSprint = 100;
  const sprintLengthDays = 14;
  const startSprintOrdinal = 1;
  const startDate = '2026-10-01';

  const inputs: ForecastInputs = {
    projectId: '019ffe00-0000-7000-8000-000000000001',
    projectRevision: 1,
    policyVersion: 'staffed-capacity-v1',
    selectedFeatureIds: Object.freeze(selectedFeatureIds),
    estimates: Object.freeze(estimates),
    pointsPerSprint,
    sprintLengthDays,
    startSprintOrdinal,
    startDate,
    parallelGroups: Object.freeze(parallelGroups.map((g) => ({ featureIds: Object.freeze(g.featureIds) }))),
    blockedFeatureIds: Object.freeze([]),
    roster: Object.freeze(roster),
    assignments: Object.freeze(assignments),
  };

  const totalPoints = Object.values(estimates).reduce((sum, pts) => sum + (pts ?? 0), 0);
  const sharedArithmetic: ForecastArithmetic = {
    totalPoints,
    pointsPerSprint,
    requiredSprints: { numerator: 50, denominator: 1 },
    occupiedSprints: 50,
    completionSprint: 50,
    completionDate: '2028-09-01',
    sprintLengthDays,
    startSprintOrdinal,
    startDate,
  };

  return { inputs, sharedArithmetic, pointsPerSprint, sprintLengthDays, startSprintOrdinal, startDate, totalAssignments };
}

export type BenchmarkMode = 'staffed' | 'shared';

/** Fixed, distinct project identity per (mode, scenario count) so fixtures never collide on import. */
export function benchmarkProjectId(mode: BenchmarkMode, scenarioCount: number): string {
  return `019ffe00-00f${mode === 'staffed' ? 'a' : 'b'}-7000-8000-00000000000${scenarioCount}`;
}

export function benchmarkProjectName(mode: BenchmarkMode, scenarioCount: number): string {
  return `Bench ${mode} ${scenarioCount}`;
}

/** The two explicit variants: staffing levers when staffed, shared levers otherwise. */
function variantPatches(fixture: BenchmarkFixture, mode: BenchmarkMode): readonly Record<string, unknown>[] {
  const ids = fixture.inputs.selectedFeatureIds;
  const roster = fixture.inputs.roster!;
  if (mode === 'staffed') {
    // Variant 1: one person on each of 50 items. Variant 2: 20 people at weight 2.00.
    const assignmentOverrides: Record<string, readonly string[]> = {};
    for (let k = 0; k < 50; k++) assignmentOverrides[ids[k]!] = [roster[(k + 5) % roster.length]!.id];
    const weightOverrides: Record<string, number> = {};
    for (let p = 0; p < 20; p++) weightOverrides[roster[p]!.id] = 200;
    return [{ assignmentOverrides }, { weightOverrides }];
  }
  // Variant 1: capacity 120. Variant 2: 50 point overrides.
  const pointOverrides: Record<string, number> = {};
  for (let k = 1; k <= 50; k++) pointOverrides[ids[k]!] = 20;
  return [{ pointsPerSprint: 120 }, { pointOverrides }];
}

/**
 * An importable portable project for the fixture. Staffed files use schema 8;
 * shared files use schema 6 so the pre-staffing build can import them too.
 */
export function buildBenchmarkPortableFile(mode: BenchmarkMode, scenarioCount: 0 | 1 | 2): string {
  const fixture = generateStaffingBenchmarkFixture();
  const projectId = benchmarkProjectId(mode, scenarioCount);
  const ids = fixture.inputs.selectedFeatureIds;
  const staffed = mode === 'staffed';
  const policyVersion = staffed ? 'staffed-capacity-v1' : 'shared-capacity-v1';

  const nodes = ids.map((id, index) => ({
    id,
    parentId: null,
    title: `Item ${index + 1}`,
    bodyText: null,
    position: String((index + 1) * 1000),
    nodeType: 'Feature',
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: fixture.inputs.estimates[id] ?? null,
    strategicWeight: null,
    phaseId: null,
  }));

  const configuration = {
    pointsPerSprint: fixture.pointsPerSprint,
    sprintLengthDays: fixture.sprintLengthDays,
    cadence: 'fixed-contiguous' as const,
    startSprintOrdinal: fixture.startSprintOrdinal,
    startDate: fixture.startDate,
  };
  const parallelGroups = fixture.inputs.parallelGroups.map((g) => ({ featureIds: [...g.featureIds] }));
  const roster = fixture.inputs.roster!.map((p) => ({ ...p }));
  const assignments = Object.fromEntries(Object.entries(fixture.inputs.assignments!).map(([k, v]) => [k, [...v]]));

  const forecastPlan = {
    selectedFeatureIds: [...ids],
    parallelGroups,
    blockedFeatureIds: [],
    ...configuration,
    policyVersion,
    planningLevel: 'Feature',
    ...(staffed ? { roster, assignments } : {}),
  };

  const factMap = Object.fromEntries(
    ids.map((id) => [id, { effortPoints: fixture.inputs.estimates[id] ?? null, nodeType: 'Feature', projectId, ancestorIds: [] }]),
  );
  const baselineRevision = 1;
  const baselineFingerprint = computeForecastFingerprintSync(
    forecastMaterialFacts({
      projectId,
      projectRevision: baselineRevision,
      policyVersion,
      selectedFeatureIds: ids,
      estimates: fixture.inputs.estimates,
      pointsPerSprint: configuration.pointsPerSprint,
      sprintLengthDays: configuration.sprintLengthDays,
      startSprintOrdinal: configuration.startSprintOrdinal,
      startDate: configuration.startDate,
      parallelGroups: fixture.inputs.parallelGroups,
      blockedFeatureIds: [],
      ...(staffed ? { roster: fixture.inputs.roster, assignments: fixture.inputs.assignments } : {}),
    } as ForecastInputs),
  );

  const forecastScenarios = variantPatches(fixture, mode)
    .slice(0, scenarioCount)
    .map((patch, k) => ({
      scenarioId: `019ffe00-00${staffed ? 'ea' : 'eb'}-7000-8000-0000000000${scenarioCount}${k}`,
      label: `Variant ${k + 1}`,
      baselineRevision,
      baselineFingerprint,
      policyVersion,
      createdAtISO: '2026-09-25T00:00:00.000Z',
      baseline: {
        planningLevel: 'Feature',
        orderedScope: [...ids],
        configuration,
        parallelGroups,
        blockedFeatureIds: [],
        factMap,
        ...(staffed ? { roster, assignments } : {}),
      },
      patch,
    }));

  return JSON.stringify({
    schemaVersion: staffed ? 8 : 6,
    exportedAt: '2026-09-25T00:00:00.000Z',
    project: { id: projectId, name: benchmarkProjectName(mode, scenarioCount) },
    phases: [],
    nodes,
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    forecastPlan,
    ...(scenarioCount > 0 ? { forecastScenarios } : {}),
  });
}

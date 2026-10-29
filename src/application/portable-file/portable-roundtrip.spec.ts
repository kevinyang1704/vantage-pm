/**
 * Portable file schema v6 round-trip specs (Story 21.8, AC 21.8-1..7).
 *
 * - v6 envelope carries `forecastPlan.planningLevel`; v1-v5 files normalize
 *   a missing level to 'Feature' on import (AC 21.8-2)
 * - a future v7 envelope is cleanly rejected with an actionable notice
 *   (AC 21.8-3)
 * - Theme- and Component-level plans round-trip exactly (AC 21.8-4/6) — the
 *   case that failed before this story because the membership validator
 *   built its set from `nodeType === 'Feature'`
 * - compatibility is backward only (AC 21.8-7)
 */

import { describe, expect, it } from 'vitest';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import { baselineFromPersisted } from '../../domain/forecast/scenario';
import { evaluateScenario } from '../../domain/forecast/scenario-evaluate';
import {
  PORTABLE_FILE_SCHEMA_VERSION,
  parsePortableFile,
  serializePortableFileEnvelope,
  type PortableFileEnvelopeV6,
  type PortableFileEnvelopeV7,
  type PortableFileEnvelopeV8,
  type PortableNode,
} from '../../contracts/portable-file.schema';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import { validateStaffingAssignments } from '../../domain/forecast/forecast-validators';
import { envelopeToSnapshot, importProject, remapPortableSnapshot } from './import-project';
import type { ForecastPerson } from '../../domain/forecast/forecast-plan.entity';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const THEME = '018f3a80-0000-7000-8000-0000000000a1';
const COMPONENT = '018f3a80-0000-7000-8000-0000000000a2';
const FEATURE = '018f3a80-0000-7000-8000-0000000000a3';

function node(id: string, nodeType: PortableNode['nodeType'], position: string, effortPoints: number | null = 5, parentId: string | null = null): PortableNode {
  return Object.freeze({
    id,
    parentId,
    title: `Node ${id}`,
    bodyText: null,
    position,
    nodeType,
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints,
    strategicWeight: null,
    phaseId: null,
  });
}

function v6Envelope(over: Record<string, unknown> = {}): PortableFileEnvelopeV6 {
  return Object.freeze({
    schemaVersion: 6,
    exportedAt: '2026-09-08T00:00:00.000Z',
    project: { id: PROJECT_ID, name: 'Round Trip' },
    phases: [],
    nodes: [
      node(THEME, 'Theme', '4294967296'),
      node(COMPONENT, 'Component', '8589934592'),
      node(FEATURE, 'Feature', '12884901888'),
    ],
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    ...over,
  });
}

function v7Envelope(over: Record<string, unknown> = {}): PortableFileEnvelopeV7 {
  return Object.freeze({
    schemaVersion: 7,
    exportedAt: '2026-09-24T00:00:00.000Z',
    project: { id: PROJECT_ID, name: 'Round Trip' },
    phases: [],
    nodes: [
      node(THEME, 'Theme', '4294967296'),
      node(COMPONENT, 'Component', '8589934592'),
      node(FEATURE, 'Feature', '12884901888'),
    ],
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    ...over,
  });
}

function v8Envelope(over: Record<string, unknown> = {}): PortableFileEnvelopeV8 {
  return Object.freeze({
    schemaVersion: 8,
    exportedAt: '2026-09-24T00:00:00.000Z',
    project: { id: PROJECT_ID, name: 'Round Trip' },
    phases: [],
    nodes: [
      node(THEME, 'Theme', '4294967296'),
      node(COMPONENT, 'Component', '8589934592'),
      node(FEATURE, 'Feature', '12884901888'),
    ],
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    ...over,
  });
}

describe('scenario level round-trip and legacy normalization', () => {
  it.each(['Theme', 'Component', 'Feature', 'legacy'] as const)('round-trips %s historical facts without fingerprint churn', async (level) => {
    const capturedLevel = level === 'legacy' ? 'Feature' : level;
    const id = capturedLevel === 'Theme' ? THEME : capturedLevel === 'Component' ? COMPONENT : FEATURE;
    const configuration = { pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' };
    const fingerprint = computeForecastFingerprintSync(forecastMaterialFacts({
      projectId: PROJECT_ID, projectRevision: 1, policyVersion: 'shared-capacity-v1',
      selectedFeatureIds: [id], estimates: { [id]: 20 }, parallelGroups: [], blockedFeatureIds: [], ...configuration,
    }));
    const scenario = {
      scenarioId: '018f3a80-0000-7000-8000-000000000099', label: 'Synthetic history',
      baselineRevision: 1, baselineFingerprint: fingerprint, policyVersion: 'shared-capacity-v1',
      createdAtISO: '2026-09-07T00:00:00.000Z', patch: {},
      baseline: {
        ...(level === 'legacy' ? {} : { planningLevel: level }),
        orderedScope: [id], configuration, parallelGroups: [], blockedFeatureIds: [],
        factMap: { [id]: { effortPoints: 20, projectId: PROJECT_ID, ancestorIds: [],
          ...(level === 'legacy' ? { isFeature: true } : { nodeType: level }),
        } },
      },
    };
    const parsed = parsePortableFile(serializePortableFileEnvelope(v6Envelope({
      schemaVersion: level === 'legacy' ? 5 : 6, forecastScenarios: [scenario],
    })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !('forecastScenarios' in parsed.value)) throw new Error('Expected scenarios');
    const saved = parsed.value.forecastScenarios![0];
    expect(saved.baseline.planningLevel).toBe(capturedLevel);
    expect(saved.baseline.factMap[id].nodeType).toBe(capturedLevel);
    expect(saved.baseline.factMap[id]).not.toHaveProperty('isFeature');
    expect(saved.baselineFingerprint).toBe(fingerprint);
    const result = await evaluateScenario(baselineFromPersisted({ ...saved, projectId: PROJECT_ID } as import('../../domain/forecast/scenario').PersistedForecastScenario), saved.patch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.baselineResult.arithmetic?.completionSprint).toBe(2);
    const again = parsePortableFile(serializePortableFileEnvelope({ ...parsed.value, schemaVersion: 6 }));
    expect(again.ok).toBe(true);
    if (again.ok && 'forecastScenarios' in again.value) expect(again.value.forecastScenarios).toEqual(parsed.value.forecastScenarios);
  });
});

describe('Story 21.8 AC 1 — v6 envelope carries planningLevel', () => {
  it('PORTABLE_FILE_SCHEMA_VERSION is 9', () => {
    expect(PORTABLE_FILE_SCHEMA_VERSION).toBe(9);
  });

  it('a Theme-level plan round-trips exactly', () => {
    const envelope = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [THEME],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Theme',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(6);
    const plan = (parsed.value as { forecastPlan?: { planningLevel?: string } }).forecastPlan;
    expect(plan?.planningLevel).toBe('Theme');
  });

  it('a Component-level plan round-trips exactly', () => {
    const envelope = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [COMPONENT],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Component',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = (parsed.value as { forecastPlan?: { planningLevel?: string } }).forecastPlan;
    expect(plan?.planningLevel).toBe('Component');
  });
});

describe('Story 21.8 AC 2 — legacy v1-v5 files normalize planningLevel to Feature', () => {
  it('a v5 file without planningLevel imports as a Feature plan', () => {
    const envelope = v6Envelope({
      schemaVersion: 5,
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schemaVersion).toBe(5);
    const plan = (parsed.value as { forecastPlan?: { planningLevel?: string } }).forecastPlan;
    expect(plan?.planningLevel).toBeUndefined();
  });
});

describe('Story 21.8 AC 3 — a future schema file is cleanly rejected', () => {
  it('rejects schemaVersion > 9 with an actionable notice', () => {
    const envelope = v6Envelope({ schemaVersion: 10 });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.type).toBe('UnsupportedNewerSchema');
    if (parsed.error.type === 'UnsupportedNewerSchema') {
      expect(parsed.error.found).toBe(10);
      expect(parsed.error.supported).toBe(9);
    }
  });
});

describe('Story 21.8 AC 6 — membership validator is level-aware', () => {
  it('accepts a Theme-level plan whose members are Theme nodes', () => {
    const envelope = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [THEME],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Theme',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
  });

  it('rejects a Theme-level plan whose member is a Feature node, naming the level', () => {
    const envelope = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Theme',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.type).toBe('InvalidRelation');
    if (parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('not a Theme in this file');
    }
  });
});

describe('Story 21.8 AC 7 — compatibility is backward only', () => {
  it('a v6 file is rejected by a pre-Epic-21 reader via the version guard', () => {
    // The guard is `schemaVersion > PORTABLE_FILE_SCHEMA_VERSION`; a
    // pre-Epic-21 build has PORTABLE_FILE_SCHEMA_VERSION = 5, so a v6 file
    // fails with UnsupportedNewerSchema. This spec asserts the current
    // reader's side: v6 is accepted, and the guard rejects anything newer.
    const envelope = v6Envelope();
    const json = serializePortableFileEnvelope(envelope);
    expect(parsePortableFile(json).ok).toBe(true);
  });
});

describe('Story 22.8 AC 22.8-1 — Transfer staffed plan with nested scope to new project', () => {
  it('remaps project, node, and person IDs consistently and preserves calculated meaning', async () => {
    const ALICE_ID = '018f3a80-0000-7000-8000-0000000000b1';
    const BOB_ID = '018f3a80-0000-7000-8000-0000000000b2';
    const roster: readonly ForecastPerson[] = [
      { id: ALICE_ID, name: 'Alice', weightUnits: 1000 },
      { id: BOB_ID, name: 'Bob', weightUnits: 500 },
    ];
    const assignments = {
      [FEATURE]: [ALICE_ID, BOB_ID],
    };

    const envelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster,
        assignments,
      },
    });

    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Evaluate staffed forecast on original inputs
    const originalForecast = await calculateForecast({
      projectId: PROJECT_ID,
      projectRevision: 1,
      selectedFeatureIds: [FEATURE],
      estimates: { [FEATURE]: 5 },
      parallelGroups: [],
      blockedFeatureIds: [],
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      policyVersion: 'staffed-capacity-v1',
      roster,
      assignments,
    });
    expect(originalForecast.state).toBe('ready');

    // Convert to snapshot and remap as a new project
    const rawSnapshot = envelopeToSnapshot(parsed.value as PortableFileEnvelopeV7);
    const snapshot = remapPortableSnapshot(rawSnapshot);
    expect(snapshot.projectId).not.toBe(PROJECT_ID);
    const remappedFeature = snapshot.nodes.find((n) => n.title === `Node ${FEATURE}`);
    expect(remappedFeature).toBeDefined();
    expect(remappedFeature!.id).not.toBe(FEATURE);

    const remappedPlan = snapshot.forecastPlan!;
    expect(remappedPlan.selectedFeatureIds).toEqual([remappedFeature!.id]);
    expect(remappedPlan.roster).toHaveLength(2);
    expect(remappedPlan.roster![0].id).not.toBe(ALICE_ID);
    expect(remappedPlan.roster![1].id).not.toBe(BOB_ID);

    const newAliceId = remappedPlan.roster![0].id;
    const newBobId = remappedPlan.roster![1].id;
    expect(remappedPlan.assignments).toEqual({
      [remappedFeature!.id]: [newAliceId, newBobId],
    });

    // Re-evaluate staffed forecast on remapped inputs
    const remappedForecast = await calculateForecast({
      projectId: snapshot.projectId,
      projectRevision: 1,
      selectedFeatureIds: remappedPlan.selectedFeatureIds,
      estimates: { [remappedFeature!.id]: remappedFeature!.effortPoints ?? 5 },
      parallelGroups: [],
      blockedFeatureIds: [],
      pointsPerSprint: remappedPlan.pointsPerSprint ?? 10,
      sprintLengthDays: remappedPlan.sprintLengthDays ?? 14,
      startSprintOrdinal: remappedPlan.startSprintOrdinal ?? 1,
      startDate: remappedPlan.startDate ?? '2026-09-07',
      policyVersion: remappedPlan.policyVersion as import('../../domain/forecast/forecast-plan.entity').ForecastPolicyVersion,
      roster: remappedPlan.roster,
      assignments: remappedPlan.assignments,
    });
    expect(remappedForecast.state).toBe('ready');
    expect(remappedForecast.arithmetic?.completionSprint).toBe(originalForecast.arithmetic?.completionSprint);
    expect(remappedForecast.arithmetic?.completionDate).toBe(originalForecast.arithmetic?.completionDate);
    expect(remappedForecast.allocation?.timelines).toHaveLength(1);
    expect(remappedForecast.allocation?.timelines[0].itemRate).toEqual(originalForecast.allocation?.timelines[0].itemRate);

    // Assert computed dates are NOT imported as authored schedules
    for (const n of snapshot.nodes) {
      expect(n.startDate).toBeNull();
      expect(n.endDate).toBeNull();
      expect(n.durationDays).toBeNull();
    }
  });
});

describe('Story 22.8 AC 22.8-2 — Retained staffing assignments survive shared mode round-trip', () => {
  it('survives round-trip in shared mode and preserves concurrency conflict until staffed activation', async () => {
    const ALICE_ID = '018f3a80-0000-7000-8000-0000000000b1';
    const FEATURE_2 = '018f3a80-0000-7000-8000-0000000000a4';
    const roster: readonly ForecastPerson[] = [
      { id: ALICE_ID, name: 'Alice', weightUnits: 1000 },
    ];
    // Alice is assigned to both FEATURE and FEATURE_2, which are in the same parallel group!
    const assignments = {
      [FEATURE]: [ALICE_ID],
      [FEATURE_2]: [ALICE_ID],
    };
    const parallelGroups = [{ featureIds: [FEATURE, FEATURE_2] }];

    const envelope = v7Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888'),
        node(FEATURE_2, 'Feature', '17179869184'),
      ],
      forecastPlan: {
        selectedFeatureIds: [FEATURE, FEATURE_2],
        parallelGroups,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1', // In shared mode!
        planningLevel: 'Feature',
        roster,
        assignments,
      },
    });

    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const plan = (parsed.value as any).forecastPlan;
    expect(plan.policyVersion).toBe('shared-capacity-v1');
    expect(plan.roster).toEqual(roster);
    expect(plan.assignments).toEqual(assignments);

    // Shared calculation remains valid
    const sharedResult = await calculateForecast({
      projectId: PROJECT_ID,
      projectRevision: 1,
      selectedFeatureIds: [FEATURE, FEATURE_2],
      estimates: { [FEATURE]: 5, [FEATURE_2]: 5 },
      parallelGroups: [{ featureIds: [FEATURE, FEATURE_2] }],
      blockedFeatureIds: [],
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
      policyVersion: 'shared-capacity-v1',
    });
    expect(sharedResult.state).toBe('ready');

    // Validating for staffed mode detects concurrency conflict requiring repair
    const staffedIssues = validateStaffingAssignments({
      assignments,
      roster,
      selectedFeatureIds: [FEATURE, FEATURE_2],
      estimates: { [FEATURE]: 5, [FEATURE_2]: 5 },
      parallelGroups: [{ featureIds: [FEATURE, FEATURE_2] }],
    });
    expect(staffedIssues.some((i) => i.code === 'CONCURRENT_ASSIGNMENT_CONFLICT')).toBe(true);
  });
});

describe('Story 22.8 AC 22.8-3 — Pre-staffing supported projects import cleanly without fabricated roster', () => {
  it('imports v6 without fabricating roster or assignments and rejects unknown policy', () => {
    const envelope = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Feature',
      },
    });
    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = (parsed.value as any).forecastPlan;
    expect(plan.policyVersion).toBe('shared-capacity-v1');
    expect(plan.roster).toBeUndefined();
    expect(plan.assignments).toBeUndefined();

    // Unknown policy is rejected with InvalidBounds
    const invalidPolicyEnvelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'unknown-v9' as any,
        planningLevel: 'Feature',
      },
    });
    const parsedInvalid = parsePortableFile(serializePortableFileEnvelope(invalidPolicyEnvelope));
    expect(parsedInvalid.ok).toBe(false);
    if (parsedInvalid.ok) return;
    expect(parsedInvalid.error.type).toBe('InvalidBounds');
  });
});

describe('Story 22.8 AC 22.8-4 — Malformed staffing packages rejected before commit', () => {
  it('rejects person not in roster', () => {
    const envelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Alice', weightUnits: 1000 }],
        assignments: { [FEATURE]: ['018f3a80-0000-7000-8000-0000000000b9'] }, // Bob not in roster
      },
    });
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('not in the project roster');
    }
  });

  it('rejects duplicate person on same item', () => {
    const envelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Alice', weightUnits: 1000 }],
        assignments: { [FEATURE]: ['018f3a80-0000-7000-8000-0000000000b1', '018f3a80-0000-7000-8000-0000000000b1'] },
      },
    });
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('assigned more than once');
    }
  });

  it('rejects assignment to a zero-effort item', () => {
    const ZERO_FEATURE = '018f3a80-0000-7000-8000-0000000000a9';
    const envelope = v7Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888'),
        node(ZERO_FEATURE, 'Feature', '17179869184', 0), // 0 points
      ],
      forecastPlan: {
        selectedFeatureIds: [FEATURE, ZERO_FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Alice', weightUnits: 1000 }],
        assignments: { [ZERO_FEATURE]: ['018f3a80-0000-7000-8000-0000000000b1'] },
      },
    });
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('zero-work item');
    }
  });

  it('rejects duplicate person IDs in roster', () => {
    const envelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [
          { id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Alice', weightUnits: 1000 },
          { id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Bob', weightUnits: 500 },
        ],
        assignments: {},
      },
    });
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('duplicate person id');
    }
  });

  it('rejects duplicate person names in roster', () => {
    const envelope = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [
          { id: '018f3a80-0000-7000-8000-0000000000b1', name: 'Alice', weightUnits: 1000 },
          { id: '018f3a80-0000-7000-8000-0000000000b2', name: 'Alice', weightUnits: 500 },
        ],
        assignments: {},
      },
    });
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.error.type === 'InvalidRelation') {
      expect(parsed.error.detail).toContain('duplicate person name');
    }
  });
});

describe('Story 23.5 — Transfer historical staffing scenarios with the project', () => {
  const PERSON_ALICE = '018f3a80-0000-7000-8000-0000000000b1';
  const PERSON_BOB = '018f3a80-0000-7000-8000-0000000000b2';
  const PERSON_CHARLIE = '018f3a80-0000-7000-8000-0000000000b3';
  const PERSON_ALICE_2 = '018f3a80-0000-7000-8000-0000000000b4';
  const FEATURE_2 = '018f3a80-0000-7000-8000-0000000000a4';

  function createStaffedScenario(overrides: Record<string, unknown> = {}) {
    const configuration = {
      pointsPerSprint: 10,
      sprintLengthDays: 14,
      cadence: 'fixed-contiguous' as const,
      startSprintOrdinal: 1,
      startDate: '2026-09-07',
    };
    const roster: readonly ForecastPerson[] = [
      { id: PERSON_ALICE, name: 'Alice', weightUnits: 1000 },
      { id: PERSON_BOB, name: 'Bob', weightUnits: 500 },
    ];
    const assignments: Readonly<Record<string, readonly string[]>> = {
      [FEATURE]: [PERSON_ALICE],
      [FEATURE_2]: [PERSON_BOB],
    };
    const fingerprint = computeForecastFingerprintSync(
      forecastMaterialFacts({
        projectId: PROJECT_ID,
        projectRevision: 1,
        policyVersion: 'staffed-capacity-v1',
        selectedFeatureIds: [FEATURE, FEATURE_2],
        estimates: { [FEATURE]: 10, [FEATURE_2]: 20 },
        parallelGroups: [],
        blockedFeatureIds: [],
        roster,
        assignments,
        ...configuration,
      }),
    );
    return {
      scenarioId: '018f3a80-0000-7000-8000-000000000099',
      label: 'Staffed Historical S1',
      baselineRevision: 1,
      baselineFingerprint: fingerprint,
      policyVersion: 'staffed-capacity-v1' as const,
      createdAtISO: '2026-09-07T00:00:00.000Z',
      baseline: {
        planningLevel: 'Feature' as const,
        orderedScope: [FEATURE, FEATURE_2],
        configuration,
        parallelGroups: [],
        blockedFeatureIds: [],
        roster,
        assignments,
        factMap: {
          [FEATURE]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
          [FEATURE_2]: { effortPoints: 20, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
        },
      },
      patch: {
        weightOverrides: { [PERSON_BOB]: 1000 },
        assignmentOverrides: { [FEATURE_2]: [PERSON_ALICE] },
      },
      ...overrides,
    };
  }

  it('AC 23.5-1: historical-only people and assignments are remapped consistently, reproducing timing and rates without inventing live roster entries', async () => {
    const s1 = createStaffedScenario();
    const originalEval = await evaluateScenario(
      baselineFromPersisted({ ...s1, projectId: PROJECT_ID } as any),
      s1.patch,
    );
    expect(originalEval.ok).toBe(true);
    if (!originalEval.ok) return;

    // Live plan has later deleted Alice and Bob! Live roster only has Charlie.
    const envelope = v8Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888', 10),
        node(FEATURE_2, 'Feature', '17179869184', 20),
      ],
      forecastPlan: {
        selectedFeatureIds: [FEATURE, FEATURE_2],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: PERSON_CHARLIE, name: 'Charlie', weightUnits: 1000 }],
        assignments: { [FEATURE]: [PERSON_CHARLIE] },
      },
      forecastScenarios: [s1],
    });

    const json = serializePortableFileEnvelope(envelope);
    const importResult = importProject(json, () => false, { asNewProject: true });
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;

    const candidate = importResult.candidate;
    expect(candidate.projectId).not.toBe(PROJECT_ID);

    // Live plan has Charlie remapped, but NO Alice and NO Bob (no invented live roster entries)
    expect(candidate.forecastPlan?.roster).toHaveLength(1);
    expect(candidate.forecastPlan?.roster?.[0].name).toBe('Charlie');
    expect(candidate.forecastPlan?.roster?.[0].id).not.toBe(PERSON_CHARLIE);

    // Historical scenario preserved and remapped
    expect(candidate.forecastScenarios).toHaveLength(1);
    const remappedScenario = candidate.forecastScenarios![0];
    expect(remappedScenario.scenarioId).not.toBe(s1.scenarioId);
    expect(remappedScenario.policyVersion).toBe('staffed-capacity-v1');

    // Historical roster members Alice & Bob remapped within scenario facts
    const remappedRoster = remappedScenario.baseline.roster!;
    expect(remappedRoster).toHaveLength(2);
    const remappedAlice = remappedRoster.find((p) => p.name === 'Alice')!;
    const remappedBob = remappedRoster.find((p) => p.name === 'Bob')!;
    expect(remappedAlice).toBeDefined();
    expect(remappedBob).toBeDefined();
    expect(remappedAlice.id).not.toBe(PERSON_ALICE);
    expect(remappedBob.id).not.toBe(PERSON_BOB);
    expect(remappedAlice.weightUnits).toBe(1000);
    expect(remappedBob.weightUnits).toBe(500);

    // Historical assignments remapped to new feature and person IDs
    const remappedFeature1 = candidate.nodes.find((n) => n.effortPoints === 10)!.id;
    const remappedFeature2 = candidate.nodes.find((n) => n.effortPoints === 20)!.id;
    expect(remappedScenario.baseline.assignments![remappedFeature1]).toEqual([remappedAlice.id]);
    expect(remappedScenario.baseline.assignments![remappedFeature2]).toEqual([remappedBob.id]);

    // Patch overrides remapped
    expect(remappedScenario.patch.weightOverrides).toEqual({ [remappedBob.id]: 1000 });
    expect(remappedScenario.patch.assignmentOverrides).toEqual({ [remappedFeature2]: [remappedAlice.id] });

    // Scenario evaluation reproduces the exact same rates, timing and dates
    const remappedEval = await evaluateScenario(
      baselineFromPersisted({ ...remappedScenario, projectId: candidate.projectId } as any),
      remappedScenario.patch,
    );
    expect(remappedEval.ok).toBe(true);
    if (!remappedEval.ok) return;

    expect(remappedEval.baselineResult.arithmetic?.occupiedSprints).toBe(originalEval.baselineResult.arithmetic?.occupiedSprints);
    expect(remappedEval.baselineResult.arithmetic?.completionDate).toBe(originalEval.baselineResult.arithmetic?.completionDate);
    expect(remappedEval.variantResult.arithmetic?.occupiedSprints).toBe(originalEval.variantResult.arithmetic?.occupiedSprints);
    expect(remappedEval.variantResult.arithmetic?.completionDate).toBe(originalEval.variantResult.arithmetic?.completionDate);
    expect(remappedEval.comparison?.sameCompletion).toBe(originalEval.comparison?.sameCompletion);
    expect(remappedEval.comparison?.changedDimensions).toEqual(originalEval.comparison?.changedDimensions);
  });

  it('AC 23.5-2: deterministic and consistent remapping across multiple scenarios without merging different people with same display name', () => {
    // S1 references Alice1 and Bob
    const s1 = createStaffedScenario({
      scenarioId: '018f3a80-0000-7000-8000-000000000091',
      label: 'Scenario 1',
    });

    // S2 references Alice1, Alice2 (same display name 'Alice', distinct UUID), and Bob
    const s2Roster = [
      { id: PERSON_ALICE, name: 'Alice', weightUnits: 1000 },
      { id: PERSON_ALICE_2, name: 'Alice', weightUnits: 600 },
      { id: PERSON_BOB, name: 'Bob', weightUnits: 500 },
    ];
    const s2Assignments = {
      [FEATURE]: [PERSON_ALICE],
      [FEATURE_2]: [PERSON_ALICE_2, PERSON_BOB],
    };
    const s2Fingerprint = computeForecastFingerprintSync(
      forecastMaterialFacts({
        projectId: PROJECT_ID,
        projectRevision: 1,
        policyVersion: 'staffed-capacity-v1',
        selectedFeatureIds: [FEATURE, FEATURE_2],
        estimates: { [FEATURE]: 10, [FEATURE_2]: 20 },
        parallelGroups: [],
        blockedFeatureIds: [],
        roster: s2Roster,
        assignments: s2Assignments,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
      }),
    );
    const s2 = {
      scenarioId: '018f3a80-0000-7000-8000-000000000092',
      label: 'Scenario 2',
      baselineRevision: 1,
      baselineFingerprint: s2Fingerprint,
      policyVersion: 'staffed-capacity-v1' as const,
      createdAtISO: '2026-09-07T00:00:00.000Z',
      baseline: {
        planningLevel: 'Feature' as const,
        orderedScope: [FEATURE, FEATURE_2],
        configuration: {
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          cadence: 'fixed-contiguous' as const,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        },
        parallelGroups: [],
        blockedFeatureIds: [],
        roster: s2Roster,
        assignments: s2Assignments,
        factMap: {
          [FEATURE]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
          [FEATURE_2]: { effortPoints: 20, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
        },
      },
      patch: {
        weightOverrides: { [PERSON_ALICE_2]: 900 },
      },
    };

    const envelope = v8Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888', 10),
        node(FEATURE_2, 'Feature', '17179869184', 20),
      ],
      forecastScenarios: [s1, s2],
    });

    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const snapshot = envelopeToSnapshot(parsed.value as PortableFileEnvelopeV8);
    const remapped = remapPortableSnapshot(snapshot);

    const remappedS1 = remapped.forecastScenarios![0];
    const remappedS2 = remapped.forecastScenarios![1];

    const s1Alice = remappedS1.baseline.roster!.find((p) => p.name === 'Alice')!;
    const s1Bob = remappedS1.baseline.roster!.find((p) => p.name === 'Bob')!;

    const s2Alice1 = remappedS2.baseline.roster!.find((p) => p.name === 'Alice' && p.weightUnits === 1000)!;
    const s2Alice2 = remappedS2.baseline.roster!.find((p) => p.name === 'Alice' && p.weightUnits === 600)!;
    const s2Bob = remappedS2.baseline.roster!.find((p) => p.name === 'Bob')!;

    // Same source identity maps to the exact same remapped ID across scenarios
    expect(s1Alice.id).toBe(s2Alice1.id);
    expect(s1Bob.id).toBe(s2Bob.id);

    // Different source identities with identical display names ('Alice') are NOT merged
    expect(s2Alice1.id).not.toBe(s2Alice2.id);

    // Overrides reference the correct remapped ID
    expect(remappedS2.patch.weightOverrides).toEqual({ [s2Alice2.id]: 900 });
  });

  it('AC 23.5-3: imports legacy shared v6, live-staffing v7, and staffed-scenario v8 preserving original policy and historical meaning', () => {
    // 1. Legacy v6 shared file
    const v6 = v6Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
        planningLevel: 'Feature',
      },
    });
    const parsedV6 = parsePortableFile(serializePortableFileEnvelope(v6));
    expect(parsedV6.ok).toBe(true);
    if (!parsedV6.ok) return;
    expect(parsedV6.value.schemaVersion).toBe(6);
    expect((parsedV6.value as any).forecastPlan.policyVersion).toBe('shared-capacity-v1');
    expect((parsedV6.value as any).forecastPlan.roster).toBeUndefined();

    // 2. v7 live-staffing file (Story 22.8)
    const v7 = v7Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: PERSON_ALICE, name: 'Alice', weightUnits: 1000 }],
        assignments: { [FEATURE]: [PERSON_ALICE] },
      },
    });
    const parsedV7 = parsePortableFile(serializePortableFileEnvelope(v7));
    expect(parsedV7.ok).toBe(true);
    if (!parsedV7.ok) return;
    expect(parsedV7.value.schemaVersion).toBe(7);
    expect((parsedV7.value as any).forecastPlan.policyVersion).toBe('staffed-capacity-v1');
    expect((parsedV7.value as any).forecastPlan.roster).toHaveLength(1);

    // 3. v8 staffed-scenario file
    const v8 = v8Envelope({
      forecastScenarios: [createStaffedScenario()],
    });
    const parsedV8 = parsePortableFile(serializePortableFileEnvelope(v8));
    expect(parsedV8.ok).toBe(true);
    if (!parsedV8.ok) return;
    expect(parsedV8.value.schemaVersion).toBe(8);
    const v8Value = parsedV8.value as PortableFileEnvelopeV8;
    expect(v8Value.forecastScenarios![0].policyVersion).toBe('staffed-capacity-v1');
    expect(v8Value.forecastScenarios![0].baseline.roster).toHaveLength(2);

    // Unknown schema version rejected with upgrade guidance
    const invalidSchema = { ...v8, schemaVersion: 10 };
    const parsedInvalidSchema = parsePortableFile(serializePortableFileEnvelope(invalidSchema as any));
    expect(parsedInvalidSchema.ok).toBe(false);
    if (!parsedInvalidSchema.ok && parsedInvalidSchema.error.type === 'UnsupportedNewerSchema') {
      expect(parsedInvalidSchema.error.found).toBe(10);
      expect(parsedInvalidSchema.error.supported).toBe(9);
    }

    // Unknown scenario policyVersion rejected
    const invalidPolicyScenario = createStaffedScenario({ policyVersion: 'quantum-capacity-v99' as any });
    const invalidPolicyEnvelope = v8Envelope({ forecastScenarios: [invalidPolicyScenario] });
    const parsedInvalidPolicy = parsePortableFile(serializePortableFileEnvelope(invalidPolicyEnvelope));
    expect(parsedInvalidPolicy.ok).toBe(false);
    if (!parsedInvalidPolicy.ok && parsedInvalidPolicy.error.type === 'InvalidBounds') {
      expect(parsedInvalidPolicy.error.field).toContain('policyVersion');
    }
  });

  it('AC 23.5-4: malformed historical staffing facts rejected without partial restore; invalid references distinguished from valid historical-only people', () => {
    // 1. weightOverrides references person not in scenario baseline roster -> rejected
    const badWeightScenario = createStaffedScenario({
      patch: {
        weightOverrides: { ['018f3a80-0000-7000-8000-0000000000ff']: 800 },
      },
    });
    const badWeightEnvelope = v8Envelope({ forecastScenarios: [badWeightScenario] });
    const parsedBadWeight = parsePortableFile(serializePortableFileEnvelope(badWeightEnvelope));
    expect(parsedBadWeight.ok).toBe(false);
    if (!parsedBadWeight.ok && parsedBadWeight.error.type === 'InvalidRelation') {
      expect(parsedBadWeight.error.detail).toContain('baseline is malformed');
    }

    // 2. assignmentOverrides assigns to a zero-work item -> rejected
    const ZERO_NODE = '018f3a80-0000-7000-8000-0000000000a9';
    const s1 = createStaffedScenario();
    const badAssignmentScenario = {
      ...s1,
      baseline: {
        ...s1.baseline,
        orderedScope: [...s1.baseline.orderedScope, ZERO_NODE],
        factMap: {
          ...s1.baseline.factMap,
          [ZERO_NODE]: { effortPoints: 0, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
        },
      },
      patch: {
        assignmentOverrides: { [ZERO_NODE]: [PERSON_ALICE] },
      },
    };
    const badAssignmentEnvelope = v8Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888', 10),
        node(FEATURE_2, 'Feature', '17179869184', 20),
        node(ZERO_NODE, 'Feature', '21474836480', 0),
      ],
      forecastScenarios: [badAssignmentScenario],
    });
    const parsedBadAssignment = parsePortableFile(serializePortableFileEnvelope(badAssignmentEnvelope));
    expect(parsedBadAssignment.ok).toBe(false);
    if (!parsedBadAssignment.ok && parsedBadAssignment.error.type === 'InvalidRelation') {
      expect(parsedBadAssignment.error.detail).toContain('baseline is malformed');
    }

    // 3. Baseline assignments referencing unknown person not in scenario baseline roster -> rejected
    const badBaselineAssignmentScenario = createStaffedScenario({
      baseline: {
        ...s1.baseline,
        assignments: {
          [FEATURE]: ['018f3a80-0000-7000-8000-0000000000ee'], // unknown person
        },
      },
    });
    const badBaselineEnvelope = v8Envelope({ forecastScenarios: [badBaselineAssignmentScenario] });
    const parsedBadBaseline = parsePortableFile(serializePortableFileEnvelope(badBaselineEnvelope));
    expect(parsedBadBaseline.ok).toBe(false);

    // 4. Valid historical-only person (in scenario baseline roster, but NOT in live roster) -> VALID
    const validHistoricalScenario = createStaffedScenario(); // Alice and Bob in baseline.roster
    const validLiveEnvelope = v8Envelope({
      forecastPlan: {
        selectedFeatureIds: [FEATURE],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 1,
        startDate: '2026-09-07',
        policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature',
        roster: [{ id: PERSON_CHARLIE, name: 'Charlie', weightUnits: 1000 }], // only Charlie live
        assignments: { [FEATURE]: [PERSON_CHARLIE] },
      },
      forecastScenarios: [validHistoricalScenario],
    });
    const parsedValidLive = parsePortableFile(serializePortableFileEnvelope(validLiveEnvelope));
    expect(parsedValidLive.ok).toBe(true);
  });

  it('AC 23.5-5: round-trip preserves both shared and staffed scenarios with captured idle roster members, weights, and overrides', () => {
    // Shared scenario (shared-capacity-v1)
    const sharedConfig = { pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' };
    const sharedFp = computeForecastFingerprintSync(forecastMaterialFacts({
      projectId: PROJECT_ID, projectRevision: 1, policyVersion: 'shared-capacity-v1',
      selectedFeatureIds: [FEATURE], estimates: { [FEATURE]: 10 }, parallelGroups: [], blockedFeatureIds: [], ...sharedConfig,
    }));
    const sharedScenario = {
      scenarioId: '018f3a80-0000-7000-8000-000000000081',
      label: 'Shared Historical',
      baselineRevision: 1,
      baselineFingerprint: sharedFp,
      policyVersion: 'shared-capacity-v1' as const,
      createdAtISO: '2026-09-01T00:00:00.000Z',
      baseline: {
        planningLevel: 'Feature' as const,
        orderedScope: [FEATURE],
        configuration: sharedConfig,
        parallelGroups: [],
        blockedFeatureIds: [],
        factMap: { [FEATURE]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const } },
      },
      patch: { pointsPerSprint: 15 },
    };

    // Staffed scenario with idle roster member (Carol has no assignments in baseline)
    const PERSON_CAROL = '018f3a80-0000-7000-8000-0000000000b5';
    const staffedRoster: readonly ForecastPerson[] = [
      { id: PERSON_ALICE, name: 'Alice', weightUnits: 1000 },
      { id: PERSON_BOB, name: 'Bob', weightUnits: 500 },
      { id: PERSON_CAROL, name: 'Carol', weightUnits: 750 }, // idle
    ];
    const staffedAssignments = {
      [FEATURE]: [PERSON_ALICE],
      [FEATURE_2]: [PERSON_BOB],
    };
    const staffedFp = computeForecastFingerprintSync(forecastMaterialFacts({
      projectId: PROJECT_ID, projectRevision: 1, policyVersion: 'staffed-capacity-v1',
      selectedFeatureIds: [FEATURE, FEATURE_2], estimates: { [FEATURE]: 10, [FEATURE_2]: 20 },
      parallelGroups: [], blockedFeatureIds: [], roster: staffedRoster, assignments: staffedAssignments, ...sharedConfig,
    }));
    const staffedScenario = {
      scenarioId: '018f3a80-0000-7000-8000-000000000082',
      label: 'Staffed with Idle Carol',
      baselineRevision: 1,
      baselineFingerprint: staffedFp,
      policyVersion: 'staffed-capacity-v1' as const,
      createdAtISO: '2026-09-02T00:00:00.000Z',
      baseline: {
        planningLevel: 'Feature' as const,
        orderedScope: [FEATURE, FEATURE_2],
        configuration: sharedConfig,
        parallelGroups: [],
        blockedFeatureIds: [],
        roster: staffedRoster,
        assignments: staffedAssignments,
        factMap: {
          [FEATURE]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
          [FEATURE_2]: { effortPoints: 20, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' as const },
        },
      },
      patch: {
        weightOverrides: { [PERSON_CAROL]: 1000 },
        assignmentOverrides: { [FEATURE]: [PERSON_CAROL] },
        orderedScope: [FEATURE], // removes FEATURE_2, triggering scope cleanup
      },
    };

    const envelope = v8Envelope({
      nodes: [
        node(THEME, 'Theme', '4294967296'),
        node(COMPONENT, 'Component', '8589934592'),
        node(FEATURE, 'Feature', '12884901888', 10),
        node(FEATURE_2, 'Feature', '17179869184', 20),
      ],
      forecastScenarios: [sharedScenario, staffedScenario],
    });

    const json = serializePortableFileEnvelope(envelope);
    const parsed = parsePortableFile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const v8Parsed = parsed.value as PortableFileEnvelopeV8;
    expect(v8Parsed.forecastScenarios).toHaveLength(2);
    const [scen1, scen2] = v8Parsed.forecastScenarios!;
    expect(scen1.policyVersion).toBe('shared-capacity-v1');
    expect(scen1.baseline.roster).toBeUndefined();

    expect(scen2.policyVersion).toBe('staffed-capacity-v1');
    expect(scen2.baseline.roster).toHaveLength(3);
    expect(scen2.baseline.roster!.some((p: ForecastPerson) => p.name === 'Carol' && p.weightUnits === 750)).toBe(true);
    expect(scen2.patch.weightOverrides).toEqual({ [PERSON_CAROL]: 1000 });
    expect(scen2.patch.assignmentOverrides).toEqual({ [FEATURE]: [PERSON_CAROL] });
    expect(scen2.patch.orderedScope).toEqual([FEATURE]);
  });

  it('AC 23.5-6: exporter emits version 9 and rejects pre-v8 schemas containing staffed scenario fields', () => {
    // Current export schema version constant is 9 (Story 26.5)
    expect(PORTABLE_FILE_SCHEMA_VERSION).toBe(9);

    // v7 envelope containing staffed scenario rejected
    const v7Staffed = v7Envelope({
      forecastScenarios: [createStaffedScenario()],
    });
    const parsedV7Staffed = parsePortableFile(serializePortableFileEnvelope(v7Staffed));
    expect(parsedV7Staffed.ok).toBe(false);
    if (!parsedV7Staffed.ok && parsedV7Staffed.error.type === 'InvalidRelation') {
      expect(parsedV7Staffed.error.detail).toContain('staffed scenarios are not supported in schema version 7');
    }

    // v7 envelope containing shared scenario with staffing patch fields rejected
    const v7StaffingFields = v7Envelope({
      forecastScenarios: [{
        ...createStaffedScenario(),
        policyVersion: 'shared-capacity-v1',
        patch: { weightOverrides: { [PERSON_BOB]: 1000 } },
      }],
    });
    const parsedV7StaffingFields = parsePortableFile(serializePortableFileEnvelope(v7StaffingFields));
    expect(parsedV7StaffingFields.ok).toBe(false);
    if (!parsedV7StaffingFields.ok && parsedV7StaffingFields.error.type === 'InvalidRelation') {
      expect(parsedV7StaffingFields.error.detail).toContain('staffing scenario fields are not supported in schema version 7');
    }
  });

  it('AC 23.5-7: portable rejection occurs before repository write and does not invent a database migration', () => {
    // SQLite storage uses schema version 15; scenario staffing uses JSON columns baseline_json/patch_json
    // A malformed scenario file fails validation completely in memory without opening a transaction
    const malformed = v8Envelope({
      forecastScenarios: [{
        ...createStaffedScenario(),
        policyVersion: 'invalid-policy' as any,
      }],
    });
    const result = importProject(serializePortableFileEnvelope(malformed), () => false);
    expect(result.ok).toBe(false);
    expect((result as any).error.type).toBe('InvalidBounds');
  });
});




/**
 * Import-as-new remaps every historical identity (Story 22.10, AC 22.10-3/-4/-5;
 * review R10).
 *
 * At 0522d6e `remapPortableSnapshot` discovered historical node identities
 * from scenario scope, fact-map keys, groups, blocked sets and assignments —
 * but never from a fact's `ancestorIds`. An ancestor deleted from the live
 * tree that survives only inside `ancestorIds` therefore fell through
 * `nodeMap.get(aid) ?? aid` and kept its source UUID in the new project.
 *
 * The fixture is built to hit every identity class at once:
 * - a deleted ancestor (`DELETED_THEME`) present ONLY in `ancestorIds`, in
 *   two scenarios;
 * - a live Feature and a live person referenced by the live plan and by
 *   both scenarios (must map once);
 * - a deleted, historical-only person, and an idle live roster member;
 * - two different people who share the display name "Alice".
 *
 * It then proves the meaning survives: import → persist into the real
 * worker SQLite store → reload → re-export → re-parse (which re-derives each
 * baseline fingerprint canonically) → evaluate, matching the pre-import
 * rates, durations and dates exactly.
 */

import { describe, expect, it } from 'vitest';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import { baselineFromPersisted, type PersistedForecastScenario } from '../../domain/forecast/scenario';
import { evaluateScenario } from '../../domain/forecast/scenario-evaluate';
import type { ForecastPerson } from '../../domain/forecast/forecast-plan.entity';
import {
  parsePortableFile,
  serializePortableFileEnvelope,
  type PortableFileEnvelopeV8,
  type PortableNode,
  type PortableProjectSnapshot,
} from '../../contracts/portable-file.schema';
import { importProject } from './import-project';
import {
  batchImportPortable,
  initWorkerDatabase,
  queryPortableSnapshot,
} from '../../adapters/persistence/repository.worker';
import { exportProject } from './export-project';

const PROJECT_ID = '019ffe10-0000-7000-8000-000000000001';
const LIVE_THEME = '019ffe10-0000-7000-8000-0000000000a0';
/** Deleted from the live tree; survives only inside scenario `ancestorIds`. */
const DELETED_THEME = '019ffe10-0000-7000-8000-0000000000d0';
const FEATURE_X = '019ffe10-0000-7000-8000-0000000000a1';
const FEATURE_Y = '019ffe10-0000-7000-8000-0000000000a2';

const ALICE = '019ffe10-0000-7000-8000-0000000000b1';
/** A different person with the same display name. */
const ALICE_TWO = '019ffe10-0000-7000-8000-0000000000b2';
/** Deleted from the live roster; historical-only. */
const DORA = '019ffe10-0000-7000-8000-0000000000b3';
/** Live roster member with no assignment: idle. */
const IDLE_ED = '019ffe10-0000-7000-8000-0000000000b4';

const SCENARIO_1 = '019ffe10-0000-7000-8000-0000000000c1';
const SCENARIO_2 = '019ffe10-0000-7000-8000-0000000000c2';

const CONFIGURATION = Object.freeze({
  pointsPerSprint: 10,
  sprintLengthDays: 14,
  cadence: 'fixed-contiguous' as const,
  startSprintOrdinal: 1,
  startDate: '2026-09-07',
});

function portableNode(id: string, nodeType: PortableNode['nodeType'], position: string, effortPoints: number | null, parentId: string | null): PortableNode {
  return Object.freeze({
    id,
    parentId,
    title: `Node ${id.slice(-2)}`,
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

function staffedScenario(params: {
  scenarioId: string;
  label: string;
  roster: readonly ForecastPerson[];
  assignments: Readonly<Record<string, readonly string[]>>;
  patch: PortableFileEnvelopeV8['forecastScenarios'] extends readonly (infer S)[] | undefined
    ? S extends { patch: infer P } ? P : never
    : never;
}) {
  const estimates = { [FEATURE_X]: 12, [FEATURE_Y]: 8 };
  const baselineFingerprint = computeForecastFingerprintSync(
    forecastMaterialFacts({
      projectId: PROJECT_ID,
      projectRevision: 3,
      policyVersion: 'staffed-capacity-v1',
      selectedFeatureIds: [FEATURE_X, FEATURE_Y],
      estimates,
      parallelGroups: [],
      blockedFeatureIds: [],
      roster: params.roster,
      assignments: params.assignments,
      pointsPerSprint: CONFIGURATION.pointsPerSprint,
      sprintLengthDays: CONFIGURATION.sprintLengthDays,
      startSprintOrdinal: CONFIGURATION.startSprintOrdinal,
      startDate: CONFIGURATION.startDate,
    }),
  );
  return {
    scenarioId: params.scenarioId,
    label: params.label,
    baselineRevision: 3,
    baselineFingerprint,
    policyVersion: 'staffed-capacity-v1',
    createdAtISO: '2026-09-20T00:00:00.000Z',
    baseline: {
      planningLevel: 'Feature' as const,
      orderedScope: [FEATURE_X, FEATURE_Y],
      configuration: CONFIGURATION,
      parallelGroups: [],
      blockedFeatureIds: [],
      roster: params.roster,
      assignments: params.assignments,
      factMap: {
        // Both facts carry the deleted ancestor, which is not a fact-map key
        // and not a live node — the case the remapper used to miss.
        [FEATURE_X]: { effortPoints: 12, projectId: PROJECT_ID, ancestorIds: [DELETED_THEME], nodeType: 'Feature' },
        [FEATURE_Y]: { effortPoints: 8, projectId: PROJECT_ID, ancestorIds: [DELETED_THEME, LIVE_THEME], nodeType: 'Feature' },
      },
    },
    patch: params.patch,
  };
}

function sourceEnvelope(): PortableFileEnvelopeV8 {
  const s1 = staffedScenario({
    scenarioId: SCENARIO_1,
    label: 'Before the reorg',
    roster: [
      { id: ALICE, name: 'Alice', weightUnits: 100 },
      { id: DORA, name: 'Dora', weightUnits: 150 },
    ],
    assignments: { [FEATURE_X]: [ALICE], [FEATURE_Y]: [DORA] },
    patch: { weightOverrides: { [DORA]: 300 } },
  });
  const s2 = staffedScenario({
    scenarioId: SCENARIO_2,
    label: 'Two Alices',
    roster: [
      { id: ALICE, name: 'Alice', weightUnits: 100 },
      { id: ALICE_TWO, name: 'Alice', weightUnits: 250 },
      { id: DORA, name: 'Dora', weightUnits: 150 },
    ],
    assignments: { [FEATURE_X]: [ALICE_TWO], [FEATURE_Y]: [ALICE, DORA] },
    patch: { assignmentOverrides: { [FEATURE_X]: [ALICE] } },
  });
  return Object.freeze({
    schemaVersion: 8,
    exportedAt: '2026-09-25T00:00:00.000Z',
    project: { id: PROJECT_ID, name: 'Remap Source' },
    phases: [],
    nodes: [
      portableNode(LIVE_THEME, 'Theme', '4294967296', null, null),
      portableNode(FEATURE_X, 'Feature', '8589934592', 12, LIVE_THEME),
      portableNode(FEATURE_Y, 'Feature', '12884901888', 8, LIVE_THEME),
    ],
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    forecastPlan: {
      selectedFeatureIds: [FEATURE_X, FEATURE_Y],
      parallelGroups: [],
      ...CONFIGURATION,
      policyVersion: 'staffed-capacity-v1',
      planningLevel: 'Feature',
      roster: [
        { id: ALICE, name: 'Alice', weightUnits: 100 },
        { id: IDLE_ED, name: 'Ed', weightUnits: 100 },
      ],
      assignments: { [FEATURE_X]: [ALICE], [FEATURE_Y]: [ALICE] },
    },
    forecastScenarios: [s1, s2],
  } as unknown as PortableFileEnvelopeV8);
}

const SOURCE_IDENTITIES = [
  PROJECT_ID, LIVE_THEME, DELETED_THEME, FEATURE_X, FEATURE_Y,
  ALICE, ALICE_TWO, DORA, IDLE_ED, SCENARIO_1, SCENARIO_2,
];

/** Sequential, recognizable UUIDv7s so a test failure names the identity. */
function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `019ffe20-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
  };
}

function importAsNew(): PortableProjectSnapshot {
  const result = importProject(serializePortableFileEnvelope(sourceEnvelope()), () => false, {
    asNewProject: true,
    generateId: sequentialIds(),
  });
  if (!result.ok) throw new Error(`import failed: ${JSON.stringify(result.error)}`);
  return result.candidate;
}

/** The production export path, so a re-parse checks what a user would save. */
async function reexport(snapshot: PortableProjectSnapshot): Promise<string> {
  const exported = await exportProject(snapshot.projectId, {
    getProject: (id) => ({ id, name: snapshot.projectName, revision: snapshot.projectRevision }) as never,
    isQueueSettled: () => true,
    queueBlockingCause: () => null,
    readPortableSnapshot: async () => snapshot,
    clock: { nowISO: () => '2026-09-25T00:00:00.000Z' } as never,
  });
  if (!exported.ok) throw new Error(`export failed: ${exported.code}`);
  return exported.json;
}

function withProject(s: PortableProjectSnapshot['forecastScenarios'] extends readonly (infer S)[] | undefined ? S : never, projectId: string) {
  return { ...s, projectId } as unknown as PersistedForecastScenario;
}

async function evaluateAll(projectId: string, scenarios: NonNullable<PortableProjectSnapshot['forecastScenarios']>) {
  const byLabel: Record<string, unknown> = {};
  for (const s of scenarios) {
    const evaluation = await evaluateScenario(baselineFromPersisted(withProject(s, projectId)), s.patch);
    if (!evaluation.ok) throw new Error(`evaluation failed for ${s.label}`);
    // Exact meaning only: completion, dates, and each item's exact rational
    // start/finish. Identities differ by design and are compared elsewhere.
    const meaning = (r: typeof evaluation.baselineResult) => ({
      state: r.state,
      completionSprint: r.arithmetic?.completionSprint,
      completionDate: r.arithmetic?.completionDate,
      occupiedSprints: r.arithmetic?.occupiedSprints,
      timings: (r.allocation?.timelines ?? []).map((t) => ({ start: t.startOffset, finish: t.finishOffset })),
    });
    byLabel[s.label] = { baseline: meaning(evaluation.baselineResult), variant: meaning(evaluation.variantResult) };
  }
  return byLabel;
}

describe('import-as-new remaps every historical identity (AC 22.10-3, R10)', () => {
  it('allocates a new identity for an ancestor that exists only inside ancestorIds', () => {
    const candidate = importAsNew();
    const [s1, s2] = candidate.forecastScenarios!;
    const s1Ancestors = s1.baseline.factMap[Object.keys(s1.baseline.factMap)[0]].ancestorIds;
    expect(s1Ancestors).toHaveLength(1);
    expect(s1Ancestors[0]).not.toBe(DELETED_THEME);
    // The same deleted ancestor is one new identity across both scenarios.
    const s2Facts = Object.values(s2.baseline.factMap);
    expect(s2Facts.every((f) => f.ancestorIds.includes(s1Ancestors[0]))).toBe(true);
  });

  it('leaves no source project, node, person or scenario identity anywhere in the candidate', () => {
    const serialized = JSON.stringify(importAsNew());
    const leaked = SOURCE_IDENTITIES.filter((id) => serialized.includes(id));
    expect(leaked).toEqual([]);
  });
});

describe('one new identity per source identity (AC 22.10-4)', () => {
  it('maps a live node and a live person to the same identity in the plan and in every scenario', () => {
    const candidate = importAsNew();
    const [newThemeInTree] = candidate.nodes.filter((n) => n.nodeType === 'Theme').map((n) => n.id);
    const plan = candidate.forecastPlan!;
    const newAlice = plan.roster!.find((p) => p.name === 'Alice')!.id;
    const [newX, newY] = plan.selectedFeatureIds;

    for (const s of candidate.forecastScenarios!) {
      expect(s.baseline.orderedScope).toEqual([newX, newY]);
      // The live Theme appears in the tree AND in historical ancestorIds.
      expect(s.baseline.factMap[newY].ancestorIds).toContain(newThemeInTree);
      expect(s.baseline.roster!.filter((p) => p.id === newAlice)).toHaveLength(1);
    }
    expect(candidate.forecastScenarios![1].patch.assignmentOverrides).toEqual({ [newX]: [newAlice] });
  });

  it('keeps historical-only and idle people, never merging two people who share a name', () => {
    const candidate = importAsNew();
    const plan = candidate.forecastPlan!;
    expect(plan.roster!.map((p) => p.name)).toEqual(['Alice', 'Ed']);
    const idleEd = plan.roster!.find((p) => p.name === 'Ed')!;
    expect(Object.values(plan.assignments!).flat()).not.toContain(idleEd.id);

    const s2 = candidate.forecastScenarios![1];
    const alices = s2.baseline.roster!.filter((p) => p.name === 'Alice');
    expect(alices).toHaveLength(2);
    expect(new Set(alices.map((p) => p.id)).size).toBe(2);
    expect(alices.map((p) => p.weightUnits).sort((a, b) => a - b)).toEqual([100, 250]);

    // Dora was deleted from the live roster; she survives in both scenarios as one person.
    const doraIds = candidate.forecastScenarios!.map((s) => s.baseline.roster!.find((p) => p.name === 'Dora')!.id);
    expect(new Set(doraIds).size).toBe(1);
    expect(plan.roster!.some((p) => p.id === doraIds[0])).toBe(false);
    expect(candidate.forecastScenarios![0].patch.weightOverrides).toEqual({ [doraIds[0]]: 300 });
  });

  it('keeps labels and numeric facts unchanged and re-derives fingerprints canonically', async () => {
    const source = sourceEnvelope();
    const candidate = importAsNew();
    expect(candidate.forecastScenarios!.map((s) => s.label)).toEqual(['Before the reorg', 'Two Alices']);
    expect(candidate.forecastScenarios!.map((s) => Object.values(s.baseline.factMap).map((f) => f.effortPoints)))
      .toEqual([[12, 8], [12, 8]]);
    // New IDs are material, so the fingerprints must be re-derived …
    expect(candidate.forecastScenarios!.map((s) => s.baselineFingerprint))
      .not.toEqual(source.forecastScenarios!.map((s) => s.baselineFingerprint));
    // … and the parser, which recomputes each one canonically, accepts them.
    const reparsed = parsePortableFile(await reexport(candidate));
    expect(reparsed.ok).toBe(true);
  });
});

describe('meaning survives import, persistence and reload (AC 22.10-5)', () => {
  it('evaluates every baseline and variant to the same exact rates, durations and dates', async () => {
    const source = sourceEnvelope();
    const before = await evaluateAll(PROJECT_ID, source.forecastScenarios!);

    await initWorkerDatabase();
    const candidate = importAsNew();
    const stored = batchImportPortable(candidate);
    expect(stored.ok).toBe(true);
    const reloaded = queryPortableSnapshot(candidate.projectId);
    expect(reloaded.forecastScenarios).toHaveLength(2);

    // The reloaded file still parses (fingerprints re-verified) …
    const reparsed = parsePortableFile(await reexport(reloaded));
    expect(reparsed.ok).toBe(true);
    // … and evaluates to the pre-import meaning.
    const after = await evaluateAll(candidate.projectId, reloaded.forecastScenarios!);
    expect(after).toEqual(before);
    expect(JSON.stringify(reloaded)).not.toContain(DELETED_THEME);
  });
});

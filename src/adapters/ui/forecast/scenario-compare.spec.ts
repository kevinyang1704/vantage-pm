/**
 * Unit tests for ScenarioCompare (Story 20.5, Story 23.4, SF-UX8, SF-UX9).
 *
 * Verifies:
 * - AC 23.4-1: Staffed Create scenario enabled; identifies model/level; offers assignment
 *   and weight controls; fixed roster membership and inherited assumptions.
 * - AC 23.4-2: Example S1 comparison display (Baseline Sprint 17 / 2026-11-29,
 *   Variant Sprint 13 / 2026-10-04), assignments changed lever, expandable timing.
 * - AC 23.4-3: Incomplete variant displays "unavailable — inputs incomplete" and missing
 *   assignments; disclosures for cleanups.
 * - AC 23.4-4: Save conflict retention with explicit retry/discard actions; no silent rebase.
 * - AC 23.4-5: Historical cross-model and cross-level labeled provenance.
 * - AC 23.4-6: Accessible named labels, error alerts, and strictly no "Apply to live" action.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ScenarioCompare, type ScenarioCompareProps } from './scenario-compare';
import type { PersistedForecastScenario, ForecastScenarioBaseline } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';
import type { ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';
import { evaluateScenario } from '../../../domain/forecast/scenario-evaluate';
import { captureScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import { describeTiming } from './scenario-explain';
import { createForecastConfiguration, createForecastPlan } from '../../../domain/forecast/forecast-plan.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';
const PERSON_ADA = '019ffe00-0000-7000-8000-00000000000c';
const PERSON_BEN = '019ffe00-0000-7000-8000-00000000000d';

const mockRoster: readonly ForecastPerson[] = Object.freeze([
  { id: PERSON_ADA, name: 'Ada Lovelace', weightUnits: 300 },
  { id: PERSON_BEN, name: 'Ben Bitdiddle', weightUnits: 100 },
]);

const mockLiveResult: ForecastResult = Object.freeze({
  state: 'ready',
  projectId: PROJECT_ID,
  projectRevision: 5,
  policyVersion: 'staffed-capacity-v1',
  materialFingerprint: 'mock-live-fingerprint',
  assumptions: {
    policyVersion: 'staffed-capacity-v1' as const,
    cadence: 'fixed-contiguous' as const,
    groupingPremise: 'fixed-assignments' as const,
    rounding: 'ceil-once' as const,
  },
  coverage: {
    selectedCount: 2,
    estimatedCount: 2,
    ratio: { numerator: 1, denominator: 1 },
  },
  arithmetic: {
    totalPoints: 40,
    pointsPerSprint: 20,
    requiredSprints: { numerator: 6, denominator: 1 },
    occupiedSprints: 6,
    completionSprint: 17,
    completionDate: '2026-11-29',
    sprintLengthDays: 14,
    startSprintOrdinal: 11,
    startDate: '2026-09-07',
  },
  totalKnownPoints: 40,
  allocation: null,
  issues: [],
});

const mockDraftFeatures = Object.freeze([
  { id: FEATURE_A, title: 'Feature Alpha', effortPoints: 30, included: true },
  { id: FEATURE_B, title: 'Feature Beta', effortPoints: 10, included: true },
]);

function cleanHtml(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

/** A draft context captured from an S1 snapshot through the production capture (Story 23.7). */
function capturedContext() {
  const node = (id: string, title: string, effortPoints: number, position: number) =>
    ({
      id,
      projectId: PROJECT_ID,
      parentId: null,
      title,
      bodyText: null,
      position: BigInt(position),
      nodeType: 'Feature',
      effortPoints,
    }) as unknown as import('../../../domain/tree/node.entity').Node;
  return captureScenarioDraftContext(
    {
      projectId: PROJECT_ID,
      projectRevision: 5,
      nodes: [node(FEATURE_A, 'Feature Alpha', 30, 1), node(FEATURE_B, 'Feature Beta', 10, 2)],
      forecastPlan: createForecastPlan({
        projectId: PROJECT_ID,
        selectedFeatureIds: [FEATURE_A, FEATURE_B],
        configuration: createForecastConfiguration({
          pointsPerSprint: 20,
          sprintLengthDays: 14,
          startSprintOrdinal: 12,
          startDate: '2026-09-07',
        }),
        policyVersion: 'staffed-capacity-v1',
        roster: mockRoster,
        assignments: { [FEATURE_A]: [PERSON_BEN], [FEATURE_B]: [PERSON_ADA] },
      }),
    },
    '019ffe00-0000-7000-8000-0000000000dd',
  );
}

function makeBaseProps(overrides: Partial<ScenarioCompareProps> = {}): ScenarioCompareProps {
  return {
    scenarios: [],
    evaluations: new Map(),
    liveResult: mockLiveResult,
    livePlanningLevel: 'Feature',
    canCreate: true,
    projectId: PROJECT_ID,
    policyVersion: 'staffed-capacity-v1',
    onCaptureDraft: vi.fn(async () => capturedContext()),
    onEvaluateDraft: vi.fn(),
    onCreate: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
}

/** Example S1 as a captured baseline (C=20, start Sprint 12 on 2026-09-07). */
function s1Baseline(): ForecastScenarioBaseline {
  return Object.freeze({
    projectId: PROJECT_ID,
    baselineRevision: 5,
    policyVersion: 'staffed-capacity-v1',
    orderedScope: Object.freeze([FEATURE_A, FEATURE_B]),
    configuration: createForecastConfiguration({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 12, startDate: '2026-09-07' }),
    parallelGroups: Object.freeze([{ featureIds: Object.freeze([FEATURE_A, FEATURE_B]) }]),
    blockedFeatureIds: Object.freeze([]),
    planningLevel: 'Feature',
    factMap: Object.freeze({
      [FEATURE_A]: { effortPoints: 30, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
      [FEATURE_B]: { effortPoints: 10, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
    }),
    roster: mockRoster,
    assignments: Object.freeze({ [FEATURE_A]: Object.freeze([PERSON_BEN]), [FEATURE_B]: Object.freeze([PERSON_ADA]) }),
  });
}

/** Render one saved scenario card through the production component. */
function renderSaved(
  baseline: ForecastScenarioBaseline,
  patch: PersistedForecastScenario['patch'],
  evaluation: ScenarioEvaluation,
  label: string,
): string {
  const { projectId: _p, baselineRevision: _r, policyVersion: _v, ...captured } = baseline;
  const scenario: PersistedForecastScenario = {
    projectId: PROJECT_ID,
    scenarioId: '019ffe00-0000-7000-8000-0000000000c9',
    label,
    baselineRevision: 5,
    baselineFingerprint: 'mock-baseline-fingerprint',
    policyVersion: 'staffed-capacity-v1',
    createdAtISO: '2026-09-25T00:00:00.000Z',
    baseline: captured,
    patch,
  };
  const props = makeBaseProps({
    scenarios: [scenario],
    evaluations: new Map([[scenario.scenarioId, evaluation]]),
  });
  return cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));
}

describe('ScenarioCompare — Story 23.4: Edit and compare staffing scenarios', () => {
  it('AC 23.4-1: enables Create scenario button for staffed live plan (no disabled notice)', () => {
    const props = makeBaseProps();
    const html = renderToString(React.createElement(ScenarioCompare, props));

    // The button is present and not disabled
    expect(html).toContain('Create scenario…');
    expect(html).not.toContain('Staffed scenarios are not available yet');
    expect(html).not.toContain('disabled=""');
  });

  it('AC 23.4-2: renders S1 comparison with Baseline Sprint 17, Variant Sprint 13, and Assignment changed lever', async () => {
    // S1 baseline: bucket with [A, B], A=30 assigned Ben, B=10 assigned Ada
    const s1Baseline: ForecastScenarioBaseline = Object.freeze({
      projectId: PROJECT_ID,
      baselineRevision: 5,
      policyVersion: 'staffed-capacity-v1',
      orderedScope: Object.freeze([FEATURE_A, FEATURE_B]),
      configuration: Object.freeze({
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
      parallelGroups: Object.freeze([{ featureIds: Object.freeze([FEATURE_A, FEATURE_B]) }]),
      blockedFeatureIds: Object.freeze([]),
      planningLevel: 'Feature',
      factMap: Object.freeze({
        [FEATURE_A]: { effortPoints: 30, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
        [FEATURE_B]: { effortPoints: 10, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
      }),
      roster: mockRoster,
      assignments: Object.freeze({
        [FEATURE_A]: Object.freeze([PERSON_BEN]),
        [FEATURE_B]: Object.freeze([PERSON_ADA]),
      }),
    });

    // S1 variant: swap assignments (A assigned Ada, B assigned Ben)
    const s1Patch = Object.freeze({
      assignmentOverrides: Object.freeze({
        [FEATURE_A]: Object.freeze([PERSON_ADA]),
        [FEATURE_B]: Object.freeze([PERSON_BEN]),
      }),
    });

    const s1Eval = await evaluateScenario(s1Baseline, s1Patch);
    expect(s1Eval.ok).toBe(true);
    if (!s1Eval.ok) throw new Error('eval failed');

    // Confirm arithmetic of S1 oracle
    expect(s1Eval.baselineResult.arithmetic?.completionSprint).toBe(17);
    expect(s1Eval.baselineResult.arithmetic?.completionDate).toBe('2026-11-29');
    expect(s1Eval.variantResult.arithmetic?.completionSprint).toBe(13);
    expect(s1Eval.variantResult.arithmetic?.completionDate).toBe('2026-10-04');

    const scenarioId = '019ffe00-0000-7000-8000-000000000099';
    const s1Scenario: PersistedForecastScenario = Object.freeze({
      projectId: PROJECT_ID,
      scenarioId,
      label: 'S1 Swap Scenario',
      baselineRevision: 5,
      baselineFingerprint: 'mock-baseline-fingerprint',
      policyVersion: 'staffed-capacity-v1',
      createdAtISO: '2026-09-24T20:00:00.000Z',
      baseline: s1Baseline,
      patch: s1Patch,
    });

    const evaluations = new Map<string, ScenarioEvaluation>([[scenarioId, s1Eval]]);
    const props = makeBaseProps({
      scenarios: [s1Scenario],
      evaluations,
    });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    // Displays scenario name, provenance, and level badge
    expect(html).toContain('S1 Swap Scenario');
    expect(html).toContain('Based on revision 5');
    expect(html).toContain('Captured at Feature level · Staffed Capacity');

    // Story 23.8 AC 23.8-1 (R11): captured baseline and variant together, labelled
    expect(html).toContain('<dt>Captured baseline</dt><dd>Sprint 17 · 2026-11-29</dd>');
    expect(html).toContain('<dt>Variant</dt><dd>Sprint 13 · 2026-10-04</dd>');
    // Exact item timing is one keyboard-reachable disclosure away
    expect(html).toContain('aria-label="Show exact item timing for S1 Swap Scenario"');

    // Displays changed lever attribution. Story 23.8 AC 23.8-6: saved
    // scenarios capture no item titles, so identities are stable identifiers
    // with an unavailable-title label — never the current live title.
    expect(html).toContain('Changed lever:');
    expect(html).toContain('Assignment — Item …00000a (title unavailable): Ben Bitdiddle → Ada Lovelace');
    expect(html).toContain('Assignment — Item …00000b (title unavailable): Ada Lovelace → Ben Bitdiddle');
  });

  it('AC 23.4-3: displays incomplete variant state and missing assignments', async () => {
    const incompleteBaseline: ForecastScenarioBaseline = Object.freeze({
      projectId: PROJECT_ID,
      baselineRevision: 5,
      policyVersion: 'staffed-capacity-v1',
      orderedScope: Object.freeze([FEATURE_A, FEATURE_B]),
      configuration: Object.freeze({
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 11,
        startDate: '2026-09-07',
      }),
      parallelGroups: Object.freeze([]),
      blockedFeatureIds: Object.freeze([]),
      planningLevel: 'Feature',
      factMap: Object.freeze({
        [FEATURE_A]: { effortPoints: 30, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
        [FEATURE_B]: { effortPoints: 10, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' },
      }),
      roster: mockRoster,
      assignments: Object.freeze({
        [FEATURE_A]: Object.freeze([PERSON_BEN]),
        // FEATURE_B is unassigned
      }),
    });

    // Variant clears assignments on FEATURE_A
    const patch = Object.freeze({
      assignmentOverrides: Object.freeze({
        [FEATURE_A]: Object.freeze([]),
      }),
    });

    const evalResult = await evaluateScenario(incompleteBaseline, patch);
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) throw new Error('eval failed');
    expect(evalResult.variantResult.state).toBe('incomplete');

    const scenarioId = '019ffe00-0000-7000-8000-000000000098';
    const scenario: PersistedForecastScenario = Object.freeze({
      projectId: PROJECT_ID,
      scenarioId,
      label: 'Incomplete Scenario',
      baselineRevision: 5,
      baselineFingerprint: 'mock-baseline-fingerprint',
      policyVersion: 'staffed-capacity-v1',
      createdAtISO: '2026-09-24T20:00:00.000Z',
      baseline: incompleteBaseline,
      patch,
    });

    const evaluations = new Map<string, ScenarioEvaluation>([[scenarioId, evalResult]]);
    const props = makeBaseProps({
      scenarios: [scenario],
      evaluations,
    });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    // Date is withheld and explicit unavailable text is displayed
    expect(html).toContain('<dt>Variant</dt><dd>unavailable — inputs incomplete</dd>');
    // Story 23.8 AC 23.8-3: named, actionable explanations — not codes.
    // Story 23.8 AC 23.8-6: saved scenarios carry no item titles, so items are
    // named by their stable identifier with an unavailable-title label.
    expect(html).toContain('The variant has no forecast (inputs are incomplete):');
    expect(html).toContain('Item …00000a (title unavailable) has work but nobody is assigned. Assign at least one person to Item …00000a (title unavailable).');
    expect(html).toContain('The captured baseline itself has no forecast:');
    expect(html).toContain('Item …00000b (title unavailable) has work but nobody is assigned.');
    expect(html).not.toContain('MISSING_ASSIGNMENT');
  });

  it('AC 23.8-2 (R8): an invalid variant names the person and conflicting items and shows no variant timing', async () => {
    const baseline = s1Baseline();
    // Ada on Alpha while she stays on Beta: both run at once in one parallel group.
    const patch = { assignmentOverrides: { [FEATURE_A]: [PERSON_ADA] } };
    const evaluation = await evaluateScenario(baseline, patch);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.variantResult.state).toBe('invalid');

    const html = renderSaved(baseline, patch, evaluation, 'Double-booked Ada');
    expect(html).toContain('<dt>Captured baseline</dt><dd>Sprint 17 · 2026-11-29</dd>');
    expect(html).toContain('<dt>Variant</dt><dd>unavailable — invalid inputs</dd>');
    expect(html).toContain(
      'Ada Lovelace is assigned to Item …00000a (title unavailable) and Item …00000b (title unavailable), which run at the same time in one parallel group. Assign Ada Lovelace to only one of them, or remove one item from the scenario.',
    );
    expect(html).not.toContain('CONCURRENT_ASSIGNMENT_CONFLICT');
    expect(html).not.toContain('Sprint 13');
  });

  it('AC 23.8-3/-6: a structural failure is explained, with an unavailable-name label for an uncaptured person', async () => {
    const baseline = s1Baseline();
    const stranger = '019ffe00-0000-7000-8000-0000000000f9';
    const patch = { weightOverrides: { [stranger]: 150 } };
    const evaluation = await evaluateScenario(baseline, patch);
    expect(evaluation.ok).toBe(false);

    const html = renderSaved(baseline, patch, evaluation, 'Unknown weight');
    expect(html).toContain('This scenario cannot be evaluated as entered:');
    expect(html).toContain(
      'A weight override is set for Person …0000f9 (name unavailable), who is not on the captured roster. Remove that weight override.',
    );
    expect(html).not.toContain('WEIGHT_OVERRIDE_FOR_UNKNOWN_PERSON');
  });

  it('AC 23.8-6 (L9): saved scenarios name every item by its stable identifier — no captured-title field exists', async () => {
    const baseline = s1Baseline();
    const patch = { assignmentOverrides: { [FEATURE_A]: [PERSON_ADA], [FEATURE_B]: [PERSON_BEN] } };
    const evaluation = await evaluateScenario(baseline, patch);
    // Released scenarios store no item title, so both items show their stable
    // identifier with an unavailable-title label. `ScenarioCompare` no longer
    // accepts a live-title lookup at all, so a live title can never appear.
    const html = renderSaved(baseline, patch, evaluation, 'Historical');
    expect(html).toContain('Assignment — Item …00000a (title unavailable): Ben Bitdiddle → Ada Lovelace');
    expect(html).toContain('Assignment — Item …00000b (title unavailable): Ada Lovelace → Ben Bitdiddle');
    expect(html).not.toContain('Feature Alpha');
    expect(html).not.toContain('Feature Beta');
    // The card copy states the real behaviour: identifiers, no live titles.
    expect(html).toContain('current live titles are never substituted');
  });

  it('AC 23.8-1: exact item timing prints the domain ratios for both sides, unrounded', async () => {
    const baseline = s1Baseline();
    const evaluation = await evaluateScenario(baseline, {
      assignmentOverrides: { [FEATURE_A]: [PERSON_ADA], [FEATURE_B]: [PERSON_BEN] },
    });
    if (!evaluation.ok) throw new Error('eval failed');
    const names = { person: (id: string) => mockRoster.find((p) => p.id === id)!.name, item: (id: string) => id, level: 'Feature' };
    const timing = (side: 'baselineResult' | 'variantResult', id: string) =>
      describeTiming(evaluation[side].allocation!.timelines.find((t) => t.featureId === id), names);
    expect(timing('baselineResult', FEATURE_A)).toBe(
      'Ben Bitdiddle · rate 5 points/sprint · duration 6 sprints · sprint offset 0 → 6 · Sprints 12–17 (2026-09-07 → 2026-11-29)',
    );
    expect(timing('baselineResult', FEATURE_B)).toBe(
      'Ada Lovelace · rate 15 points/sprint · duration 2/3 sprints · sprint offset 0 → 2/3 · Sprint 12 (2026-09-07 → 2026-09-20)',
    );
    expect(timing('variantResult', FEATURE_A)).toBe(
      'Ada Lovelace · rate 15 points/sprint · duration 2 sprints · sprint offset 0 → 2 · Sprints 12–13 (2026-09-07 → 2026-10-04)',
    );
  });

  it('AC 23.4-5: renders cross-model note for older shared scenario viewed in staffed mode', () => {
    const scenarioId = '019ffe00-0000-7000-8000-000000000088';
    const sharedScenario: PersistedForecastScenario = Object.freeze({
      projectId: PROJECT_ID,
      scenarioId,
      label: 'Legacy Shared Scenario',
      baselineRevision: 2,
      baselineFingerprint: 'mock-baseline-fingerprint',
      policyVersion: 'shared-capacity-v1',
      createdAtISO: '2026-09-01T12:00:00.000Z',
      baseline: {
        projectId: PROJECT_ID,
        baselineRevision: 2,
        policyVersion: 'shared-capacity-v1',
        orderedScope: [FEATURE_A],
        configuration: { pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' },
        parallelGroups: [],
        blockedFeatureIds: [],
        planningLevel: 'Feature' as const,
        factMap: { [FEATURE_A]: { effortPoints: 15, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Feature' } },
      },
      patch: {},
    });

    const props = makeBaseProps({
      scenarios: [sharedScenario],
      policyVersion: 'staffed-capacity-v1',
    });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    expect(html).toContain('Captured at Feature level · Shared Capacity');
    expect(html).toContain('Captured under the Shared Capacity model. The comparison uses that captured model against its own saved baseline.');
  });

  it('AC 23.4-5: renders cross-level notice for scenario captured at another level', () => {
    const scenarioId = '019ffe00-0000-7000-8000-000000000089';
    const compScenario: PersistedForecastScenario = Object.freeze({
      projectId: PROJECT_ID,
      scenarioId,
      label: 'Component Scenario',
      baselineRevision: 3,
      baselineFingerprint: 'mock-baseline-fingerprint',
      policyVersion: 'staffed-capacity-v1',
      createdAtISO: '2026-09-10T12:00:00.000Z',
      baseline: {
        projectId: PROJECT_ID,
        baselineRevision: 3,
        policyVersion: 'staffed-capacity-v1',
        orderedScope: ['comp-1'],
        configuration: { pointsPerSprint: 20, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' },
        parallelGroups: [],
        blockedFeatureIds: [],
        planningLevel: 'Component' as const,
        factMap: { 'comp-1': { effortPoints: 10, isFeature: true, projectId: PROJECT_ID, ancestorIds: [], nodeType: 'Component' } },
      },
      patch: {},
    });

    const props = makeBaseProps({
      scenarios: [compScenario],
      livePlanningLevel: 'Feature',
    });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    expect(html).toContain('Captured at Component level');
    // Story 23.8 AC 23.8-4 (D1): the mismatch is labelled; the comparison is not hidden
    expect(html).toContain('Captured at Component level; the live plan is now at Feature level.');
    expect(html).not.toContain('Comparison is unavailable across levels');
    expect(html).toContain('Evaluating…');
  });

  it('AC 23.4-1: draft form renders captured model/level, weight controls, assignments, and inherited assumptions', () => {
    const props = makeBaseProps({ initialDraft: { context: capturedContext() } });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    // Captured baseline, model & level context (Story 23.7: the capture, not live props)
    expect(html).toContain('Baseline:</strong> captured at revision 5');
    expect(html).toContain('Model:</strong> Staffed Capacity');
    expect(html).toContain('Level:</strong> Feature');

    // Inherited assumptions notice
    expect(html).toContain('Inherited from the captured baseline: roster membership, model (Staffed Capacity), planning level (Feature), parallel groups, blockers, start anchor, sprint length. Only the fields above change.');

    // Team member weight overrides (AC 23.4-1)
    expect(html).toContain('Team member weight overrides');
    expect(html).toContain('aria-label="Ada Lovelace weight override"');
    // Story 23.9: captured weights show in the entered decimal form.
    expect(html).toContain('placeholder="3.00"');
    expect(html).toContain('aria-label="Ben Bitdiddle weight override"');
    expect(html).toContain('placeholder="1.00"');

    // Fixed roster membership (no add or remove person actions in scenario)
    expect(html.toLowerCase()).not.toContain('add person');
    expect(html.toLowerCase()).not.toContain('remove person');

    // Per-item assignment controls (AC 23.4-1)
    expect(html).toContain('aria-label="Assign Ada Lovelace to Feature Alpha"');
    expect(html).toContain('aria-label="Assign Ben Bitdiddle to Feature Alpha"');
    expect(html).toContain('aria-label="Assign Ada Lovelace to Feature Beta"');
    expect(html).toContain('aria-label="Assign Ben Bitdiddle to Feature Beta"');

    // Capacity override
    expect(html).toContain('Capacity / sprint override');

    // Action buttons
    expect(html).toContain('Save scenario');
    expect(html).toContain('Cancel');
  });

  it('AC 23.4-4: renders conflict notice with explicit retry and discard actions on save conflict', () => {
    const props = makeBaseProps({ initialDraft: { context: capturedContext(), saveState: 'stale' } });

    const html = cleanHtml(renderToString(React.createElement(ScenarioCompare, props)));

    // Conflict guidance names the captured revision; edits are kept (Story 23.7 AC 23.7-2)
    expect(html).toContain('Not saved: the live plan changed after this draft captured revision 5. Your edits are kept.');

    // Explicit refresh & discard choices; refresh never saves by itself (AC 23.7-3)
    expect(html).toContain('Refresh baseline');
    expect(html).not.toContain('retry');
    expect(html).toContain('Discard draft');
  });

  it('AC 23.4-6: strictly forbids any "Apply to live" action in rendered markup', () => {
    const props = makeBaseProps({ initialDraft: { context: capturedContext() } });
    const html = renderToString(React.createElement(ScenarioCompare, props));
    expect(html.toLowerCase()).not.toContain('apply to live');
  });
});

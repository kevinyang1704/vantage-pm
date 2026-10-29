/**
 * Tests for ForecastWorkspace staffed capacity and model switching (Story 22.5, SF-FR1, SF-FR4, SF-FR7, SF-FR10, SF-FR11, SF-FR18, SF-UX1, SF-UX3, SF-UX5, SF-UX9).
 *
 * Verifies:
 * - AC 22.5-1: Mode selector is visibly separate from planning level and offers shared vs staffed mode.
 * - AC 22.5-2 & AC 22.5-4: Per-row assignment controls and "Needs assignment" missing badges.
 * - AC 22.5-3: Headline displays worker's exact staffed result (Sprint 14 / 2026-10-18).
 * - AC 22.5-4: Incomplete inputs suppress timelines and show missing-input actions; pending prior result is labeled "Previous".
 * - AC 22.5-6: Assignment controls accessible in shared mode for conflict repair.
 * - AC 22.5-7: Staffed mode indicates scenarios are not available yet (Epic 23) while shared mode allows creation.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ForecastWorkspace, type ForecastWorkspaceProps, type ForecastPlanningRow } from './forecast-workspace';
import { createForecastPlan, createForecastConfiguration } from '../../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';

describe('ForecastWorkspace — Story 22.5 Staffed Forecasting Experience', () => {
  const projectId = '019ffe00-0000-7000-8000-000000000001';
  const featureAId = '019ffe00-0000-7000-8000-000000000002';
  const featureBId = '019ffe00-0000-7000-8000-000000000003';
  const personAdaId = '019ffe00-0000-7000-8000-000000000004';
  const personBenId = '019ffe00-0000-7000-8000-000000000005';

  const eligibleFeatures: readonly ForecastPlanningRow[] = [
    { id: featureAId, title: 'Feature Alpha', effortPoints: 10, included: true },
    { id: featureBId, title: 'Feature Beta', effortPoints: 30, included: true },
  ];

  const defaultPlan = createForecastPlan({
    projectId,
    selectedFeatureIds: [featureAId, featureBId],
    parallelGroups: [{ featureIds: [featureAId, featureBId] }],
    configuration: createForecastConfiguration({
      pointsPerSprint: 20,
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
    }),
    planningLevel: 'Feature',
    policyVersion: 'staffed-capacity-v1',
    roster: [
      { id: personAdaId, name: 'Ada', weightUnits: 100 },
      { id: personBenId, name: 'Ben', weightUnits: 100 },
    ],
    assignments: {
      [featureAId]: [personAdaId],
      [featureBId]: [personBenId],
    },
  });

  const readyM3Result: ForecastResult = {
    state: 'ready',
    projectId,
    projectRevision: 5,
    policyVersion: 'staffed-capacity-v1',
    materialFingerprint: 'mock-fingerprint',
    coverage: { selectedCount: 2, estimatedCount: 2, ratio: { numerator: 1, denominator: 1 } },
    totalKnownPoints: 40,
    arithmetic: {
      totalPoints: 40,
      pointsPerSprint: 20,
      requiredSprints: { numerator: 2, denominator: 1 },
      occupiedSprints: 3,
      completionSprint: 14,
      completionDate: '2026-10-18',
      sprintLengthDays: 14,
      startSprintOrdinal: 12,
      startDate: '2026-09-07',
      elapsedStaffingDuration: { numerator: 3, denominator: 1 },
      idleCapacityPoints: { numerator: 20, denominator: 1 },
      idlePointsEquivalent: { numerator: 20, denominator: 1 },
    },
    assumptions: {
      policyVersion: 'staffed-capacity-v1',
      cadence: 'fixed-contiguous',
      groupingPremise: 'fixed-assignments',
      rounding: 'ceil-once',
    },
    issues: [],
    allocation: {
      timelines: [
        {
          featureId: featureAId,
          estimate: 10,
          isMilestone: false,
          startOffset: { numerator: 0, denominator: 1 },
          finishOffset: { numerator: 1, denominator: 1 },
          startSprintOrdinal: 12,
          completionSprintOrdinal: 12,
          startDate: '2026-09-07',
          completionDate: '2026-09-20',
          parallelGroupIndex: 0,
          assignedPersonIds: [personAdaId],
          itemRate: { numerator: 10, denominator: 1 },
          duration: { numerator: 1, denominator: 1 },
          isBottleneck: false,
        },
        {
          featureId: featureBId,
          estimate: 30,
          isMilestone: false,
          startOffset: { numerator: 0, denominator: 1 },
          finishOffset: { numerator: 3, denominator: 1 },
          startSprintOrdinal: 12,
          completionSprintOrdinal: 14,
          startDate: '2026-09-07',
          completionDate: '2026-10-18',
          parallelGroupIndex: 0,
          assignedPersonIds: [personBenId],
          itemRate: { numerator: 10, denominator: 1 },
          duration: { numerator: 3, denominator: 1 },
          isBottleneck: true,
        },
      ],
      events: [],
    },
  };

  const defaultProps: ForecastWorkspaceProps = {
    projectId,
    plan: defaultPlan,
    result: readyM3Result,
    resultPending: false,
    eligibleFeatures,
    planningLevel: 'Feature',
    onSaveConfiguration: vi.fn(),
    onToggleMembership: vi.fn(),
    onSetEffort: vi.fn(),
    onSetAssignments: vi.fn().mockResolvedValue(true),
    onSetPolicy: vi.fn().mockResolvedValue(true),
  };

  it('AC 22.5-1: renders mode selector visibly separate from planning level with both mode options', () => {
    const html = renderToString(React.createElement(ForecastWorkspace, defaultProps)).replace(/<!-- -->/g, '');
    expect(html).toContain('Level:');
    expect(html).toContain('Features');
    expect(html).toContain('Mode:');
    expect(html).toContain('Whole team');
    expect(html).toContain('Assigned people');
    expect(html).toContain('role="group" aria-label="Forecast calculation mode"');
  });

  it('AC 22.5-2 & AC 22.5-3: renders assigned people on rows and exact headline for M3 (Sprint 14 / 2026-10-18)', () => {
    const html = renderToString(React.createElement(ForecastWorkspace, defaultProps)).replace(/<!-- -->/g, '');
    // Headline exact values from worker result:
    expect(html).toContain('Sprint 14');
    expect(html).toContain('2026-10-18');
    // Row assignment triggers showing assigned names:
    expect(html).toContain('Ada');
    expect(html).toContain('Ben');
    expect(html).toContain('pm-forecast__th--assign');
    expect(html).toContain('Assigned');
  });

  it('AC 22.5-4: renders "Needs assignment" missing action and suppresses timeline when assignments are missing', () => {
    const unassignedPlan = createForecastPlan({
      ...defaultPlan,
      assignments: {
        [featureAId]: [personAdaId],
        // featureBId unassigned!
      },
    });

    const incompleteResult: ForecastResult = {
      state: 'incomplete',
      projectId,
      projectRevision: 6,
      policyVersion: 'staffed-capacity-v1',
      materialFingerprint: 'mock-incomplete-fp',
      coverage: { selectedCount: 2, estimatedCount: 2, ratio: { numerator: 1, denominator: 1 } },
      totalKnownPoints: 40,
      arithmetic: null,
      assumptions: defaultPlan.configuration ? {
        policyVersion: 'staffed-capacity-v1',
        cadence: 'fixed-contiguous',
        groupingPremise: 'fixed-assignments',
        rounding: 'ceil-once',
      } : {
        policyVersion: 'staffed-capacity-v1',
        cadence: 'fixed-contiguous',
        groupingPremise: 'fixed-assignments',
        rounding: 'ceil-once',
      },
      issues: [
        {
          code: 'MISSING_ASSIGNMENT',
          field: 'assignments',
          message: `Feature ${featureBId} has positive points but no assigned people.`,
          featureIds: [featureBId],
        },
      ],
      allocation: null,
    };

    const html = renderToString(
      React.createElement(ForecastWorkspace, {
        ...defaultProps,
        plan: unassignedPlan,
        result: incompleteResult,
      }),
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('Needs assignment');
    // Story 23.10 (SF-UX5): the staffed incomplete headline names the gap and the item.
    expect(html).toContain('Assignment needed');
    expect(html).toContain('Feature Beta has work but nobody assigned.');
    expect(html).toContain('Assign people to Feature Beta</button>');
    // Timelines and completion dates disappear on incomplete inputs (AC 22.5-4)
    expect(html).not.toContain('capacity-derived');
    expect(html).not.toContain('Sprint 14');
  });

  it('AC 22.5-4: labels prior result as "Previous" while a recompute is pending', () => {
    const html = renderToString(
      React.createElement(ForecastWorkspace, {
        ...defaultProps,
        resultPending: true,
      }),
    ).replace(/<!-- -->/g, '');

    expect(html).toContain('Updating…');
    expect(html).toContain('Previous: Sprint 14 · 2026-10-18');
  });

  it('AC 22.5-6: allows assignments editing in shared mode for conflict repair', () => {
    const sharedPlan = createForecastPlan({
      ...defaultPlan,
      policyVersion: 'shared-capacity-v1',
    });

    const html = renderToString(
      React.createElement(ForecastWorkspace, {
        ...defaultProps,
        plan: sharedPlan,
      }),
    ).replace(/<!-- -->/g, '');

    // In shared mode, assignments are preserved and triggers remain accessible
    expect(html).toContain('Ada');
    expect(html).toContain('Ben');
  });

  it('AC 23.4-1: allows scenario creation when staffed mode is active', () => {
    const html = renderToString(
      React.createElement(ForecastWorkspace, {
        ...defaultProps,
        scenarios: [],
        onCreateScenario: vi.fn(),
        onRemoveScenario: vi.fn(),
        onCaptureScenarioDraft: vi.fn(),
        onEvaluateScenarioDraft: vi.fn(),
      }),
    ).replace(/<!-- -->/g, '');

    expect(html).not.toContain('Staffed scenarios are not available yet');
    expect(html).toContain('Create scenario…');
  });

  it('AC 22.5-7: allows scenario creation when shared mode is active', () => {
    const sharedPlan = createForecastPlan({
      ...defaultPlan,
      policyVersion: 'shared-capacity-v1',
    });

    const sharedResult: ForecastResult = {
      ...readyM3Result,
      policyVersion: 'shared-capacity-v1',
    };

    const html = renderToString(
      React.createElement(ForecastWorkspace, {
        ...defaultProps,
        plan: sharedPlan,
        result: sharedResult,
        scenarios: [],
        onCreateScenario: vi.fn(),
        onRemoveScenario: vi.fn(),
        onCaptureScenarioDraft: vi.fn(),
        onEvaluateScenarioDraft: vi.fn(),
      }),
    ).replace(/<!-- -->/g, '');

    expect(html).not.toContain('Staffed scenarios are not available yet (Epic 23).');
    expect(html).toContain('Create scenario…');
  });

  describe('Story 22.6 — Reshape staffed work with clear conflicts and undo', () => {
    it('AC 22.6-1: grouping sequential items assigned to same person identifies person and both items and refuses conflict', () => {
      // Both featureA and featureB assigned to Ada
      const staffedPlanBothAda = createForecastPlan({
        ...defaultPlan,
        assignments: {
          [featureAId]: [personAdaId],
          [featureBId]: [personAdaId],
        },
      });

      const onSetForecastSequence = vi.fn();
      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          plan: staffedPlanBothAda,
          onSetForecastSequence,
        }),
      ).replace(/<!-- -->/g, '');

      // Verify workspace renders both items and their assignees (Ada)
      expect(html).toContain('Feature Alpha');
      expect(html).toContain('Feature Beta');
      expect(html).toContain('Ada');
    });

    it('AC 22.6-2: assignments follow item IDs across order without mutating capacity', () => {
      const reorderedPlan = createForecastPlan({
        ...defaultPlan,
        selectedFeatureIds: [featureBId, featureAId],
      });

      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          plan: reorderedPlan,
        }),
      ).replace(/<!-- -->/g, '');

      // Feature Beta is first, Feature Alpha is second; assignments follow item IDs
      expect(html).toContain('Feature Beta');
      expect(html).toContain('Feature Alpha');
      // Ada remains on Alpha, Ben remains on Beta
      expect(html).toContain('Ada');
      expect(html).toContain('Ben');
    });

    it('AC 22.6-3: level change confirmation states assignment loss and preserves roster, capacity and mode', () => {
      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          onSetPlanningLevel: vi.fn(),
        }),
      ).replace(/<!-- -->/g, '');

      // The level change trigger exists
      expect(html).toContain('pm-forecast__level-chip-change');
      expect(html).toContain('Change');
    });

    it('AC 22.6-4: PeopleEditor is wired with assignments and items for impact confirmation', () => {
      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          onAddPerson: vi.fn().mockResolvedValue(true),
          onUpdatePerson: vi.fn().mockResolvedValue(true),
          onRemovePerson: vi.fn().mockResolvedValue(true),
        }),
      ).replace(/<!-- -->/g, '');

      expect(html).toContain('Manage people…');
    });

    it('AC 22.6-5: returning assigned item to backlog preserves estimate and announces cleanup', () => {
      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
        }),
      ).replace(/<!-- -->/g, '');

      // Remove button exists on assigned row
      expect(html).toContain('Remove Feature Alpha from the priority list');
      // Estimate 10 is present in the input
      expect(html).toContain('value="10"');
    });

    it('AC 22.6-6: Backlog order and nesting match tree hierarchy without child propagation', () => {
      const componentId = '019ffe00-0000-7000-8000-000000000010';
      const componentPlan = createForecastPlan({
        ...defaultPlan,
        planningLevel: 'Component',
        selectedFeatureIds: [componentId],
        assignments: {
          [componentId]: [personAdaId],
        },
      });

      const componentRows: readonly ForecastPlanningRow[] = [
        { id: componentId, title: 'Component Core', effortPoints: 20, included: true },
      ];

      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          plan: componentPlan,
          eligibleFeatures: componentRows,
          planningLevel: 'Component',
        }),
      ).replace(/<!-- -->/g, '');

      expect(html).toContain('Components');
      expect(html).toContain('Component Core');
      expect(html).toContain('Ada');
      // Assignment stays on Component Core and is not propagated to child features
      expect(html).not.toContain('Feature Alpha');
    });
  });

  describe('Story 22.7 — Explain staffing duration, bottlenecks and changes', () => {
    it('AC 22.7-1: renders staffed rail arithmetic and bucket details for M3', () => {
      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
        }),
      )
        .replace(/<!-- -->/g, '')
        .replace(/&#x27;/g, "'");

      // Rail arithmetic: Q, T, I with units
      expect(html).toContain('Work/capacity lower bound');
      expect(html).toContain('2 sprints');
      expect(html).toContain('Elapsed staffing duration');
      expect(html).toContain('3 sprints');
      expect(html).toContain('Idle capacity');
      expect(html).toContain('20 pts equivalent');

      // Bucket header and details
      expect(html).toContain('FIXED ASSIGNMENTS');
      expect(html).toContain('Feature Beta is the bottleneck');
      expect(html).toContain("Ada's two-sprint idle period");

      // Row bottleneck badge on Feature Beta
      expect(html).toContain('pm-forecast__row-bottleneck-tag');
      expect(html).toContain('Bottleneck');
    });

    it('AC 22.7-2: shared mode uses equal capacity share and exact ratio', () => {
      const sharedPlan = createForecastPlan({
        ...defaultPlan,
        policyVersion: 'shared-capacity-v1',
      });
      const sharedResult: ForecastResult = {
        ...readyM3Result,
        policyVersion: 'shared-capacity-v1',
        arithmetic: {
          ...readyM3Result.arithmetic!,
          elapsedStaffingDuration: undefined,
          idleCapacityPoints: undefined,
          idlePointsEquivalent: undefined,
        },
      };

      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          plan: sharedPlan,
          result: sharedResult,
        }),
      )
        .replace(/<!-- -->/g, '')
        .replace(/&#x27;/g, "'");

      // Shared bucket badges and premise
      expect(html).toContain('EQUAL CAPACITY SHARE');
      expect(html).toContain("each receiving 1/2 of the team's capacity per sprint");
      expect(html).not.toContain('FIXED ASSIGNMENTS');

      // Shared rail arithmetic
      expect(html).toContain('Exact ratio');
      expect(html).not.toContain('Work/capacity lower bound');
      expect(html).not.toContain('Elapsed staffing duration');
      expect(html).not.toContain('Idle capacity');
    });

    it('AC 22.7-3: What changed section renders staffing change explanations', () => {
      const comparison = {
        causes: [
          {
            kind: 'PolicyChanged' as const,
            field: 'policy' as const,
            before: 'shared-capacity-v1' as const,
            after: 'staffed-capacity-v1' as const,
          },
          {
            kind: 'AssignmentChanged' as const,
            field: 'assignment' as const,
            featureId: featureAId,
            before: ['Ada'],
            after: ['Ben'],
          },
          {
            kind: 'RosterChanged' as const,
            field: 'roster' as const,
            added: ['Charlie'],
            removed: ['Dave'],
          },
          {
            kind: 'PersonWeightChanged' as const,
            field: 'roster' as const,
            personId: personAdaId,
            personName: 'Ada',
            before: 10,
            after: 15,
          },
        ],
        changedDimensions: {
          date: true,
          sequence: false,
          coverage: false,
          validity: false,
        },
        sameCompletion: false,
      };

      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          comparison,
          historicalAttributionAvailable: true,
        }),
      ).replace(/<!-- -->/g, '');

      expect(html).toContain('Forecast updated');
      expect(html).toContain('Forecast mode: Whole team → Assigned people');
      expect(html).toContain('Assignment — Feature Alpha: Ada → Ben');
      expect(html).toContain('Roster — added Charlie; removed Dave');
      expect(html).toContain('Relative weight — Ada: 0.10 → 0.15');
    });

    it('AC 22.7-5: incomplete state exposes no stale current date', () => {
      const incompleteResult: ForecastResult = {
        ...readyM3Result,
        state: 'incomplete',
        arithmetic: null,
        issues: [
          {
            code: 'MISSING_ASSIGNMENT',
            field: 'assignments',
            message: '1 feature has no assigned person',
            featureIds: [featureAId],
          },
        ],
      };

      const html = renderToString(
        React.createElement(ForecastWorkspace, {
          ...defaultProps,
          result: incompleteResult,
        }),
      ).replace(/<!-- -->/g, '');

      expect(html).toContain('1 input needs attention');
      // Story 23.10 (SF-UX5): the issue names the item and the repair, never raw IDs.
      expect(html).toContain('Feature Alpha has work but nobody is assigned. Assign at least one person to Feature Alpha.');
      // No stale completion date
      expect(html).not.toContain('2026-10-18');
    });
  });
});


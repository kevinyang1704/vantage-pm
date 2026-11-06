import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DeliveryBoard, type DeliveryBoardProps } from './delivery-board';
import { createForecastConfiguration, createForecastPlan } from '../../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const A = '019ffe00-0000-7000-8000-000000000002';
const B = '019ffe00-0000-7000-8000-000000000003';

const plan = createForecastPlan({
  projectId: PROJECT_ID,
  selectedFeatureIds: [A, B],
  sprintPlan: { placements: [{ itemId: A, sprint: 10 }, { itemId: B, sprint: 11 }], capacities: {} },
  configuration: createForecastConfiguration({
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 10,
    startDate: '2026-09-07',
  }),
});

const result: ForecastResult = {
  state: 'ready',
  projectId: PROJECT_ID,
  projectRevision: 4,
  policyVersion: 'shared-capacity-v1',
  materialFingerprint: 'fp',
  coverage: {
    selectedCount: 2,
    estimatedCount: 2,
    ratio: { numerator: 1, denominator: 1 },
  },
  totalKnownPoints: 20,
  arithmetic: {
    totalPoints: 20,
    pointsPerSprint: 10,
    requiredSprints: { numerator: 2, denominator: 1 },
    occupiedSprints: 2,
    completionSprint: 11,
    completionDate: '2026-10-04',
    sprintLengthDays: 14,
    startSprintOrdinal: 10,
    startDate: '2026-09-07',
    asOfDate: '2026-09-08',
  },
  assumptions: {
    policyVersion: 'shared-capacity-v1',
    cadence: 'fixed-contiguous',
    groupingPremise: 'sequential-only',
    rounding: 'ceil-once',
  },
  issues: [],
  allocation: {
    timelines: [
      {
        featureId: A,
        estimate: 10,
        isMilestone: false,
        startOffset: { numerator: 0, denominator: 1 },
        finishOffset: { numerator: 1, denominator: 1 },
        startSprintOrdinal: 10,
        completionSprintOrdinal: 10,
        startDate: '2026-09-07',
        completionDate: '2026-09-20',
        parallelGroupIndex: null,
      },
      {
        featureId: B,
        estimate: 10,
        isMilestone: false,
        startOffset: { numerator: 1, denominator: 1 },
        finishOffset: { numerator: 2, denominator: 1 },
        startSprintOrdinal: 11,
        completionSprintOrdinal: 11,
        startDate: '2026-09-21',
        completionDate: '2026-10-04',
        parallelGroupIndex: null,
      },
    ],
    events: [],
  },
};

const baseProps: DeliveryBoardProps = {
  projectId: PROJECT_ID,
  plan,
  result,
  resultPending: false,
  eligibleFeatures: [
    { id: A, title: 'Social login', effortPoints: 10, included: true },
    { id: B, title: 'Email and password', effortPoints: 10, included: true },
  ],
  backlogItems: [
    { id: '019ffe00-0000-7000-8000-000000000004', title: 'Saved cards', points: 5, inPlan: false },
  ],
  planningLevel: 'Feature',
  levelOptions: [
    { level: 'Feature', count: 2, enabled: true, blurb: 'Finest detail.' },
  ],
  onSaveConfiguration: vi.fn(),
  onToggleMembership: vi.fn().mockResolvedValue(true),
  onSetEffort: vi.fn(),
  onSetForecastSequence: vi.fn(),
  onChoosePlanningLevel: vi.fn(),
  onSwitchView: vi.fn(),
};

function html(props: DeliveryBoardProps): string {
  return renderToString(React.createElement(DeliveryBoard, props)).replace(/<!-- -->/g, '');
}

describe('DeliveryBoard', () => {
  it('renders the delivery outcome, milestone ships, ranks, backlog and trade-offs', () => {
    const markup = html(baseProps);
    expect(markup).toContain('Delivery board');
    expect(markup).toContain('Projected launch');
    expect(markup).toContain('Sprint 11');
    expect(markup).toContain('What ships');
    expect(markup).toContain('Ships');
    expect(markup).toContain('Social login');
    expect(markup).toContain('Email and password');
    expect(markup).toContain('01');
    expect(markup).toContain('02');
    expect(markup).toContain('Backlog');
    expect(markup).not.toContain('Trade-offs');
    expect(markup).toContain('Plan sprints by hand');
    expect(markup).toContain('List view');
  });

  it('holds a blocked item back from the sprints and says why', () => {
    const blockedPlan = createForecastPlan({
      ...plan,
      blockedFeatureIds: [A],
    });
    const markup = html({
      ...baseProps,
      plan: blockedPlan,
      result: { ...result, state: 'conditional' },
    });
    expect(markup).toContain('1 not in a sprint');
    expect(markup).toContain('Can&#x27;t schedule yet');
    expect(markup).toContain('Blocked. Clear the blocker before putting it in a sprint.');
  });

  it('shows hand-placed work, per-sprint capacity and dependencies', () => {
    const placedPlan = createForecastPlan({
      ...plan,
      sprintPlan: { placements: [{ itemId: B, sprint: 10 }], capacities: { '11': 4 } },
    });
    // Social login is in the plan but not dragged into a sprint: it waits in the Backlog.
    const markup = html({
      ...baseProps,
      plan: placedPlan,
      unlockEdges: [],
      onSetSprintPlan: vi.fn().mockResolvedValue(true),
    });
    expect(markup).toContain('Ready to schedule');
    expect(markup).toContain('1 not in a sprint');
    expect(markup).toContain('/ 4 pts');
    expect(markup).toContain('Full');
    expect(markup).not.toContain('Forecast');
    const dependent = html({
      ...baseProps,
      unlockEdges: [{ sourceNodeId: A, targetNodeId: B }],
    });
    expect(dependent).toContain('After Social login');
  });

  it('keeps the sprint board available while the forecast updates', () => {
    const markup = html({ ...baseProps, resultPending: true });
    expect(markup).toContain('Projected launch');
    expect(markup).toContain('Sprint 10');
  });

  it('shows the level step when no plan exists', () => {
    const markup = html({ ...baseProps, plan: null, result: null });
    expect(markup).toContain('What are you forecasting?');
  });

  it('asks for configuration when the plan has no baseline', () => {
    const incomplete = createForecastPlan({ projectId: PROJECT_ID });
    const markup = html({ ...baseProps, plan: incomplete, result: null });
    expect(markup).toContain('Finish the plan configuration');
  });

  it('shows the empty result without fabricating a date', () => {
    const emptyPlan = createForecastPlan({
      projectId: PROJECT_ID,
      configuration: plan.configuration,
    });
    const markup = html({
      ...baseProps,
      plan: emptyPlan,
      eligibleFeatures: [],
      backlogItems: baseProps.backlogItems,
      result: { ...result, state: 'empty', arithmetic: null, allocation: null },
    });
    expect(markup).toContain('Nothing scheduled');
    expect(markup).toContain('Drag Backlog work into a sprint to start the plan.');
  });
});

/**
 * Forecast input normalization — multi-level planning (Story 21.6, AC 21.6-3/4).
 *
 * `normalizeForecastInputs` extracts estimates strictly from nodes matching
 * `plan.planningLevel` and validates scope at that level. A Theme or
 * Component's own authored `effortPoints` count; child descendant points are
 * never rolled up, derived, or double-counted (AC 21.6-4).
 */

import { describe, expect, it } from 'vitest';
import { normalizeForecastInputs } from './forecast-normalization';
import { createForecastPlan } from './forecast-plan.entity';
import type { Node } from '../tree/node.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const THEME = '019ffe00-0000-7000-8000-00000000000d';
const COMPONENT = '019ffe00-0000-7000-8000-00000000000e';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';

function node(id: string, nodeType: Node['nodeType'], parentId: string | null, effortPoints: number | null): Node {
  return Object.freeze({
    id,
    projectId: PROJECT_ID,
    parentId,
    title: `Node ${id}`,
    bodyText: null,
    position: 4294967296n,
    nodeType,
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

const nodes = [
  node(THEME, 'Theme', null, 5),
  node(COMPONENT, 'Component', THEME, 3),
  node(FEATURE_A, 'Feature', COMPONENT, 2),
  node(FEATURE_B, 'Feature', COMPONENT, 1),
];

function snapshot() {
  return Object.freeze({ projectId: PROJECT_ID, projectRevision: 1, nodes });
}

describe('normalizeForecastInputs — AC 21.6-3: level-scoped estimates', () => {
  it('extracts estimates only from nodes matching the plan level', () => {
    const themePlan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [THEME], planningLevel: 'Theme' });
    const themeInputs = normalizeForecastInputs(snapshot(), themePlan);
    expect(themeInputs.inputs.estimates).toEqual({ [THEME]: 5 });

    const componentPlan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [COMPONENT], planningLevel: 'Component' });
    const componentInputs = normalizeForecastInputs(snapshot(), componentPlan);
    expect(componentInputs.inputs.estimates).toEqual({ [COMPONENT]: 3 });

    const featurePlan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [FEATURE_A, FEATURE_B], planningLevel: 'Feature' });
    const featureInputs = normalizeForecastInputs(snapshot(), featurePlan);
    expect(featureInputs.inputs.estimates).toEqual({ [FEATURE_A]: 2, [FEATURE_B]: 1 });
  });

  it('validates scope at the plan level (NOT_A_FEATURE for a mismatched member)', () => {
    const plan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [FEATURE_A], planningLevel: 'Theme' });
    const result = normalizeForecastInputs(snapshot(), plan);
    expect(result.issues.some((i) => i.code === 'NOT_A_FEATURE')).toBe(true);
  });
});

describe('normalizeForecastInputs — AC 21.6-4: no descendant roll-up', () => {
  it('never sums child points into a Theme or Component estimate', () => {
    // The Theme has 5 authored points; its descendants total 6. Only the
    // authored 5 may appear.
    const plan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [THEME], planningLevel: 'Theme' });
    const result = normalizeForecastInputs(snapshot(), plan);
    expect(result.inputs.estimates[THEME]).toBe(5);
    expect(result.inputs.estimates[FEATURE_A]).toBeUndefined();
    expect(result.inputs.estimates[FEATURE_B]).toBeUndefined();
  });

  it('a Theme without authored points contributes null, never a derived sum', () => {
    const bareTheme = node(THEME, 'Theme', null, null);
    const bareNodes = [bareTheme, node(COMPONENT, 'Component', THEME, 3)];
    const plan = createForecastPlan({ projectId: PROJECT_ID, selectedFeatureIds: [THEME], planningLevel: 'Theme' });
    const result = normalizeForecastInputs(
      Object.freeze({ projectId: PROJECT_ID, projectRevision: 1, nodes: bareNodes }),
      plan,
    );
    expect(result.inputs.estimates[THEME]).toBeNull();
  });
});

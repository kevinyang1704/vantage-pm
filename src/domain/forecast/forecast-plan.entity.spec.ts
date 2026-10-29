/**
 * Forecast plan entity — multi-level planning (Story 21.6, AC 21.6-1).
 *
 * `ForecastPlan` carries `planningLevel: ForecastNodeLevel` defaulting to
 * `'Feature'` in both constructors; the existing plan shape is otherwise
 * unchanged (byte-parity for Feature-level plans, AC 21.6-6).
 */

import { describe, expect, it } from 'vitest';
import {
  createEmptyForecastPlan,
  createForecastPlan,
  DEFAULT_FORECAST_NODE_LEVEL,
  type ForecastNodeLevel,
} from './forecast-plan.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';

describe('ForecastNodeLevel', () => {
  it('is exactly Theme | Component | Feature', () => {
    const levels: readonly ForecastNodeLevel[] = ['Theme', 'Component', 'Feature'];
    expect(levels).toHaveLength(3);
    expect(DEFAULT_FORECAST_NODE_LEVEL).toBe('Feature');
  });
});

describe('createEmptyForecastPlan — AC 21.6-1', () => {
  it('defaults planningLevel to Feature', () => {
    const plan = createEmptyForecastPlan(PROJECT_ID);
    expect(plan.planningLevel).toBe('Feature');
  });

  it('accepts an explicit planning level via the optional second parameter', () => {
    expect(createEmptyForecastPlan(PROJECT_ID, 'Theme').planningLevel).toBe('Theme');
    expect(createEmptyForecastPlan(PROJECT_ID, 'Component').planningLevel).toBe('Component');
  });

  it('keeps the existing plan shape otherwise unchanged', () => {
    const plan = createEmptyForecastPlan(PROJECT_ID, 'Theme');
    expect(plan.projectId).toBe(PROJECT_ID);
    expect(plan.selectedFeatureIds).toEqual([]);
    expect(plan.parallelGroups).toEqual([]);
    expect(plan.blockedFeatureIds).toEqual([]);
    expect(plan.configuration.pointsPerSprint).toBeNull();
    expect(plan.policyVersion).toBe('shared-capacity-v1');
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

describe('createForecastPlan — AC 21.6-1', () => {
  it('defaults planningLevel to Feature when omitted', () => {
    expect(createForecastPlan({ projectId: PROJECT_ID }).planningLevel).toBe('Feature');
  });

  it('accepts an explicit planning level', () => {
    expect(createForecastPlan({ projectId: PROJECT_ID, planningLevel: 'Theme' }).planningLevel).toBe('Theme');
    expect(createForecastPlan({ projectId: PROJECT_ID, planningLevel: 'Component' }).planningLevel).toBe('Component');
  });

  it('freezes the planning level with the rest of the plan', () => {
    const plan = createForecastPlan({ projectId: PROJECT_ID, planningLevel: 'Theme' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.selectedFeatureIds)).toBe(true);
  });
});

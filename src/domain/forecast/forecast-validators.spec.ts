/**
 * Forecast scope validators — multi-level planning (Story 21.6, AC 21.6-2/5).
 *
 * `validateForecastScope` accepts an optional `level` (default `'Feature'`):
 * members whose node type differs from the level are flagged with the stable
 * `NOT_A_FEATURE` code (AR-6) and a level-aware message. The parent/descendant
 * overlap walk stays level-agnostic (AC 21.6-5).
 */

import { describe, expect, it } from 'vitest';
import { validateForecastScope } from './forecast-validators';
import type { Node } from '../tree/node.entity';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const THEME = '019ffe00-0000-7000-8000-00000000000d';
const COMPONENT = '019ffe00-0000-7000-8000-00000000000e';
const FEATURE_A = '019ffe00-0000-7000-8000-00000000000a';
const FEATURE_B = '019ffe00-0000-7000-8000-00000000000b';

function node(id: string, nodeType: Node['nodeType'], parentId: string | null = null): Node {
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
    effortPoints: null,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
  });
}

describe('validateForecastScope — AC 21.6-2: level-aware membership', () => {
  const nodes = [
    node(THEME, 'Theme'),
    node(COMPONENT, 'Component', THEME),
    node(FEATURE_A, 'Feature', COMPONENT),
    node(FEATURE_B, 'Feature', COMPONENT),
  ];

  it('accepts members whose type matches the level', () => {
    expect(validateForecastScope([THEME], nodes, PROJECT_ID, 'Theme')).toEqual([]);
    expect(validateForecastScope([COMPONENT], nodes, PROJECT_ID, 'Component')).toEqual([]);
    expect(validateForecastScope([FEATURE_A, FEATURE_B], nodes, PROJECT_ID, 'Feature')).toEqual([]);
  });

  it('flags a type mismatch with NOT_A_FEATURE and a level-aware message', () => {
    const issues = validateForecastScope([FEATURE_A], nodes, PROJECT_ID, 'Theme');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('NOT_A_FEATURE');
    expect(issues[0].message).toBe('Expected node of type Theme, but found Feature.');
  });

  it('defaults to Feature when level is omitted (existing call sites)', () => {
    const issues = validateForecastScope([THEME], nodes, PROJECT_ID);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('NOT_A_FEATURE');
    expect(issues[0].message).toBe('Expected node of type Feature, but found Theme.');
  });
});

describe('validateForecastScope — AC 21.6-5: level-agnostic overlap walk', () => {
  it('rejects a Theme selected together with its descendant Component', () => {
    const nodes = [node(THEME, 'Theme'), node(COMPONENT, 'Component', THEME)];
    const issues = validateForecastScope([THEME, COMPONENT], nodes, PROJECT_ID, 'Theme');
    expect(issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });

  it('rejects a Component selected together with its descendant Feature', () => {
    const nodes = [node(COMPONENT, 'Component'), node(FEATURE_A, 'Feature', COMPONENT)];
    const issues = validateForecastScope([COMPONENT, FEATURE_A], nodes, PROJECT_ID, 'Component');
    expect(issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });

  it('rejects a Theme selected together with a deep descendant Feature across mixed types', () => {
    const nodes = [
      node(THEME, 'Theme'),
      node(COMPONENT, 'Component', THEME),
      node(FEATURE_A, 'Feature', COMPONENT),
    ];
    const issues = validateForecastScope([THEME, FEATURE_A], nodes, PROJECT_ID, 'Theme');
    expect(issues.some((i) => i.code === 'OVERLAPPING_SCOPE')).toBe(true);
  });
});

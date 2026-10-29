import { describe, expect, it } from 'vitest';
import { createNode } from '../tree/node.entity';
import { attributeNodesToNearestTheme, attributeNodeToNearestTheme } from './theme-attribution.policy';

const V = '019ffe00-0000-7000-8000-000000000001';
const T1 = '019ffe00-0000-7000-8000-000000000011';
const T2 = '019ffe00-0000-7000-8000-000000000012';
const F1 = '019ffe00-0000-7000-8000-000000000021';
const F2 = '019ffe00-0000-7000-8000-000000000022';
const AC = '019ffe00-0000-7000-8000-000000000031';
const ORPHAN = '019ffe00-0000-7000-8000-000000000041';

function node(params: { id: string; parentId?: string | null; nodeType?: 'Vision' | 'Theme' | 'Component' | 'Feature' | 'AcceptanceCriterion' | null; title?: string }): ReturnType<typeof createNode> {
  return createNode({
    id: params.id,
    projectId: V,
    parentId: params.parentId ?? null,
    nodeType: params.nodeType ?? null,
    title: params.title ?? '',
    position: 1n,
  });
}

const FOREST = Object.freeze([
  node({ id: V, nodeType: 'Vision', title: 'Vision' }),
  node({ id: T1, parentId: V, nodeType: 'Theme', title: 'Theme 1' }),
  node({ id: T2, parentId: V, nodeType: 'Theme', title: 'Theme 2' }),
  node({ id: F1, parentId: T1, nodeType: 'Feature', title: 'Feature 1' }),
  node({ id: F2, parentId: T2, nodeType: 'Feature', title: 'Feature 2' }),
  node({ id: AC, parentId: F1, nodeType: 'AcceptanceCriterion', title: 'AC' }),
  node({ id: ORPHAN, nodeType: 'Feature', title: 'Root orphan' }),
]);

describe('theme-attribution policy', () => {
  it('attributes each node to its nearest Theme ancestor', () => {
    const attribution = attributeNodesToNearestTheme(FOREST);

    expect(attribution.get(V)).toBeNull();
    expect(attribution.get(T1)).toBe(T1);
    expect(attribution.get(T2)).toBe(T2);
    expect(attribution.get(F1)).toBe(T1);
    expect(attribution.get(F2)).toBe(T2);
    expect(attribution.get(AC)).toBe(T1);
    expect(attribution.get(ORPHAN)).toBeNull();
  });

  it('handles multi-level nesting through features down to ACs', () => {
    expect(attributeNodeToNearestTheme(FOREST, AC)).toBe(T1);
    expect(attributeNodeToNearestTheme(FOREST, F1)).toBe(T1);
  });

  it('walks past a Component to the enclosing Theme', () => {
    const C1 = '019ffe00-0000-7000-8000-000000000051';
    const CF = '019ffe00-0000-7000-8000-000000000052';
    const forest = Object.freeze([
      node({ id: V, nodeType: 'Vision' }),
      node({ id: T1, parentId: V, nodeType: 'Theme' }),
      node({ id: C1, parentId: T1, nodeType: 'Component', title: 'Account Opening' }),
      node({ id: CF, parentId: C1, nodeType: 'Feature', title: 'CB Account Opening' }),
    ]);
    const attribution = attributeNodesToNearestTheme(forest);
    expect(attribution.get(C1)).toBe(T1);
    expect(attribution.get(CF)).toBe(T1);
  });

  it('returns null for nodes with no theme ancestor', () => {
    expect(attributeNodeToNearestTheme(FOREST, ORPHAN)).toBeNull();
    expect(attributeNodeToNearestTheme(FOREST, V)).toBeNull();
  });

  it('returns null for a missing node', () => {
    expect(attributeNodeToNearestTheme(FOREST, '019ffe00-0000-7000-8000-000000000099')).toBeNull();
  });

  it('does not loop forever on a parent cycle', () => {
    const a = node({ id: F1, parentId: AC, nodeType: 'Feature' });
    const b = node({ id: AC, parentId: F1, nodeType: 'AcceptanceCriterion' });
    const cyclic = Object.freeze([a, b]);

    expect(attributeNodeToNearestTheme(cyclic, F1)).toBeNull();
  });
});

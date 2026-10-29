import { describe, it, expect } from 'vitest';
import { computeSubtreeEffort, type EffortTreeNode } from './effort-frontier.policy';

describe('effort-frontier.policy', () => {
  it('sums frontier effort without double-counting ancestors', () => {
    // Tree:
    // Root (effort: 100)
    //   ├── Child 1 (effort: 20)
    //   └── Child 2 (effort: 30)
    //         ├── Grandchild 2A (effort: 10)
    //         └── Grandchild 2B (effort: null)
    // Frontier should be: Child 1 (20) + Grandchild 2A (10) = 30 points (Root 100 and Child 2 are superseded by descendants)
    const nodes: EffortTreeNode[] = [
      { id: 'root', parentId: null, effortPoints: 100 },
      { id: 'c1', parentId: 'root', effortPoints: 20 },
      { id: 'c2', parentId: 'root', effortPoints: 30 },
      { id: 'gc2a', parentId: 'c2', effortPoints: 10 },
      { id: 'gc2b', parentId: 'c2', effortPoints: null },
    ];

    const res = computeSubtreeEffort(nodes, 'root');
    expect(res.authoredEffort).toBe(100);
    expect(res.frontierEffort).toBe(30);
    expect(res.frontierNodeIds).toEqual(['c1', 'gc2a']);
    expect(res.totalNodes).toBe(5);
    expect(res.nodesWithEffort).toBe(4);
    expect(res.coveragePercentage).toBe(80);
  });

  it('reports direct authored effort if no descendants have effort', () => {
    const nodes: EffortTreeNode[] = [
      { id: 'root', parentId: null, effortPoints: 50 },
      { id: 'c1', parentId: 'root', effortPoints: null },
      { id: 'c2', parentId: 'root', effortPoints: null },
    ];

    const res = computeSubtreeEffort(nodes, 'root');
    expect(res.authoredEffort).toBe(50);
    expect(res.frontierEffort).toBe(50);
    expect(res.frontierNodeIds).toEqual(['root']);
  });
});

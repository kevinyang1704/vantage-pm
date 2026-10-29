import { describe, expect, it } from 'vitest';
import { computeStrategicEffortBalance, computeThemeRollup } from './strategic-balance.policy';
import type { Node } from '../tree/node.entity';

function createMockNode(params: Partial<Node> & { id: string }): Node {
  return {
    id: params.id,
    projectId: 'proj-1',
    parentId: params.parentId ?? null,
    title: params.title ?? 'Test Node',
    bodyText: null,
    position: 1000n,
    nodeType: params.nodeType ?? 'Feature',
    startDate: null,
    endDate: null,
    durationDays: params.durationDays ?? null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: params.effortPoints ?? null,
    effortPointsDone: null,
    strategicWeight: params.strategicWeight ?? null,
    phaseId: null,
    deliveryStatus: 'not_started',
  };
}

describe('strategic-balance.policy', () => {
  it('flags theme when effort share diverges from weight share by >= 20%', () => {
    // Theme 1: Weight 10 (10/100 = 10%), Effort 80 (80/100 = 80%) -> Divergence 70%
    // Theme 2: Weight 90 (90/100 = 90%), Effort 20 (20/100 = 20%) -> Divergence 70%
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme', strategicWeight: 10 }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 't1', effortPoints: 80 }),

      createMockNode({ id: 't2', title: 'Theme 2', nodeType: 'Theme', strategicWeight: 90 }),
      createMockNode({ id: 'f2', title: 'Feature 2', nodeType: 'Feature', parentId: 't2', effortPoints: 20 }),
    ];

    const findings = computeStrategicEffortBalance(nodes);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const t1Finding = findings.find((f) => f.themeId === 't1');
    expect(t1Finding).toBeDefined();
    expect(t1Finding?.divergencePercentage).toBeGreaterThanOrEqual(20);
    expect(t1Finding?.effortShare).toBe(80);
    expect(t1Finding?.strategicWeightShare).toBe(10);
  });

  it('rolls effort under an interposed Component into its Theme', () => {
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme', strategicWeight: 10 }),
      createMockNode({ id: 'c1', title: 'Component 1', nodeType: 'Component', parentId: 't1' }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 'c1', effortPoints: 80 }),

      createMockNode({ id: 't2', title: 'Theme 2', nodeType: 'Theme', strategicWeight: 90 }),
      createMockNode({ id: 'f2', title: 'Feature 2', nodeType: 'Feature', parentId: 't2', effortPoints: 20 }),
    ];

    const t1 = computeStrategicEffortBalance(nodes).find((f) => f.themeId === 't1');
    expect(t1?.effortShare).toBe(80);
    expect(t1?.strategicWeightShare).toBe(10);
  });

  it('does not flag themes when effort and weight shares are balanced within 20%', () => {
    // Theme 1: Weight 50 (50%), Effort 55 (55%) -> Divergence 5%
    // Theme 2: Weight 50 (50%), Effort 45 (45%) -> Divergence 5%
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme', strategicWeight: 50 }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 't1', effortPoints: 55 }),

      createMockNode({ id: 't2', title: 'Theme 2', nodeType: 'Theme', strategicWeight: 50 }),
      createMockNode({ id: 'f2', title: 'Feature 2', nodeType: 'Feature', parentId: 't2', effortPoints: 45 }),
    ];

    const findings = computeStrategicEffortBalance(nodes);
    expect(findings).toHaveLength(0);
  });

  it('computeThemeRollup produces a row for a single-theme project (AC 5.6-#1)', () => {
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Solo Theme', nodeType: 'Theme', strategicWeight: 40 }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature', parentId: 't1', effortPoints: 30 }),
    ];

    const rollup = computeThemeRollup(nodes);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].themeName).toBe('Solo Theme');
    // Single-theme: its shares are 100% of the total (or the reduced-coverage value)
    expect(rollup[0].effortShare).toBe(100);
    expect(rollup[0].strategicWeightShare).toBe(100);
  });

  it('computeThemeRollup surfaces missing weight as reduced coverage, never a false zero', () => {
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'No Weight', nodeType: 'Theme', strategicWeight: null }),
      createMockNode({ id: 'f1', title: 'Feature', nodeType: 'Feature', parentId: 't1', effortPoints: 30 }),
    ];

    const rollup = computeThemeRollup(nodes);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].strategicWeightShare).toBeNull();
    expect(rollup[0].coveragePercentage).toBeLessThan(100);
  });
});

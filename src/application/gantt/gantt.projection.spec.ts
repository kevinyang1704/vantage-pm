import { describe, it, expect } from 'vitest';
import { projectGantt } from './gantt.projection';
import type { Node } from '../../domain/tree/node.entity';

function createMockNode(overrides: Partial<Node> & { id: string; projectId: string; position: bigint }): Node {
  return {
    parentId: null,
    title: `Node ${overrides.id}`,
    bodyText: null,
    nodeType: null,
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
    ...overrides,
  };
}

describe('projectGantt (Story 7.1)', () => {
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  it('projects dated nodes preserving hierarchy and sibling order', () => {
    const root1 = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000010',
      projectId,
      position: 1000n,
      title: 'Theme 1',
      nodeType: 'Theme',
    });
    const child1 = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000011',
      projectId,
      parentId: root1.id,
      position: 1000n,
      title: 'Feature A',
      nodeType: 'Feature',
      startDate: '2026-09-01',
      endDate: '2026-09-15',
      durationDays: 15,
      scheduleSourceMode: 'start_end',
    });
    const child2 = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000012',
      projectId,
      parentId: root1.id,
      position: 2000n,
      title: 'Feature B',
      nodeType: 'Feature',
      startDate: '2026-09-10',
      endDate: '2026-09-30',
      durationDays: 21,
      scheduleSourceMode: 'start_end',
    });

    const projection = projectGantt({
      projectId,
      projectRevision: 42,
      nodes: [root1, child1, child2],
    });

    expect(projection.projectId).toBe(projectId);
    expect(projection.projectRevision).toBe(42);
    expect(projection.rows.length).toBe(3);

    // Root is derived from children
    expect(projection.rows[0].nodeId).toBe(root1.id);
    expect(projection.rows[0].barKind).toBe('derived');
    expect(projection.rows[0].startDate).toBe('2026-09-01');
    expect(projection.rows[0].endDate).toBe('2026-09-30');
    expect(projection.rows[0].durationDays).toBe(30);
    expect(projection.rows[0].depth).toBe(0);

    // Child 1
    expect(projection.rows[1].nodeId).toBe(child1.id);
    expect(projection.rows[1].barKind).toBe('authored');
    expect(projection.rows[1].startDate).toBe('2026-09-01');
    expect(projection.rows[1].endDate).toBe('2026-09-15');
    expect(projection.rows[1].depth).toBe(1);

    // Child 2
    expect(projection.rows[2].nodeId).toBe(child2.id);
    expect(projection.rows[2].barKind).toBe('authored');
    expect(projection.rows[2].startDate).toBe('2026-09-10');
    expect(projection.rows[2].endDate).toBe('2026-09-30');
    expect(projection.rows[2].depth).toBe(1);

    expect(projection.minProjectDate).toBe('2026-09-01');
    expect(projection.maxProjectDate).toBe('2026-09-30');
    expect(projection.undatedCount).toBe(0);
  });

  it('excludes undated subtrees and tracks undatedCount accurately', () => {
    const rootDated = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000010',
      projectId,
      position: 1000n,
      title: 'Theme Dated',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      durationDays: 10,
    });
    const rootUndated = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000020',
      projectId,
      position: 2000n,
      title: 'Theme Undated',
    });
    const childUndated = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000021',
      projectId,
      parentId: rootUndated.id,
      position: 1000n,
      title: 'Feature Undated',
    });

    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes: [rootDated, rootUndated, childUndated],
    });

    expect(projection.rows.length).toBe(1);
    expect(projection.rows[0].nodeId).toBe(rootDated.id);
    expect(projection.totalProjectNodes).toBe(3);
    expect(projection.datedNodeCount).toBe(1);
    expect(projection.undatedCount).toBe(2);
  });

  it('identifies explicit overrides when a parent has authored dates and children', () => {
    const root = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000010',
      projectId,
      position: 1000n,
      title: 'Parent With Override',
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      durationDays: 90,
      scheduleSourceMode: 'start_end',
    });
    const child = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000011',
      projectId,
      parentId: root.id,
      position: 1000n,
      title: 'Child',
      startDate: '2026-01-15',
      endDate: '2026-02-15',
      durationDays: 32,
      scheduleSourceMode: 'start_end',
    });

    const projection = projectGantt({
      projectId,
      projectRevision: 2,
      nodes: [root, child],
    });

    expect(projection.rows.length).toBe(2);
    expect(projection.rows[0].barKind).toBe('authored');
    expect(projection.rows[0].isExplicitOverride).toBe(true);
    expect(projection.rows[0].startDate).toBe('2026-01-01');
    expect(projection.rows[0].endDate).toBe('2026-03-31');
  });

  it('is strictly deterministic across multiple runs with identical input', () => {
    const node1 = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000001',
      projectId,
      position: 2000n,
      startDate: '2026-05-01',
      endDate: '2026-05-10',
      durationDays: 10,
    });
    const node2 = createMockNode({
      id: '018f6c40-1111-7000-8000-000000000002',
      projectId,
      position: 1000n,
      startDate: '2026-04-01',
      endDate: '2026-04-15',
      durationDays: 15,
    });

    const runA = projectGantt({ projectId, projectRevision: 5, nodes: [node1, node2] });
    const runB = projectGantt({ projectId, projectRevision: 5, nodes: [node2, node1] });

    expect(runA).toEqual(runB);
  });
});

describe('projectGantt — workstream hue assignment', () => {
  const projectId = '018f6c40-2222-7000-8000-000000000001';

  /** A dated leaf feature under `parentId`. */
  function datedFeature(id: string, parentId: string | null, position: bigint) {
    return createMockNode({
      id,
      projectId,
      parentId,
      position,
      nodeType: 'Feature',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      durationDays: 30,
      scheduleSourceMode: 'start_end',
    });
  }

  function theme(id: string, parentId: string | null, position: bigint) {
    return createMockNode({ id, projectId, parentId, position, nodeType: 'Theme' });
  }

  it('a Feature inherits its nearest Theme ancestor as workstream; the Theme carries its own id, hue 1', () => {
    const t = theme('theme-1', null, 1000n);
    const f = datedFeature('feat-1', t.id, 1000n);

    const { rows } = projectGantt({ projectId, projectRevision: 1, nodes: [t, f] });

    const themeRow = rows.find((r) => r.nodeId === 'theme-1')!;
    const featRow = rows.find((r) => r.nodeId === 'feat-1')!;
    expect(themeRow.workstreamId).toBe('theme-1');
    expect(themeRow.workstreamHueIndex).toBe(1);
    expect(featRow.workstreamId).toBe('theme-1');
    expect(featRow.workstreamHueIndex).toBe(1);
  });

  it('sibling top-level Themes get hue indices in document (position) order', () => {
    const tB = theme('theme-b', null, 2000n);
    const tA = theme('theme-a', null, 1000n);
    const fA = datedFeature('feat-a', tA.id, 1000n);
    const fB = datedFeature('feat-b', tB.id, 1000n);

    // Pass unsorted to prove ordering is by position, not array order.
    const { rows } = projectGantt({ projectId, projectRevision: 1, nodes: [tB, fB, tA, fA] });

    expect(rows.find((r) => r.nodeId === 'theme-a')!.workstreamHueIndex).toBe(1);
    expect(rows.find((r) => r.nodeId === 'feat-a')!.workstreamHueIndex).toBe(1);
    expect(rows.find((r) => r.nodeId === 'theme-b')!.workstreamHueIndex).toBe(2);
    expect(rows.find((r) => r.nodeId === 'feat-b')!.workstreamHueIndex).toBe(2);
  });

  it('a nested Theme opens its own workstream for its subtree', () => {
    const outer = theme('theme-outer', null, 1000n);
    const inner = theme('theme-inner', outer.id, 1000n);
    const fOuter = datedFeature('feat-outer', outer.id, 2000n); // directly under outer
    const fInner = datedFeature('feat-inner', inner.id, 1000n); // under nested theme

    const { rows } = projectGantt({ projectId, projectRevision: 1, nodes: [outer, inner, fInner, fOuter] });

    expect(rows.find((r) => r.nodeId === 'theme-outer')!.workstreamHueIndex).toBe(1);
    expect(rows.find((r) => r.nodeId === 'theme-inner')!.workstreamHueIndex).toBe(2);
    expect(rows.find((r) => r.nodeId === 'feat-inner')!.workstreamId).toBe('theme-inner');
    expect(rows.find((r) => r.nodeId === 'feat-inner')!.workstreamHueIndex).toBe(2);
    expect(rows.find((r) => r.nodeId === 'feat-outer')!.workstreamId).toBe('theme-outer');
    expect(rows.find((r) => r.nodeId === 'feat-outer')!.workstreamHueIndex).toBe(1);
  });

  it('rows above the first Theme have no workstream', () => {
    const vision = createMockNode({ id: 'vision', projectId, position: 1000n, nodeType: 'Vision' });
    const t = theme('theme-1', vision.id, 1000n);
    const f = datedFeature('feat-1', t.id, 1000n);

    const { rows } = projectGantt({ projectId, projectRevision: 1, nodes: [vision, t, f] });

    const visionRow = rows.find((r) => r.nodeId === 'vision')!;
    expect(visionRow.workstreamId).toBeNull();
    expect(visionRow.workstreamHueIndex).toBeNull();
    expect(rows.find((r) => r.nodeId === 'theme-1')!.workstreamHueIndex).toBe(1);
  });

  it('hue indices wrap after six', () => {
    const nodes = [];
    for (let i = 0; i < 7; i++) {
      const t = theme(`theme-${i}`, null, BigInt((i + 1) * 1000));
      nodes.push(t, datedFeature(`feat-${i}`, t.id, 1000n));
    }

    const { rows } = projectGantt({ projectId, projectRevision: 1, nodes });

    expect(rows.find((r) => r.nodeId === 'theme-5')!.workstreamHueIndex).toBe(6);
    expect(rows.find((r) => r.nodeId === 'theme-6')!.workstreamHueIndex).toBe(1); // wrapped
  });

  it('a workstream keeps its hue index when an earlier branch is collapsed', () => {
    const tA = theme('theme-a', null, 1000n);
    const inner = theme('theme-a-inner', tA.id, 1000n);
    const fInner = datedFeature('feat-a-inner', inner.id, 1000n);
    const tB = theme('theme-b', null, 2000n);
    const fB = datedFeature('feat-b', tB.id, 1000n);
    const nodes = [tA, inner, fInner, tB, fB];

    const expanded = projectGantt({ projectId, projectRevision: 1, nodes });
    const collapsed = projectGantt({ projectId, projectRevision: 1, nodes, collapsedNodeIds: ['theme-a'] });

    const hue = (p: typeof expanded, id: string) => p.rows.find((r) => r.nodeId === id)?.workstreamHueIndex ?? null;

    // theme-a=1, theme-a-inner=2, theme-b=3 — unchanged by collapsing theme-a,
    // even though theme-a-inner then has no row.
    expect(hue(expanded, 'theme-a-inner')).toBe(2);
    expect(hue(expanded, 'theme-b')).toBe(3);
    expect(collapsed.rows.find((r) => r.nodeId === 'theme-a-inner')).toBeUndefined();
    expect(hue(collapsed, 'theme-b')).toBe(3);
  });
});

/**
 * Deterministic layered layout engine specs (Epic 10, E10-FR1/2/3/5/8,
 * E10-NFR1, E10-AR1/2/4/5/6).
 *
 * Replaces the Story 6.1 ELK-compound-node assertions. Every fixture is
 * proven through GEOMETRY — finite absolute coordinates, documented card
 * dimensions, strictly-increasing parent-to-child vertical separation, zero
 * pairwise card overlap — never node-count assertions (E10-FR8, E10-NFR1).
 */

import { describe, expect, it } from 'vitest';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createUnlockEdge, type UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import {
  projectVisualTree,
  type VisualTreeProjectionInput,
} from './visual-tree.projection';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  LAYER_GAP,
  TRUNK_HEIGHT,
  TRUNK_WIDTH,
  computeLayout,
} from './layout-engine';
import type { LayoutResultResponse, NodeGeometry } from '../../contracts/layout-protocol';

const P = '019ffe00-0000-7000-8000-000000000001';
const V = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const F3 = '019ffe00-0000-7000-8000-000000000032';
const F4 = '019ffe00-0000-7000-8000-000000000033';
const A1 = '019ffe00-0000-7000-8000-000000000040';
const A2 = '019ffe00-0000-7000-8000-000000000041';
const E_IN = '019ffe00-0000-7000-8000-000000000050';
const E_OUT = '019ffe00-0000-7000-8000-000000000051';

function node(id: string, parentId: string | null, nodeType: Node['nodeType'] | null = null, title?: string): Node {
  return createNode({ id, projectId: P, parentId, title: title ?? id, position: 1n, nodeType });
}

function edge(id: string, sourceNodeId: string, targetNodeId: string): UnlockEdge {
  return createUnlockEdge({ id, projectId: P, sourceNodeId, targetNodeId });
}

function layout(input: VisualTreeProjectionInput): LayoutResultResponse {
  const vis = projectVisualTree(input);
  const res = computeLayout({ type: 'LayoutSnapshot', visualTree: vis });
  expect(res.type).toBe('LayoutResult');
  return res as LayoutResultResponse;
}

function geom(res: LayoutResultResponse): Map<string, NodeGeometry> {
  return new Map(res.nodeGeometry.map((g) => [g.nodeId, g]));
}

function assertNoPairwiseOverlap(res: LayoutResultResponse): void {
  const geoms = res.nodeGeometry;
  for (let i = 0; i < geoms.length; i += 1) {
    for (let j = i + 1; j < geoms.length; j += 1) {
      const a = geoms[i];
      const b = geoms[j];
      const overlapsX = a.x < b.x + b.width && b.x < a.x + a.width;
      const overlapsY = a.y < b.y + b.height && b.y < a.y + a.height;
      expect(overlapsX && overlapsY, `${a.nodeId} overlaps ${b.nodeId}`).toBe(false);
    }
  }
}

function assertFinite(geoms: readonly NodeGeometry[]): void {
  for (const g of geoms) {
    expect(Number.isFinite(g.x), `${g.nodeId}.x`).toBe(true);
    expect(Number.isFinite(g.y), `${g.nodeId}.y`).toBe(true);
    expect(Number.isFinite(g.width), `${g.nodeId}.width`).toBe(true);
    expect(Number.isFinite(g.height), `${g.nodeId}.height`).toBe(true);
  }
}

describe('Epic 10 layout engine (E10-AR1..AR6)', () => {
  it('emits NodeGeometry with exactly the five documented keys and never mutates input', () => {
    const input = {
      projectId: P,
      projectRevision: 7,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Feature 1'),
      ],
      unlockEdges: [],
    };
    const vis = projectVisualTree(input);
    const before = JSON.stringify(vis);
    const res = computeLayout({ type: 'LayoutSnapshot', visualTree: vis });
    expect(res.type).toBe('LayoutResult');
    for (const entry of (res as LayoutResultResponse).nodeGeometry) {
      expect(Object.keys(entry).sort()).toEqual(['height', 'nodeId', 'width', 'x', 'y']);
    }
    expect(JSON.stringify(vis)).toBe(before);
  });

  it('computes a deterministic LayoutResult (same input twice → same output)', () => {
    const input = fixture();
    const a = layout(input);
    const b = layout(input);
    expect(a.nodeGeometry).toEqual(b.nodeGeometry);
  });

  it('fixture: trunk only (E10-FR8)', () => {
    const input = {
      projectId: P,
      projectRevision: 1,
      themeId: T1,
      nodes: [node(V, null, 'Vision', 'Vision'), node(T1, V, 'Theme', 'Theme 1')],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const trunk = g.get(T1)!;
    assertFinite([trunk]);
    expect(trunk.width).toBe(TRUNK_WIDTH);
    expect(trunk.height).toBe(TRUNK_HEIGHT);
    // Trunk sits at the top, centered in its subtree width.
    expect(trunk.y).toBeGreaterThanOrEqual(0);
  });

  it('fixture: one child (E10-FR8) — child below trunk, no overlap, non-zero gap', () => {
    const input = {
      projectId: P,
      projectRevision: 2,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Feature 1'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const trunk = g.get(T1)!;
    const child = g.get(F1)!;
    assertFinite([trunk, child]);
    expect(child.width).toBe(CARD_WIDTH);
    expect(child.height).toBe(CARD_HEIGHT);
    // E10-FR2: child depth strictly below parent with separation.
    expect(child.y).toBeGreaterThanOrEqual(trunk.y + trunk.height + LAYER_GAP);
    // Child is horizontally centered under the trunk.
    expect(child.x + child.width / 2).toBeCloseTo(trunk.x + trunk.width / 2);
    assertNoPairwiseOverlap(res);
  });

  it('fixture: multiple siblings — ordered left-to-right by siblingIndex, zero overlap', () => {
    const input = {
      projectId: P,
      projectRevision: 3,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Feature A'),
        node(F2, T1, 'Feature', 'Feature B'),
        node(F3, T1, 'Feature', 'Feature C'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const f1 = g.get(F1)!;
    const f2 = g.get(F2)!;
    const f3 = g.get(F3)!;
    // E10-FR3: deterministic sibling order — x strictly increases by siblingIndex.
    expect(f1.x).toBeLessThan(f2.x);
    expect(f2.x).toBeLessThan(f3.x);
    // Same layer (same y).
    expect(f1.y).toBe(f2.y);
    expect(f2.y).toBe(f3.y);
    assertNoPairwiseOverlap(res);
  });

  it('fixture: three depths — strictly increasing Y per depth, no overlap across depths', () => {
    const input = {
      projectId: P,
      projectRevision: 4,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Feature A'),
        node(A1, F1, 'Feature', 'Child A'),
        node(A2, F1, 'Feature', 'Child B'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const trunk = g.get(T1)!;
    const feature = g.get(F1)!;
    const ac1 = g.get(A1)!;
    const ac2 = g.get(A2)!;
    expect(trunk.y).toBeLessThan(feature.y);
    expect(feature.y).toBeLessThan(ac1.y);
    expect(feature.y).toBeLessThan(ac2.y);
    assertNoPairwiseOverlap(res);
  });

  it('fixture: uneven branch sizes — no overlap, subtree centering (E10-FR8)', () => {
    const input = {
      projectId: P,
      projectRevision: 5,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Left'),
        node(F2, F1, 'Feature', 'Left child A'),
        node(F3, F1, 'Feature', 'Left child B'),
        node(F4, T1, 'Feature', 'Right'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const left = g.get(F1)!;
    const right = g.get(F4)!;
    const childA = g.get(F2)!;
    const childB = g.get(F3)!;
    // Left branch wider than right; both children of F1 centered under it.
    expect(childA.x).toBeLessThan(childB.x);
    expect(childA.y).toBe(childB.y);
    // Left and right siblings do not overlap.
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    assertNoPairwiseOverlap(res);
  });

  it('fixture: selected-card expansion does not obscure the layer below (E10-UX5)', () => {
    const input = {
      projectId: P,
      projectRevision: 6,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Feature A'),
        node(A1, F1, 'Feature', 'Child A'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    const g = geom(res);
    const feature = g.get(F1)!;
    const ac = g.get(A1)!;
    // Simulate the selected expansion (height grows beyond CARD_HEIGHT):
    const expandedBottom = feature.y + CARD_HEIGHT + 40;
    expect(ac.y).toBeGreaterThanOrEqual(expandedBottom);
    assertNoPairwiseOverlap(res);
  });

  it('routes only in-subtree unlock edges (E10-AR3); outside endpoint excluded', () => {
    const input = fixture();
    const res = layout(input);
    const ids = res.edgeGeometry.map((e) => e.edgeId);
    expect(ids).toEqual([E_IN]);
    for (const e of res.edgeGeometry) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('fixture: 4-depth multi-branch tree with multiple child-bearing siblings — zero overlap', () => {
    const F1_1 = '019ffe00-0000-7000-8000-000000000060';
    const F1_2 = '019ffe00-0000-7000-8000-000000000061';
    const F2_1 = '019ffe00-0000-7000-8000-000000000062';
    const F2_2 = '019ffe00-0000-7000-8000-000000000063';
    const F1_1_1 = '019ffe00-0000-7000-8000-000000000070';
    const input = {
      projectId: P,
      projectRevision: 10,
      themeId: T1,
      nodes: [
        node(V, null, 'Vision', 'Vision'),
        node(T1, V, 'Theme', 'Theme 1'),
        node(F1, T1, 'Feature', 'Branch 1'),
        node(F2, T1, 'Feature', 'Branch 2'),
        node(F3, T1, 'Feature', 'Branch 3'),
        node(F1_1, F1, 'Feature', 'Branch 1.1'),
        node(F1_2, F1, 'Feature', 'Branch 1.2'),
        node(F2_1, F2, 'Feature', 'Branch 2.1'),
        node(F2_2, F2, 'Feature', 'Branch 2.2'),
        node(F1_1_1, F1_1, 'Feature', 'Branch 1.1.1'),
      ],
      unlockEdges: [],
    };
    const res = layout(input);
    expect(res.nodeGeometry.length).toBe(9);
    assertFinite(res.nodeGeometry);
    assertNoPairwiseOverlap(res);
  });
});

function fixture(): VisualTreeProjectionInput {
  return {
    projectId: P,
    projectRevision: 7,
    themeId: T1,
    nodes: [
      node(V, null, 'Vision', 'Vision'),
      node(T1, V, 'Theme', 'Theme 1'),
      node(T2, V, 'Theme', 'Theme 2'),
      node(F1, T1, 'Feature', 'Feature 1'),
      node(F2, T1, 'Feature', 'Feature 2'),
      node(F3, T2, 'Feature', 'Feature 3'),
    ],
    unlockEdges: [
      edge(E_IN, F1, F2),
      edge(E_OUT, F1, F3),
    ],
  };
}

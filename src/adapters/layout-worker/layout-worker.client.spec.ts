import { describe, expect, it } from 'vitest';
import { createNode, type Node } from '../../domain/tree/node.entity';
import {
  projectVisualTree,
  type VisualTreeProjectionInput,
} from '../../application/visual-tree/visual-tree.projection';
import {
  LayoutWorkerClient,
  isLayoutResultCurrent,
  layoutRequestKey,
} from './layout-worker.client';
import type { LayoutResultResponse } from '../../contracts/layout-protocol';

const P = '019ffe00-0000-7000-8000-000000000001';
const T1 = '019ffe00-0000-7000-8000-000000000020';

function node(id: string, parentId: string | null, nodeType: Node['nodeType'] | null = null): Node {
  return createNode({ id, projectId: P, parentId, title: id, position: 1n, nodeType });
}

function fixture(revision: number): VisualTreeProjectionInput {
  return {
    projectId: P,
    projectRevision: revision,
    themeId: T1,
    nodes: [node(T1, null, 'Theme')],
    unlockEdges: [],
  };
}

function resultRes(revision: number): LayoutResultResponse {
  return Object.freeze({
    type: 'LayoutResult',
    projectId: P,
    projectRevision: revision,
    themeId: T1,
    nodeGeometry: [],
    edgeGeometry: [],
    computedDurationMs: 1,
  });
}

describe('layout worker client (Story 6.1 Task 5, AC3)', () => {
  it('builds a request key from projectId/themeId/projectRevision', () => {
    expect(layoutRequestKey(P, T1, 3)).toBe(`${P}:${T1}:3`);
  });

  it('isLayoutResultCurrent accepts the matching revision and rejects stale ones', () => {
    const currentKey = layoutRequestKey(P, T1, 3);

    expect(isLayoutResultCurrent(currentKey, resultRes(3))).toBe(true);
    expect(isLayoutResultCurrent(currentKey, resultRes(2))).toBe(false);
    expect(isLayoutResultCurrent(currentKey, resultRes(4))).toBe(false);
    expect(isLayoutResultCurrent(null, resultRes(3))).toBe(false);
  });

  it('delivers a result matching the latest request through the fallback path', async () => {
    const client = new LayoutWorkerClient();
    const delivered: number[] = [];
    client.onResult((res) => delivered.push(res.projectRevision));

    client.requestLayout(projectVisualTree(fixture(5)));

    await new Promise((r) => setTimeout(r, 500));
    expect(delivered).toContain(5);
    client.terminate();
  });

  it('fallback path (synchronous engine) delivers each request in order while it is current', async () => {
    // The deterministic engine is synchronous, so the fallback delivers
    // result N synchronously BEFORE request N+1 is issued — each delivery is
    // current at delivery time. The latest-request-wins guard (asserted
    // above via isLayoutResultCurrent) still protects the async worker path.
    const client = new LayoutWorkerClient();
    const delivered: number[] = [];
    client.onResult((res) => delivered.push(res.projectRevision));

    client.requestLayout(projectVisualTree(fixture(2)));
    client.requestLayout(projectVisualTree(fixture(3)));

    await new Promise((r) => setTimeout(r, 500));
    expect(delivered).toEqual([2, 3]);
    client.terminate();
  });
});

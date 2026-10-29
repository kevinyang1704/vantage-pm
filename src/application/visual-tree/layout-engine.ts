/**
 * Deterministic layered visual-tree layout engine (Epic 10, E10-AR1..AR6).
 *
 * Replaces the ELK compound-node representation (children nested inside
 * parent elk-nodes with `elk.hierarchyHandling: INCLUDE_CHILDREN`, which
 * produced overlapping descendant geometry after flattening) with a pure
 * hand-written layerer:
 *
 * - Every rendered card is a LEAF in the layout graph; containment is not
 *   a layout container (E10-AR1). Depth drives the layer assignment.
 * - One canvas-absolute coordinate space (E10-AR2): x/y are absolute from
 *   the canvas origin; there is no nested/local geometry to convert.
 * - Depth → layer Y; siblings laid out in a row ordered by the
 *   authoritative `siblingIndex`/`depth` (E10-AR4). No overlap by
 *   construction; any residual overlap or non-finite coordinate is an
 *   explicit `LayoutFailed` (E10-AR5).
 * - Sibling order is NEVER inferred from x-coordinates; `siblingIndex` is
 *   the only order source (E10-AR4).
 * - Containment edges are handled downstream by `connector-geometry`; the
 *   engine routes only unlock edges with both endpoints in-subtree
 *   (E10-AR3 separation).
 * - Output geometry is disposable and revision-tagged via the response
 *   envelope (E10-AR6); input is never mutated.
 *
 * The visual tree is a rooted tree, so the layout is a pure function of
 * (depth, siblingIndex, card dimensions, gaps) — no general-graph solver.
 */

import type {
  EdgeGeometry,
  LayoutFailedResponse,
  LayoutResultResponse,
  LayoutSnapshotRequest,
  LayoutWorkerResponse,
  NodeGeometry,
} from '../../contracts/layout-protocol';
import type { VisualTreeProjection, VisualTreeNode } from '../../contracts/visual-tree';

export const CARD_WIDTH = 208;
export const CARD_HEIGHT = 98;
export const TRUNK_WIDTH = 400;
export const TRUNK_HEIGHT = 76;

/** Horizontal gap between sibling cards on the same layer. */
export const SIBLING_GAP = 40;
/** Vertical gap between layers (leaves room for rails/drops). */
export const LAYER_GAP = 80;
/** Canvas padding around the tree (matches DESIGN.md tree-canvas-pad). */
export const PAD_LEFT = 28;
export const PAD_TOP = 32;

function cardSize(depth: number): { width: number; height: number } {
  return depth === 0 ? { width: TRUNK_WIDTH, height: TRUNK_HEIGHT } : { width: CARD_WIDTH, height: CARD_HEIGHT };
}

function rowWidth(siblings: readonly VisualTreeNode[]): number {
  let width = 0;
  for (let i = 0; i < siblings.length; i += 1) {
    width += cardSize(siblings[i].depth).width;
    if (i > 0) width += SIBLING_GAP;
  }
  return width;
}

/** Total width of the subtree rooted at `nodeId` (for parent-centered rows). */
function computeSubtreeWidths(
  projection: VisualTreeProjection,
  childrenByParent: Map<string, VisualTreeNode[]>,
): Map<string, number> {
  const widthByNode = new Map<string, number>();
  const visit = (nodeId: string): number => {
    const cached = widthByNode.get(nodeId);
    if (cached !== undefined) return cached;
    const node = projection.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      widthByNode.set(nodeId, 0);
      return 0;
    }
    const children = childrenByParent.get(nodeId) ?? [];
    const own = cardSize(node.depth).width;
    if (children.length === 0) {
      widthByNode.set(nodeId, own);
      return own;
    }
    let childrenTotalWidth = 0;
    for (let i = 0; i < children.length; i += 1) {
      const childWidth = visit(children[i].nodeId);
      childrenTotalWidth += childWidth;
      if (i > 0) childrenTotalWidth += SIBLING_GAP;
    }
    const subtreeWidth = Math.max(own, childrenTotalWidth);
    widthByNode.set(nodeId, subtreeWidth);
    return subtreeWidth;
  };
  for (const node of projection.nodes) {
    visit(node.nodeId);
  }
  return widthByNode;
}

function findOverlap(geometries: readonly NodeGeometry[]): { a: string; b: string } | null {
  for (let i = 0; i < geometries.length; i += 1) {
    for (let j = i + 1; j < geometries.length; j += 1) {
      const a = geometries[i];
      const b = geometries[j];
      const overlapsX = a.x < b.x + b.width && b.x < a.x + a.width;
      const overlapsY = a.y < b.y + b.height && b.y < a.y + a.height;
      if (overlapsX && overlapsY) {
        return { a: a.nodeId, b: b.nodeId };
      }
    }
  }
  return null;
}

/**
 * Compute the deterministic layered layout.
 * Pure: identical input → identical output; never mutates the input.
 * Returns a `LayoutResult` or an explicit `LayoutFailed` (E10-AR5).
 */
export function computeLayout(request: LayoutSnapshotRequest): LayoutWorkerResponse {
  const start = performance.now();
  const projection = request.visualTree;

  const fail = (reason: string): LayoutFailedResponse =>
    Object.freeze({
      type: 'LayoutFailed',
      projectId: projection.projectId,
      themeId: projection.themeId,
      reason,
    });

  if (projection.nodes.length === 0) {
    return fail('EMPTY_TREE');
  }

  const root = projection.nodes.find((n) => n.parentId === null);
  if (!root) {
    return fail('ROOT_MISSING');
  }

  const childrenByParent = new Map<string, VisualTreeNode[]>();
  for (const node of projection.nodes) {
    if (node.parentId !== null) {
      const list = childrenByParent.get(node.parentId) ?? [];
      list.push(node);
      childrenByParent.set(node.parentId, list);
    }
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }

  const subtreeWidths = computeSubtreeWidths(projection, childrenByParent);
  const geometryByNode = new Map<string, NodeGeometry>();

  const placeSubtree = (nodeId: string, subtreeLeft: number, depth: number): void => {
    const node = projection.nodes.find((n) => n.nodeId === nodeId);
    if (!node) return;

    const size = cardSize(node.depth);
    const nodeSubtreeWidth = subtreeWidths.get(nodeId) ?? size.width;

    const nodeX = subtreeLeft + nodeSubtreeWidth / 2 - size.width / 2;
    const nodeY = depth === 0
      ? PAD_TOP
      : PAD_TOP + TRUNK_HEIGHT + LAYER_GAP + (depth - 1) * (CARD_HEIGHT + LAYER_GAP);

    geometryByNode.set(
      nodeId,
      Object.freeze({
        nodeId,
        x: nodeX,
        y: nodeY,
        width: size.width,
        height: size.height,
      }),
    );

    const children = childrenByParent.get(nodeId) ?? [];
    if (children.length === 0) return;

    let childrenTotalWidth = 0;
    for (let i = 0; i < children.length; i += 1) {
      childrenTotalWidth += subtreeWidths.get(children[i].nodeId) ?? cardSize(children[i].depth).width;
      if (i > 0) childrenTotalWidth += SIBLING_GAP;
    }

    let currentLeft = subtreeLeft + nodeSubtreeWidth / 2 - childrenTotalWidth / 2;

    for (const child of children) {
      const childSubtreeWidth = subtreeWidths.get(child.nodeId) ?? cardSize(child.depth).width;
      placeSubtree(child.nodeId, currentLeft, depth + 1);
      currentLeft += childSubtreeWidth + SIBLING_GAP;
    }
  };

  placeSubtree(root.nodeId, PAD_LEFT, 0);

  const nodeGeometry = Array.from(geometryByNode.values());
  if (nodeGeometry.length !== projection.nodes.length) {
    return fail('GEOMETRY_MISSING_NODE');
  }

  // E10-AR5: reject non-finite or overlapping geometry explicitly rather
  // than rendering a degraded view as if it were valid.
  for (const g of nodeGeometry) {
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.width) || !Number.isFinite(g.height)) {
      return fail('NON_FINITE_GEOMETRY');
    }
  }
  const overlap = findOverlap(nodeGeometry);
  if (overlap) {
    return fail(`OVERLAP_DETECTED:${overlap.a}x${overlap.b}`);
  }

  // E10-AR3: only unlock edges with both endpoints in-subtree are routed;
  // secondary relationships never affect containment placement.
  const edgeGeometry: readonly EdgeGeometry[] = Object.freeze(
    projection.unlockEdges
      .filter((e) => e.sourceInSubtree && e.targetInSubtree)
      .map((e) => {
        const src = geometryByNode.get(e.sourceNodeId);
        const tgt = geometryByNode.get(e.targetNodeId);
        if (!src || !tgt) return null;
        const x1 = src.x + src.width;
        const y1 = src.y + src.height / 2;
        const x2 = tgt.x;
        const y2 = tgt.y + tgt.height / 2;
        const midX = (x1 + x2) / 2;
        return Object.freeze({
          edgeId: e.edgeId,
          points: Object.freeze([
            Object.freeze({ x: x1, y: y1 }),
            Object.freeze({ x: midX, y: y1 }),
            Object.freeze({ x: midX, y: y2 }),
            Object.freeze({ x: x2, y: y2 }),
          ]),
        });
      })
      .filter((e): e is EdgeGeometry => e !== null),
  );

  return Object.freeze({
    type: 'LayoutResult',
    projectId: projection.projectId,
    projectRevision: projection.projectRevision,
    themeId: projection.themeId,
    nodeGeometry: Object.freeze(nodeGeometry),
    edgeGeometry,
    computedDurationMs: Math.round(performance.now() - start),
  });
}

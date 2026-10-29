/**
 * Pure connector geometry (Story 6.2 Task 3, DESIGN.md Connectors).
 *
 * No DOM, no React. Computes rail/drop paths from per-node boxes ONLY —
 * the type signatures carry no node-property fields, which makes the
 * uniform-1.4px stroke rule a compile-time guarantee (the 6px effort-branch
 * defect cannot be reintroduced through these types).
 */

export interface NodeBox {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RailGeometry {
  readonly parentId: string;
  readonly y: number; // vertical midpoint of the inter-layer gap
  readonly xStart: number; // first child's centre-x
  readonly xEnd: number; // last child's centre-x
  readonly path: string; // 'M {xStart},{y} H {xEnd}'
}

/** Minimum visible rail width for single-child branches (E10-FR4). */
export const MIN_RAIL_WIDTH = 24;

export interface DropGeometry {
  readonly ownerId: string; // the child (or, for the trunk stub, the theme itself)
  readonly kind: 'child' | 'stub'; // discriminates the two drop roles a node can hold
  readonly path: string; // 'M {x},{yTop} V {yBottom}'
  readonly junction: { readonly x: number; readonly y: number };
}

// children must already be in AD-11 order (Story 6.1); this function does not sort.
export function computeContainmentRail(parent: NodeBox, orderedChildren: readonly NodeBox[]): RailGeometry {
  if (orderedChildren.length === 0) {
    return Object.freeze({
      parentId: parent.nodeId,
      y: parent.y + parent.height,
      xStart: parent.x + parent.width / 2,
      xEnd: parent.x + parent.width / 2,
      path: '',
    });
  }

  const first = orderedChildren[0];
  const last = orderedChildren[orderedChildren.length - 1];

  const minChildTop = orderedChildren.reduce((min, c) => Math.min(min, c.y), first.y);
  const gapTop = parent.y + parent.height;
  const railY = gapTop + (minChildTop - gapTop) / 2;

  let xStart = first.x + first.width / 2;
  let xEnd = last.x + last.width / 2;

  // E10-FR4 (Epic 10): a single-child branch must still show a visible,
  // non-zero containment path. A rail that spans from a point to itself
  // renders as an invisible zero-length line; give it a documented minimum
  // width centered on the child, so the trunk stub → rail → drop chain
  // stays legible without changing multi-child geometry.
  if (orderedChildren.length === 1) {
    const half = MIN_RAIL_WIDTH / 2;
    xStart = xEnd - half;
    xEnd = xEnd + half;
  }

  return Object.freeze({
    parentId: parent.nodeId,
    y: railY,
    xStart,
    xEnd,
    path: `M ${xStart},${railY} H ${xEnd}`,
  });
}

export function computeChildDrop(rail: RailGeometry, child: NodeBox): DropGeometry {
  const x = child.x + child.width / 2;
  return Object.freeze({
    ownerId: child.nodeId,
    kind: 'child' as const,
    path: `M ${x},${rail.y} V ${child.y}`,
    junction: Object.freeze({ x, y: rail.y }),
  });
}

export function computeTrunkStub(trunk: NodeBox, rail: RailGeometry): DropGeometry {
  const x = trunk.x + trunk.width / 2;
  return Object.freeze({
    ownerId: trunk.nodeId,
    kind: 'stub' as const,
    path: `M ${x},${trunk.y + trunk.height} V ${rail.y}`,
    junction: Object.freeze({ x, y: rail.y }),
  });
}
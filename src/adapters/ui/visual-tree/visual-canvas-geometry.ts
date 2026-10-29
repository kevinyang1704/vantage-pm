/**
 * Canvas geometry helper (Story 6.2 Task 5).
 *
 * Derives rail/drop geometry and the union bounding box from the projection's
 * AD-11-ordered nodes + ELK boxes — the same pure functions as
 * connector-geometry, assembled per parent-child layer.
 */

import type { VisualTreeProjection, VisualTreeNode } from '../../../contracts/visual-tree';
import type { NodeGeometry } from '../../../contracts/layout-protocol';
import {
  computeChildDrop,
  computeContainmentRail,
  computeTrunkStub,
  type DropGeometry,
  type RailGeometry,
} from './connector-geometry';

export interface CanvasLayout {
  readonly rails: readonly RailGeometry[];
  readonly drops: readonly DropGeometry[];
  readonly bounds: { readonly width: number; readonly height: number };
}

export class ComputeContainmentGeometryHelper {
  static computeAll(
    projection: VisualTreeProjection,
    geomByNode: Map<string, NodeGeometry>,
    orphanNodeIds?: ReadonlySet<string>,
  ): CanvasLayout {
    const nodeById = new Map(projection.nodes.map((n) => [n.nodeId, n]));
    const childrenByParent = new Map<string, VisualTreeNode[]>();
    for (const n of projection.nodes) {
      if (n.parentId !== null && nodeById.has(n.parentId)) {
        const list = childrenByParent.get(n.parentId) ?? [];
        list.push(n);
        childrenByParent.set(n.parentId, list);
      }
    }
    // Children are already AD-11 ordered by the projection; preserve order.
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => {
        if (a.siblingIndex !== b.siblingIndex) return a.siblingIndex - b.siblingIndex;
        return a.nodeId < b.nodeId ? -1 : 1;
      });
    }

    const rails: RailGeometry[] = [];
    const drops: DropGeometry[] = [];

    for (const parent of projection.nodes) {
      const children = childrenByParent.get(parent.nodeId) ?? [];
      if (children.length === 0) continue;

      const parentBox = geomByNode.get(parent.nodeId);
      if (!parentBox) continue;

      const childBoxes = children
        .map((c) => geomByNode.get(c.nodeId))
        .filter((g): g is NodeGeometry => g !== undefined);

      if (childBoxes.length === 0) continue;

      const rail = computeContainmentRail(parentBox, childBoxes);
      rails.push(rail);

      for (const childBox of childBoxes) {
        if (orphanNodeIds?.has(childBox.nodeId)) {
          // AC1: Orphan feature omission — no connector line is drawn to or from an orphan card
          continue;
        }
        drops.push(computeChildDrop(rail, childBox));
      }

      drops.push(computeTrunkStub(parentBox, rail));
    }

    const bounds = ComputeContainmentGeometryHelper.computeBounds(
      Array.from(geomByNode.values()),
    );

    return Object.freeze({ rails: Object.freeze(rails), drops: Object.freeze(drops), bounds });
  }

  static computeBounds(geometries: readonly NodeGeometry[]): { width: number; height: number } {
    if (geometries.length === 0) return Object.freeze({ width: 0, height: 0 });
    let maxX = 0;
    let maxY = 0;
    for (const g of geometries) {
      maxX = Math.max(maxX, g.x + g.width);
      maxY = Math.max(maxY, g.y + g.height);
    }
    // Account for canvas padding (DESIGN.md tree-canvas-pad: 22px 14px 26px)
    return Object.freeze({ width: Math.max(maxX, 1) + 28, height: Math.max(maxY, 1) + 48 });
  }
}
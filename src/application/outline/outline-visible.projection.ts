/**
 * Flattened visible outline projection (Story 2.2, Epic 3).
 *
 * Pure projection: maps OutlineReadModel + collapsedNodeIds -> VisibleOutline.
 * Traversal: depth-first pre-order.
 * Sibling order: position ascending (signed 64-bit gap), then id ascending (stable tie-break).
 */

import type { OutlineNodeReadModel, OutlineReadModel } from './outline-read-model';
import type { DeliveryStatus, NodeType, ScheduleSourceMode } from '../../domain/tree/node.entity';
import type { NodeOpenQuestion } from '../../domain/tree/node-question.entity';

export interface VisibleOutlineRow {
  readonly nodeId: string;
  readonly title: string;
  readonly bodyText: string | null; // authored markdown prose (Story 16.2)
  readonly depth: number; // 0-based
  readonly hasChildren: boolean;
  readonly isExpanded: boolean; // false when hasChildren is false or in collapsed set
  readonly posInSet: number; // 1-based, among siblings
  readonly setSize: number; // sibling count
  readonly typeTag: string | null;
  readonly nodeType: NodeType | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly scheduleSourceMode: ScheduleSourceMode | null;
  readonly derivedStartDate: string | null;
  readonly derivedEndDate: string | null;
  readonly derivedDurationDays: number | null;
  readonly completed: boolean;
  readonly effortPoints: number | null;
  readonly strategicWeight: number | null;
  readonly deliveryStatus: DeliveryStatus;
  readonly phaseId: string | null;
  readonly phaseName: string | null;
  readonly effectivePhaseName: string | null;
  readonly effectivePhaseSource: 'explicit' | 'inherited' | 'none';
  readonly unlocksCount: number;
  readonly unlockedByCount: number;
  readonly customFields: Readonly<Record<string, string>>;
  readonly acceptanceSummary: string | null;
  /** Open questions & decisions for this node (Story 16.1 AC4, Story 16.3 E16-FR4). */
  readonly openQuestions: readonly NodeOpenQuestion[];
}

export interface VisibleOutline {
  readonly projectRevision: number;
  readonly rows: readonly VisibleOutlineRow[];
}

function compareSiblings(a: OutlineNodeReadModel, b: OutlineNodeReadModel): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function projectVisibleOutline(
  model: OutlineReadModel,
  collapsedNodeIds: ReadonlySet<string>,
): VisibleOutline {
  const nodeMap = new Map<string, OutlineNodeReadModel>();
  const childrenMap = new Map<string | null, OutlineNodeReadModel[]>();

  // Acceptance criteria are authored and reviewed only in the node inspector
  // (Story 16.3) — they are never their own outline rows. Dropping them here
  // keeps child counts, expand carets, and pre-order traversal aligned with
  // what the tree actually shows; the inspector still reads the full model.
  const visibleNodes = model.nodes.filter((n) => n.nodeType !== 'AcceptanceCriterion');

  for (const node of visibleNodes) {
    nodeMap.set(node.id, node);
  }

  for (const node of visibleNodes) {
    // If parent doesn't exist in nodeMap and parentId is non-null, treat as root (depth 0)
    const effectiveParentId = node.parentId && nodeMap.has(node.parentId) ? node.parentId : null;
    let list = childrenMap.get(effectiveParentId);
    if (!list) {
      list = [];
      childrenMap.set(effectiveParentId, list);
    }
    list.push(node);
  }

  // Sort each sibling list
  for (const list of childrenMap.values()) {
    list.sort(compareSiblings);
  }

  const rows: VisibleOutlineRow[] = [];
  const visited = new Set<string>();

  function walk(parentId: string | null, depth: number): void {
    const siblings = childrenMap.get(parentId);
    if (!siblings || siblings.length === 0) return;

    const setSize = siblings.length;
    for (let i = 0; i < setSize; i++) {
      const node = siblings[i];
      if (visited.has(node.id)) {
        // Prevent cycle
        continue;
      }
      visited.add(node.id);

      const children = childrenMap.get(node.id);
      const hasChildren = Boolean(children && children.length > 0);
      const isCollapsed = collapsedNodeIds.has(node.id);
      const isExpanded = hasChildren && !isCollapsed;

      rows.push(
        Object.freeze({
          nodeId: node.id,
          title: node.title,
          bodyText: node.bodyText ?? null,
          depth,
          hasChildren,
          isExpanded,
          posInSet: i + 1,
          setSize,
          typeTag: node.typeTag,
          nodeType: node.nodeType,
          startDate: node.startDate,
          endDate: node.endDate,
          durationDays: node.durationDays,
          scheduleSourceMode: node.scheduleSourceMode,
          derivedStartDate: node.derivedStartDate,
          derivedEndDate: node.derivedEndDate,
          derivedDurationDays: node.derivedDurationDays,
          completed: node.completed,
          effortPoints: node.effortPoints,
          strategicWeight: node.strategicWeight,
          deliveryStatus: node.deliveryStatus ?? 'not_started',
          phaseId: node.phaseId,
          phaseName: node.phaseName,
          effectivePhaseName: node.effectivePhaseName,
          effectivePhaseSource: node.effectivePhaseSource,
          unlocksCount: node.unlocksCount,
          unlockedByCount: node.unlockedByCount,
          customFields: node.customFields ?? Object.freeze({}),
          acceptanceSummary: node.acceptanceSummary,
          openQuestions: node.openQuestions ?? Object.freeze([]),
        }),
      );

      if (isExpanded) {
        walk(node.id, depth + 1);
      }
    }
  }

  walk(null, 0);

  return Object.freeze({
    projectRevision: model.projectRevision,
    rows: Object.freeze(rows),
  });
}

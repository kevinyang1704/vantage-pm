/**
 * Hierarchical Gantt projection builder (Story 7.1, Story 7.8, AD-2, AD-11).
 *
 * Pure projection: transforms Node[] into GanttProjection.
 * - Preserves containment hierarchy and persisted sibling order.
 * - Resolves authored schedules vs derived parent spans (linear bottom-up aggregation).
 * - Omits undated nodes and tracks undatedCount.
 * - ISO string comparisons for speed with Temporal.PlainDate only for duration calculation.
 */

import type { Node } from '../../domain/tree/node.entity';
import type { GanttProjection, GanttRow, GanttBarKind } from '../../contracts/gantt';
import { deriveNodeSchedule, isValidIsoDate } from '../../domain/tree/schedule.policy';
import { Temporal } from 'temporal-polyfill';

export interface ProjectGanttInput {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly nodes: readonly Node[];
  readonly collapsedNodeIds?: ReadonlySet<string> | readonly string[];
}

function compareSiblings(a: Node, b: Node): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

interface ResolvedNodeInfo {
  readonly node: Node;
  readonly hasDirectDates: boolean;
  readonly isDated: boolean;
  readonly barKind: GanttBarKind;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly isExplicitOverride: boolean;
  readonly datedChildren: readonly ResolvedNodeInfo[];
}

export function projectGantt(input: ProjectGanttInput): GanttProjection {
  const { projectId, projectRevision, nodes } = input;
  const collapsedSet = new Set(input.collapsedNodeIds ?? []);

  // 1. Group nodes by parentId
  const childrenMap = new Map<string | null, Node[]>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const parentKey = node.parentId ?? null;
    const list = childrenMap.get(parentKey);
    if (list) {
      list.push(node);
    } else {
      childrenMap.set(parentKey, [node]);
    }
  }

  // Sort sibling groups deterministically
  for (const list of childrenMap.values()) {
    list.sort(compareSiblings);
  }

  // 2. Bottom-up schedule resolution helper (O(N) bottom-up tree walk)
  function resolveNodeInfo(node: Node): ResolvedNodeInfo {
    const directSchedule = deriveNodeSchedule({
      startDate: node.startDate,
      endDate: node.endDate,
      durationDays: node.durationDays,
      sourceMode: node.scheduleSourceMode,
    });

    const hasDirectDates = directSchedule.isValid && directSchedule.startDate !== null && directSchedule.endDate !== null;

    // Resolve children
    const rawChildren = childrenMap.get(node.id) ?? [];
    const childInfos: ResolvedNodeInfo[] = [];
    const datedChildren: ResolvedNodeInfo[] = [];

    for (let i = 0; i < rawChildren.length; i++) {
      const c = resolveNodeInfo(rawChildren[i]);
      childInfos.push(c);
      if (c.isDated) {
        datedChildren.push(c);
      }
    }

    if (hasDirectDates) {
      return {
        node,
        hasDirectDates: true,
        isDated: true,
        barKind: 'authored',
        startDate: directSchedule.startDate,
        endDate: directSchedule.endDate,
        durationDays: directSchedule.durationDays,
        isExplicitOverride: rawChildren.length > 0,
        datedChildren,
      };
    }

    // If no direct dates, aggregate directly from immediate dated children (each child is already an aggregate)
    if (datedChildren.length > 0) {
      let minStart: string | null = null;
      let maxEnd: string | null = null;

      for (let i = 0; i < datedChildren.length; i++) {
        const child = datedChildren[i];
        if (child.startDate && child.endDate) {
          if (minStart === null || child.startDate < minStart) {
            minStart = child.startDate;
          }
          if (maxEnd === null || child.endDate > maxEnd) {
            maxEnd = child.endDate;
          }
        }
      }

      if (minStart && maxEnd) {
        const pStart = Temporal.PlainDate.from(minStart);
        const pEnd = Temporal.PlainDate.from(maxEnd);
        const durationDays = pStart.until(pEnd, { largestUnit: 'day' }).days + 1;

        return {
          node,
          hasDirectDates: false,
          isDated: true,
          barKind: 'derived',
          startDate: minStart,
          endDate: maxEnd,
          durationDays,
          isExplicitOverride: false,
          datedChildren,
        };
      }
    }

    return {
      node,
      hasDirectDates: false,
      isDated: false,
      barKind: 'derived',
      startDate: null,
      endDate: null,
      durationDays: null,
      isExplicitOverride: false,
      datedChildren,
    };
  }

  // Resolve all root nodes
  const rootNodes = childrenMap.get(null) ?? [];
  const rootInfos = rootNodes.map(resolveNodeInfo);

  // 3. Pre-order depth-first traversal of dated nodes
  const rows: GanttRow[] = [];
  let minDate: string | null = null;
  let maxDate: string | null = null;

  // Workstream hue index: a Theme node opens a workstream for itself and its
  // subtree; a nested Theme opens another. Indices are handed out 1..6 (wrapping)
  // over the FULL dated tree in document order — independent of the visible
  // window and of collapse — so a workstream keeps its hue no matter what is
  // collapsed elsewhere.
  const workstreamHueByNodeId = new Map<string, number>();
  function assignWorkstreamHues(info: ResolvedNodeInfo, inheritedWorkstreamId: string | null) {
    if (!info.isDated) return;
    const workstreamId = info.node.nodeType === 'Theme' ? info.node.id : inheritedWorkstreamId;
    if (workstreamId !== null && !workstreamHueByNodeId.has(workstreamId)) {
      workstreamHueByNodeId.set(workstreamId, (workstreamHueByNodeId.size % 6) + 1);
    }
    for (let i = 0; i < info.datedChildren.length; i++) {
      assignWorkstreamHues(info.datedChildren[i], workstreamId);
    }
  }
  for (const rootInfo of rootInfos) {
    assignWorkstreamHues(rootInfo, null);
  }

  function traverse(
    info: ResolvedNodeInfo,
    depth: number,
    siblingIndex: number,
    siblingSetSize: number,
    inheritedWorkstreamId: string | null,
  ) {
    if (!info.isDated || !info.startDate || !info.endDate || !info.durationDays) return;

    const workstreamId = info.node.nodeType === 'Theme' ? info.node.id : inheritedWorkstreamId;
    const workstreamHueIndex = workstreamId === null ? null : workstreamHueByNodeId.get(workstreamId) ?? null;

    if (isValidIsoDate(info.startDate)) {
      if (minDate === null || info.startDate < minDate) {
        minDate = info.startDate;
      }
    }
    if (isValidIsoDate(info.endDate)) {
      if (maxDate === null || info.endDate > maxDate) {
        maxDate = info.endDate;
      }
    }

    const hasChildren = info.datedChildren.length > 0;
    const isCollapsed = collapsedSet.has(info.node.id);

    rows.push(
      Object.freeze({
        nodeId: info.node.id,
        parentId: info.node.parentId,
        depth,
        title: info.node.title,
        nodeType: info.node.nodeType,
        completed: info.node.completed,
        siblingIndex,
        siblingSetSize,
        hasChildren,
        isCollapsed,
        barKind: info.barKind,
        startDate: info.startDate,
        endDate: info.endDate,
        durationDays: info.durationDays,
        scheduleSourceMode: info.node.scheduleSourceMode,
        isExplicitOverride: info.isExplicitOverride,
        workstreamId,
        workstreamHueIndex,
      }),
    );

    // If branch is NOT collapsed, traverse children
    if (!isCollapsed && hasChildren) {
      const childCount = info.datedChildren.length;
      for (let i = 0; i < childCount; i++) {
        traverse(info.datedChildren[i], depth + 1, i, childCount, workstreamId);
      }
    }
  }

  const datedRoots = rootInfos.filter((r) => r.isDated);
  const rootCount = datedRoots.length;
  for (let i = 0; i < rootCount; i++) {
    traverse(datedRoots[i], 0, i, rootCount, null);
  }

  const undatedCount = nodes.length - rows.length;

  return Object.freeze({
    projectId,
    projectRevision,
    rows: Object.freeze(rows),
    minProjectDate: minDate,
    maxProjectDate: maxDate,
    datedNodeCount: rows.length,
    undatedCount: Math.max(0, undatedCount),
    totalProjectNodes: nodes.length,
  });
}

/**
 * Gantt dependency routing policy (Story 7.4, FR-46, AD-10, AD-12).
 *
 * Resolves orthogonal connector routes for unlock edges between visible Gantt bars.
 * Highlights sequencing violations without relying on color alone.
 * Omit edges if either endpoint is outside visible scope.
 */

import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { GanttRow, GanttDependencyRoute } from '../../contracts/gantt';

export interface ResolveGanttDependenciesInput {
  readonly visibleRows: readonly GanttRow[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly dateToX: (date: string, isEnd?: boolean) => number;
  readonly rowHeight: number;
  readonly headerOffset?: number;
}

export function resolveGanttDependencies(input: ResolveGanttDependenciesInput): readonly GanttDependencyRoute[] {
  const { visibleRows, unlockEdges, dateToX, rowHeight, headerOffset = 0 } = input;
  const rowMap = new Map<string, { rowIndex: number; row: GanttRow }>();

  visibleRows.forEach((row, index) => {
    rowMap.set(row.nodeId, { rowIndex: index, row });
  });

  const routes: GanttDependencyRoute[] = [];

  for (const edge of unlockEdges) {
    const source = rowMap.get(edge.sourceNodeId);
    const target = rowMap.get(edge.targetNodeId);

    // AC2: If either endpoint is outside visible scope, omit edge entirely
    if (!source || !target) {
      continue;
    }

    const sourceX = dateToX(source.row.endDate, true);
    const sourceY = headerOffset + source.rowIndex * rowHeight + rowHeight / 2;

    const targetX = dateToX(target.row.startDate, false);
    const targetY = headerOffset + target.rowIndex * rowHeight + rowHeight / 2;

    // AC1: Sequencing conflict if target starts before source ends
    const isViolating = source.row.endDate > target.row.startDate;

    // Orthogonal step routing
    let pathD = '';
    const buffer = 10;
    let vertices: { x: number; y: number }[];

    if (targetX >= sourceX + buffer * 2) {
      // Forward standard step: right -> down/up -> right
      const midX = sourceX + buffer;
      pathD = `M ${sourceX} ${sourceY} H ${midX} V ${targetY} H ${targetX}`;
      vertices = [
        { x: sourceX, y: sourceY },
        { x: midX, y: sourceY },
        { x: midX, y: targetY },
        { x: targetX, y: targetY },
      ];
    } else {
      // Backwards / overlapping routing: right -> down/up -> left -> down/up -> right
      const midY = sourceY < targetY ? sourceY + rowHeight / 2 + 2 : sourceY - rowHeight / 2 - 2;
      pathD = `M ${sourceX} ${sourceY} H ${sourceX + buffer} V ${midY} H ${targetX - buffer} V ${targetY} H ${targetX}`;
      vertices = [
        { x: sourceX, y: sourceY },
        { x: sourceX + buffer, y: sourceY },
        { x: sourceX + buffer, y: midY },
        { x: targetX - buffer, y: midY },
        { x: targetX - buffer, y: targetY },
        { x: targetX, y: targetY },
      ];
    }

    routes.push({
      edgeId: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      sourceBarPoint: { x: sourceX, y: sourceY },
      targetBarPoint: { x: targetX, y: targetY },
      pathD,
      vertices: Object.freeze(vertices),
      isViolating,
    });
  }

  return Object.freeze(routes);
}

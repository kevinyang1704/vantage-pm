/**
 * Gantt -> PPTX slide-plan mapper (Story 8.3 Task 3, AD-12, AD-11).
 *
 * Pure functional core with NO pptxgenjs import. Maps the resolved Story 8.1
 * scope plus phase/dependency inputs into a fully-positioned, framework-agnostic
 * plan. This is the single place AC1's "no recomputed graph facts" and AC2's
 * "matches the preview by construction" are enforced structurally: everything
 * downstream is pure placement of already-computed inch coordinates.
 *
 * It calls resolveGanttPhases / resolveGanttDependencies exactly as
 * GanttTimelineCanvas does, passing a `createDateToUnit` instance scaled to
 * inches — never a second phase-span or dependency-routing algorithm.
 */

import type { GanttVisibleScopeResult, GanttRow } from '../../contracts/gantt';
import type { Phase } from '../../domain/phase/phase.entity';
import type { Node } from '../../domain/tree/node.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { createDateToUnit } from './gantt-geometry';
import { resolveGanttPhases } from './gantt-phases';
import { resolveGanttDependencies } from './gantt-dependencies';

export interface GanttPptxGeometryConfig {
  readonly slideWidthIn: number;
  readonly slideHeightIn: number;
  readonly hierarchyColWidthIn: number;
  readonly rowHeightIn: number;
  readonly headerHeightIn: number;
  readonly footerHeightIn: number;
}

export const DEFAULT_GANTT_PPTX_GEOMETRY: GanttPptxGeometryConfig = Object.freeze({
  slideWidthIn: 13.333, // 16:9 widescreen
  slideHeightIn: 7.5,
  hierarchyColWidthIn: 3.5,
  rowHeightIn: 0.28,
  headerHeightIn: 0.5,
  footerHeightIn: 0.4,
});

export interface GanttPptxSlidePlanInput {
  readonly scope: GanttVisibleScopeResult; // Story 7.3's resolver output (AD-12's GanttVisible)
  readonly phases: readonly Phase[];
  readonly nodes: readonly Node[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly projectName: string;
  readonly generatedAt: string; // injected clock, ISO instant
  readonly geometry?: Partial<GanttPptxGeometryConfig>;
}

export interface GanttPptxHierarchyLabel {
  readonly nodeId: string;
  readonly text: string;
  readonly xIn: number;
  readonly yIn: number;
  readonly wIn: number;
  readonly hIn: number;
  readonly bold: boolean;
}

export interface GanttPptxBar {
  readonly nodeId: string;
  readonly xIn: number;
  readonly yIn: number;
  readonly wIn: number;
  readonly hIn: number;
  readonly kind: 'authored' | 'derived';
  readonly label: string;
  readonly isClippedLeft: boolean;
  readonly isClippedRight: boolean;
  readonly workstreamHueIndex: number | null; // 1..6, carried verbatim from the row — no recomputation
}

export interface GanttPptxPhaseBand {
  readonly phaseId: string;
  readonly label: string;
  readonly xIn: number;
  readonly yIn: number;
  readonly wIn: number;
  readonly hIn: number;
}

export interface GanttPptxDependencyLine {
  readonly edgeId: string;
  readonly points: readonly { readonly xIn: number; readonly yIn: number }[];
  readonly isViolating: boolean;
}

export interface GanttPptxHeaderColumn {
  readonly label: string;
  readonly xIn: number;
  readonly wIn: number;
}

export interface GanttPptxSlidePlan {
  readonly hierarchyLabels: readonly GanttPptxHierarchyLabel[];
  readonly bars: readonly GanttPptxBar[];
  readonly phaseBands: readonly GanttPptxPhaseBand[];
  readonly dependencyLines: readonly GanttPptxDependencyLine[];
  readonly headerColumns: readonly GanttPptxHeaderColumn[];
  readonly footerStamp: string;
  readonly exclusionSummary: string;
}

/** Format an ISO YYYY-MM-DD date as "D Mon YYYY" (deterministic, no system clock). */
function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

export function buildGanttPptxSlidePlan(input: GanttPptxSlidePlanInput): GanttPptxSlidePlan {
  const geometry: GanttPptxGeometryConfig = { ...DEFAULT_GANTT_PPTX_GEOMETRY, ...input.geometry };
  const { scope } = input;
  const { window } = scope;

  // Gantt area: from hierarchy column right edge to slide width.
  const ganttLeftIn = geometry.hierarchyColWidthIn;
  const ganttWidthIn = Math.max(1, geometry.slideWidthIn - ganttLeftIn - 0.3);
  const timelineTopIn = geometry.headerHeightIn;

  const totalDays = Math.max(
    1,
    (() => {
      const start = new Date(window.dateWindowStart).getTime();
      const end = new Date(window.dateWindowEnd).getTime();
      return Math.round((end - start) / 86_400_000) + 1;
    })(),
  );
  const unitsPerDay = ganttWidthIn / totalDays;

  const dateToUnit = createDateToUnit({
    windowStart: window.dateWindowStart,
    windowEnd: window.dateWindowEnd,
    unitsPerDay,
    totalUnits: ganttWidthIn,
  });

  // 1. Hierarchy labels (left column), row placement mirrors GanttHierarchyColumn's indentation.
  const hierarchyLabels: GanttPptxHierarchyLabel[] = [];
  const bars: GanttPptxBar[] = [];

  scope.visibleRows.forEach((row, index) => {
    const topIn = timelineTopIn + index * geometry.rowHeightIn;
    const indentIn = row.depth * 0.22 + 0.05;
    const isCollapsedParent = row.barKind === 'derived' && row.hasChildren;

    hierarchyLabels.push(
      Object.freeze({
        nodeId: row.nodeId,
        text: row.title,
        xIn: indentIn,
        yIn: topIn,
        wIn: geometry.hierarchyColWidthIn - indentIn - 0.05,
        hIn: geometry.rowHeightIn,
        bold: row.barKind === 'derived' && isCollapsedParent,
      }),
    );

    const startUnit = dateToUnit(row.startDate, false);
    const endUnit = dateToUnit(row.endDate, true);
    const isClippedLeft = row.startDate < window.dateWindowStart;
    const isClippedRight = row.endDate > window.dateWindowEnd;
    const barLeft = ganttLeftIn + startUnit;
    const barWidth = Math.max(unitsPerDay, endUnit - startUnit);

    bars.push(
      Object.freeze({
        nodeId: row.nodeId,
        xIn: barLeft,
        yIn: topIn + 0.03,
        wIn: barWidth,
        hIn: 0.22,
        kind: row.barKind,
        label: row.title,
        isClippedLeft,
        isClippedRight,
        workstreamHueIndex: row.workstreamHueIndex,
      }),
    );
  });

  // 2. Phase bands (reuse resolveGanttPhases verbatim).
  const phaseBands = resolveGanttPhases({
    phases: input.phases,
    nodes: input.nodes,
    dateToX: (d, isEnd) => ganttLeftIn + dateToUnit(d, isEnd),
    windowStart: window.dateWindowStart,
    windowEnd: window.dateWindowEnd,
  }).map((band) =>
    Object.freeze({
      phaseId: band.phaseId,
      label: band.phaseName,
      xIn: band.startX,
      yIn: geometry.slideHeightIn - geometry.footerHeightIn - 0.18,
      wIn: Math.max(0.2, band.endX - band.startX),
      hIn: 0.18,
    }),
  );

  // 3. Dependency lines (reuse resolveGanttDependencies verbatim, inches).
  const dependencyLines = resolveGanttDependencies({
    visibleRows: scope.visibleRows,
    unlockEdges: input.unlockEdges,
    dateToX: (d, isEnd) => ganttLeftIn + dateToUnit(d, isEnd),
    rowHeight: geometry.rowHeightIn,
    headerOffset: timelineTopIn,
  }).map((route) =>
    Object.freeze({
      edgeId: route.edgeId,
      points: Object.freeze(route.vertices.map((v) => Object.freeze({ xIn: v.x, yIn: v.y }))),
      isViolating: route.isViolating,
    }),
  );

  // 4. Header columns from scope.headerColumns (already pixel-width'd; re-derive inch widths).
  //    Only major interval columns are exported — minor sub-interval guides are
  //    a screen-only presentation aid (E14-NFR1 parity).
  const headerColumns: GanttPptxHeaderColumn[] = scope.headerColumns
    .filter((col) => col.level === 'major')
    .map((col) => {
      const colStart = dateToUnit(col.startDate, false);
      const colEnd = dateToUnit(col.endDate, true);
      return Object.freeze({
        label: col.label,
        xIn: ganttLeftIn + colStart,
        wIn: Math.max(0.05, colEnd - colStart),
      });
    });

  // 5. Footer stamp + exclusion summary.
  const stampTime = formatIsoDate(input.generatedAt.slice(0, 10));
  const footerStamp = `${input.projectName} — Generated ${stampTime}`;

  const exclusions: string[] = [];
  if (scope.undatedCount > 0) exclusions.push(`${scope.undatedCount} undated`);
  if (scope.outOfWindowCount > 0) exclusions.push(`${scope.outOfWindowCount} out of window`);
  if (scope.collapsedCount > 0) exclusions.push(`${scope.collapsedCount} collapsed`);
  const exclusionSummary = exclusions.length > 0 ? `Excluded: ${exclusions.join(', ')}` : 'No exclusions';

  return Object.freeze({
    hierarchyLabels: Object.freeze(hierarchyLabels),
    bars: Object.freeze(bars),
    phaseBands: Object.freeze(phaseBands),
    dependencyLines: Object.freeze(dependencyLines),
    headerColumns: Object.freeze(headerColumns),
    footerStamp,
    exclusionSummary,
  });
}

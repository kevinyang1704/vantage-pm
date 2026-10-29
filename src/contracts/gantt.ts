/**
 * Gantt contracts (Story 7.1, AD-2, AD-11).
 *
 * Defines the types for the hierarchical Gantt timeline projection.
 * Spans, rollups, and rows are pure derived projections and are never persisted.
 */

import type { NodeType, ScheduleSourceMode } from '../domain/tree/node.entity';

export type GanttBarKind = 'authored' | 'derived';

export interface GanttRow {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly title: string;
  readonly nodeType: NodeType | null;
  readonly completed: boolean;
  readonly siblingIndex: number;
  readonly siblingSetSize: number;
  readonly hasChildren: boolean;
  readonly isCollapsed: boolean;
  readonly barKind: GanttBarKind;
  readonly startDate: string; // ISO YYYY-MM-DD
  readonly endDate: string;   // ISO YYYY-MM-DD
  readonly durationDays: number;
  readonly scheduleSourceMode: ScheduleSourceMode | null;
  readonly isExplicitOverride: boolean; // has authored dates while having descendants
  readonly workstreamId: string | null; // nearest Theme ancestor node id (self if this row is a Theme); null above the first Theme
  readonly workstreamHueIndex: number | null; // 1..6, assigned in document order and wrapped; null when workstreamId is null
}

export interface GanttProjection {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly rows: readonly GanttRow[];
  readonly totalProjectNodes: number;
  readonly datedNodeCount: number;
  readonly undatedCount: number;
  readonly minProjectDate: string | null; // ISO YYYY-MM-DD across all dated rows
  readonly maxProjectDate: string | null; // ISO YYYY-MM-DD across all dated rows
}

export type GanttGranularity = 'week' | 'month' | 'quarter';

export interface GanttWindowScope {
  readonly dateWindowStart: string; // ISO YYYY-MM-DD
  readonly dateWindowEnd: string;   // ISO YYYY-MM-DD
  readonly granularity: GanttGranularity;
}

export interface GanttHeaderColumn {
  readonly id: string;
  readonly label: string;
  readonly subLabel?: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly pixelWidth: number;
  /**
   * Semantic interval level (Epic 14, E14-AR3): `major` columns are the
   * granularity boundaries (month/quarter/week); `minor` columns are
   * sub-interval guides (e.g. week starts within a month view). Emphasis is
   * derived from this level, never from pixel position or DOM index.
   */
  readonly level: 'major' | 'minor';
}

export interface GanttVisibleScopeResult {
  readonly visibleRows: readonly GanttRow[];
  readonly totalProjectNodes: number;
  readonly datedNodeCount: number;
  readonly undatedCount: number;
  readonly outOfWindowCount: number;
  readonly collapsedCount: number;
  readonly window: GanttWindowScope;
  readonly headerColumns: readonly GanttHeaderColumn[];
}

export interface GanttDependencyRoute {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourceBarPoint: { readonly x: number; readonly y: number };
  readonly targetBarPoint: { readonly x: number; readonly y: number };
  readonly pathD: string; // SVG path data (orthogonal routing)
  readonly vertices: readonly { readonly x: number; readonly y: number }[]; // routable points (Story 8.3 Task 2) for line-segment renderers
  readonly isViolating: boolean; // target start < source end
}

export interface GanttPhaseBand {
  readonly phaseId: string;
  readonly phaseName: string;
  readonly position: number;
  readonly startDate: string; // ISO YYYY-MM-DD
  readonly endDate: string;   // ISO YYYY-MM-DD
  readonly startX: number;
  readonly endX: number;
}

/**
 * ViewScope contract (Story 8.1, AD-12, AD-2).
 *
 * Discriminated derived projection describing exactly what an export would
 * contain from the invoking view. Pure derived projection — never persisted,
 * never in a ChangeSet, never in the portable file (AD-2/AD-13).
 *
 * Each variant is a thin wrapper that re-expresses an existing view projection's
 * membership computation as ordered entity IDs plus exclusion metadata. It does
 * NOT re-walk the tree a second, competing way, and it does NOT replace the
 * three existing functions' own return shapes.
 */

import type { GanttWindowScope } from './gantt';

export type ScopeExclusionReason =
  | 'collapsed'
  | 'zoom-out-of-scope'
  | 'undated'
  | 'out-of-window';

export interface ScopeExclusion {
  readonly nodeId: string;
  readonly title: string;
  readonly reason: ScopeExclusionReason;
}

export interface OutlineVisibleScope {
  readonly kind: 'OutlineVisible';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly zoomRootId: string | null;
  readonly orderedNodeIds: readonly string[]; // matches VisibleOutlineRow order exactly
  readonly excluded: readonly ScopeExclusion[];
}

export interface VisualFocusScope {
  readonly kind: 'VisualFocus';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly themeId: string;
  readonly orderedNodeIds: readonly string[]; // matches VisualTreeNode pre-order exactly
  readonly nodeCount: number;
  readonly degraded: boolean; // echoes VisualTreeProjection.degraded, NFR-22
}

export interface GanttVisibleScope {
  readonly kind: 'GanttVisible';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly window: GanttWindowScope;
  readonly orderedNodeIds: readonly string[]; // matches GanttVisibleScopeResult.visibleRows order exactly
  readonly undatedCount: number;
  readonly outOfWindowCount: number;
  readonly collapsedCount: number;
}

export type ViewScope = OutlineVisibleScope | VisualFocusScope | GanttVisibleScope;

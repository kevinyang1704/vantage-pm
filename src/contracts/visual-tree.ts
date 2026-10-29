/**
 * Visual tree projection contract (Story 6.1 Task 1, AD-2, AD-11, AD-12, FR-63..66, NFR-22).
 *
 * Pure derived projection of exactly one theme's subtree — never persisted,
 * never in a ChangeSet, no SQLite table.
 */

import type { NodeType, ScheduleSourceMode } from '../domain/tree/node.entity';

export interface VisualTreeNode {
  readonly nodeId: string;
  /** Containment parent within this projection's scope; null only for the focused theme root
   * (its true domain parentId may point outside scope and is intentionally not exposed here — AC1). */
  readonly parentId: string | null;
  readonly title: string;
  readonly nodeType: NodeType | null;
  readonly startDate: string | null; // ISO YYYY-MM-DD, resolved via deriveNodeSchedule (AD-8)
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly scheduleSourceMode: ScheduleSourceMode | null;
  readonly completed: boolean;
  readonly depth: number; // 0 = theme root
  readonly siblingIndex: number; // 0-based, resolved via compareVisualSiblingOrder (AC2)
  readonly siblingSetSize: number;
}

export interface VisualTreeOutsideEndpoint {
  readonly nodeId: string;
  readonly title: string;
  readonly themeId: string | null; // nearest-theme-ancestor of the outside node; null if none
  readonly themeName: string | null;
}

export interface VisualTreeUnlockEdge {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly sourceInSubtree: boolean;
  readonly targetInSubtree: boolean;
  /** Populated iff exactly one of sourceInSubtree/targetInSubtree is false (AC1). */
  readonly outsideEndpoint: VisualTreeOutsideEndpoint | null;
}

export interface VisualTreeProjection {
  readonly themeId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly nodes: readonly VisualTreeNode[]; // theme root + all structural descendants, pre-order
  readonly unlockEdges: readonly VisualTreeUnlockEdge[]; // at least one endpoint inside the subtree
  readonly nodeCount: number; // always nodes.length; never truncated (AC4)
  readonly degraded: boolean; // nodeCount > renderLimit
  readonly renderLimit: number; // 300, NFR-22
}
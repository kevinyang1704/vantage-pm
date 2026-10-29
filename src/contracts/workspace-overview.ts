/**
 * Workspace overview contract (Story 5.1, AD-2, FR-3; Epic 24).
 *
 * Pure derived projection — never persisted, never in ChangeSet, never
 * in the portable file. Keyed only by the canonical projectRevision.
 *
 * Epic 24 extends the row with the Feature delivery-status distribution and
 * a compact, revision-consistent Feature list used by the expandable,
 * read-only theme details (DO-FR1/D, DO-FR6/F, DO-NFR1). The list is
 * presentation data only: no bodies, no private metadata, and no new
 * persistence or schema version.
 */

import type { DeliveryStatus } from '../domain/tree/node.entity';

export interface ProjectRevisionEntry {
  readonly projectId: string;
  readonly projectRevision: number;
}

/** Fixed status buckets, in canonical display order (DO-UX2). */
export interface WorkspaceStatusCounts {
  readonly notStarted: number;
  readonly inProgress: number;
  readonly delivered: number;
}

/**
 * One Feature listed beneath a theme summary. Identity is the stable node id;
 * `title` is the authored title (empty string is preserved — the presentation
 * layer applies the existing Untitled fallback). `deliveryStatus` is the raw
 * existing read-path status; nothing is inferred from completed flags or
 * parent status (AC 24.1-1).
 */
export interface WorkspaceFeatureRow {
  readonly featureId: string;
  readonly title: string;
  readonly deliveryStatus: DeliveryStatus;
}

export interface WorkspaceThemeRow {
  readonly themeId: string;
  readonly themeName: string;
  readonly featureCount: number;
  readonly effortShare: number | null;
  readonly spanShare: number | null;
  readonly strategyShare: number | null;
  readonly phase: Readonly<{ phaseId: string; phaseName: string; index: number; count: number }> | null;
  readonly spanStartDate: string | null;
  readonly spanEndDate: string | null;
  readonly coherenceState: 'clear' | 'flagged';
  readonly openFindingCount: number;
  readonly findingCounts: Readonly<{
    orphan: number;
    sequencing: number;
    effort: number;
  }>;
  /** Feature delivery-status buckets for this theme's attributed Features. */
  readonly statusCounts: WorkspaceStatusCounts;
  /**
   * This theme's Features, pre-order (containment/document order), each once.
   * Bounded presentation data for the expandable read-only details.
   */
  readonly features: readonly WorkspaceFeatureRow[];
}

export interface WorkspaceProjectRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRevision: number;
  readonly nodeCount: number;
  readonly phaseCount: number;
  readonly featureCount: number;
  /** Project-wide Feature status buckets, including unattributed Features. */
  readonly statusCounts: WorkspaceStatusCounts;
  /**
   * Features whose nearest Theme ancestor is null. Non-zero only when project
   * totals exceed the sum of the displayed theme buckets (AC 24.1-2).
   */
  readonly unattributedFeatureCount: number;
  readonly openFindingCount: number;
  readonly coverage: Readonly<{
    weightCoveragePercentage: number;
    effortCoveragePercentage: number;
    scheduleCoveragePercentage: number;
  }>;
  readonly themes: readonly WorkspaceThemeRow[];
}

export interface WorkspaceOverviewProjection {
  readonly revisionVector: readonly ProjectRevisionEntry[];
  readonly projects: readonly WorkspaceProjectRow[];
  readonly limitWarning: Readonly<{
    exceededProjectCount: boolean;
    observedProjectCount: number;
    supportedProjectCount: number;
    overLimitNodeProjects: readonly Readonly<{ projectId: string; nodeCount: number; supportedNodeCount: number }>[];
  }> | null;
}

export function createWorkspaceOverviewProjection(
  revisionVector: readonly ProjectRevisionEntry[],
  projects: readonly WorkspaceProjectRow[],
  limitWarning: WorkspaceOverviewProjection['limitWarning'] = null,
): WorkspaceOverviewProjection {
  return Object.freeze({
    revisionVector: Object.freeze(
      revisionVector.map((e) => Object.freeze({ ...e })),
    ),
    projects: Object.freeze(
      projects.map((p) => Object.freeze({ ...p })),
    ),
    limitWarning,
  });
}

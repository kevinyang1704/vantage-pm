/**
 * Workspace overview projection (Story 5.1 Task 4, AD-2, FR-3; Epic 24).
 *
 * Pure functional-core projection: maps per-project snapshots to
 * WorkspaceProjectRow rows, deterministically sorted. No I/O, no worker,
 * no SQLite, no React (AD-1).
 *
 * Epic 24 adds the Feature delivery-status distribution and a bounded,
 * revision-consistent Feature list per theme. Both reuse the existing
 * canonical theme attribution and the existing read-path delivery status —
 * no new status model, stage, inferred completion, or migration (DO-NFR1).
 */

import type { Node } from '../../domain/tree/node.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { FindingDismissal, CoherenceFinding, StrategicImbalanceFinding } from '../../contracts/analysis-protocol';
import type {
  WorkspaceOverviewProjection,
  WorkspaceProjectRow,
  WorkspaceStatusCounts,
  WorkspaceThemeRow,
  WorkspaceFeatureRow,
} from '../../contracts/workspace-overview';
import {
  createWorkspaceOverviewProjection,
} from '../../contracts/workspace-overview';
import { detectOrphanedFeatures } from '../../domain/analysis/orphan-policy';
import {
  detectPhaseSequencingConflicts,
  detectDateSequencingConflicts,
} from '../../domain/analysis/sequencing-conflict.policy';
import { detectUnlockCycles } from '../../domain/analysis/cycle-policy';
import { filterActiveFindings } from '../../domain/analysis/dismissal-filter.policy';
import { computeThemeRollup, computeStrategicEffortBalance } from '../../domain/analysis/strategic-balance.policy';
import { attributeNodesToNearestTheme } from '../../domain/analysis/theme-attribution.policy';
import { deriveNodeSchedule } from '../../domain/tree/schedule.policy';

export interface ProjectAnalysisInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRevision: number;
  readonly nodes: readonly Node[];
  readonly phases: readonly Phase[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly dismissals: readonly FindingDismissal[];
}

function findNode(nodes: readonly Node[], id: string): Node | undefined {
  return nodes.find((n) => n.id === id);
}

/**
 * Group every Feature under its nearest Theme ancestor, in a single
 * containment pre-order pass, keyed by theme id. Matches the ordering
 * `getDescendantNodes` produced, but is O(nodes) overall instead of
 * O(themes x nodes) — the per-theme descendant walk rebuilt a full children
 * map on every call and did not hold at the supported 5,000-node scale
 * (AC 24.4-4). A nested Theme resets the current attribution, so each Feature
 * lands in exactly one bucket. Duplicate node ids are emitted once.
 *
 * `attribution` (the canonical nearest-theme map) is the authority: any
 * Feature the pre-order walk could not reach — a containment cycle, or a
 * subtree whose root is only reachable through itself — falls back to its
 * attributed theme, so buckets still reconcile with `attributeNodesToNearestTheme`.
 */
export function groupFeaturesByTheme(
  nodes: readonly Node[],
  attribution: ReadonlyMap<string, string | null>,
): ReadonlyMap<string, readonly WorkspaceFeatureRow[]> {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const childrenOf = new Map<string, Node[]>();
  for (const n of nodes) {
    const parentKey = n.parentId && nodeMap.has(n.parentId) ? n.parentId : '__root__';
    const list = childrenOf.get(parentKey);
    if (list) list.push(n);
    else childrenOf.set(parentKey, [n]);
  }

  const byTheme = new Map<string, WorkspaceFeatureRow[]>();
  const emitted = new Set<string>();
  const bucket = (themeId: string, node: Node): void => {
    let list = byTheme.get(themeId);
    if (!list) {
      list = [];
      byTheme.set(themeId, list);
    }
    list.push(
      Object.freeze({
        featureId: node.id,
        title: node.title,
        deliveryStatus: node.deliveryStatus,
      }),
    );
  };

  // Iterative pre-order carrying the nearest Theme ancestor as attribution.
  const stack: { node: Node; themeId: string | null }[] = [];
  const roots = childrenOf.get('__root__') ?? [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push({ node: roots[i], themeId: roots[i].nodeType === 'Theme' ? roots[i].id : null });
  }

  while (stack.length > 0) {
    const { node, themeId } = stack.pop()!;
    if (emitted.has(node.id)) continue;
    emitted.add(node.id);

    if (node.nodeType === 'Feature' && themeId !== null) {
      bucket(themeId, node);
    }

    const children = childrenOf.get(node.id);
    if (!children) continue;
    const childTheme = node.nodeType === 'Theme' ? node.id : themeId;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], themeId: childTheme });
    }
  }

  // Reachability fallback: any Feature the walk missed (cycle / unreachable
  // subtree) is placed by the canonical attribution so buckets reconcile.
  for (const n of nodes) {
    if (emitted.has(n.id)) continue;
    if (n.nodeType !== 'Feature') continue;
    const attributed = attribution.get(n.id) ?? null;
    if (attributed !== null) {
      emitted.add(n.id);
      bucket(attributed, n);
    }
  }

  return byTheme;
}

function addStatus(counts: {
  notStarted: number;
  inProgress: number;
  delivered: number;
}, status: Node['deliveryStatus']): void {
  if (status === 'in_progress') counts.inProgress += 1;
  else if (status === 'delivered') counts.delivered += 1;
  else counts.notStarted += 1;
}

function freezeCounts(counts: {
  notStarted: number;
  inProgress: number;
  delivered: number;
}): WorkspaceStatusCounts {
  return Object.freeze({
    notStarted: counts.notStarted,
    inProgress: counts.inProgress,
    delivered: counts.delivered,
  });
}

export function projectWorkspaceProjectRow(input: ProjectAnalysisInput): WorkspaceProjectRow {
  const { nodes, phases, unlockEdges, dismissals } = input;

  const orphans = detectOrphanedFeatures(nodes, unlockEdges);
  const phaseConflicts = detectPhaseSequencingConflicts(nodes, phases, unlockEdges);
  const dateConflicts = detectDateSequencingConflicts(nodes, unlockEdges);
  const cycles = detectUnlockCycles(nodes, unlockEdges);
  const imbalances = computeStrategicEffortBalance(nodes);

  const allTreeFindings: CoherenceFinding[] = [
    ...orphans,
    ...phaseConflicts,
    ...dateConflicts,
    ...cycles,
  ];
  const activeFindings = filterActiveFindings(allTreeFindings, dismissals);
  const activeImbalances = filterActiveFindings(imbalances, dismissals) as readonly StrategicImbalanceFinding[];

  const attribution = attributeNodesToNearestTheme(nodes);
  const rollup = computeThemeRollup(nodes);

  const phaseList = [...phases].sort((a, b) => {
    if (a.position < b.position) return -1;
    if (a.position > b.position) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // Project-wide Feature counts: every current Feature contributes once,
  // including Features with no nearest Theme ancestor (AC 24.1-2).
  const featureNodes = nodes.filter((n) => n.nodeType === 'Feature');
  const projectTally = { notStarted: 0, inProgress: 0, delivered: 0 };
  let unattributedFeatureCount = 0;
  for (const feature of featureNodes) {
    addStatus(projectTally, feature.deliveryStatus);
    if (attribution.get(feature.id) === null) unattributedFeatureCount += 1;
  }

  const featuresByTheme = groupFeaturesByTheme(nodes, attribution);

  const themes: WorkspaceThemeRow[] = rollup.map((row) => {
    const themeNode = findNode(nodes, row.themeId);

    // Features attributed to this theme, in containment/document pre-order,
    // each once (AC 24.1-1, 24.3-2). Grouped in one pass over all nodes.
    const themeFeatures: readonly WorkspaceFeatureRow[] =
      featuresByTheme.get(row.themeId) ?? Object.freeze([]);
    const themeTally = { notStarted: 0, inProgress: 0, delivered: 0 };
    for (const feature of themeFeatures) addStatus(themeTally, feature.deliveryStatus);

    const themeFindings = activeFindings.filter(
      (f) => attribution.get(f.targetNodeId) === row.themeId,
    );
    const orphanCount = themeFindings.filter((f) => f.kind === 'OrphanedFeature').length;
    const sequencingCount = themeFindings.filter(
      (f) =>
        f.kind === 'PhaseSequencingConflict' ||
        f.kind === 'DateSequencingConflict' ||
        f.kind === 'UnlockCycle',
    ).length;
    const effortCount = activeImbalances.filter(
      (f) => attribution.get(f.targetNodeId) === row.themeId,
    ).length;

    const phaseId = themeNode?.phaseId ?? null;
    const phaseIndex = phaseId ? phaseList.findIndex((p) => p.id === phaseId) : -1;
    const phase =
      phaseId && phaseIndex >= 0
        ? Object.freeze({
            phaseId,
            phaseName: phaseList[phaseIndex].name,
            index: phaseIndex,
            count: phaseList.length,
          })
        : null;

    const openFindingCount = themeFindings.length + effortCount;

    // A Theme's own authored dates take precedence over the derived descendant
    // span, so a scheduled zero-Feature theme shows its authored span instead
    // of a false "Not scheduled" (AC 24.2-3). One-sided authored dates merge
    // with the derived span rather than dropping a valid derived side, and an
    // invalid authored schedule is surfaced as-is (never masked by a valid
    // derived span). With no authored dates, the canonical derived span is
    // used unchanged — canonical span derivation is not altered.
    const themeSchedule = themeNode
      ? deriveNodeSchedule({
          startDate: themeNode.startDate,
          endDate: themeNode.endDate,
          durationDays: themeNode.durationDays,
          sourceMode: themeNode.scheduleSourceMode,
        })
      : null;
    const hasAuthoredThemeDate = Boolean(themeNode?.startDate || themeNode?.endDate);
    let spanStartDate = row.spanStartDate;
    let spanEndDate = row.spanEndDate;
    if (themeSchedule && hasAuthoredThemeDate) {
      if (!themeSchedule.isValid) {
        // Reversed/malformed authored dates: report them so the lane shows an
        // explicit invalid state (AC 24.2-3).
        spanStartDate = themeSchedule.startDate;
        spanEndDate = themeSchedule.endDate;
      } else {
        spanStartDate = themeSchedule.startDate ?? row.spanStartDate;
        spanEndDate = themeSchedule.endDate ?? row.spanEndDate;
      }
    }

    return Object.freeze({
      themeId: row.themeId,
      themeName: row.themeName,
      featureCount: themeFeatures.length,
      effortShare: row.effortShare !== null ? Math.round(row.effortShare) : null,
      spanShare: row.spanShare !== null ? Math.round(row.spanShare) : null,
      strategyShare:
        row.strategicWeightShare !== null ? Math.round(row.strategicWeightShare) : null,
      phase,
      spanStartDate,
      spanEndDate,
      coherenceState: openFindingCount > 0 ? 'flagged' : 'clear',
      openFindingCount,
      findingCounts: Object.freeze({
        orphan: orphanCount,
        sequencing: sequencingCount,
        effort: effortCount,
      }),
      statusCounts: freezeCounts(themeTally),
      features: Object.freeze(themeFeatures),
    });
  });

  const themeRows = themes.sort((a, b) => {
    if (a.themeId < b.themeId) return -1;
    if (a.themeId > b.themeId) return 1;
    return 0;
  });

  const openFindingCount = activeFindings.length;

  return Object.freeze({
    projectId: input.projectId,
    projectName: input.projectName,
    projectRevision: input.projectRevision,
    nodeCount: nodes.length,
    phaseCount: phases.length,
    featureCount: featureNodes.length,
    statusCounts: freezeCounts(projectTally),
    unattributedFeatureCount,
    openFindingCount,
    coverage: Object.freeze({
      weightCoveragePercentage: coverageRate(rollup, (r) => r.strategicWeight !== null),
      effortCoveragePercentage: coverageRate(rollup, (r) => r.frontierEffort !== null),
      scheduleCoveragePercentage: coverageRate(rollup, (r) => r.totalSpanDays !== null),
    }),
    themes: Object.freeze(themeRows),
  });
}

function coverageRate(
  rollup: readonly import('../../domain/analysis/strategic-balance.policy').ThemeRollupRow[],
  present: (row: import('../../domain/analysis/strategic-balance.policy').ThemeRollupRow) => boolean,
): number {
  if (rollup.length === 0) return 0;
  return Math.round((rollup.filter(present).length / rollup.length) * 100);
}

export function projectWorkspaceOverview(
  inputs: readonly ProjectAnalysisInput[],
): WorkspaceOverviewProjection {
  const sorted = [...inputs].sort(compareByProjectId);
  const projects = sorted.map((i) => projectWorkspaceProjectRow(i));
  return assembleWorkspaceOverview(projects);
}

export const SUPPORTED_PROJECT_COUNT = 10;
export const SUPPORTED_NODE_COUNT = 5_000;

function compareByProjectId(a: { projectId: string }, b: { projectId: string }): number {
  if (a.projectId < b.projectId) return -1;
  if (a.projectId > b.projectId) return 1;
  return 0;
}

export function computeLimitWarning(
  projects: readonly WorkspaceProjectRow[],
): WorkspaceOverviewProjection['limitWarning'] {
  const exceededProjectCount = projects.length > SUPPORTED_PROJECT_COUNT;
  const overLimitNodeProjects = projects
    .filter((p) => p.nodeCount > SUPPORTED_NODE_COUNT)
    .map((p) =>
      Object.freeze({
        projectId: p.projectId,
        nodeCount: p.nodeCount,
        supportedNodeCount: SUPPORTED_NODE_COUNT,
      }),
    );

  if (!exceededProjectCount && overLimitNodeProjects.length === 0) {
    return null;
  }

  return Object.freeze({
    exceededProjectCount,
    observedProjectCount: projects.length,
    supportedProjectCount: SUPPORTED_PROJECT_COUNT,
    overLimitNodeProjects: Object.freeze(overLimitNodeProjects),
  });
}

/**
 * Assemble the final projection from per-project rows: sorts deterministically,
 * truncates to the supported subset when the limit is exceeded, and computes
 * the aggregate limit warning over the full observed set.
 * Shared by the pure path and the live repository-worker path so they cannot drift.
 */
export function assembleWorkspaceOverview(
  projects: readonly WorkspaceProjectRow[],
): WorkspaceOverviewProjection {
  const sorted = [...projects].sort(compareByProjectId);
  const limitWarning = computeLimitWarning(sorted);

  const visible = limitWarning
    ? sorted.slice(0, SUPPORTED_PROJECT_COUNT)
    : sorted;

  return createWorkspaceOverviewProjection(
    Object.freeze(
      visible.map((row) =>
        Object.freeze({ projectId: row.projectId, projectRevision: row.projectRevision }),
      ),
    ),
    Object.freeze(visible),
    limitWarning,
  );
}

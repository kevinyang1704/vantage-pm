/**
 * Native Tauri repository client (E9-FR4, E9-FR5).
 *
 * Implements the same exported surface as `repository-worker.client.ts`
 * but routes through the narrow typed Tauri command boundary. The webview
 * never receives raw SQL, paths, or stack traces — only sanitized unions.
 *
 * Only active when `__TAURI_NATIVE_BRIDGE__` is true (vite mode `tauri`).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ProductCommand, ProductCommandResult } from '../../contracts/repository-commands';
import type { OutlineReadModel, OutlineNodeReadModel } from '../../application/outline/outline-read-model';
import type {
  ViewId,
  ViewStateSnapshot,
  ViewStateFields,
  ViewStatePatch,
} from '../../contracts/view-state';
import type { WorkspaceOverviewProjection } from '../../contracts/workspace-overview';
import type { WorkspaceRegistry, WorkspaceMutationResult } from '../../contracts/workspace';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { FindingDismissal, AffectedReason, AnalysisSnapshotRequest } from '../../contracts/analysis-protocol';
import { createViewStateSnapshot, applyViewStatePatch } from '../../contracts/view-state';
import { WorkspaceSummaryCache } from './workspace-summary-cache';
import { projectWorkspaceOverview, assembleWorkspaceOverview } from '../../application/workspace/workspace-overview.projection';
import type { ProjectAnalysisInput } from '../../application/workspace/workspace-overview.projection';
import { coerceDeliveryStatus } from '../../domain/tree/node.entity';
import {
  canonicalizeForecastAssignments,
  createForecastSprintPlan,
  type ForecastPolicyVersion,
} from '../../domain/forecast/forecast-plan.entity';
import { normalizePersistedForecastScenario } from '../../domain/forecast/scenario';
import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';
import { calculateAcceptanceRatio } from '../../domain/tree/acceptance-criteria.policy';
import { resolveEffectiveField } from '../../domain/tree/field-inheritance.policy';
import { deriveAncestorSpan } from '../../domain/tree/schedule.policy';
import { computeNodeEdgeCounts } from '../../domain/edge/unlock-edge.policy';
import type {
  NativeProjectSnapshot,
  NativeProjectRow,
  NativeViewStateRow,
  NativePhaseRow,
  NativeUnlockEdgeRow,
} from './native-read-model';
import type { NativeStorageStatus } from '../platform/storage-health';
import type { PortableProjectSnapshot } from '../../contracts/portable-file.schema';
import { mapPhases, mapUnlockEdges, mapDismissals, mapAffectedReasons, mapDomainNodes } from './native-read-model';

declare const __TAURI_NATIVE_BRIDGE__: boolean;

const workspaceSummaryCache = new WorkspaceSummaryCache();
let unlistenFns: UnlistenFn[] = [];

/** Tracks whether the native runtime is open and ready. */
let nativeReady = false;

function normalizeNativePlanningLevel(level: string | null | undefined): 'Theme' | 'Component' | 'Feature' {
  return level === 'Theme' || level === 'Component' ? level : 'Feature';
}

/** Hooks for consumers that need revision-invalidation events. */
export type RevisionInvalidatedHandler = (projectId: string, revision: number) => void;
let revisionHandler: RevisionInvalidatedHandler | null = null;

export function onRevisionInvalidated(handler: RevisionInvalidatedHandler): void {
  revisionHandler = handler;
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

export async function initNativeBridge(): Promise<{ isOpfs: boolean }> {
  if (!nativeReady) {
    const result = await invokeNative<{ projectId: string; sqliteVersion: string; applicationId: number; userVersion: number; ready: boolean }>('repository_open');
    nativeReady = result.ready;
    const unlisten = await listen<{ projectId: string; revision: number }>(
      'repository:revision-invalidated',
      (event) => {
        revisionHandler?.(event.payload.projectId, event.payload.revision);
        workspaceSummaryCache.invalidate(event.payload.projectId);
      },
    );
    unlistenFns.push(unlisten);
  }
  // Native storage: OPFS is not used.
  return { isOpfs: false };
}

export async function resetNativeDatabase(): Promise<void> {
  await invokeNative<null>('repository_reset');
}

export async function applyNativeCommand(command: ProductCommand): Promise<ProductCommandResult> {
  return invokeNative<ProductCommandResult>('repository_apply', { command });
}

export async function queryNativeProjects(): Promise<readonly { id: string; name: string; revision: number }[]> {
  const rows = await invokeNative<NativeProjectRow[]>('repository_query_projects');
  return Object.freeze(rows.map((r) => Object.freeze({ id: r.id, name: r.name, revision: r.revision })));
}

export async function queryNativeProjectSnapshot(projectId: string): Promise<NativeProjectSnapshot> {
  return invokeNative<NativeProjectSnapshot>('repository_query_project_snapshot', { projectId });
}

export async function queryNativeProjectNodes(projectId: string): Promise<OutlineReadModel> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  return projectSnapshotToOutline(snapshot);
}

export async function queryNativeNodeEdges(
  projectId: string,
  nodeId: string,
): Promise<{ inbound: readonly UnlockEdge[]; outbound: readonly UnlockEdge[] }> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  const edges = mapUnlockEdges(snapshot.unlockEdges);
  const inbound: UnlockEdge[] = [];
  const outbound: UnlockEdge[] = [];
  for (const edge of edges) {
    if (edge.targetNodeId === nodeId) inbound.push(edge);
    if (edge.sourceNodeId === nodeId) outbound.push(edge);
  }
  return Object.freeze({ inbound: Object.freeze(inbound), outbound: Object.freeze(outbound) });
}

export async function queryNativeSubtreeEdges(projectId: string, rootNodeId: string): Promise<readonly UnlockEdge[]> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  const edges = mapUnlockEdges(snapshot.unlockEdges);
  const rootNode = snapshot.nodes.find((n) => n.id === rootNodeId);
  if (!rootNode) return Object.freeze([]);

  // Collect subtree ids via DFS.
  const subtreeIds = new Set<string>();
  const visit = (id: string): void => {
    if (subtreeIds.has(id)) return;
    subtreeIds.add(id);
    for (const n of snapshot.nodes) {
      if (n.parentId === id) visit(n.id);
    }
  };
  visit(rootNodeId);

  return Object.freeze(
    edges.filter((e) => subtreeIds.has(e.sourceNodeId) || subtreeIds.has(e.targetNodeId)),
  );
}

export async function queryNativeDismissals(projectId: string): Promise<readonly FindingDismissal[]> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  return mapDismissals(snapshot.dismissals);
}

export async function queryNativeAffectedReasons(projectId: string): Promise<readonly AffectedReason[]> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  return mapAffectedReasons(snapshot.affectedReasons);
}

export async function queryNativeAnalysisSnapshot(projectId: string): Promise<AnalysisSnapshotRequest> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  const fp = snapshot.forecastPlan;
  return Object.freeze({
    type: 'AnalysisSnapshot',
    projectId: snapshot.projectId,
    projectRevision: snapshot.revision,
    nodes: mapDomainNodes(snapshot),
    phases: mapPhases(snapshot.phases),
    unlockEdges: mapUnlockEdges(snapshot.unlockEdges),
    dismissals: mapDismissals(snapshot.dismissals),
    // A corrupt stored plan arrives as a marker with no plan. Carry it, as the
    // browser worker does, so the forecast reports the damage while coherence
    // analysis keeps running — never an empty plan or roster.
    ...(snapshot.forecastPlanError ? { forecastPlanError: snapshot.forecastPlanError } : {}),
    // Epic 18, Story 18.2: native parity for the project-owned forecast plan.
    ...(fp
      ? {
          forecastPlan: Object.freeze({
            projectId: snapshot.projectId,
            selectedFeatureIds: Object.freeze([...fp.selectedFeatureIds]),
            parallelGroups: Object.freeze(
              fp.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
            ),
            blockedFeatureIds: Object.freeze([...(fp.blockedFeatureIds ?? [])]),
            configuration: Object.freeze({
              pointsPerSprint: fp.pointsPerSprint,
              sprintLengthDays: fp.sprintLengthDays,
              cadence: fp.cadence,
              startSprintOrdinal: fp.startSprintOrdinal,
              startDate: fp.startDate,
            }),
            policyVersion: fp.policyVersion as ForecastPolicyVersion,
            planningLevel: normalizeNativePlanningLevel(fp.planningLevel),
            roster: Object.freeze(
              (fp.roster ?? []).map((p) =>
                Object.freeze({
                  id: p.id,
                  name: p.name,
                  weightUnits: p.weightUnits,
                }),
              ),
            ),
            // Stored assignments, in the canonical form the browser reads
            // (Story 22.10, R1): replacing them with `{}` made every staffed
            // native plan analyse as incomplete after load, reload or resync.
            assignments: canonicalizeForecastAssignments(fp.assignments ?? {}),
            sprintPlan: createForecastSprintPlan(fp.sprintPlan),
          }),
        }
      : {}),
    ...((snapshot.forecastScenarios?.length ?? 0) > 0
      ? {
          forecastScenarios: Object.freeze(snapshot.forecastScenarios!.map(normalizePersistedForecastScenario)),
        }
      : {}),
  });
}

export async function queryNativeWorkspaceOverview(): Promise<WorkspaceOverviewProjection> {
  const projects = await queryNativeProjects();

  const rows = [];
  for (const p of projects) {
    const cached = workspaceSummaryCache.get(p.id, p.revision);
    if (cached) {
      rows.push(cached);
      continue;
    }
    const snapshot = await queryNativeProjectSnapshot(p.id);
    const input: ProjectAnalysisInput = Object.freeze({
      projectId: p.id,
      projectName: p.name,
      projectRevision: p.revision,
      nodes: mapDomainNodes(snapshot),
      phases: mapPhases(snapshot.phases),
      unlockEdges: mapUnlockEdges(snapshot.unlockEdges),
      dismissals: mapDismissals(snapshot.dismissals),
    });
    const row = projectWorkspaceOverview([input]).projects[0];
    workspaceSummaryCache.set(p.id, p.revision, row);
    rows.push(row);
  }

  return assembleWorkspaceOverview(rows);
}

// ── Epic 17: workspace registry ──────────────────────────────────────────

export async function queryNativeWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  return invokeNative<WorkspaceRegistry>('repository_query_workspace_registry');
}

/**
 * Apply a workspace mutation natively.
 *
 * The mutation union crosses the Tauri boundary as a tagged object; the Rust
 * side re-validates it (name rules, delete eligibility) rather than trusting
 * the webview, so a rejection here carries the same codes the browser path
 * produces.
 */
export async function mutateNativeWorkspace(
  mutation:
    | Readonly<{ kind: 'Create'; workspaceId: string; name: string }>
    | Readonly<{ kind: 'Rename'; workspaceId: string; name: string }>
    | Readonly<{ kind: 'Delete'; workspaceId: string }>
    | Readonly<{ kind: 'SetActive'; workspaceId: string }>
    | Readonly<{ kind: 'MoveProject'; projectId: string; workspaceId: string }>,
): Promise<WorkspaceMutationResult> {
  return invokeNative<WorkspaceMutationResult>('repository_mutate_workspace', { mutation });
}

export async function queryNativeViewState(projectId: string, viewId: ViewId): Promise<ViewStateSnapshot> {
  const row = await invokeNative<NativeViewStateRow | null>('repository_query_view_state', { projectId, viewId });
  if (!row) {
    return createViewStateSnapshot({ projectId, viewId, viewStateRevision: 0 });
  }

  let collapsed: readonly string[] = [];
  try {
    collapsed = JSON.parse(row.collapsedNodeIds) as string[];
  } catch {
    collapsed = [];
  }

  return createViewStateSnapshot({
    projectId,
    viewId,
    viewStateRevision: row.viewStateRevision,
    fields: {
      collapsedNodeIds: Object.freeze(collapsed),
      zoomRootId: row.zoomRootId,
      scrollTop: row.scrollTop,
      focusedThemeId: row.focusedThemeId,
      dateWindowStart: row.dateWindowStart,
      dateWindowEnd: row.dateWindowEnd,
      granularity: row.granularity as ViewStateFields['granularity'],
      navCollapsed: row.navCollapsed,
    },
  });
}

export async function updateNativeViewState(
  projectId: string,
  viewId: ViewId,
  baseRevision: number,
  patch: ViewStatePatch,
): Promise<{ kind: 'Applied'; snapshot: ViewStateSnapshot } | { kind: 'StaleBase'; snapshot: ViewStateSnapshot }> {
  const current = await queryNativeViewState(projectId, viewId);
  if (current.viewStateRevision !== baseRevision) {
    return { kind: 'StaleBase', snapshot: current };
  }

  const nextFields = applyViewStatePatch(current.fields, patch);
  const nextRevision = current.viewStateRevision + 1;

  const row: NativeViewStateRow = {
    projectId,
    viewId,
    viewStateRevision: nextRevision,
    collapsedNodeIds: JSON.stringify(nextFields.collapsedNodeIds),
    zoomRootId: nextFields.zoomRootId,
    scrollTop: nextFields.scrollTop,
    focusedThemeId: nextFields.focusedThemeId,
    dateWindowStart: nextFields.dateWindowStart,
    dateWindowEnd: nextFields.dateWindowEnd,
    granularity: nextFields.granularity,
    navCollapsed: nextFields.navCollapsed,
  };
  await invokeNative<null>('repository_upsert_view_state', { projectId, viewId, row });

  const snapshot = createViewStateSnapshot({
    projectId,
    viewId,
    viewStateRevision: nextRevision,
    fields: nextFields,
  });
  return { kind: 'Applied', snapshot };
}

export async function getNativeStorageStatus(): Promise<{ isOpfs: boolean }> {
  return { isOpfs: false };
}

/** Native runtime status for the storage-health derivation (E9-FR14). */
export async function getNativeStorageRuntimeStatus(): Promise<NativeStorageStatus> {
  return invokeNative<NativeStorageStatus>('repository_storage_status');
}

export async function closeNativeBridge(): Promise<void> {
  await invokeNative<null>('repository_close');
  for (const unlisten of unlistenFns) {
    unlisten();
  }
  unlistenFns = [];
  nativeReady = false;
}

// ── Outline projection (ported from repository.worker.ts) ──────────────────

export function projectSnapshotToOutline(snapshot: NativeProjectSnapshot): OutlineReadModel {
  const phases = mapPhases(snapshot.phases);
  const unlockEdges = mapUnlockEdges(snapshot.unlockEdges);
  const phaseMap = new Map<string, { name: string }>(phases.map((p) => [p.id, p]));

  const customFieldMap = new Map<string, Record<string, string>>();
  for (const f of snapshot.customFields) {
    let dict = customFieldMap.get(f.nodeId);
    if (!dict) {
      dict = {};
      customFieldMap.set(f.nodeId, dict);
    }
    if (f.fieldValue !== null) {
      dict[f.fieldKey] = f.fieldValue;
    }
  }

  const childrenMap = new Map<string | null, { id: string; nodeType: string | null; completed: boolean }[]>();
  const minimalNodes = new Map<string, { id: string; parentId: string | null; title: string }>();
  for (const r of snapshot.nodes) {
    minimalNodes.set(r.id, { id: r.id, parentId: r.parentId, title: r.title });
    let list = childrenMap.get(r.parentId);
    if (!list) {
      list = [];
      childrenMap.set(r.parentId, list);
    }
    list.push({ id: r.id, nodeType: r.nodeType, completed: r.completed });
  }

  // Open questions per node, pre-sorted by position ascending (Story 16.1 AC4).
  const questionsByNode = new Map<string, readonly import('../../domain/tree/node-question.entity').NodeOpenQuestion[]>();
  const rawQuestions = (snapshot as NativeProjectSnapshotWithOpenQuestions).openQuestions ?? [];
  for (const q of rawQuestions) {
    const list = questionsByNode.get(q.nodeId) ?? [];
    questionsByNode.set(q.nodeId, [
      ...list,
      Object.freeze({
        id: q.id,
        projectId: snapshot.projectId,
        nodeId: q.nodeId,
        questionText: q.questionText,
        status: q.status,
        decisionText: q.decisionText,
        position: BigInt(q.position),
        resolvedAtISO: q.resolvedAtISO,
        createdAtISO: q.createdAtISO,
      }),
    ]);
  }

  // Derived ancestor spans.
  const datedDescendantSpan = new Map<string, { startDate: string | null; endDate: string | null; durationDays: number | null }>();
  const collect = (nodeId: string): { startDate: string | null; endDate: string | null; durationDays: number | null } => {
    const cached = datedDescendantSpan.get(nodeId);
    if (cached) return cached;
    const childIds = childrenMap.get(nodeId) ?? [];
    const descendantDates: { startDate: string | null; endDate: string | null }[] = [];
    for (const child of childIds) {
      const row = snapshot.nodes.find((nr) => nr.id === child.id);
      if (row) {
        if (row.startDate) descendantDates.push({ startDate: row.startDate, endDate: row.endDate });
        else if (row.endDate) descendantDates.push({ startDate: null, endDate: row.endDate });
        const childSpan = collect(child.id);
        if (childSpan.startDate || childSpan.endDate) descendantDates.push(childSpan);
      }
    }
    const span = deriveAncestorSpan(descendantDates);
    datedDescendantSpan.set(nodeId, span);
    return span;
  };
  for (const r of snapshot.nodes) collect(r.id);

  const nodes: OutlineNodeReadModel[] = snapshot.nodes.map((r) => {
    const phaseId = r.phaseId;
    const phaseName = phaseId && phaseMap.has(phaseId) ? phaseMap.get(phaseId)!.name : null;

    const effectivePhase = resolveEffectiveField(minimalNodes, r.id, (nId) => {
      const row = snapshot.nodes.find((nr) => nr.id === nId);
      if (!row || !row.phaseId) return { kind: 'inherit' as const };
      const name = phaseMap.get(row.phaseId)?.name ?? row.phaseId;
      return { kind: 'explicit' as const, value: name };
    });

    const edgeCounts = computeNodeEdgeCounts(r.id, unlockEdges);
    const children = childrenMap.get(r.id) ?? [];
    const acceptance = calculateAcceptanceRatio(children);
    const span = datedDescendantSpan.get(r.id) ?? { startDate: null, endDate: null, durationDays: null };
    const hasAuthoredDates = r.startDate !== null || r.endDate !== null || r.durationDays !== null;

    return Object.freeze({
      id: r.id,
      parentId: r.parentId,
      title: r.title,
      bodyText: r.bodyText,
      position: BigInt(r.position),
      typeTag: r.nodeType ? formatNodeTypeTag(r.nodeType) : null,
      nodeType: r.nodeType,
      startDate: r.startDate,
      endDate: r.endDate,
      durationDays: r.durationDays,
      scheduleSourceMode: r.scheduleSourceMode,
      derivedStartDate: !hasAuthoredDates ? span.startDate : null,
      derivedEndDate: !hasAuthoredDates ? span.endDate : null,
      derivedDurationDays: !hasAuthoredDates ? span.durationDays : null,
      completed: r.completed,
      effortPoints: r.effortPoints,
      effortPointsDone: r.effortPointsDone ?? null,
      strategicWeight: r.strategicWeight,
      deliveryStatus: coerceDeliveryStatus(r.deliveryStatus),
      phaseId,
      phaseName,
      effectivePhaseName: effectivePhase.effectiveValue ?? null,
      effectivePhaseSource: effectivePhase.source,
      unlocksCount: edgeCounts.unlocksCount,
      unlockedByCount: edgeCounts.unlockedByCount,
      customFields: Object.freeze(customFieldMap.get(r.id) ?? {}),
      acceptanceSummary: r.nodeType === 'Feature' ? acceptance.ratioText : null,
      openQuestions: Object.freeze(questionsByNode.get(r.id) ?? Object.freeze([])),
    });
  });

  return Object.freeze({
    projectId: snapshot.projectId,
    projectRevision: snapshot.revision,
    nodes: Object.freeze(nodes),
    phases: Object.freeze(phases),
    unlockEdges: Object.freeze(unlockEdges),
  });
}

// ── Portable snapshot (E13 Task 2 native parity) ───────────────────────────

export async function queryNativePortableSnapshot(projectId: string): Promise<PortableProjectSnapshot> {
  const snapshot = await queryNativeProjectSnapshot(projectId);
  // Exporting would silently drop the plan the user still has on disk; fail
  // instead, exactly as the browser's `queryPortableSnapshot` does when
  // `readForecastPlan` throws `ForecastPlanCorruptError`.
  if (snapshot.forecastPlanError) {
    throw new Error(snapshot.forecastPlanError);
  }
  return Object.freeze({
    projectId: snapshot.projectId,
    projectName: snapshot.projectName,
    projectRevision: snapshot.revision,
    phases: Object.freeze(
      snapshot.phases.map((p) =>
        Object.freeze({ id: p.id, name: p.name, position: String(p.position) }),
      ),
    ),
    nodes: Object.freeze(
      snapshot.nodes.map((n) =>
        Object.freeze({
          id: n.id,
          parentId: n.parentId,
          title: n.title,
          bodyText: n.bodyText,
          position: String(n.position),
          nodeType: n.nodeType,
          startDate: n.startDate,
          endDate: n.endDate,
          durationDays: n.durationDays,
          scheduleSourceMode: n.scheduleSourceMode,
          completed: n.completed,
          effortPoints: n.effortPoints,
          effortPointsDone: n.effortPointsDone ?? null,
          strategicWeight: n.strategicWeight,
          phaseId: n.phaseId,
          deliveryStatus: coerceDeliveryStatus(n.deliveryStatus),
        }),
      ),
    ),
    nodeCustomFields: Object.freeze(
      snapshot.customFields.map((f) =>
        Object.freeze({ nodeId: f.nodeId, fieldKey: f.fieldKey, fieldValue: f.fieldValue }),
      ),
    ),
    typeTemplateFields: Object.freeze(
      (snapshot as NativeProjectSnapshotWithTemplates).typeTemplateFields?.map((t) =>
        Object.freeze({ nodeType: t.nodeType, fieldKey: t.fieldKey, fieldLabel: t.fieldLabel, position: t.position }),
      ) ?? [],
    ),
    unlockEdges: Object.freeze(
      snapshot.unlockEdges.map((e) =>
        Object.freeze({ id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId }),
      ),
    ),
    findingDismissals: Object.freeze(
      snapshot.dismissals.map((d) =>
        Object.freeze({
          findingId: d.findingId,
          findingKind: d.findingKind,
          targetId: d.targetId,
          fingerprint: d.fingerprint,
          dismissedAt: d.dismissedAt,
        }),
      ),
    ),
    affectedReasons: Object.freeze(
      snapshot.affectedReasons.map((r) =>
        Object.freeze({
          id: r.id,
          affectedNodeId: r.affectedNodeId,
          causalNodeId: r.causalNodeId,
          causalNodeTitle: r.causalNodeTitle,
          deltaDays: r.deltaDays,
          causalDateSummary: r.causalDateSummary,
          createdAt: r.createdAt,
          acknowledgedAt: r.acknowledgedAt,
        }),
      ),
    ),
    openQuestions: Object.freeze(
      (snapshot as NativeProjectSnapshotWithOpenQuestions).openQuestions?.map((q) =>
        Object.freeze({
          id: q.id,
          nodeId: q.nodeId,
          questionText: q.questionText,
          status: q.status,
          decisionText: q.decisionText,
          position: String(q.position),
          resolvedAtISO: q.resolvedAtISO,
          createdAtISO: q.createdAtISO,
        }),
      ) ?? [],
    ),
    ...((snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan
      ? {
          forecastPlan: Object.freeze({
            selectedFeatureIds: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.selectedFeatureIds,
            planningLevel: normalizeNativePlanningLevel(snapshot.forecastPlan?.planningLevel),
            parallelGroups: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.parallelGroups,
            ...(((snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.blockedFeatureIds?.length ?? 0) > 0
              ? { blockedFeatureIds: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.blockedFeatureIds }
              : {}),
            pointsPerSprint: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.pointsPerSprint,
            sprintLengthDays: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.sprintLengthDays,
            cadence: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.cadence,
            startSprintOrdinal: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.startSprintOrdinal,
            startDate: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.startDate,
            policyVersion: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.policyVersion,
              roster: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.roster ?? [],
              assignments: (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.assignments ?? {},
              ...((snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!.sprintPlan
                ? {
                    sprintPlan: (() => {
                      const native = (snapshot as NativeProjectSnapshotWithForecastPlan).forecastPlan!;
                      const sprintPlan = createForecastSprintPlan(native.sprintPlan);
                      // Same as the browser export: only items still in the plan.
                      return Object.freeze({
                        placements: Object.freeze(sprintPlan.placements.filter((p) => native.selectedFeatureIds.includes(p.itemId))),
                        capacities: sprintPlan.capacities,
                      });
                    })(),
                  }
                : {}),
            }),
        }
      : {}),
    ...(((snapshot as NativeProjectSnapshotWithForecastPlan).forecastScenarios?.length ?? 0) > 0
      ? {
          forecastScenarios: Object.freeze(
            snapshot.forecastScenarios!.map(normalizePersistedForecastScenario),
          ) as unknown as PortableProjectSnapshot['forecastScenarios'],
        }
      : {}),
  });
}

interface NativeProjectSnapshotWithTemplates {
  readonly typeTemplateFields?: readonly {
    readonly nodeType: string;
    readonly fieldKey: string;
    readonly fieldLabel: string;
    readonly position: number;
  }[];
}

interface NativeProjectSnapshotWithOpenQuestions {
  readonly openQuestions?: readonly {
    readonly id: string;
    readonly nodeId: string;
    readonly questionText: string;
    readonly status: 'OPEN' | 'DECIDED';
    readonly decisionText: string | null;
    readonly position: number;
    readonly resolvedAtISO: string | null;
    readonly createdAtISO: string;
  }[];
}

interface NativeProjectSnapshotWithForecastPlan {
  readonly forecastPlan?: {
    readonly selectedFeatureIds: readonly string[];
    readonly parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    readonly blockedFeatureIds?: readonly string[];
    readonly pointsPerSprint: number | null;
    readonly sprintLengthDays: number | null;
    readonly cadence: 'fixed-contiguous';
    readonly startSprintOrdinal: number | null;
    readonly startDate: string | null;
    readonly policyVersion: string;
    readonly roster?: readonly import('../../domain/forecast/forecast-plan.entity').ForecastPerson[];
    readonly assignments?: Readonly<Record<string, readonly string[]>>;
    readonly sprintPlan?: import('../../domain/forecast/forecast-plan.entity').ForecastSprintPlan;
  };
  readonly forecastScenarios?: readonly unknown[];
}

export async function batchImportNativePortable(
  snapshot: PortableProjectSnapshot,
  localFileStateJson?: string,
): Promise<{ ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string }> {
  const result = await invokeNative<{ ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string }>(
    'repository_batch_import_portable',
    { snapshot, localFileStateJson },
  );
  return result;
}

export async function readNativeCollaborationOutbox(projectId: string): Promise<import('../../application/collaboration/sync-client').OutboxState> {
  return invokeNative('repository_read_outbox', { projectId });
}
export async function discardNativeCollaborationOutboxEntry(projectId: string, commandId: string): Promise<void> {
  await invokeNative('repository_discard_outbox', { projectId, commandId });
}
export async function applyNativeCommandWithOutbox(command: ProductCommand, outbox: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>, projectId: string): Promise<ProductCommandResult> {
  const persisted: unknown = JSON.parse(outbox.commandJson);
  // The Rust boundary binds both typed commands and refuses mismatched payloads.
  return invokeNative('repository_commit_with_outbox', { projectId, command, entry: { commandId: outbox.commandId, command: persisted, commitAttemptId: outbox.commitAttemptId, queuedAtISO: outbox.queuedAtISO } });
}
/** A composite gesture's members + outbox entries in ONE native actor transaction. */
export async function applyNativeGroupWithOutbox(projectId: string, members: readonly Readonly<{ command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string }>[], groupId: string): Promise<readonly ProductCommandResult[]> {
  return invokeNative('repository_commit_group_with_outbox', {
    projectId,
    groupId,
    entries: members.map((member, index) => ({ commandId: member.command.commandId, command: JSON.parse(member.commandJson) as unknown, commitAttemptId: member.commitAttemptId, queuedAtISO: member.queuedAtISO, groupId, groupIndex: index })),
  });
}

export async function applyNativeRebaseAtomic(projectId: string, remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number }>, survivors: readonly import('../../application/collaboration/sync-client').OutboxEntry[], rejected: readonly Readonly<{ commandId: string; reason?: string }>[]): Promise<ProductCommandResult | null> {
  return invokeNative('repository_rebase', { projectId, remote, survivors, rejected: rejected.map((r) => ({ commandId: r.commandId, reason: r.reason ?? 'RebasePreconditionFailed' })) });
}

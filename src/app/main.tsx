/**
 * PMApp composition root (Epic 1, Epic 2, Epic 3, Epic 4).
 * Mounts the Meridian authoring shell, initializes SQLite repository handler,
 * wires view-state coalescing, undo engine, command palette, jump search,
 * dedicated analysis worker, coherence review panel, and affected work consequence review.
 */

import { createElement, Fragment, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/plus-jakarta-sans/index.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '../adapters/ui/theme/meridian.generated.css';
import './main.css';
import { AppShell } from '../adapters/ui/app-shell';
import { AppFrame } from '../adapters/ui/shell/app-frame';
import { SideNav } from '../adapters/ui/shell/side-nav';
import { TreeRegion } from '../adapters/ui/shell/tree-region';
import { StatusLine } from '../adapters/ui/shell/status-line';
import { Breadcrumb, type Crumb } from '../adapters/ui/shell/breadcrumb';
import { OutlineView, type OutlineViewHandle } from '../adapters/ui/outline/outline-view';
import { VisualTreeView } from '../adapters/ui/visual-tree/visual-tree-view';
import type { ViewportTransform } from '../application/visual-tree/viewport-transform';
import { ThemeChipRow } from '../adapters/ui/visual-tree/theme-chip-row';
import { GanttView } from './ui/gantt/GanttView';
import { ForecastWorkspace, type ForecastPlanningRow } from '../adapters/ui/forecast/forecast-workspace';
import { sortByTreeOrder } from '../adapters/ui/forecast/forecast-placement';
import { createForecastPlan, type ForecastPlan } from '../domain/forecast/forecast-plan.entity';
import { createForecastRefreshChain } from '../application/forecast-refresh-chain';
import {
  captureScenarioDraftContext,
  draftScenarioRecord,
  type ScenarioDraftContext,
} from '../application/forecast/scenario-draft-context';
import type { ScenarioSaveOutcome } from '../adapters/ui/forecast/scenario-compare';
import type { ForecastResult } from '../domain/forecast/forecast-result';
import { createUuidV7 as createForecastUuidV7, PROTOCOL_VERSION } from '../../spikes/phase-0-durability/src/command-receipt';
import {
  createConfigureForecastPlanWireCommand,
  createSetForecastMembershipWireCommand,
  createSetForecastBlockerWireCommand,
  createSetForecastPlanningLevelWireCommand,
  createCreateForecastScenarioWireCommand,
  createRemoveForecastScenarioWireCommand,
  createAddForecastPersonWireCommand,
  createUpdateForecastPersonWireCommand,
  createRemoveForecastPersonWireCommand,
  createSetForecastPolicyWireCommand,
  createMoveForecastFeatureWireCommand,
  createSetForecastAssignmentWireCommand,
} from '../contracts/repository-commands';
import {
  createConfigureForecastPlanCommand,
  createSetForecastMembershipCommand,
  createSetForecastBlockerCommand,
  createSetForecastPlanningLevelCommand,
  createCreateForecastScenarioCommand,
  createRemoveForecastScenarioCommand,
  createAddForecastPersonCommand,
  createUpdateForecastPersonCommand,
  createRemoveForecastPersonCommand,
  createSetForecastPolicyCommand,
  createMoveForecastFeatureCommand,
  createSetForecastAssignmentCommand,
  type ForecastParallelGroup,
} from '../domain/forecast';
import { diffForecastSequence } from '../application/forecast/forecast-sequence-diff';
import {
  listThemesInOrdinalOrder,
  resolveFocusedThemeId,
} from '../domain/visual/theme-focus-resolution.policy';
import {
  CommandSurfaceHost,
  type ActiveCommandSurface,
} from '../adapters/ui/command-surface/command-surface-host';
import { formatCommandRejection } from '../adapters/ui/command-feedback';
import { detectStorageHealth } from '../adapters/platform/storage-health';
import type { StorageHealthCategory } from '../adapters/platform/storage-health';
import {
  initWorkerDatabase,
  resetDatabase,
  applyProductCommand,
  applyProductCommandBatch,
  queryProjectNodes,
  queryProjects,
  queryViewState,
  updateViewState,
  queryDismissals,
  queryAffectedReasons,
  queryAnalysisSnapshot,
  queryWorkspaceOverview,
  queryWorkspaceRegistryForApp,
  mutateWorkspace,
  queryPortableSnapshot,
  batchImportPortable,
  isNativeBridge,
  releaseStorage,
} from '../adapters/persistence/repository-worker.client';
import {
  CommandQueueOrchestrator,
  type CommandDispatcher,
} from '../application/command-queue/command-queue-orchestrator';
import { createUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand as createDomainCreateProject } from '../domain/project/create-project.command';
import { createDeleteProjectCommand as createDomainDeleteProject } from '../domain/project/delete-project.command';
import { createRenameProjectCommand as createDomainRenameProject } from '../domain/project/rename-project.command';
import {
  createCreateProjectCommand,
  createDeleteProjectWireCommand,
  createRenameProjectCommand as createRenameProjectWireCommand,
  createCreateNodeWireCommand,
  createSetNodeTitleWireCommand,
  createSetNodeBodyTextWireCommand,
  createMoveNodeWireCommand,
  createDeleteSubtreeWireCommand,
  createDuplicateSubtreeWireCommand,
  createSetNodeTypeWireCommand,
  createSetNodeCustomFieldWireCommand,
  createPromoteFieldToTemplateWireCommand,
  createSetNodeScheduleWireCommand,
  createToggleNodeCompletedWireCommand,
  createSetNodeEffortWireCommand,
  createSetNodePointsDoneWireCommand,
  createSetNodeStatusWireCommand,
  createSetThemeWeightWireCommand,
  createCreatePhaseWireCommand,
  createRenamePhaseWireCommand,
  createMovePhaseWireCommand,
  createAssignNodePhaseWireCommand,
  createDeletePhaseWireCommand,
  createCreateUnlockEdgeWireCommand,
  createDeleteUnlockEdgeWireCommand,
  createDismissFindingWireCommand,
  createRecordAffectedReasonsWireCommand,
  createAcknowledgeAffectedReasonWireCommand,
  createClearNodeAffectedReasonsWireCommand,
  type ProductCommand,
  type ProductCommandResult,
  type ProductCommandApplied,
  type ProductCommandRejected,
} from '../contracts/repository-commands';
import type { OutlineReadModel } from '../application/outline/outline-read-model';
import type { DeliveryStatus, Node, NodeType, ScheduleSourceMode } from '../domain/tree/node.entity';
import { positionBetween, positionForAppend } from '../domain/tree/sibling-position.policy';
import { createMovePhaseCommand } from '../domain/phase/phase.commands';
import { ViewStateCoalescer } from '../application/view-state/view-state-coalescer';
import type { InteractionStatePort } from '../application/view-state/interaction-state.port';
import { UndoEngine } from '../application/undo/undo-engine';
import { NodeTitleIndex } from '../application/search/node-title-index';
import { createDefaultActionContext } from '../application/actions/action-context';
import type { ActionDeclaration } from '../application/actions/action';
import { AnalysisWorkerClient } from '../adapters/platform/analysis-worker.client';
import type {
  CoherenceFinding,
  StrategicImbalanceFinding,
  AffectedReason,
} from '../contracts/analysis-protocol';
import { calculateDownstreamAffectedWork } from '../domain/analysis/affected-reachability.policy';
import { projectCoherenceReview } from '../application/review/coherence-review.projection';
import { CoherenceReviewPanel } from '../adapters/ui/review/coherence-review-panel';
import { AffectedWorkPanel } from '../adapters/ui/review/affected-work-panel';
import type { ViewId } from '../contracts/view-state';
import type { WorkspaceOverviewProjection } from '../contracts/workspace-overview';
import { WorkspaceOverview } from '../adapters/ui/workspace/workspace-overview';
import { CollaborationMount } from '../adapters/ui/collaboration/collaboration-mount';
import { collaborationServiceOrigin } from '../application/collaboration/feature-flag';
import type { SyncState } from '../domain/collaboration/sync-state';
import type { WorkspaceRegistry } from '../contracts/workspace';
import { WorkspaceNameDialog } from '../adapters/ui/workspace/workspace-name-dialog';
import { formatWorkspaceDeleteRefusal } from '../domain/workspace/workspace.policy';
import { decideProjectSwitch } from '../application/workspace/decide-project-switch';
import {
  createDefaultSessionViewContext,
  sessionViewContextKey,
  type SessionViewContext,
} from '../application/workspace/session-view-context';
import { decideExportEligibility } from '../application/export/decide-export-eligibility';
import { formatExportScopeSentence } from '../application/export/format-export-scope-sentence';
import { resolveOutlineExportScope } from '../application/outline/resolve-outline-export-scope';
import { resolveVisualExportScope } from '../application/visual-tree/resolve-visual-export-scope';
import { resolveGanttExportScope } from '../application/gantt/resolve-gantt-export-scope';
import { resolveGanttVisibleScope } from '../application/gantt/gantt-scope';
import { projectGantt } from '../application/gantt/gantt.projection';
import type { ViewScope } from '../contracts/view-scope';
import type { ExportFormat } from '../contracts/export-protocol';
import { ExportPreviewModal, defaultExportFormatForScope } from '../adapters/ui/export/export-preview-modal';
import { exportGanttPptx } from '../application/export/export-gantt-pptx.use-case';
import { exportDocumentDocx, exportFeatureOnePagerDocx } from '../application/export/export-document-docx.use-case';
import { formatExportFailure } from '../adapters/ui/export-feedback';
import { publishExport, checkExportScopeFresh, type GeneratedPackage } from '../application/export/publish-export';
import { EXPORT_MIME_TYPES, saveGeneratedFile } from '../adapters/platform/save-generated-file';
import { exportProject, portableBackupFilename } from '../application/portable-file/export-project';
import { useLocalFileCollaboration } from './use-local-file-collaboration';
import { LocalFileDialog, LocalFileRecoveryDialog } from '../adapters/ui/collaboration/local-file-dialog';
import { remapPortableSnapshot } from '../application/portable-file/import-project';
import { riskCountPhrase } from '../adapters/ui/vocabulary';
import {
  NodeInspectorDrawer,
  type InspectorTab,
} from '../adapters/ui/inspector/node-inspector-drawer';
import { INSPECTOR_DEFAULT_WIDTH } from '../adapters/ui/inspector/inspector-width';
import { copyText } from '../adapters/ui/copy-text';
import { GANTT_HIERARCHY_DEFAULT_WIDTH } from '../application/gantt/gantt-hierarchy-width';
import { FORECAST_BACKLOG_DEFAULT_WIDTH } from '../application/forecast/forecast-backlog-width';
import {
  createAddNodeQuestionWireCommand,
  createResolveNodeQuestionWireCommand,
  createDeleteNodeQuestionWireCommand,
} from '../contracts/repository-commands';
import {
  createAddNodeQuestionCommand,
  createResolveNodeQuestionCommand,
  createDeleteNodeQuestionCommand,
} from '../domain/tree/node-question.commands';

/** Cold-start timing harness (NFR-16, AD-17). */
const startTime = performance.now();

/**
 * The injected local calendar date (Story 26.6, FC-NFR2). One local date per
 * evaluation; tests pass an explicit date. Never read inside the calculator.
 */
function localToday(): string {
  const override = (globalThis as { __PMAPP_TODAY__?: unknown }).__PMAPP_TODAY__;
  if (typeof override === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function createEmptyOverview(): WorkspaceOverviewProjection {
  return Object.freeze({
    revisionVector: Object.freeze([]),
    projects: Object.freeze([]),
    limitWarning: null,
  });
}

/** Map OutlineNodeReadModel nodes to domain Node shape (AD-1: UI never holds the full domain graph). */
function toDomainNodes(model: OutlineReadModel): readonly Node[] {
  return model.nodes.map((n) =>
    Object.freeze({
      id: n.id,
      projectId: model.projectId,
      parentId: n.parentId,
      title: n.title,
      bodyText: null,
      position: n.position,
      nodeType: n.nodeType,
      startDate: n.startDate,
      endDate: n.endDate,
      durationDays: n.durationDays,
      scheduleSourceMode: n.scheduleSourceMode,
      completed: n.completed,
      effortPoints: n.effortPoints,
      effortPointsDone: n.effortPointsDone,
      strategicWeight: n.strategicWeight,
      phaseId: n.phaseId,
      deliveryStatus: n.deliveryStatus,
    }),
  );
}

/** Story 27.2: result of one atomic composite gesture. */
type BatchTrackOutcome =
  | { kind: 'applied' }
  | { kind: 'rejected'; rejected: ProductCommandRejected }
  | { kind: 'failed' };

// Story 27.1 (AD-20): read the literal build constant here so a flag-off
// build folds every collaboration branch and its dynamic import away.
declare const __PMAPP_COLLABORATION__: boolean | undefined;
const COLLABORATION_BUILD = typeof __PMAPP_COLLABORATION__ !== 'undefined' && __PMAPP_COLLABORATION__ === true;
type CollaborationModule = typeof import('./collaboration-composition');

/** Plain-language copy for a failed first share (no codes beyond the fallback). */
function shareErrorMessage(code: string): string {
  switch (code) {
    case 'PROJECT_ALREADY_CLAIMED':
      return 'This project is already registered with the team service by another device or browser identity.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'CREDENTIAL_MISSING':
      return 'This device lost its sharing credential for this project.';
    case 'RESHARE_REQUIRES_NEW_EPOCH':
      return 'Sharing was stopped for this project, so it cannot be shared again as itself.';
    default:
      return 'The project could not be shared right now. It is still saved on this device; try again.';
  }
}

/** Share failures a fresh copy (new project ID) gets around. */
const SHARE_AS_COPY_CODES: ReadonlySet<string> = new Set(['PROJECT_ALREADY_CLAIMED', 'CREDENTIAL_MISSING', 'RESHARE_REQUIRES_NEW_EPOCH']);

/** Plain-language copy for a failed join (Story 27.4: plain explanations). */
function joinErrorMessage(code: string): string {
  switch (code) {
    case 'INVITE_LINK_INVALID':
      return 'That does not look like an invite link. Paste the whole link you were sent.';
    case 'INVITE_FOR_OTHER_SERVICE':
      return 'This invite belongs to a different Vantage service (staging or production) than this app. Open it in the matching Vantage app.';
    case 'INVITEUSED':
    case 'INVITEEXPIRED':
    case 'INVITEREPLACED':
      return 'This link was already used, has expired or was replaced. Ask the owner for a new one.';
    case 'INVITENOTFOUND':
      return 'This link is not valid. Ask the owner for a new one.';
    case 'ALREADY_A_MEMBER':
      return 'You already have this project on this device.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'NOTAMEMBER':
    case 'RECOVERY_LINK_INVALID':
      return 'This recovery link is not valid or was already used.';
    case 'JOIN_REQUEST_UNKNOWN':
      return 'The team service does not know this request. Paste the invite link again.';
    default:
      return 'You could not join right now. Check your connection and try again.';
  }
}

function PMAppRoot() {
  const [health, setHealth] = useState<StorageHealthCategory | null>(null);
  // UAT #11: capture boot time ONCE (lazy initializer). Previously recomputed
  // on every render as `performance.now() - startTime`, so "Boot: Xms" grew
  // with session elapsed time instead of staying the one-shot cold-start value.
  const [bootTime] = useState(() => Math.max(1, Math.round(performance.now() - startTime)));
  const [projects, setProjects] = useState<readonly { id: string; name: string; revision: number }[]>([]);
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [outlineModel, setOutlineModel] = useState<OutlineReadModel | null>(null);
  const currentBodyModelRef = useRef(outlineModel);
  const pendingBodySavesRef = useRef(new Map<string, { bodyText: string | null; completion: Promise<void> }>());
  currentBodyModelRef.current = outlineModel;
  // Highest read-model revision already applied, per project. Every command
  // refreshes the outline with its own `queryProjectNodes`, and those refreshes
  // can resolve out of order under load — an older snapshot then overwrites a
  // newer one and the tree briefly reverts (a just-indented child looks like a
  // root again, so its parent reports no children and the expand caret goes
  // inert). Snapshots that predate what is already on screen are dropped.
  const appliedModelRef = useRef<{ projectId: string; revision: number } | null>(null);

  // Monotonic guard for workspace-overview refreshes (AC 24.1-5). Several
  // paths (project CRUD, any applied command, workspace entry, import) refresh
  // the overview concurrently; their `queryWorkspaceOverview()` awaits can
  // resolve out of order, letting an older read replace a newer one. Each
  // refresh takes a token and only the latest-issued result is applied.
  const overviewRequestTokenRef = useRef(0);
  const refreshWorkspaceOverview = useCallback(async (): Promise<void> => {
    const token = (overviewRequestTokenRef.current += 1);
    let overview;
    try {
      overview = await queryWorkspaceOverview();
    } catch (err) {
      // A read failure is only applied if it is still the latest request, so a
      // stale rejection cannot blank a newer, already-applied overview
      // (AC 24.1-5). The error is rethrown for the caller's own handling.
      if (token === overviewRequestTokenRef.current) setWorkspaceOverview(null);
      throw err;
    }
    if (token !== overviewRequestTokenRef.current) return;
    setWorkspaceOverview(overview);
  }, []);

  const applyOutlineModel = useCallback((model: OutlineReadModel): void => {
    const applied = appliedModelRef.current;
    if (
      applied !== null &&
      applied.projectId === model.projectId &&
      model.projectRevision < applied.revision
    ) {
      return;
    }
    appliedModelRef.current = { projectId: model.projectId, revision: model.projectRevision };
    currentBodyModelRef.current = model;
    setOutlineModel(model);
  }, []);
  const [viewMode, setViewMode] = useState<'workspace' | 'project'>('workspace');
  const [activeViewId, setActiveViewId] = useState<'outline' | 'visual' | 'gantt' | 'forecast'>('outline');
  // Epic 18: the current forecast plan + result, fed by the analysis worker.
  const [forecastPlan, setForecastPlan] = useState<ForecastPlan | null>(null);
  const [forecastResult, setForecastResult] = useState<ForecastResult | null>(null);
  const [forecastComparison, setForecastComparison] = useState<
    import('../domain/forecast/compare.policy').ForecastComparison | null
  >(null);
  const [forecastHistoryAvailable, setForecastHistoryAvailable] = useState(false);
  const [forecastScenarios, setForecastScenarios] = useState<
    readonly import('../domain/forecast/scenario').PersistedForecastScenario[]
  >([]);
  const [scenarioEvaluations, setScenarioEvaluations] = useState<
    ReadonlyMap<string, import('../domain/forecast/scenario-evaluate').ScenarioEvaluation>
  >(new Map());
  const [forecastPending, setForecastPending] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  /**
   * Saved-scenario evaluation cache (Story 25.1 AC 25.1-1). Keyed by scenario
   * id; holds a cheap content key and the content fingerprint so an unchanged
   * scenario is neither re-hashed nor re-sent to the worker on refresh.
   */
  const scenarioEvaluationCacheRef = useRef<
    Map<
      string,
      {
        contentKey: string;
        fingerprint: string;
        evaluation: import('../domain/forecast/scenario-evaluate').ScenarioEvaluation;
      }
    >
  >(new Map());
  const forecastRequestRef = useRef<{ projectId: string; revision: number; policyVersion?: string; token: string } | null>(null);
  const forecastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Per-project chain of in-flight forecast refreshes (serialized, Story 21.10; hardened, Story 21.13 D1). */
  const forecastRefreshChainRef = useRef(
    createForecastRefreshChain(),
  );
  // Holds the latest `refreshForecast` so the mount effect's resync handler can
  // reach it without a forward reference.
  const refreshForecastRef = useRef<((projectId: string) => Promise<void>) | null>(null);
  // Epic 15: side-nav collapsed presentation, mirrored from the current
  // project+view's view-state (E15-FR5, E15-AR2) — resynced by the effect
  // below whenever selectedProjectId or activeViewId changes.
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [workspaceOverview, setWorkspaceOverview] = useState<WorkspaceOverviewProjection | null>(null);
  // Epic 17: the workspace registry (list + active pointer). Refreshed at
  // boot and after every workspace mutation, which returns the full registry
  // so the switcher can never render a stale count.
  const [workspaceRegistry, setWorkspaceRegistry] = useState<WorkspaceRegistry | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState<
    | { kind: 'none' }
    | { kind: 'create' }
    | { kind: 'rename'; workspaceId: string; currentName: string }
  >({ kind: 'none' });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingRenameProjectId, setPendingRenameProjectId] = useState<string | null>(null);
  const [zoomRootId, setZoomRootId] = useState<string | null>(null);
  const [focusedThemeId, setFocusedThemeId] = useState<string | null>(null);
  const [visualFocusedThemeId, setVisualFocusedThemeId] = useState<string | null>(null);
  const [activeSurface, setActiveSurface] = useState<ActiveCommandSurface>('none');
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<{ sentence: string; scope: ViewScope; format: ExportFormat } | null>(null);

  // Story 27.6/27.7/27.8 (AD-20): collaboration surfaces are OFF unless the
  // build flag is on. These hold the live sync/rejection/presence/share state;
  // they are only ever populated when a shared project is open and the
  // CollaborationService is composed. With the flag off they stay at their
  // local defaults and nothing renders (TC-NFR1).
  const [collabSharedProjectId, setCollabSharedProjectId] = useState<string | null>(null);
  const [collabSyncState, setCollabSyncState] = useState<SyncState>({ kind: 'local' });
  const [collabRejected, setCollabRejected] = useState<
    readonly { commandId: string; label: string; yourValue: string; reason: string; copyText: string; unreadable?: boolean }[]
  >([]);
  // Bumped when an owner changes this member's role, so view-only re-renders.
  const [, setCollabRoleVersion] = useState(0);
  const [collabPresent, setCollabPresent] = useState<readonly { actorId: string; actorName: string; lastSeenISO: string }[]>([]);
  const [collabShareDialog, setCollabShareDialog] = useState<import('../adapters/ui/collaboration/share-dialog').ShareDialogProps | null>(null);
  const handleCollabCopy = useCallback((commandId: string) => {
    // Copy places the complete authored content on the clipboard (R8).
    const entry = collabRejected.find((r) => r.commandId === commandId);
    if (entry) void copyText(entry.copyText);
  }, [collabRejected]);
  const collabOrigin = COLLABORATION_BUILD ? collaborationServiceOrigin() : null;
  const [firstShare, setFirstShare] = useState<import('../adapters/ui/collaboration/first-share-dialog').FirstShareStatus | null>(null);
  /** The newest invite created this session per project, so Sharing shows it again. */
  const lastInviteRef = useRef(new Map<string, { inviteId: string; link: string; role: 'editor' | 'viewer'; expiresAtISO: string }>());
  const [shareView, setShareView] = useState<{
    invite: { inviteId: string; link: string; role: 'editor' | 'viewer'; expiresAtISO: string } | null;
    members: readonly import('../adapters/ui/collaboration/share-dialog').MemberView[];
    requests: readonly import('../adapters/ui/collaboration/share-dialog').JoinRequestView[];
    status: string | null;
    approvalRequired?: boolean;
  } | null>(null);
  const [joinStatus, setJoinStatus] = useState<import('../adapters/ui/collaboration/join-dialog').JoinStatus | null>(null);
  // Story 28.2: the vantage:// link the desktop app was opened with, pre-filled in Join.
  const [joinInitialLink, setJoinInitialLink] = useState<string | undefined>(undefined);
  const [memberDialog, setMemberDialog] = useState<{ busy: boolean; message: string | null } | null>(null);
  /** Copies a member left (or a removed member's): read-only on this device. */
  const [collabReadOnly, setCollabReadOnly] = useState<ReadonlySet<string>>(new Set());
  const collabReadOnlyRef = useRef<ReadonlySet<string>>(new Set());
  collabReadOnlyRef.current = collabReadOnly;
  const [activityView, setActivityView] = useState<{
    open: boolean; limit: number; filterActorId: string | null;
    changes: readonly import('../domain/collaboration/attribution').ConfirmedChange[];
    people: readonly { actorId: string; actorName: string }[]; hasMore: boolean;
  }>({ open: false, limit: 20, filterActorId: null, changes: [], people: [], hasMore: false });
  void collabShareDialog;

  // Epic 13 backup state — finite typed machine (E13 Task 7).
  const [backupState, setBackupState] = useState<
    | { kind: 'idle' }
    | { kind: 'preparing' }
    | { kind: 'saving' }
    | { kind: 'blocked'; cause: string }
    | { kind: 'failed'; cause: string }
    | { kind: 'complete'; filename: string }
  >({ kind: 'idle' });

  // Epic 4 Analysis & Review state
  const [coherenceFindings, setCoherenceFindings] = useState<readonly CoherenceFinding[]>([]);
  const [themeImbalances, setThemeImbalances] = useState<readonly StrategicImbalanceFinding[]>([]);
  const [affectedReasons, setAffectedReasons] = useState<readonly AffectedReason[]>([]);
  const [isCoherenceReviewOpen, setIsCoherenceReviewOpen] = useState(false);
  const [isAffectedPanelOpen, setIsAffectedPanelOpen] = useState(false);
  const [isEdgeInspectorOpen, setIsEdgeInspectorOpen] = useState(false);
  // Story 16.3 (E16-AR4): inspector open/close, active tab, and docked width
  // live strictly in the React view-state lane — never SQLite, ChangeSets, or
  // portable backups. Width is a session preference (resets on reload).
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brief');
  const [inspectorWidth, setInspectorWidth] = useState<number>(INSPECTOR_DEFAULT_WIDTH);
  const [ganttHierarchyWidth, setGanttHierarchyWidth] = useState<number>(GANTT_HIERARCHY_DEFAULT_WIDTH);
  const [forecastBacklogWidth, setForecastBacklogWidth] = useState<number>(FORECAST_BACKLOG_DEFAULT_WIDTH);

  const orchestratorRef = useRef<CommandQueueOrchestrator | null>(null);
  const undoEngineRef = useRef<UndoEngine | null>(null);
  const coalescerRef = useRef<ViewStateCoalescer | null>(null);
  const searchIndexRef = useRef<NodeTitleIndex>(new NodeTitleIndex());
  const analysisClientRef = useRef<AnalysisWorkerClient | null>(null);
  const outlineViewRef = useRef<OutlineViewHandle | null>(null);
  const sessionContextRef = useRef<Map<string, SessionViewContext>>(new Map());
  const isSwitchingRef = useRef(false);

  // Initialize Analysis Worker Client
  useEffect(() => {
    const client = new AnalysisWorkerClient();
    analysisClientRef.current = client;

    client.onResult((res) => {
      setCoherenceFindings(res.findings);
      setThemeImbalances(res.themeImbalances);
    });

    client.onForecastResult((res) => {
      const latest = forecastRequestRef.current;
      if (
        !latest ||
        latest.projectId !== res.projectId ||
        latest.revision !== res.projectRevision ||
        (latest.policyVersion && res.policyVersion && latest.policyVersion !== res.policyVersion) ||
        latest.token !== res.requestToken
      ) {
        return;
      }
      if (forecastTimeoutRef.current) {
        clearTimeout(forecastTimeoutRef.current);
        forecastTimeoutRef.current = null;
      }
      setForecastPending(false);
      if (res.error || res.result === null) {
        // A recoverable "forecast unavailable" condition — never a stale or
        // misleading date shown as current (AC 18.4-6, UX-DR7).
        setForecastError(res.error?.message ?? 'The forecast is temporarily unavailable.');
      } else {
        setForecastError(null);
        setForecastResult(res.result);
        setForecastComparison(res.comparison ?? null);
        setForecastHistoryAvailable(res.historicalAttributionAvailable);
      }
    });

    client.onResyncRequired(async (projectId) => {
      const snap = await queryAnalysisSnapshot(projectId);
      client.sendSnapshot(snap);
      // A resync re-bootstraps the engine — recompute the forecast off the
      // freshly applied snapshot so no stale projection lingers (AC 18.4-3).
      // Story 20.6: the saved-scenario set is re-read from the same fresh
      // snapshot so a comparison can never lag the live plan.
      setForecastScenarios(snap.forecastScenarios ?? []);
      void refreshForecastRef.current?.(projectId);
    });

    return () => {
      client.terminate();
    };
  }, []);

  // Hand OPFS sync access handles back as the page goes away. `pagehide` is
  // the last event that reliably fires for a reload, a navigation and a tab
  // close alike; without this the successor page contends with the handles
  // this page still holds and boots into a retry storm.
  useEffect(() => {
    const onPageHide = (): void => {
      void releaseStorage();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // Interaction State Port for ViewStateCoalescer
  const port: InteractionStatePort = useMemo(() => {
    return {
      getViewState: async (projectId: string, viewId: ViewId) => {
        return queryViewState(projectId, viewId);
      },
      putViewState: async (projectId: string, viewId: ViewId, baseRevision: number, patch: import('../contracts/view-state').ViewStatePatch) => {
        try {
          const res = await updateViewState(projectId, viewId, baseRevision, patch);
          if (res.kind === 'Applied') return { kind: 'Applied', snapshot: res.snapshot };
          if (res.kind === 'StaleBase') return { kind: 'StaleBase', snapshot: res.snapshot };
          return { kind: 'Failed', code: 'FAILED', cause: 'Update failed', snapshot: null };
        } catch (err) {
          // A newer-schema refusal is a typed `Failed` at this boundary, never
          // an unhandled rejection on the fire-and-forget coalescer flush
          // (Story 22.15 AC 22.15-2/-3, review L2). Surface the canonical
          // reload guidance and mark storage read-only.
          const code = (err as { code?: unknown } | null)?.code;
          if (code === 'UNSUPPORTED_NEWER_SCHEMA') {
            const refusalMessage = 'This project data was saved by a newer version of the app. Reload to update.';
            setCompatibilityError(refusalMessage);
            setHealth({
              kind: 'Denied',
              cause: refusalMessage,
              capabilities: Object.freeze({ canWrite: false, canPersist: false, isCertified: false }),
            });
            return { kind: 'Failed', code: 'UNSUPPORTED_NEWER_SCHEMA', cause: refusalMessage, snapshot: null };
          }
          return { kind: 'Failed', code: 'FAILED', cause: err instanceof Error ? err.message : 'Update failed', snapshot: null };
        }
      },
    };
  }, []);

  // ── Epic 18: forecast plan + result refresh ─────────────────────────
  // The analysis snapshot carries the optional project-owned forecast plan.
  // We push that exact snapshot to the worker and then request the forecast
  // against *its* revision, so the engine's revision and the request revision
  // cannot drift apart (AC 18.4-2). A bounded timeout guarantees the pending
  // state is always resolved — a dropped or skewed response never strands the
  // workspace (AC 18.4-3, AC 18.4-6).
  const requestForecastFromSnapshot = useCallback(
    (snap: import('../contracts/analysis-protocol').AnalysisSnapshotRequest, todayOverride?: string | null) => {
      const client = analysisClientRef.current;
      if (!client) return;
      const today = todayOverride ?? localToday();
      setForecastPlan(snap.forecastPlan ?? null);
      setForecastScenarios(snap.forecastScenarios ?? []);
      if (snap.forecastPlanError) {
        forecastRequestRef.current = null;
        if (forecastTimeoutRef.current) {
          clearTimeout(forecastTimeoutRef.current);
          forecastTimeoutRef.current = null;
        }
        setForecastPending(false);
        setForecastError('Stored forecast inputs could not be read. Reopen the project or restore from a backup.');
        return;
      }
      const token = createForecastUuidV7();
      forecastRequestRef.current = {
        projectId: snap.projectId,
        revision: snap.projectRevision,
        policyVersion: snap.forecastPlan?.policyVersion ?? 'shared-capacity-v1',
        token,
      };
      setForecastPending(true);
      setForecastError(null);
      if (forecastTimeoutRef.current) clearTimeout(forecastTimeoutRef.current);
      forecastTimeoutRef.current = setTimeout(() => {
        forecastTimeoutRef.current = null;
        if (forecastRequestRef.current?.token !== token) return;
        setForecastPending(false);
        setForecastError('The forecast did not settle. Reopen Forecast or make an edit to retry.');
      }, 10_000);
      client.requestForecast({
        type: 'ForecastRequest',
        projectId: snap.projectId,
        projectRevision: snap.projectRevision,
        policyVersion: snap.forecastPlan?.policyVersion ?? 'shared-capacity-v1',
        requestToken: token,
        today,
      });
    },
    [],
  );

  const refreshForecast = useCallback(
    async (projectId: string) => {
      const client = analysisClientRef.current;
      if (!client) return;
      // Serialize refreshes per project: two commands dispatched back-to-back
      // (e.g. config save then level switch) each fire a refresh, and the
      // first snapshot read can resolve after the second, overwriting the
      // newer plan with a stale one. Chain them so the last refresh wins.
      // The chain neutralizes a rejected predecessor, so one throwing refresh
      // can never poison every later refresh for the session (Story 21.13 D1).
      return forecastRefreshChainRef.current.schedule(projectId, async () => {
        let snap;
        try {
          snap = await queryAnalysisSnapshot(projectId);
          // H08: keep the shared project's rebase merge state current.
          if (COLLABORATION_BUILD && collabModuleRef.current && collabSessionsRef.current.has(projectId)) {
            collabMergeStatesRef.current.set(projectId, collabModuleRef.current.mergeStateFromSnapshot(snap));
          }
        } catch (err) {
          // e.g. ForecastPlanCorruptError — surface a recoverable read failure
          // rather than presenting a silently empty forecast.
          if (forecastRequestRef.current) forecastRequestRef.current = null;
          setForecastPending(false);
          setForecastError(
            err instanceof Error && err.message.startsWith('FORECAST_PLAN_CORRUPT')
              ? 'Stored forecast inputs could not be read. Reopen the project or restore from a backup.'
              : 'The forecast could not be prepared.',
          );
          return;
        }
        client.sendSnapshot(snap);
        requestForecastFromSnapshot(snap);
      }).catch((err) => {
        // A throw AFTER the snapshot read (sendSnapshot /
        // requestForecastFromSnapshot) is not covered by the query try above.
        // Surface it with context instead of letting it hide as an unhandled
        // rejection — the same standard Story 21.12 AC 4 set (Story 21.13
        // D1 AC 2). The chain itself stays healthy: the next refresh for
        // this project still runs.
        console.error(`[forecast] refresh failed for project ${projectId}`, err);
      });
    },
    [requestForecastFromSnapshot],
  );
  refreshForecastRef.current = refreshForecast;

  // ── Collaboration composition (H08) ─────────────────────────────────────
  // Composed only in a collaboration build with a configured service origin.
  // A shared project's edits go through its session (atomic command + outbox,
  // then submission); every other project dispatches locally as before.
  const collabModuleRef = useRef<CollaborationModule | null>(null);
  const collabPortsRef = useRef<import('../application/collaboration/collaboration-session').CollaborationSessionPorts | null>(null);
  const collabSessionsRef = useRef(new Map<string, import('../application/collaboration/collaboration-session').SharedSession>());
  const collabMergeStatesRef = useRef(new Map<string, import('../domain/collaboration/rebase').MergeState>());
  const collabSelectedRef = useRef<string | null>(null);

  const loadCollaboration = useCallback(async () => {
    if (!COLLABORATION_BUILD || !collabOrigin) return null;
    if (!collabModuleRef.current || !collabPortsRef.current) {
      const mod = await import('./collaboration-composition');
      collabPortsRef.current = await mod.createCollaborationPorts(collabOrigin, (projectId) => {
        const state = collabMergeStatesRef.current.get(projectId);
        if (!state) throw new Error('COLLABORATION_MERGE_STATE_UNAVAILABLE');
        return state;
      });
      collabModuleRef.current = mod;
    }
    return { mod: collabModuleRef.current, ports: collabPortsRef.current };
  }, [collabOrigin]);

  // Story 28.2: a vantage:// invite or recovery link opened from outside the
  // app pre-fills the Join dialog; the user still names themselves and joins.
  useEffect(() => {
    if (!isNativeBridge()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import('../adapters/platform/vantage-link')
      .then(({ subscribeVantageLinks }) => subscribeVantageLinks((link) => {
        if (!COLLABORATION_BUILD || !collabOrigin) {
          setStatusMessage('This is a Vantage invite link. Open it with the collaboration version of the app to join.');
          return;
        }
        void loadCollaboration().then(() => {
          setJoinInitialLink(link);
          setJoinStatus({ kind: 'entry' });
        });
      }))
      .then((off) => { if (cancelled) off(); else unlisten = off; })
      .catch((err) => console.error('[collaboration] vantage:// links unavailable', err));
    return () => { cancelled = true; unlisten?.(); };
  }, [collabOrigin, loadCollaboration]);

  /** Reload the attributed activity page for the open shared project. */
  const refreshActivity = useCallback(async (projectId: string, limit: number) => {
    const session = collabSessionsRef.current.get(projectId);
    if (!session) return;
    try {
      const page = await session.activity(limit);
      if (collabSelectedRef.current !== projectId) return;
      setActivityView((prev) => ({ ...prev, changes: page.changes, people: page.people, hasMore: page.hasMore }));
    } catch (err) {
      console.error('[collaboration] activity unavailable', err);
    }
  }, []);
  const activityOpenRef = useRef(false);
  activityOpenRef.current = activityView.open;
  const activityLimitRef = useRef(20);
  activityLimitRef.current = activityView.limit;

  const refreshAfterRemote = useCallback(async (projectId: string) => {
    if (collabSelectedRef.current !== projectId) return;
    // Attribution (27.8-1) and the activity feed share one bounded history read.
    void refreshActivity(projectId, 200);
    const model = await queryProjectNodes(projectId);
    const applied = appliedModelRef.current;
    if (applied && applied.projectId === projectId && model.projectRevision < applied.revision
      && orchestratorRef.current?.adoptAuthoritativeRevision(projectId, model.projectRevision) !== false) {
      // An authoritative install moved the repository back; the stale-read
      // guard must not hide it, and new edits must use its revision.
      appliedModelRef.current = null;
    }
    applyOutlineModel(model);
    setAffectedReasons(await queryAffectedReasons(projectId));
    setProjects(await queryProjects());
    void refreshForecastRef.current?.(projectId);
  }, []);

  const openCollabSession = useCallback(async (projectId: string) => {
    const loaded = await loadCollaboration();
    if (!loaded) return;
    // One live session at a time; other shared projects keep their durable
    // queue and resume when reopened.
    for (const [id, session] of collabSessionsRef.current) {
      if (id !== projectId) { session.close(); collabSessionsRef.current.delete(id); }
    }
    const record = await loaded.ports.registry.get(projectId);
    if (record?.status === 'stopped' && record.role !== 'owner') {
      // A copy this member left stays read-only (AC 27.6-5).
      setCollabReadOnly((prev) => new Set([...prev, projectId]));
    }
    if (!record || record.status !== 'shared') {
      if (collabSelectedRef.current === projectId) { setCollabSharedProjectId(null); setCollabSyncState({ kind: 'local' }); }
      return;
    }
    if (!collabSessionsRef.current.has(projectId)) {
      collabMergeStatesRef.current.set(projectId, loaded.mod.mergeStateFromSnapshot(await queryAnalysisSnapshot(projectId)));
      const session = await loaded.mod.openSharedSession(loaded.ports, record, {
        onChange: (state) => {
          if (collabSelectedRef.current !== projectId) return;
          setCollabSyncState(state);
          const live = collabSessionsRef.current.get(projectId);
          if (live) setCollabRejected(rejectedViews(loaded.mod, live));
        },
        // Command rejections are shown from the durable journal (onChange);
        // session-level notices (revoked, update required) go to the status line.
        onRejected: (commandId, reason) => { if (!commandId && collabSelectedRef.current === projectId) setStatusMessage(reason); },
        onRemoteChange: () => { void refreshAfterRemote(projectId); },
        // Shared undo (R9): a teammate's confirmed change to an item blocks
        // undoing your earlier edit of it; an authoritative replacement makes
        // local undo history unsafe, so it is dropped.
        onRemoteCommand: (_command, actorId, targetIds) => {
          undoEngineRef.current?.recordOtherActorChange(projectId, actorId ?? 'unknown-teammate', targetIds);
        },
        onAuthoritativeReplace: () => { undoEngineRef.current?.clearProject(projectId); },
        // An owner changed this member's role: the view-only state and Sharing
        // dialog follow within one heartbeat.
        onRoleChange: (role) => {
          if (collabSelectedRef.current !== projectId) return;
          setCollabRoleVersion((version) => version + 1);
          setStatusMessage(role === 'viewer' ? 'An owner changed your access to view only.' : role === 'owner' ? 'You are now an owner of this project.' : 'An owner gave you edit access.');
        },
        onPresence: (present) => {
          if (collabSelectedRef.current !== projectId) return;
          const seen = new Date().toISOString();
          setCollabPresent(present.map((m) => ({ actorId: m.actorId, actorName: m.displayName, lastSeenISO: seen })));
        },
      });
      collabSessionsRef.current.set(projectId, session);
    }
    if (collabSelectedRef.current === projectId) {
      const live = collabSessionsRef.current.get(projectId);
      void refreshActivity(projectId, 200);
      setCollabSharedProjectId(projectId);
      setCollabSyncState(live?.syncState() ?? { kind: 'saved-on-device' });
      if (live) setCollabRejected(rejectedViews(loaded.mod, live));
    }
  }, [loadCollaboration, refreshAfterRemote]);

  /** Panel rows from the durable journal: rejected work plus unreadable rows. */
  function rejectedViews(mod: CollaborationModule, session: import('../application/collaboration/collaboration-session').SharedSession) {
    const titleOf = (nodeId: string) => currentBodyModelRef.current?.nodes.find((n) => n.id === nodeId)?.title ?? null;
    return [
      ...session.rejectedWork().map((entry) => mod.describeRejectedWork(entry, titleOf)),
      ...session.unreadableWork().map((commandId) => ({
        commandId, label: 'Unreadable change', yourValue: '', reason: 'This change could not be read from storage. It is kept until you discard it.', copyText: '', unreadable: true,
      })),
    ];
  }

  const handleCollabRetry = useCallback((commandId: string) => {
    const projectId = selectedProjectId;
    const session = projectId ? collabSessionsRef.current.get(projectId) : undefined;
    const row = collabRejected.find((r) => r.commandId === commandId);
    if (!projectId || !session || !row) return;
    if (row.unreadable) { setStatusMessage('This change cannot be retried because it could not be read. Discard it when you are ready.'); return; }
    void (async () => {
      try {
        // A new command id at the current revision (R8); the old entry is
        // dismissed only once the retry applied.
        const result = await session.retryRejected(commandId, getProjectRevision(projectId), createUuidV7());
        if (result.type !== 'ProductCommandApplied') setStatusMessage('The change still cannot be applied. Copy it before discarding.');
        await refreshAfterRemote(projectId);
        if (collabModuleRef.current) setCollabRejected(rejectedViews(collabModuleRef.current, session));
      } catch (err) {
        console.error('[collaboration] retry failed', err);
        setStatusMessage('The change could not be retried right now.');
      }
    })();
  }, [selectedProjectId, collabRejected, refreshAfterRemote]);

  const handleCollabDiscard = useCallback((commandId: string) => {
    // Discard is a durable dismissal of retained rejected work, never of
    // confirmed state.
    const projectId = selectedProjectId;
    const session = projectId ? collabSessionsRef.current.get(projectId) : undefined;
    if (!session) return;
    void session.discardRejected(commandId).then(
      () => { if (collabModuleRef.current) setCollabRejected(rejectedViews(collabModuleRef.current, session)); },
      (err) => { console.error('[collaboration] discard failed', err); setStatusMessage('The change could not be discarded right now.'); },
    );
  }, [selectedProjectId]);

  useEffect(() => {
    collabSelectedRef.current = selectedProjectId;
    if (!COLLABORATION_BUILD || !collabOrigin || !selectedProjectId) return;
    setCollabRejected([]);
    setCollabPresent([]);
    void openCollabSession(selectedProjectId).catch((err) => {
      console.error('[collaboration] session could not start', err);
      setStatusMessage('Team sync could not start. Your changes stay on this device.');
    });
  }, [selectedProjectId, collabOrigin, openCollabSession]);

  useEffect(() => () => {
    for (const session of collabSessionsRef.current.values()) session.close();
    collabSessionsRef.current.clear();
  }, []);

  const handleFirstShare = useCallback(async (displayName: string, projectIdOverride?: string) => {
    const projectId = projectIdOverride ?? selectedProjectId;
    const loaded = await loadCollaboration();
    if (!loaded || !projectId) return;
    setFirstShare({ kind: 'working' });
    try {
      const outcome = await loaded.mod.shareProject(loaded.ports, { projectId, displayName });
      await openCollabSession(projectId);
      // One step: the owner gets a ready editor invite with the recovery link.
      let invite: { link: string; role: 'editor' | 'viewer' } | null = null;
      try {
        const created = await loaded.mod.createInvite(loaded.ports, outcome.record, 'editor');
        lastInviteRef.current.set(projectId, created);
        invite = { link: created.link, role: created.role };
      } catch (err) {
        console.error('[collaboration] first invite failed', err instanceof loaded.mod.CollaborationError ? err.code : err);
      }
      setFirstShare({ kind: 'done', recoveryCode: outcome.recoveryLink, invite });
    } catch (err) {
      console.error('[collaboration] share failed', err instanceof loaded.mod.CollaborationError ? err.code : err);
      const code = err instanceof loaded.mod.CollaborationError ? err.code : 'NETWORK';
      setFirstShare({ kind: 'error', message: shareErrorMessage(code), offerCopy: SHARE_AS_COPY_CODES.has(code) });
    }
  }, [selectedProjectId, loadCollaboration, openCollabSession]);

  /**
   * This project's ID cannot be shared from here (owned by an identity this
   * browser no longer has, a lost credential, or a stopped share): copy it
   * under fresh IDs, open the copy and share that. The original is untouched.
   */
  const handleShareCopy = useCallback(async (displayName: string) => {
    const sourceId = selectedProjectId;
    if (!sourceId) return;
    setFirstShare({ kind: 'working' });
    let copyId: string;
    try {
      const source = await queryPortableSnapshot(sourceId);
      const copy = remapPortableSnapshot({ ...source, projectName: `${source.projectName} (shared copy)` });
      const imported = await batchImportPortable(copy);
      if (!imported.ok) throw new Error(imported.code);
      copyId = copy.projectId;
      setProjects(await queryProjects());
      await refreshWorkspaceOverview();
      await switchProjectRef.current?.(copyId);
    } catch (err) {
      console.error('[collaboration] share copy failed', err);
      setFirstShare({ kind: 'error', message: 'A copy could not be made. Your project is unchanged; try again.', offerCopy: true });
      return;
    }
    await handleFirstShare(displayName, copyId);
  }, [selectedProjectId, refreshWorkspaceOverview, handleFirstShare]);

  /** Swap the first-share invite for one with the other role (old link stops working). */
  const handleFirstInviteRole = useCallback(async (role: 'editor' | 'viewer') => {
    const projectId = selectedProjectId;
    const loaded = await loadCollaboration();
    const session = projectId ? collabSessionsRef.current.get(projectId) : undefined;
    const current = projectId ? lastInviteRef.current.get(projectId) : undefined;
    if (!loaded || !projectId || !session || current?.role === role) return;
    try {
      const created = await loaded.mod.createInvite(loaded.ports, session.record, role, current ? { replacesInviteId: current.inviteId } : {});
      lastInviteRef.current.set(projectId, created);
      setFirstShare((prev) => prev?.kind === 'done' ? { ...prev, invite: { link: created.link, role: created.role }, inviteNote: role === 'viewer' ? 'New view-only link. The previous link no longer works.' : 'New editing link. The previous link no longer works.' } : prev);
    } catch {
      setFirstShare((prev) => prev?.kind === 'done' ? { ...prev, inviteNote: 'The link could not be changed. Try again.' } : prev);
    }
  }, [selectedProjectId, loadCollaboration]);

  const handleStopSharing = useCallback(async () => {
    const projectId = selectedProjectId;
    const loaded = await loadCollaboration();
    const session = projectId ? collabSessionsRef.current.get(projectId) : undefined;
    if (!loaded || !projectId || !session) return;
    try {
      await loaded.mod.stopSharing(loaded.ports, session.record);
      session.close();
      collabSessionsRef.current.delete(projectId);
      setShareView(null);
      setCollabSharedProjectId(null);
      setCollabSyncState({ kind: 'local' });
      setStatusMessage('Sharing stopped. This project is local to this device again.');
    } catch (err) {
      console.error('[collaboration] stop sharing failed', err);
      setStatusMessage('Sharing could not be stopped right now. Try again.');
    }
  }, [selectedProjectId, loadCollaboration]);

  /** Reload members and pending requests from the service (owner only). */
  const refreshShareView = useCallback(async (projectId: string, status: string | null | undefined) => {
    const loaded = await loadCollaboration();
    const session = collabSessionsRef.current.get(projectId);
    if (!loaded || !session) return;
    try {
      const view = await loaded.mod.listMembership(loaded.ports, session.record);
      setShareView((prev) => prev && ({
        ...prev,
        members: view.members.map((m) => ({ deviceId: m.deviceId, displayName: m.displayName, role: m.role, thisDevice: m.deviceId === session.record.deviceId })),
        requests: view.requests.map((r) => ({ requestId: r.requestId, displayName: r.displayName, role: r.role })),
        approvalRequired: view.approvalRequired,
        // `undefined` (background refresh) keeps the current status line.
        status: status === undefined ? prev.status : status,
      }));
    } catch (err) {
      console.error('[collaboration] members unavailable', err);
      setShareView((prev) => prev && ({ ...prev, status: 'Members could not be loaded. Check your connection.' }));
    }
  }, [loadCollaboration]);

  /** Run one owner action and report it in the dialog in plain words. */
  const runShareAction = useCallback(async (action: (loaded: { mod: CollaborationModule; ports: import('../application/collaboration/collaboration-session').CollaborationSessionPorts }, session: import('../application/collaboration/collaboration-session').SharedSession) => Promise<string | null>, failure: string) => {
    const projectId = selectedProjectId;
    const loaded = await loadCollaboration();
    const session = projectId ? collabSessionsRef.current.get(projectId) : undefined;
    if (!loaded || !session || !projectId) return;
    try {
      const done = await action(loaded, session);
      await refreshShareView(projectId, done);
    } catch (err) {
      console.error('[collaboration] share action failed', err instanceof loaded.mod.CollaborationError ? err.code : err);
      // Re-read the service's truth so no optimistic control stays wrong.
      await refreshShareView(projectId, failure);
    }
  }, [selectedProjectId, loadCollaboration, refreshShareView]);

  const handleShareProject = useCallback(() => {
    if (!selectedProjectId) return;
    const session = collabSessionsRef.current.get(selectedProjectId);
    if (!session) { setFirstShare({ kind: 'confirm' }); return; }
    if (session.record.role !== 'owner') {
      setMemberDialog({ busy: false, message: null });
      return;
    }
    setShareView({
      invite: lastInviteRef.current.get(selectedProjectId) ?? null,
      members: [{ deviceId: session.record.deviceId, displayName: session.record.displayName, role: session.record.role, thisDevice: true }],
      requests: [],
      status: 'Loading members…',
    });
    void refreshShareView(selectedProjectId, null);
  }, [selectedProjectId, refreshShareView]);

  // While the owner's Share dialog is open, new join requests and member
  // changes appear by themselves (no close-and-reopen).
  const shareViewOpen = shareView !== null;
  useEffect(() => {
    if (!shareViewOpen || !selectedProjectId) return;
    const projectId = selectedProjectId;
    const timer = setInterval(() => { if (!document.hidden) void refreshShareView(projectId, undefined); }, 5000);
    return () => clearInterval(timer);
  }, [shareViewOpen, selectedProjectId, refreshShareView]);

  const collabShareDialogProps: import('../adapters/ui/collaboration/share-dialog').ShareDialogProps | null = shareView ? {
    projectName: projects.find((p) => p.id === selectedProjectId)?.name ?? 'Project',
    invite: shareView.invite ? { url: shareView.invite.link, role: shareView.invite.role, singleUse: true, expiresAtISO: shareView.invite.expiresAtISO } : null,
    joinRequests: shareView.requests,
    members: shareView.members,
    statusMessage: shareView.status,
    approvalRequired: shareView.approvalRequired,
    onChangeRole: (deviceId, role) => { void runShareAction(async ({ mod, ports }, session) => {
      await mod.changeRole(ports, session.record, deviceId, role);
      return 'Role changed.';
    }, 'The role could not be changed (the last owner must stay an owner).'); },
    onApprovalChange: (required) => {
      // Reflect the choice at once; the follow-up membership read restores
      // the service's value if the change fails.
      setShareView((prev) => prev && ({ ...prev, approvalRequired: required }));
      void runShareAction(async ({ mod, ports }, session) => {
      await mod.setApprovalRequired(ports, session.record, required);
      return required ? 'Approval is on. New joiners wait for an owner.' : 'Approval is off.';
    }, 'The approval setting could not be changed. Try again.'); },
    onCreateInvite: (role) => { void runShareAction(async ({ mod, ports }, session) => {
      const invite = await mod.createInvite(ports, session.record, role);
      lastInviteRef.current.set(session.record.projectId, invite);
      setShareView((prev) => prev && ({ ...prev, invite }));
      return 'Link created. It works once and expires in 7 days.';
    }, 'The link could not be created. Try again.'); },
    onReplaceInvite: () => { void runShareAction(async ({ mod, ports }, session) => {
      const current = shareView.invite;
      const invite = await mod.createInvite(ports, session.record, current?.role ?? 'editor', current ? { replacesInviteId: current.inviteId } : {});
      lastInviteRef.current.set(session.record.projectId, invite);
      setShareView((prev) => prev && ({ ...prev, invite }));
      return 'Link replaced. The old link no longer works.';
    }, 'The link could not be replaced. Try again.'); },
    onCopyInvite: () => {
      if (!shareView.invite) return Promise.resolve(false);
      const link = shareView.invite.link;
      return copyText(link).then((copied) => {
        setShareView((prev) => prev && ({
          ...prev,
          status: copied ? 'Link copied. Send it by any channel you like.' : 'Copying is blocked here. Select the link, then press Ctrl+C.',
        }));
        return copied;
      });
    },
    onApprove: (requestId) => { void runShareAction(async ({ mod, ports }, session) => { await mod.decideJoin(ports, session.record, requestId, true); return 'Approved.'; }, 'Approval failed. Try again.'); },
    onDeny: (requestId) => { void runShareAction(async ({ mod, ports }, session) => { await mod.decideJoin(ports, session.record, requestId, false); return 'Declined.'; }, 'That request could not be declined. Try again.'); },
    onRemoveDevice: (deviceId) => { void runShareAction(async ({ mod, ports }, session) => { await mod.removeMember(ports, session.record, deviceId); return 'Removed.'; }, 'That device could not be removed.'); },
    onStopSharing: () => { void handleStopSharing(); },
    onClose: () => setShareView(null),
  } : null;

  const joinRecordRef = useRef<import('../application/collaboration/shared-project-registry').SharedProjectRecord | null>(null);
  // Assigned after `switchProject` is defined further down this component.
  const switchProjectRef = useRef<((projectId: string) => Promise<{ kind: string }>) | null>(null);

  /** Approved: make the local placeholder the authoritative snapshot replaces, then open it. */
  const completeJoin = useCallback(async (record: import('../application/collaboration/shared-project-registry').SharedProjectRecord) => {
    if (!(await queryProjects()).some((p) => p.id === record.projectId)) {
      const cmd = createCreateProjectCommand(createDomainCreateProject({ commandId: createUuidV7(), projectId: record.projectId, name: 'Shared project' }));
      await orchestratorRef.current?.dispatchCommand(cmd);
    }
    setProjects(await queryProjects());
    await refreshWorkspaceOverview();
    setJoinStatus({ kind: 'approved' });
    const outcome = await switchProjectRef.current?.(record.projectId);
    if (outcome?.kind === 'Switched' || outcome?.kind === 'NoOp') setViewMode('project');
  }, [refreshWorkspaceOverview]);

  const handleCheckJoin = useCallback(async (background = false) => {
    const loaded = await loadCollaboration();
    const record = joinRecordRef.current;
    if (!loaded || !record) return;
    // A background check keeps the waiting screen steady (no "Joining..." flash).
    if (!background) setJoinStatus({ kind: 'working' });
    try {
      const next = await loaded.mod.refreshJoinStatus(loaded.ports, record);
      if (next === null) { joinRecordRef.current = null; setJoinStatus({ kind: 'denied' }); return; }
      joinRecordRef.current = next;
      if (next.status === 'shared') await completeJoin(next);
      else setJoinStatus({ kind: 'waiting' });
    } catch (err) {
      if (background) return; // Stay waiting; the next check retries.
      setJoinStatus({ kind: 'error', message: joinErrorMessage(err instanceof loaded.mod.CollaborationError ? err.code : 'NETWORK') });
    }
  }, [loadCollaboration, completeJoin]);

  // While the joiner waits, check for approval by itself every few seconds.
  const joinWaiting = joinStatus?.kind === 'waiting';
  useEffect(() => {
    if (!joinWaiting) return;
    const timer = setInterval(() => { if (!document.hidden) void handleCheckJoin(true); }, 5000);
    return () => clearInterval(timer);
  }, [joinWaiting, handleCheckJoin]);

  const handleJoin = useCallback(async (link: string, displayName: string) => {
    const loaded = await loadCollaboration();
    if (!loaded) return;
    setJoinStatus({ kind: 'working' });
    if (loaded.mod.parseRecoveryLink(link)) {
      try {
        // Owner recovery: bind this device as an owner, then bootstrap.
        await completeJoin(await loaded.mod.recoverOwner(loaded.ports, { link, displayName }));
      } catch (err) {
        setJoinStatus({ kind: 'error', message: joinErrorMessage(err instanceof loaded.mod.CollaborationError ? err.code : 'NETWORK') });
      }
      return;
    }
    try {
      const record = await loaded.mod.joinWithInvite(loaded.ports, { link, displayName });
      joinRecordRef.current = record;
      if (record.status === 'shared') await completeJoin(record);
      else setJoinStatus({ kind: 'waiting' });
    } catch (err) {
      const code = err instanceof loaded.mod.CollaborationError ? err.code : 'NETWORK';
      const parsed = loaded.mod.parseInviteLink(link);
      const pending = code === 'JOIN_ALREADY_PENDING' && parsed ? await loaded.ports.registry.get(parsed.projectId) : null;
      if (pending) { joinRecordRef.current = pending; await handleCheckJoin(); return; }
      setJoinStatus({ kind: 'error', message: joinErrorMessage(code) });
    }
  }, [loadCollaboration, completeJoin, handleCheckJoin]);

  // Initialize SQLite repository, orchestrator, and default project
  const init = useCallback(async () => {
    try {
      const { isOpfs } = await initWorkerDatabase();
      // Native composition: derive health from the native runtime status
      // instead of browser storage signals (E9-FR14, E9-UX4).
      const h = isNativeBridge()
        ? await (async () => {
            const { detectNativeStorageHealth } = await import('../adapters/platform/native-storage-status');
            return detectNativeStorageHealth();
          })()
        : await detectStorageHealth(isOpfs);
      setHealth(h);
      // H08: a shared project's edits commit with their outbox entry through
      // its live session; local projects are unchanged.
      const dispatcher: CommandDispatcher = async (cmd) => {
        const session = COLLABORATION_BUILD ? collabSessionsRef.current.get(cmd.projectId) : undefined;
        if ((COLLABORATION_BUILD && collabReadOnlyRef.current.has(cmd.projectId)) || (session && (session.record.role === 'viewer' || session.service.terminal() === 'revoked'))) {
          // A viewer's (or a removed member's) edit would be refused by the
          // service without a durable terminal outcome; refuse it before
          // anything is applied or queued. The copy stays readable (R8).
          return { type: 'ProductCommandRejected', protocolVersion: cmd.protocolVersion, commandId: cmd.commandId, projectId: cmd.projectId, code: 'SHARED_PROJECT_READ_ONLY' };
        }
        return session ? session.applyLocalEdit(cmd) : applyProductCommand(cmd);
      };
      // Story 27.2: grouped gestures commit as one repository transaction.
      // A shared project's composite gesture commits with its outbox entries
      // and syncs as one all-or-nothing group through its live session.
      const batchDispatcher = async (cmds: readonly ProductCommand[]): Promise<readonly ProductCommandResult[]> => {
        const projectId = cmds[0]?.projectId;
        const session = COLLABORATION_BUILD && projectId ? collabSessionsRef.current.get(projectId) : undefined;
        if (projectId && ((COLLABORATION_BUILD && collabReadOnlyRef.current.has(projectId)) || (session && (session.record.role === 'viewer' || session.service.terminal() === 'revoked')))) {
          return [{ type: 'ProductCommandRejected', protocolVersion: cmds[0].protocolVersion, commandId: cmds[0].commandId, projectId, code: 'SHARED_PROJECT_READ_ONLY' }];
        }
        return session ? session.applyLocalGroup(cmds) : applyProductCommandBatch(cmds);
      };
      const orchestrator = new CommandQueueOrchestrator(dispatcher, batchDispatcher);
      orchestratorRef.current = orchestrator;
      undoEngineRef.current = new UndoEngine(orchestrator);
      coalescerRef.current = new ViewStateCoalescer(port);

      let currentProjects = await queryProjects();
      if (currentProjects.length === 0) {
        const defaultProjectId = createUuidV7();
        const createCmd = createCreateProjectCommand(
          createDomainCreateProject({
            commandId: createUuidV7(),
            projectId: defaultProjectId,
            name: 'My Project',
          }),
        );
        const projectOutcome = await orchestrator.dispatchCommand(createCmd);
        const projectRevision =
          projectOutcome.type === 'CommandDispatched' && projectOutcome.result.type === 'ProductCommandApplied'
            ? projectOutcome.result.targetRevision
            : 0;

        const initialNodeCmd = createCreateNodeWireCommand({
          type: 'CreateNode',
          commandId: createUuidV7(),
          projectId: defaultProjectId,
          baseRevision: projectRevision,
          nodeId: createUuidV7(),
          parentId: null,
          position: 4294967296n,
          title: '',
        });
        await orchestrator.dispatchCommand(initialNodeCmd);

        currentProjects = await queryProjects();
      }

      setProjects(currentProjects);
      if (currentProjects.length > 0) {
        const pId = currentProjects[0].id;
        setSelectedProjectId(pId);
        const model = await queryProjectNodes(pId);
        applyOutlineModel(model);
        searchIndexRef.current.rebuildFromNodes(model.nodes);

        const vs = await queryViewState(pId, 'outline');
        setZoomRootId(vs.fields.zoomRootId);
        coalescerRef.current?.setSnapshot(vs);

        const vsVisual = await queryViewState(pId, 'visual');
        coalescerRef.current?.setSnapshot(vsVisual);
        const vsGantt = await queryViewState(pId, 'gantt');
        coalescerRef.current?.setSnapshot(vsGantt);

        // Initialize background analysis snapshot & affected reasons
        if (analysisClientRef.current) {
          const snap = await queryAnalysisSnapshot(pId);
          analysisClientRef.current.sendSnapshot(snap);
          requestForecastFromSnapshot(snap);
        }
        setAffectedReasons(await queryAffectedReasons(pId));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('saved by a newer version') || (err instanceof Error && err.name === 'NewerSchemaVersionError')) {
        const refusalMessage = 'This project data was saved by a newer version of the app. Reload to update.';
        setHealth({
          kind: 'Denied',
          cause: refusalMessage,
          capabilities: Object.freeze({
            canWrite: false,
            canPersist: false,
            isCertified: false,
          }),
        });
        setStatusMessage(refusalMessage);
        setCompatibilityError(refusalMessage);
        const rejectingDispatcher: CommandDispatcher = async (cmd) => ({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: cmd.commandId,
          projectId: 'projectId' in cmd ? cmd.projectId : '',
          code: 'UNSUPPORTED_NEWER_SCHEMA',
        });
        orchestratorRef.current = new CommandQueueOrchestrator(rejectingDispatcher);
        return;
      }
      throw err;
    }
  }, [port, applyOutlineModel, refreshForecast]);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __resetRepositoryDatabase?: () => Promise<void> }).__resetRepositoryDatabase = async () => {
        await resetDatabase();
        await init();
      };
    }
  }, [init]);

  useEffect(() => {
    async function updateOverview() {
      try {
        await refreshWorkspaceOverview();
      } catch (err) {
        // `refreshWorkspaceOverview` already blanks the overview only when this
        // is still the latest read, so a stale rejection cannot blank a newer
        // overview. A newer-schema refusal must still surface the read-only
        // banner, not just a blanked overview (review L2).
        if ((err as { code?: unknown } | null)?.code === 'UNSUPPORTED_NEWER_SCHEMA') {
          setCompatibilityError('This project data was saved by a newer version of the app. Reload to update.');
        }
      }
    }
    void updateOverview();
  }, [projects, refreshWorkspaceOverview]);

  // Epic 17: load the workspace registry once the store is open. Keyed on
  // `projects` as well, so creating or deleting a project refreshes the
  // per-workspace counts the switcher shows.
  useEffect(() => {
    async function updateRegistry() {
      try {
        setWorkspaceRegistry(await queryWorkspaceRegistryForApp());
      } catch (err) {
        // Leave the last known registry in place: blanking the switcher on a
        // transient read failure would make the workspace look deleted. But a
        // newer-schema refusal is terminal and must surface the read-only
        // banner (review L2).
        if ((err as { code?: unknown } | null)?.code === 'UNSUPPORTED_NEWER_SCHEMA') {
          setCompatibilityError('This project data was saved by a newer version of the app. Reload to update.');
        }
      }
    }
    void updateRegistry();
  }, [projects]);

  const switchProjectInner = useCallback(
    async (targetProjectId: string): Promise<
      | Readonly<{ kind: 'NoOp' }>
      | Readonly<{ kind: 'Blocked'; cause: string }>
      | Readonly<{ kind: 'Switched'; projectId: string; restoredFocusedNodeId: string | null; initialCollapsedNodeIds: readonly string[] }>
    > => {
      const currentProjectId = selectedProjectId;
      let orchestrator = orchestratorRef.current;
      let coalescer = coalescerRef.current;

      if (!orchestrator || !coalescer) {
        for (let i = 0; i < 100; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (orchestratorRef.current && coalescerRef.current) break;
        }
        orchestrator = orchestratorRef.current;
        coalescer = coalescerRef.current;
        if (!orchestrator || !coalescer) {
          return Object.freeze({ kind: 'Blocked', cause: 'Repository not initialized.' });
        }
      }

      if (targetProjectId === currentProjectId && viewMode === 'project' && outlineModel !== null) {
        return Object.freeze({ kind: 'NoOp' });
      }

      if (currentProjectId) {
        if (!orchestrator.isQueueSettled(currentProjectId)) {
          for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (orchestrator.isQueueSettled(currentProjectId)) break;
          }
        }
        const firstDecision = decideProjectSwitch({
          targetProjectId,
          currentProjectId,
          isQueueSettled: orchestrator.isQueueSettled(currentProjectId),
          blockingCause: orchestrator.queueBlockingCause(currentProjectId),
        });
        if (firstDecision.kind === 'Blocked') {
          return Object.freeze({ kind: 'Blocked', cause: firstDecision.cause });
        }
      }

      if (currentProjectId) {
        // Acknowledged preferences flush — never through dispatchCommand.
        const flushResult = await coalescer.flush(currentProjectId, 'outline');

        // Re-check the queue after the await yielded to the event loop.
        const secondDecision = decideProjectSwitch({
          targetProjectId,
          currentProjectId,
          isQueueSettled: orchestrator.isQueueSettled(currentProjectId),
          blockingCause: orchestrator.queueBlockingCause(currentProjectId),
        });
        if (secondDecision.kind === 'Blocked') {
          return Object.freeze({ kind: 'Blocked', cause: secondDecision.cause });
        }

        // Surface a soft flush failure without blocking navigation.
        if (flushResult && flushResult.kind === 'Failed') {
          setStatusMessage('View state could not be saved before switching.');
        }

        sessionContextRef.current.set(sessionViewContextKey(currentProjectId, 'outline'), {
          focusedNodeId,
          focusReturnNodeId: null,
        });
      }

      const model = await queryProjectNodes(targetProjectId);
      const vs = await queryViewState(targetProjectId, 'outline');

      // Leaving a project: drop its retained refresh chain so the session
      // does not hold one promise per visited project id forever. The next
      // refresh after a return starts a fresh chain (Story 21.13 D1 AC 4).
      if (currentProjectId) {
        forecastRefreshChainRef.current.evict(currentProjectId);
      }

      coalescer.setSnapshot(vs);
      const vsVisual = await queryViewState(targetProjectId, 'visual');
      coalescer.setSnapshot(vsVisual);
      const vsGantt = await queryViewState(targetProjectId, 'gantt');
      coalescer.setSnapshot(vsGantt);

      const restoredFocusedNodeId =
        sessionContextRef.current.get(sessionViewContextKey(targetProjectId, 'outline'))?.focusedNodeId ?? null;

      setViewMode('project');
      setSelectedProjectId(targetProjectId);
      applyOutlineModel(model);
      setZoomRootId(vs.fields.zoomRootId);
      setFocusedThemeId(vs.fields.focusedThemeId);
      searchIndexRef.current.rebuildFromNodes(model.nodes);
      setAffectedReasons(await queryAffectedReasons(targetProjectId));
      if (analysisClientRef.current) {
        const snap = await queryAnalysisSnapshot(targetProjectId);
        analysisClientRef.current.sendSnapshot(snap);
        requestForecastFromSnapshot(snap);
      }
      setProjects(await queryProjects());

      return Object.freeze({
        kind: 'Switched',
        projectId: targetProjectId,
        restoredFocusedNodeId,
        initialCollapsedNodeIds: vs.fields.collapsedNodeIds,
      });
    },
    [selectedProjectId, focusedNodeId, outlineModel, viewMode, applyOutlineModel],
  );

  const switchProject = useCallback(
    async (targetProjectId: string): Promise<
      | Readonly<{ kind: 'NoOp' }>
      | Readonly<{ kind: 'Blocked'; cause: string }>
      | Readonly<{ kind: 'Switched'; projectId: string; restoredFocusedNodeId: string | null; initialCollapsedNodeIds: readonly string[] }>
    > => {
      if (isSwitchingRef.current) {
        return Object.freeze({ kind: 'Blocked', cause: 'A project switch is already in progress.' });
      }
      isSwitchingRef.current = true;
      try {
        // A reverted brief may be queued behind its first save, outside the
        // orchestrator's command queue. Finish both before changing projects.
        while (pendingBodySavesRef.current.size > 0) {
          await Promise.all([...pendingBodySavesRef.current.values()].map((save) => save.completion));
        }
        return await switchProjectInner(targetProjectId);
      } finally {
        isSwitchingRef.current = false;
      }
    },
    [switchProjectInner],
  );

  // Focus restoration after a switch commits (AC4).
  // Fallback chain: restored focusedNodeId → zoomRootId → first visible row → tree container.
  useEffect(() => {
    if (!selectedProjectId || !outlineModel) return;
    const session = sessionContextRef.current.get(sessionViewContextKey(selectedProjectId, 'outline'));
    const vs = coalescerRef.current?.getSnapshot(selectedProjectId, 'outline');
    const candidates = [
      session?.focusedNodeId ?? null,
      vs?.fields.zoomRootId ?? zoomRootId,
    ].filter((id): id is string => id !== null);

    (async () => {
      for (const candidate of candidates) {
        const ok = await outlineViewRef.current?.focusNodeById(candidate) ?? false;
        if (ok) return;
      }
      const firstRow = outlineViewRef.current?.focusFirstVisibleRow() ?? false;
      if (!firstRow) {
        outlineViewRef.current?.focusTreeContainer();
      }
    })();
  }, [selectedProjectId, viewMode]);

  useEffect(() => {
    if (viewMode === 'workspace') {
      void (async () => {
        try {
          await refreshWorkspaceOverview();
          setProjects(await queryProjects());
        } catch (error) {
          // Story 21.12 AC 4: a workspace-scoped read failure must surface
          // with context, never become an unhandled rejection that hides in
          // console noise. `refreshWorkspaceOverview` already blanks the
          // overview only when this is still the latest read (AC 24.1-5); the
          // project list is the workspace switcher's source of truth, so a
          // failure there is reported visibly.
          console.error('[workspace] overview/projects read failed:', error);
          setStatusMessage('The workspace could not be read. Your projects are safe; reload to retry.');
        }
      })();
    }
  }, [viewMode, refreshWorkspaceOverview]);

  switchProjectRef.current = switchProject;

  const openProject = useCallback(
    (projectId: string): void => {
      void switchProject(projectId);
    },
    [switchProject],
  );

  const dispatchAndTrack = useCallback(
    async (cmd: ProductCommand) => {
      const targetProjectId = cmd.projectId;
      if (!orchestratorRef.current || !targetProjectId) return undefined;
      const outcome = await orchestratorRef.current.dispatchCommand(cmd);
      if (outcome.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied') {
        const applied = outcome.result as ProductCommandApplied;
        if (applied.changeSet && undoEngineRef.current) {
          undoEngineRef.current.recordAppliedCommand(cmd, applied.changeSet);
          searchIndexRef.current.applyChangeSet(applied.changeSet);
        }

        // Send delta to background analysis worker
        if (applied.changeSet && analysisClientRef.current) {
          analysisClientRef.current.sendDelta({
            type: 'AnalysisDelta',
            projectId: targetProjectId,
            baseRevision: cmd.baseRevision,
            targetRevision: cmd.expectedRevision,
            changeSet: applied.changeSet,
          });
        }
      } else if (outcome.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandRejected') {
        const rejected = outcome.result as ProductCommandRejected;
        const feedback = formatCommandRejection(rejected);
        setStatusMessage(`${feedback.cause} ${feedback.resultingState}`);
        if (rejected.code === 'FORECAST_PLAN_CORRUPT') {
          setForecastError('Stored forecast inputs could not be read. Reopen the project or restore from a backup.');
        }
        if (rejected.code === 'UNSUPPORTED_NEWER_SCHEMA') {
          const refusalMessage = 'This project data was saved by a newer version of the app. Reload to update.';
          setCompatibilityError(refusalMessage);
          setHealth({
            kind: 'Denied',
            cause: refusalMessage,
            capabilities: Object.freeze({
              canWrite: false,
              canPersist: false,
              isCertified: false,
            }),
          });
        }
        orchestratorRef.current?.discardCommand(targetProjectId);
      }
      const updated = await queryProjectNodes(targetProjectId);
      applyOutlineModel(updated);
      setAffectedReasons(await queryAffectedReasons(targetProjectId));
      await refreshWorkspaceOverview();
      setProjects(await queryProjects());
      void refreshForecast(targetProjectId);
      return outcome;
    },
    [refreshForecast],
  );

  /**
   * Story 27.2: apply a composite gesture as ONE repository transaction. Every
   * component applies (one grouped undo entry, one read-model refresh) or none
   * does and the single refusal is returned. A thrown or malformed reply does
   * not prove rollback, so the revision is re-read before further edits.
   */
  const dispatchBatchAndTrack = useCallback(
    async (cmds: readonly ProductCommand[]): Promise<BatchTrackOutcome | undefined> => {
      const orchestrator = orchestratorRef.current;
      const targetProjectId = cmds[0]?.projectId;
      if (!orchestrator || !targetProjectId) return undefined;
      let result: BatchTrackOutcome;
      try {
        const outcomes = await orchestrator.dispatchBatch(cmds);
        const refusal = outcomes.length === 1 && outcomes[0].result.type === 'ProductCommandRejected'
          ? (outcomes[0].result as ProductCommandRejected) : null;
        if (refusal) {
          const feedback = formatCommandRejection(refusal);
          setStatusMessage(`${feedback.cause} ${feedback.resultingState}`);
          result = { kind: 'rejected', rejected: refusal };
        } else {
          undoEngineRef.current?.beginGroup(targetProjectId);
          try {
            outcomes.forEach((outcome, index) => {
              const applied = outcome.result as ProductCommandApplied;
              if (!applied.changeSet) return;
              const cmd = Object.freeze({ ...cmds[index], baseRevision: applied.baseRevision, expectedRevision: applied.targetRevision }) as ProductCommand;
              undoEngineRef.current?.recordAppliedCommand(cmd, applied.changeSet);
              searchIndexRef.current.applyChangeSet(applied.changeSet);
              analysisClientRef.current?.sendDelta({
                type: 'AnalysisDelta',
                projectId: targetProjectId,
                baseRevision: applied.baseRevision,
                targetRevision: applied.targetRevision,
                changeSet: applied.changeSet,
              });
            });
          } finally {
            undoEngineRef.current?.endGroup();
          }
          result = { kind: 'applied' };
        }
      } catch (error) {
        console.error('[command] grouped edit did not complete', error);
        setStatusMessage('The grouped edit could not be confirmed. The project was reloaded; check the result before continuing.');
        const project = (await queryProjects()).find((p) => p.id === targetProjectId);
        if (project) {
          try {
            orchestrator.reconcileAtomicBatchRevision(targetProjectId, project.revision);
          } catch (reconcileError) {
            console.error('[command] grouped edit reconciliation refused', reconcileError);
          }
        }
        result = { kind: 'failed' };
      }
      const updated = await queryProjectNodes(targetProjectId);
      applyOutlineModel(updated);
      setAffectedReasons(await queryAffectedReasons(targetProjectId));
      await refreshWorkspaceOverview();
      setProjects(await queryProjects());
      void refreshForecast(targetProjectId);
      return result;
    },
    [refreshForecast],
  );

  const getProjectRevision = (_projectId: string): number => {
    return outlineModel?.projectRevision ?? 0;
  };

  // ── Epic 2 Core Tree Handlers ─────────────────────────────────────

  const handleCreateNode = async (params: {
    nodeId: string;
    parentId: string | null;
    position: bigint;
    title: string;
    /** A new sibling's inherited type (e.g. Enter on a Feature makes a Feature). */
    nodeType?: NodeType | null;
  }) => {
    if (!selectedProjectId || !outlineModel) return;
    const base = getProjectRevision(selectedProjectId);
    const created = dispatchAndTrack(createCreateNodeWireCommand({
      type: 'CreateNode',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: base,
      nodeId: params.nodeId,
      parentId: params.parentId,
      position: params.position,
      title: params.title,
    }));
    if (!params.nodeType) {
      await created;
      return;
    }
    // Queued right behind the create (the queue orders them), not as an atomic
    // batch: a batch is refused while the title edit committed by the same
    // Enter is still in flight, which would drop the new item.
    const typed = dispatchAndTrack(createSetNodeTypeWireCommand({
      type: 'SetNodeType',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: base + 1,
      nodeId: params.nodeId,
      nodeType: params.nodeType,
    }));
    await Promise.all([created, typed]);
  };

  // Create a node nested under the focused node (Alt+Enter / "Add child").
  const handleCreateChild = async (parentNodeId: string | null) => {
    if (!selectedProjectId || !outlineModel) return;
    const parentId = parentNodeId;
    const nodeId = createUuidV7();
    const existingChildren = outlineModel.nodes
      .filter((n) => n.parentId === parentId)
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const lastChild = existingChildren[existingChildren.length - 1];
    const position = positionForAppend(lastChild?.position ?? null);
    await handleCreateNode({ nodeId, parentId, position, title: '' });
  };

  const handleCreateCriterion = async (parentId: string, title: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const nodeId = createUuidV7();
    const existingChildren = outlineModel.nodes
      .filter((n) => n.parentId === parentId)
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const lastChild = existingChildren[existingChildren.length - 1];
    const position = positionForAppend(lastChild?.position ?? null);
    await handleCreateNode({ nodeId, parentId, position, title });
    await handleSetNodeType({ nodeId, nodeType: 'AcceptanceCriterion' });
  };

  const handleSetNodeTitle = async (params: { nodeId: string; title: string }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodeTitleWireCommand({
      type: 'SetNodeTitle',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      title: params.title,
    });
    await dispatchAndTrack(cmd);
  };

  const handleSetNodeBodyText = async (params: { nodeId: string; bodyText: string | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const node = outlineModel.nodes.find((candidate) => candidate.id === params.nodeId);
    if (!node) return;
    const saveKey = `${selectedProjectId}:${params.nodeId}`;
    const normalizeBody = (body: string | null | undefined): string | null =>
      body == null || body.trim().length === 0 ? null : body;
    const bodyText = normalizeBody(params.bodyText);
    const pending = pendingBodySavesRef.current.get(saveKey);
    if (pending ? pending.bodyText === bodyText : normalizeBody(node.bodyText) === bodyText) return;
    const completion = (async () => {
      if (pending) await pending.completion;
      const currentNode = currentBodyModelRef.current?.nodes.find((candidate) => candidate.id === params.nodeId);
      if (currentBodyModelRef.current?.projectId !== selectedProjectId
        || !currentNode || normalizeBody(currentNode.bodyText) === bodyText) return;
      const cmd = createSetNodeBodyTextWireCommand({
        type: 'SetNodeBodyText',
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: currentBodyModelRef.current.projectRevision,
        nodeId: params.nodeId,
        bodyText,
      });
      await dispatchAndTrack(cmd);
    })();
    pendingBodySavesRef.current.set(saveKey, { bodyText, completion });
    try {
      await completion;
    } finally {
      if (pendingBodySavesRef.current.get(saveKey)?.completion === completion) {
        pendingBodySavesRef.current.delete(saveKey);
      }
    }
  };

  // ── Story 16.1/16.3: Open Questions & Decisions handlers ──────────

  const handleAddQuestion = async (nodeId: string, questionText: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const node = outlineModel.nodes.find((n) => n.id === nodeId);
    const existing = node?.openQuestions ?? [];
    const position = BigInt(existing.length + 1) * 4294967296n;
    const cmd = createAddNodeQuestionWireCommand(
      createAddNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        questionId: createUuidV7(),
        nodeId,
        questionText,
        position,
        createdAtISO: new Date().toISOString(),
      }),
    );
    await dispatchAndTrack(cmd);
  };

  const handleResolveQuestion = async (questionId: string, decisionText: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createResolveNodeQuestionWireCommand(
      createResolveNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        questionId,
        decisionText,
        resolvedAtISO: new Date().toISOString(),
      }),
    );
    await dispatchAndTrack(cmd);
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createDeleteNodeQuestionWireCommand(
      createDeleteNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        questionId,
      }),
    );
    await dispatchAndTrack(cmd);
  };

  const handleMoveNode = async (params: {
    nodeId: string;
    newParentId: string | null;
    newPosition: bigint;
  }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createMoveNodeWireCommand({
      type: 'MoveNode',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      newParentId: params.newParentId,
      newPosition: params.newPosition,
    });
    await dispatchAndTrack(cmd);
  };

  const handleDeleteSubtree = async (nodeId: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createDeleteSubtreeWireCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId,
    });
    await dispatchAndTrack(cmd);
  };

  const handleDuplicateSubtree = async (nodeId: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const sourceNode = outlineModel.nodes.find((n) => n.id === nodeId);
    const siblings = outlineModel.nodes.filter((n) => n.parentId === (sourceNode?.parentId ?? null));
    const sorted = [...siblings].sort((a, b) => (a.position < b.position ? -1 : 1));
    const idx = sorted.findIndex((n) => n.id === nodeId);
    const nextSibling = idx !== -1 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const posRes = positionBetween(sourceNode?.position ?? null, nextSibling?.position ?? null);
    const newPosition = posRes.kind === 'Position' ? posRes.position : positionForAppend(sourceNode?.position ?? null);

    const cmd = createDuplicateSubtreeWireCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      sourceNodeId: nodeId,
      newRootId: createUuidV7(),
      idMap: {},
      newPosition,
    });
    await dispatchAndTrack(cmd);
  };

  // ── Epic 3 Planning & Structuring Handlers ───────────────────────

  const handleSetNodeType = async (params: { nodeId: string; nodeType: NodeType | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodeTypeWireCommand({
      type: 'SetNodeType',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      nodeType: params.nodeType,
    });
    await dispatchAndTrack(cmd);
  };

  const handleSetNodeCustomField = async (params: {
    nodeId: string;
    fieldKey: string;
    fieldValue: string | null;
  }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodeCustomFieldWireCommand({
      type: 'SetNodeCustomField',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      fieldKey: params.fieldKey,
      fieldValue: params.fieldValue,
    });
    await dispatchAndTrack(cmd);
  };

  const handlePromoteFieldToTemplate = async (params: {
    nodeType: NodeType;
    fieldKey: string;
    fieldLabel: string;
  }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createPromoteFieldToTemplateWireCommand({
      type: 'PromoteFieldToTemplate',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeType: params.nodeType,
      fieldKey: params.fieldKey,
      fieldLabel: params.fieldLabel,
    });
    await dispatchAndTrack(cmd);
  };

  const handleSetNodeSchedule = async (params: {
    nodeId: string;
    startDate: string | null;
    endDate: string | null;
    durationDays: number | null;
    sourceMode: ScheduleSourceMode;
  }) => {
    if (!selectedProjectId || !outlineModel) return;

    const existingNode = outlineModel.nodes.find((n) => n.id === params.nodeId);
    const priorStartDate = existingNode?.startDate ?? null;

    const cmd = createSetNodeScheduleWireCommand({
      type: 'SetNodeSchedule',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      startDate: params.startDate,
      endDate: params.endDate,
      durationDays: params.durationDays,
      sourceMode: params.sourceMode,
    });
    await dispatchAndTrack(cmd);

    // Story 4.8: If start date shifted, calculate and record downstream affected work
    if (params.startDate && priorStartDate && params.startDate !== priorStartDate) {
      const deltaDays = 5; // derived shift
      const domainNodes = toDomainNodes(outlineModel);
      const domainEdges = outlineModel.unlockEdges ?? [];
      const reasons = calculateDownstreamAffectedWork({
        nodes: domainNodes,
        edges: domainEdges,
        causalNodeId: params.nodeId,
        priorStartDate,
        newStartDate: params.startDate,
        deltaDays,
        createdAt: new Date().toISOString(),
      });

      if (reasons.length > 0) {
        const affCmd = createRecordAffectedReasonsWireCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: getProjectRevision(selectedProjectId),
          reasons,
        });
        await dispatchAndTrack(affCmd);
      }
    }

    // Clear open affected reasons for this node since its schedule was just directly authored
    const clearCmd = createClearNodeAffectedReasonsWireCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
    });
    await dispatchAndTrack(clearCmd);
  };

  const handleToggleNodeCompleted = async (params: { nodeId: string; completed: boolean }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createToggleNodeCompletedWireCommand({
      type: 'ToggleNodeCompleted',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      completed: params.completed,
    });
    await dispatchAndTrack(cmd);
  };

  const handleSetNodeEffort = async (params: { nodeId: string; effortPoints: number | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodeEffortWireCommand({
      type: 'SetNodeEffort',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      effortPoints: params.effortPoints,
    });
    await dispatchAndTrack(cmd);
  };

  /** Story 26.5, FC-FR5: record (or clear) points done on an item. */
  const handleSetNodePointsDone = async (params: { nodeId: string; effortPointsDone: number | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodePointsDoneWireCommand({
      type: 'SetNodePointsDone',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      effortPointsDone: params.effortPointsDone,
    });
    await dispatchAndTrack(cmd);
  };

  // ── Epic 18: forecast handlers (Story 18.5, Story 18.6) ─────────────

  const handleSaveForecastConfiguration = async (config: {
    pointsPerSprint: number | null;
    sprintLengthDays: number | null;
    startSprintOrdinal: number | null;
    startDate: string | null;
  }) => {
    if (!selectedProjectId || !outlineModel) return;
    // Story 21.13 D5: plan CREATION is atomic — the level chosen on the step
    // card rides the SAME ConfigureForecastPlan command as the configuration
    // group, so creation is one command, one revision, one undo entry. One
    // Ctrl+Z returns to the pre-creation state (the level step), never to a
    // Feature plan with the Theme configuration retained. Edit-in-place saves
    // carry a null level and preserve the stored level.
    const hadPlan = forecastPlan !== null;
    let cmd;
    try {
      // The command constructors validate the configuration group and throw a
      // typed error for a malformed entry (negative capacity, non-integer,
      // impossible date). Surface it instead of losing the save silently.
      cmd = createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: getProjectRevision(selectedProjectId),
          pointsPerSprint: config.pointsPerSprint,
          sprintLengthDays: config.sprintLengthDays,
          startSprintOrdinal: config.startSprintOrdinal,
          startDate: config.startDate,
          planningLevel: !hadPlan ? (forecastChosenLevel ?? null) : null,
        }),
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INVALID_CONFIGURATION';
      setStatusMessage(
        `That forecast configuration was not saved (${code}). Capacity and sprint length must be whole non-negative numbers and the date a real calendar date.`,
      );
      return;
    }
    await dispatchAndTrack(cmd);
  };

  const handleToggleForecastMembership = async (featureId: string, included: boolean): Promise<boolean> => {
    if (!selectedProjectId || !outlineModel) return false;
    const cmd = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        featureId,
        included,
      }),
    );
    const outcome = await dispatchAndTrack(cmd);
    return (
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied'
    );
  };

  // Story 20.5 / 25.1: evaluate every saved scenario purely from its captured
  // facts, in the analysis worker. A scenario whose identity + content
  // fingerprint is unchanged since its last evaluation is reused from the
  // cache: refreshes no longer recompute a main-thread fingerprint or post a
  // new worker request for an unchanged scenario (AC 25.1-1). A changed
  // scenario re-evaluates exactly once.
  useEffect(() => {
    let cancelled = false;
    const today = localToday();
    void (async () => {
      const { baselineFromPersisted, scenarioFingerprint } = await import('../domain/forecast/scenario');
      const { reconcileScenarioEvaluations } = await import('../application/forecast/scenario-evaluation-cache');
      const result = await reconcileScenarioEvaluations(
        scenarioEvaluationCacheRef.current,
        forecastScenarios,
        (s) => scenarioFingerprint(baselineFromPersisted(s), s.patch, today),
        async (s, fingerprint) => {
          try {
            const response = await analysisClientRef.current?.requestScenarioEvaluation({
              type: 'ScenarioEvaluationRequest',
              projectId: s.projectId,
              scenarioId: s.scenarioId,
              requestToken: createUuidV7(),
              scenarioFingerprint: fingerprint,
              baselineRevision: s.baselineRevision,
              policyVersion: s.policyVersion,
              scenario: s,
              today,
            });
            return response?.evaluation ?? undefined;
          } catch {
            // Superseded by a newer pass over the scenario set, or the worker
            // failed: the card keeps its "Evaluating..." state for this pass.
            return undefined;
          }
        },
        () => cancelled,
        today,
      );
      if (cancelled) return;
      setScenarioEvaluations(new Map(result.evaluations));
    })();
    return () => {
      cancelled = true;
    };
  }, [forecastScenarios]);

  // -- Story 23.7: scenario drafts ---------------------------------------
  // A draft captures one acknowledged baseline when it opens and never reads
  // live facts again; previews run in the analysis worker; Save sends the
  // captured revision and fingerprint, so a changed live plan is refused as
  // stale instead of silently rebased.
  const handleCaptureScenarioDraft = async (): Promise<ScenarioDraftContext> => {
    if (!selectedProjectId) throw new Error('NO_PROJECT_SELECTED');
    const snap = await queryAnalysisSnapshot(selectedProjectId);
    return captureScenarioDraftContext(snap, createUuidV7());
  };

  const handleEvaluateScenarioDraft = async (
    context: ScenarioDraftContext,
    patch: import('../domain/forecast/scenario').ForecastScenarioPatch,
  ): Promise<import('../domain/forecast/scenario-evaluate').ScenarioEvaluation> => {
    const client = analysisClientRef.current;
    if (!client) throw new Error('SCENARIO_WORKER_UNAVAILABLE');
    const { scenarioFingerprint } = await import('../domain/forecast/scenario');
    const response = await client.requestScenarioEvaluation({
      type: 'ScenarioEvaluationRequest',
      projectId: context.projectId,
      scenarioId: context.draftId,
      requestToken: createUuidV7(),
      scenarioFingerprint: await scenarioFingerprint(context.baseline, patch),
      baselineRevision: context.baselineRevision,
      policyVersion: context.policyVersion,
      scenario: draftScenarioRecord(context, patch),
      today: localToday(),
    });
    if (!response.evaluation) throw new Error('SCENARIO_EVALUATION_FAILED');
    return response.evaluation;
  };

  const handleCancelScenarioDraft = (draftId: string): void => {
    analysisClientRef.current?.cancelScenarioEvaluation(draftId);
  };


  const handleCreateForecastScenario = async (params: {
    label: string;
    patch: import('../domain/forecast/scenario').ForecastScenarioPatch;
    context: ScenarioDraftContext;
  }): Promise<ScenarioSaveOutcome> => {
    const { context } = params;
    const cmd = createCreateForecastScenarioWireCommand(
      createCreateForecastScenarioCommand({
        commandId: createUuidV7(),
        projectId: context.projectId,
        baseRevision: context.baselineRevision,
        scenarioId: createUuidV7(),
        label: params.label,
        // The captured expectations, never the live revision or fingerprint
        // at save time (AC 23.7-2).
        baselineRevision: context.baselineRevision,
        expectedMaterialFingerprint: context.materialFingerprint,
        createdAtISO: new Date().toISOString(),
        patch: params.patch,
      }),
    );
    const outcome = await dispatchAndTrack(cmd);
    if (outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied') {
      const snap = await queryAnalysisSnapshot(context.projectId);
      setForecastScenarios(snap.forecastScenarios ?? []);
      return { kind: 'saved' };
    }
    const code =
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandRejected'
        ? outcome.result.code
        : 'SCENARIO_SAVE_FAILED';
    return code === 'FORECAST_SCENARIO_STALE' || code === 'REVISION_CONFLICT'
      ? { kind: 'stale' }
      : { kind: 'rejected', code };
  };

  const handleRemoveForecastScenario = async (scenarioId: string) => {
    if (!selectedProjectId) return;
    const cmd = createRemoveForecastScenarioWireCommand(
      createRemoveForecastScenarioCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        scenarioId,
      }),
    );
    await dispatchAndTrack(cmd);
    const snap = await queryAnalysisSnapshot(selectedProjectId);
    setForecastScenarios(snap.forecastScenarios ?? []);
  };

  const handleSetForecastBlocker = async (featureId: string, blocked: boolean) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetForecastBlockerWireCommand(
      createSetForecastBlockerCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        featureId,
        blocked,
      }),
    );
    await dispatchAndTrack(cmd);
  };

  // Story 21.10 AC 3: persist a planning-level switch (FR-13). The command
  // atomically clears scope, groups, and blockers; the confirmation dialog
  // lives in the workspace.
  const handleSetForecastPlanningLevel = async (level: import('../adapters/ui/forecast/planning-level-step').PlanningLevel) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetForecastPlanningLevelWireCommand(
      createSetForecastPlanningLevelCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        planningLevel: level,
      }),
    );
    await dispatchAndTrack(cmd);
  };

  // Persistence seam for the forecast workspace's combined move. Story 27.2:
  // the gesture's result is reduced to single MoveForecastFeature commands, and
  // the whole gesture is one undo entry (beginGroup/endGroup).
  const handleSetForecastSequence = async (featureIds: readonly string[], parallelGroups: readonly ForecastParallelGroup[]) => {
    if (!selectedProjectId || !outlineModel) return;
    const priorIds = forecastPlan?.selectedFeatureIds ?? [];
    const priorGroups = forecastPlan?.parallelGroups ?? [];
    setForecastPlan((prev) =>
      prev
        ? createForecastPlan({
            projectId: prev.projectId,
            selectedFeatureIds: featureIds,
            parallelGroups,
            blockedFeatureIds: prev.blockedFeatureIds,
            configuration: prev.configuration,
            policyVersion: prev.policyVersion,
            planningLevel: prev.planningLevel,
            roster: prev.roster,
            assignments: prev.assignments,
          })
        : prev,
    );
    const intents = diffForecastSequence(priorIds, priorGroups, featureIds, parallelGroups);
    // A pure reorder/group edit always diffs; if the scope itself changed the
    // diff is empty and there is nothing to persist (the caller changed scope
    // separately via membership commands).
    if (intents.length === 0) return;
    // Story 27.2: the whole gesture is one transaction (a refused later move
    // leaves no earlier move applied) and one grouped undo entry.
    const base = getProjectRevision(selectedProjectId);
    const cmds = intents.map((intent, index) => createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: base + index,
        featureId: intent.featureId,
        afterId: intent.afterId,
        beforeId: intent.beforeId,
        intendedIndex: intent.intendedIndex,
        groupChange: intent.groupChange,
      }),
    ));
    await dispatchBatchAndTrack(cmds);
  };

  // ── Jump-the-line what-if (Story 26.7, FC-FR7/8) ──────────────────────
  const whatIfContextRef = useRef<ScenarioDraftContext | null>(null);

  const handleSetForecastAssignments = async (
    featureId: string,
    personIds: readonly string[],
  ): Promise<boolean | string> => {
    if (!selectedProjectId || !outlineModel) return false;
    // Story 27.2: express the change as single-person SetForecastAssignment
    // commands (assign/unassign), one undo entry for the whole commit.
    const priorPersonIds = forecastPlan?.assignments?.[featureId] ?? [];
    const priorSet = new Set(priorPersonIds);
    const nextSet = new Set(personIds);
    const toAssign = personIds.filter((id) => !priorSet.has(id));
    const toUnassign = priorPersonIds.filter((id) => !nextSet.has(id));
    const changes = [
      ...toAssign.map((personId) => ({ personId, assigned: true })),
      ...toUnassign.map((personId) => ({ personId, assigned: false })),
    ];
    if (changes.length === 0) return true;

    // Story 27.2: prevalidate every component, then apply them as ONE
    // transaction with one grouped undo entry. A refusal leaves no component.
    const base = getProjectRevision(selectedProjectId);
    let cmds: ProductCommand[];
    try {
      cmds = changes.map((change, index) => createSetForecastAssignmentWireCommand(
        createSetForecastAssignmentCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: base + index,
          featureId,
          personId: change.personId,
          assigned: change.assigned,
        }),
      ));
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INVALID_ASSIGNMENT';
      setStatusMessage(`Assignment was not applied (${code}).`);
      return false;
    }
    const outcome = await dispatchBatchAndTrack(cmds);
    if (outcome?.kind === 'applied') return true;
    if (outcome?.kind !== 'rejected') return false;
    // Story 23.10 (SF-FR5, SF-UX4): both runtimes name the person and the
    // conflicting items; say so in words instead of a generic failure.
    const rejected = outcome.rejected;
    const title = (id: string) => domainNodes.find((n) => n.id === id)?.title || 'Untitled';
    const person = forecastPlan?.roster?.find((p) => p.id === rejected.personId)?.name ?? 'This person';
    if (rejected.code === 'FORECAST_ASSIGNMENT_CONFLICT' && rejected.conflictingFeatureIds) {
      const items = [...new Set([featureId, ...rejected.conflictingFeatureIds])].map(title);
      return `${person} would be assigned to both ${items.slice(0, -1).join(', ')} and ${items[items.length - 1]} in one parallel bucket. Change the assignments or keep the items sequential.`;
    }
    if (rejected.code === 'FORECAST_ASSIGNMENT_ZERO_WORK') {
      return `${title(featureId)} has 0 points, so it cannot have people assigned.`;
    }
    return false;
  };

  const handleCaptureWhatIfBaseline = useCallback(async (): Promise<ScenarioDraftContext> => {
    if (!selectedProjectId) throw new Error('NO_PROJECT_SELECTED');
    const snap = await queryAnalysisSnapshot(selectedProjectId);
    const context = captureScenarioDraftContext(snap, createUuidV7());
    whatIfContextRef.current = context;
    return context;
  }, [selectedProjectId]);

  const handleEvaluateWhatIf = useCallback(
    async (
      patch: import('../domain/forecast/scenario').ForecastScenarioPatch,
      addedFact?: { id: string; fact: unknown; title?: string },
    ): Promise<import('../domain/forecast/scenario-evaluate').ScenarioEvaluation> => {
      const context = whatIfContextRef.current;
      if (!context) throw new Error('WHAT_IF_NO_BASELINE');
      // Merge a new draft item into the captured baseline so the scenario can
      // reference it without writing anything (AC 26.7-1).
      const merged: ScenarioDraftContext = addedFact
        ? Object.freeze({
            ...context,
            baseline: Object.freeze({
              ...context.baseline,
              factMap: Object.freeze({ ...context.baseline.factMap, [addedFact.id]: addedFact.fact as never }),
            }),
            items: Object.freeze([
              ...context.items,
              Object.freeze({
                id: addedFact.id,
                title: addedFact.title ?? 'New item',
                effortPoints: (addedFact.fact as { effortPoints: number }).effortPoints,
                included: true,
              }),
            ]),
          })
        : context;
      return handleEvaluateScenarioDraft(merged, patch);
    },
    [handleEvaluateScenarioDraft],
  );

  const handleApplyWhatIf = useCallback(
    (params: {
      patch: import('../domain/forecast/scenario').ForecastScenarioPatch;
      addedFact?: { id: string; fact: unknown; title?: string };
    }) => {
      const { patch, addedFact } = params;
      const scope = patch.orderedScope;
      if (addedFact) {
        const points = (addedFact.fact as { effortPoints: number }).effortPoints;
        const level = forecastPlan?.planningLevel ?? 'Feature';
        void (async () => {
          await handleCreateNode({
            nodeId: addedFact.id,
            parentId: null,
            position: BigInt(Date.now()) * 1024n,
            title: addedFact.title ?? 'Urgent item',
          });
          await handleSetNodeType({ nodeId: addedFact.id, nodeType: level });
          await handleSetNodeEffort({ nodeId: addedFact.id, effortPoints: points });
          await handleToggleForecastMembership(addedFact.id, true);
          for (const [nodeId, personIds] of Object.entries(patch.assignmentOverrides ?? {})) {
            await handleSetForecastAssignments(nodeId, personIds);
          }
          // Apply the exact evaluated scope (which may exclude items the
          // hold-the-date strategy deferred), not a rebuilt order.
          const nextScope = scope ?? [addedFact.id, ...(forecastPlan?.selectedFeatureIds ?? [])];
          await handleSetForecastSequence(
            nextScope,
            patch.parallelGroups ?? forecastPlan?.parallelGroups ?? [],
          );
        })();
      } else if (scope) {
        void (async () => {
          for (const [nodeId, points] of Object.entries(patch.pointOverrides ?? {})) {
            await handleSetNodeEffort({ nodeId, effortPoints: points });
          }
          for (const [nodeId, personIds] of Object.entries(patch.assignmentOverrides ?? {})) {
            await handleSetForecastAssignments(nodeId, personIds);
          }
          await handleSetForecastSequence(scope, patch.parallelGroups ?? forecastPlan?.parallelGroups ?? []);
        })();
      }
    },
    [
      forecastPlan,
      handleCreateNode,
      handleSetNodeType,
      handleSetNodeEffort,
      handleToggleForecastMembership,
      handleSetForecastSequence,
      handleSetForecastAssignments,
    ],
  );

  const handleSaveWhatIf = useCallback(
    (label: string, patch: import('../domain/forecast/scenario').ForecastScenarioPatch) => {
      const context = whatIfContextRef.current;
      if (!context) return;
      void handleCreateForecastScenario({ label, patch, context });
    },
    [handleCreateForecastScenario],
  );

  const handleAddForecastPerson = async (name: string, weightUnits: number): Promise<boolean> => {
    if (!selectedProjectId || !outlineModel) return false;
    let cmd;
    try {
      cmd = createAddForecastPersonWireCommand(
        createAddForecastPersonCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: getProjectRevision(selectedProjectId),
          personId: createUuidV7(),
          name,
          weightUnits,
        }),
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INVALID_PERSON';
      setStatusMessage(`Person was not added (${code}). Name must be non-empty and weight positive.`);
      return false;
    }
    const outcome = await dispatchAndTrack(cmd);
    return Boolean(
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied',
    );
  };

  const handleUpdateForecastPerson = async (personId: string, name: string, weightUnits: number): Promise<boolean> => {
    if (!selectedProjectId || !outlineModel) return false;
    let cmd;
    try {
      cmd = createUpdateForecastPersonWireCommand(
        createUpdateForecastPersonCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: getProjectRevision(selectedProjectId),
          personId,
          name,
          weightUnits,
        }),
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INVALID_PERSON';
      setStatusMessage(`Person was not updated (${code}). Name must be non-empty and weight positive.`);
      return false;
    }
    const outcome = await dispatchAndTrack(cmd);
    return Boolean(
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied',
    );
  };

  const handleRemoveForecastPerson = async (personId: string): Promise<boolean> => {
    if (!selectedProjectId || !outlineModel) return false;
    const cmd = createRemoveForecastPersonWireCommand(
      createRemoveForecastPersonCommand({
        commandId: createUuidV7(),
        projectId: selectedProjectId,
        baseRevision: getProjectRevision(selectedProjectId),
        personId,
      }),
    );
    const outcome = await dispatchAndTrack(cmd);
    return Boolean(
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied',
    );
  };

  const handleSetForecastPolicy = async (
    policyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion,
  ): Promise<boolean> => {
    if (!selectedProjectId || !outlineModel) return false;
    let cmd;
    try {
      cmd = createSetForecastPolicyWireCommand(
        createSetForecastPolicyCommand({
          commandId: createUuidV7(),
          projectId: selectedProjectId,
          baseRevision: getProjectRevision(selectedProjectId),
          policyVersion,
        }),
      );
    } catch (err) {
      const code = err instanceof Error ? err.message : 'INVALID_POLICY';
      setStatusMessage(`Policy was not updated (${code}).`);
      return false;
    }
    const outcome = await dispatchAndTrack(cmd);
    return Boolean(
      outcome?.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied',
    );
  };

  const handleSetDeliveryStatus = async (params: { nodeId: string; deliveryStatus: DeliveryStatus }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetNodeStatusWireCommand({
      type: 'SetNodeStatus',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      deliveryStatus: params.deliveryStatus,
    });
    await dispatchAndTrack(cmd);
  };

  const handleSetThemeWeight = async (params: { nodeId: string; strategicWeight: number | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createSetThemeWeightWireCommand({
      type: 'SetThemeWeight',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      strategicWeight: params.strategicWeight,
    });
    await dispatchAndTrack(cmd);
  };

  const handleCreatePhase = async (name: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const phaseId = createUuidV7();
    const currentPhases = outlineModel.phases ?? [];
    const position = BigInt(currentPhases.length + 1) * 4294967296n;

    const cmd = createCreatePhaseWireCommand({
      type: 'CreatePhase',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      phaseId,
      name,
      position,
    });
    await dispatchAndTrack(cmd);
  };

  const handleRenamePhase = async (params: { phaseId: string; name: string }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createRenamePhaseWireCommand({
      type: 'RenamePhase',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      phaseId: params.phaseId,
      name: params.name,
    });
    await dispatchAndTrack(cmd);
  };

  const handleReorderPhases = async (phases: readonly { phaseId: string; position: bigint }[]) => {
    if (!selectedProjectId || !outlineModel) return;
    // Story 27.2: the phase manager hands us the full new order; reduce it to
    // the single phase that moved, with after/before anchors (D8(c)).
    const priorOrder = [...(outlineModel.phases ?? [])]
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id.localeCompare(b.id)))
      .map((p) => p.id);
    const nextOrder = phases.map((p) => p.phaseId);
    const movedId = nextOrder.find((id, i) => priorOrder[i] !== id);
    if (!movedId) return;
    const idx = nextOrder.indexOf(movedId);
    const cmd = createMovePhaseWireCommand(createMovePhaseCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      phaseId: movedId,
      afterId: idx > 0 ? nextOrder[idx - 1] : null,
      beforeId: null,
      intendedIndex: idx,
    }));
    await dispatchAndTrack(cmd);
  };

  const handleAssignNodePhase = async (params: { nodeId: string; phaseId: string | null }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createAssignNodePhaseWireCommand({
      type: 'AssignNodePhase',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      nodeId: params.nodeId,
      phaseId: params.phaseId,
    });
    await dispatchAndTrack(cmd);
  };

  const handleDeletePhase = async (params: { phaseId: string; reassignments: Record<string, string | null> }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createDeletePhaseWireCommand({
      type: 'DeletePhase',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      phaseId: params.phaseId,
      reassignments: params.reassignments,
    });
    await dispatchAndTrack(cmd);
  };

  const handleCreateUnlockEdge = async (params: { sourceNodeId: string; targetNodeId: string }) => {
    if (!selectedProjectId || !outlineModel) return;
    const edgeId = createUuidV7();
    const cmd = createCreateUnlockEdgeWireCommand({
      type: 'CreateUnlockEdge',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      edgeId,
      sourceNodeId: params.sourceNodeId,
      targetNodeId: params.targetNodeId,
    });
    await dispatchAndTrack(cmd);
  };

  const handleDeleteUnlockEdge = async (params: { edgeId: string; sourceNodeId: string; targetNodeId: string }) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createDeleteUnlockEdgeWireCommand({
      type: 'DeleteUnlockEdge',
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      edgeId: params.edgeId,
      sourceNodeId: params.sourceNodeId,
      targetNodeId: params.targetNodeId,
    });
    await dispatchAndTrack(cmd);
  };

  // ── Epic 4 Coherence & Consequence Handlers ───────────────────────

  const handleDismissFinding = async (finding: CoherenceFinding) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createDismissFindingWireCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: getProjectRevision(selectedProjectId),
      findingId: finding.id,
      findingKind: finding.kind,
      targetId: finding.targetNodeId,
      fingerprint: finding.fingerprint,
      dismissedAt: new Date().toISOString(),
    });
    await dispatchAndTrack(cmd);
  };

  const handleAcknowledgeAffectedReason = async (reasonId: string) => {
    if (!selectedProjectId || !outlineModel) return;
    const cmd = createAcknowledgeAffectedReasonWireCommand({
      commandId: createUuidV7(),
      projectId: selectedProjectId,
      baseRevision: outlineModel.projectRevision,
      reasonId,
      acknowledgedAt: new Date().toISOString(),
    });
    await dispatchAndTrack(cmd);
  };

  const handleUndo = async () => {
    if (!undoEngineRef.current || !selectedProjectId || !outlineModel) return;
    if (orchestratorRef.current && !orchestratorRef.current.isQueueSettled(selectedProjectId)) {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (orchestratorRef.current.isQueueSettled(selectedProjectId)) break;
      }
    }
    const undoResult = await undoEngineRef.current.undo(selectedProjectId, getProjectRevision(selectedProjectId));
    if (undoResult?.type === 'ProductCommandRejected') {
      // A refused undo/redo (e.g. a teammate changed the item after you, or a
      // restore conflict) is explained instead of silently doing nothing.
      const feedback = formatCommandRejection(undoResult as ProductCommandRejected);
      setStatusMessage(`${feedback.cause} ${feedback.resultingState}`);
    }
    const updated = await queryProjectNodes(selectedProjectId);
    applyOutlineModel(updated);
    setAffectedReasons(await queryAffectedReasons(selectedProjectId));
    void refreshForecast(selectedProjectId);
  };

  const handleRedo = async () => {
    if (!undoEngineRef.current || !selectedProjectId || !outlineModel) return;
    if (orchestratorRef.current && !orchestratorRef.current.isQueueSettled(selectedProjectId)) {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (orchestratorRef.current.isQueueSettled(selectedProjectId)) break;
      }
    }
    const undoResult = await undoEngineRef.current.redo(selectedProjectId, outlineModel.projectRevision);
    if (undoResult?.type === 'ProductCommandRejected') {
      // A refused undo/redo (e.g. a teammate changed the item after you, or a
      // restore conflict) is explained instead of silently doing nothing.
      const feedback = formatCommandRejection(undoResult as ProductCommandRejected);
      setStatusMessage(`${feedback.cause} ${feedback.resultingState}`);
    }
    const updated = await queryProjectNodes(selectedProjectId);
    applyOutlineModel(updated);
    setAffectedReasons(await queryAffectedReasons(selectedProjectId));
    void refreshForecast(selectedProjectId);
  };

  const handleSwitchView = useCallback(async (targetView: 'outline' | 'visual' | 'gantt' | 'forecast') => {
    if (targetView === activeViewId) return;
    if (selectedProjectId && orchestratorRef.current) {
      if (!orchestratorRef.current.isQueueSettled(selectedProjectId)) {
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (orchestratorRef.current.isQueueSettled(selectedProjectId)) break;
        }
      }
      if (!orchestratorRef.current.isQueueSettled(selectedProjectId)) {
        const cause = orchestratorRef.current.queueBlockingCause(selectedProjectId);
        setStatusMessage(`View switch blocked: ${cause ?? 'Pending commands in flight'}`);
        return;
      }
    }
    setActiveViewId(targetView);
  }, [activeViewId, selectedProjectId]);

  const handleViewStateChange = (
    viewIdOrPatch: ViewId | { collapsedNodeIds?: readonly string[]; zoomRootId?: string | null; focusedThemeId?: string | null; navCollapsed?: boolean },
    maybePatch?: { collapsedNodeIds?: readonly string[]; zoomRootId?: string | null; focusedThemeId?: string | null; navCollapsed?: boolean },
  ) => {
    if (!selectedProjectId || !coalescerRef.current) return;
    const targetViewId: ViewId = typeof viewIdOrPatch === 'string' ? viewIdOrPatch : 'outline';
    const patch = typeof viewIdOrPatch === 'string' ? (maybePatch ?? {}) : viewIdOrPatch;
    coalescerRef.current.submitPatch(selectedProjectId, targetViewId, patch);
  };

  // Epic 15 (E15-FR5): resync the nav's collapsed presentation from the
  // current project+view's view-state whenever either changes — covers
  // initial load, project switch, and view switch uniformly, since all
  // three already seed/hold the coalescer snapshot by that point. The
  // Forecast destination is a planning surface, not a view-state lane
  // (UX-DR1), so it falls back to the outline lane's presentation.
  useEffect(() => {
    if (!selectedProjectId || !coalescerRef.current) return;
    const lane: ViewId = activeViewId === 'forecast' ? 'outline' : activeViewId;
    const snap = coalescerRef.current.getSnapshot(selectedProjectId, lane);
    if (snap) setNavCollapsed(snap.fields.navCollapsed);
  }, [selectedProjectId, activeViewId]);

  const handleToggleNavCollapsed = useCallback(() => {
    const next = !navCollapsed;
    setNavCollapsed(next);
    if (selectedProjectId) {
      const lane: ViewId = activeViewId === 'forecast' ? 'outline' : activeViewId;
      handleViewStateChange(lane, { navCollapsed: next });
    }
  }, [navCollapsed, selectedProjectId, activeViewId]);

  // Breadcrumbs calculation
  const crumbs: Crumb[] = useMemo(() => {
    const selectedProj = projects.find((p) => p.id === selectedProjectId);
    const rootCrumb: Crumb = { id: null, label: selectedProj?.name ?? 'Project' };
    if (!zoomRootId || !outlineModel) return [rootCrumb];

    const nodeMap = new Map(outlineModel.nodes.map((n) => [n.id, n]));
    const chain: { id: string; label: string }[] = [];
    let curr = nodeMap.get(zoomRootId);
    while (curr) {
      chain.unshift({ id: curr.id, label: curr.title || 'Untitled' });
      curr = curr.parentId ? nodeMap.get(curr.parentId) : undefined;
    }
    return [rootCrumb, ...chain];
  }, [projects, selectedProjectId, zoomRootId, outlineModel]);

  // Coherence Review projection (Story 4.7)
  const coherenceReview = useMemo(() => {
    const domainNodes = outlineModel ? toDomainNodes(outlineModel) : [];
    const allFindings = [...coherenceFindings, ...themeImbalances];
    return projectCoherenceReview(allFindings, domainNodes);
  }, [coherenceFindings, themeImbalances, outlineModel]);


  // Global keydown handler for palette, jump, and review panels
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;

      if (isCtrlOrMeta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setActiveSurface((prev) => (prev === 'palette' ? 'none' : 'palette'));
      } else if (isCtrlOrMeta && e.key === '/') {
        e.preventDefault();
        setActiveSurface((prev) => (prev === 'jump' ? 'none' : 'jump'));
      } else if (isCtrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setIsCoherenceReviewOpen((prev) => !prev);
      } else if (isCtrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setIsAffectedPanelOpen((prev) => !prev);
      } else if (isCtrlOrMeta && (e.key.toLowerCase() === 'l' || e.key.toLowerCase() === 'u')) {
        e.preventDefault();
        setInspectorTab('unlocks');
        setIsInspectorOpen(true);
      } else if (isCtrlOrMeta && e.key.toLowerCase() === 'e') {
        // Story 16.3 (E16-UX2): ⌘E toggles the Side Inspector Drawer.
        e.preventDefault();
        setIsInspectorOpen((prev) => !prev);
      } else if (isCtrlOrMeta && e.key.toLowerCase() === 'z') {
        const active = document.activeElement;
        const isEditingText =
          (active instanceof HTMLInputElement &&
            active.type !== 'checkbox' &&
            active.type !== 'radio' &&
            active.type !== 'button') ||
          active instanceof HTMLTextAreaElement;
        if (isEditingText) {
          return;
        }
        e.preventDefault();
        if (e.shiftKey) {
          void handleRedo();
        } else {
          void handleUndo();
        }
      } else if (isCtrlOrMeta && e.key.toLowerCase() === 'y') {
        const active = document.activeElement;
        const isEditingText =
          (active instanceof HTMLInputElement &&
            active.type !== 'checkbox' &&
            active.type !== 'radio' &&
            active.type !== 'button') ||
          active instanceof HTMLTextAreaElement;
        if (isEditingText) {
          return;
        }
        e.preventDefault();
        void handleRedo();
      } else if (e.altKey && e.key === '1') {
        e.preventDefault();
        handleSwitchView('outline');
      } else if (e.altKey && e.key === '2') {
        e.preventDefault();
        handleSwitchView('visual');
      } else if (e.altKey && e.key === '3') {
        e.preventDefault();
        handleSwitchView('gantt');
      } else if (e.altKey && e.key === '4') {
        e.preventDefault();
        handleSwitchView('forecast');
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleSwitchView, handleUndo, handleRedo, activeViewId]);

  const actionContext = useMemo(() => {
    return createDefaultActionContext({
      viewId: viewMode === 'workspace' ? 'overview' : activeViewId,
      focusedNodeId: focusedNodeId ?? undefined,
      projectId: selectedProjectId ?? undefined,
    });
  }, [viewMode, activeViewId, focusedNodeId, selectedProjectId]);


  const domainNodes = useMemo(() => (outlineModel ? toDomainNodes(outlineModel) : []), [outlineModel]);

  const projectThemes = useMemo(() => {
    return listThemesInOrdinalOrder(domainNodes);
  }, [domainNodes]);

  // 2026-09-07 planning surface: the level step. Stage 2 (Epic 21, Story
  // 21.10): every level with project nodes is enabled; a level with 0 nodes
  // is disabled with a `0 available` badge (UX-DR1). Declared before
  // `forecastRows` so the row builder can bind to the chosen level.
  const [forecastChosenLevel, setForecastChosenLevel] = useState<
    import('../adapters/ui/forecast/planning-level-step').PlanningLevel | undefined
  >(undefined);

  // Epic 18 (Story 18.5/18.6): planning-list rows. Built from the union of
  // current nodes at the plan's level AND every selected reference — a
  // deleted or retyped selected node stays visible as an invalid reference
  // with an explicit exclude affordance; scope is never silently shrunk
  // (AC 18.1-4, AC 18.6-5). `overlap` flags a node that is an ancestor or
  // descendant of an already selected node so the picker can name and block
  // it (AC 18.6-4, UX-DR10). Story 21.10 AC 2: the level is the plan's
  // planningLevel (falling back to the chosen level before a plan exists) —
  // never a hardcoded 'Feature'.
  const forecastRows = useMemo(() => {
    const selectedIds = forecastPlan?.selectedFeatureIds ?? [];
    const selectedSet = new Set(selectedIds);
    const byId = new Map(domainNodes.map((n) => [n.id, n] as const));
    const parentOf = new Map(domainNodes.map((n) => [n.id, n.parentId] as const));
    const level = forecastPlan?.planningLevel ?? forecastChosenLevel ?? 'Feature';

    const isOverlapping = (nodeId: string): boolean => {
      if (selectedSet.has(nodeId)) return false;
      // ancestor already selected?
      const visited = new Set<string>([nodeId]);
      let a = parentOf.get(nodeId) ?? null;
      while (a !== null && !visited.has(a)) {
        visited.add(a);
        if (selectedSet.has(a)) return true;
        a = parentOf.get(a) ?? null;
      }
      // descendant already selected?
      for (const sel of selectedIds) {
        const seen = new Set<string>([sel]);
        let p = parentOf.get(sel) ?? null;
        while (p !== null && !seen.has(p)) {
          seen.add(p);
          if (p === nodeId) return true;
          p = parentOf.get(p) ?? null;
        }
      }
      return false;
    };

    // 1. Selected nodes in exact plan.selectedFeatureIds sequence order
    const selectedRows: ForecastPlanningRow[] = [];
    for (const id of selectedIds) {
      const node = byId.get(id);
      if (node && node.nodeType === level) {
        selectedRows.push({
          id: node.id,
          title: node.title,
          effortPoints: node.effortPoints,
          effortPointsDone: node.effortPointsDone,
          deliveryStatus: node.deliveryStatus,
          included: true,
          overlap: false,
          invalid: false,
        });
      } else {
        selectedRows.push({
          id,
          title: node?.title ?? `(removed ${level})`,
          effortPoints: null,
          included: true,
          overlap: false,
          invalid: true,
        });
      }
    }

    // 2. Unselected nodes at the level, in tree order
    const unselectedRows = domainNodes
      .filter((n) => n.nodeType === level && !selectedSet.has(n.id))
      .map((n) => ({
        id: n.id,
        title: n.title,
        effortPoints: n.effortPoints,
        effortPointsDone: n.effortPointsDone,
        deliveryStatus: n.deliveryStatus,
        included: false,
        overlap: isOverlapping(n.id),
        invalid: false,
      }));

    return [...selectedRows, ...unselectedRows];
  }, [domainNodes, forecastPlan, forecastChosenLevel]);

  /**
   * Backlog rows in tree order with their nesting among same-level peers, so
   * the pane can indent and collapse them like the outline. Tree order (not
   * the Priority list's ranked order) is what makes a parent sit directly
   * above its children; the Priority list keeps its own ordering from
   * `forecastRows`.
   */
  const forecastBacklogItems = useMemo(() => {
    const selectedIds = forecastPlan?.selectedFeatureIds ?? [];
    const selectedSet = new Set(selectedIds);
    const parentOf = new Map(domainNodes.map((n) => [n.id, n.parentId] as const));
    const level = forecastPlan?.planningLevel ?? forecastChosenLevel ?? 'Feature';
    // Sort the whole tree first: `domainNodes` arrives ORDER BY position
    // across the project, which interleaves subtrees (a child at position 0
    // lands above an unrelated root at position 1).
    const atLevel = sortByTreeOrder(domainNodes).filter((n) => n.nodeType === level);
    const levelIds = new Set(atLevel.map((n) => n.id));

    /** Nearest ancestor that is itself a row at this level, and the depth to it. */
    const placeInHierarchy = (nodeId: string): { parentId: string | null; depth: number } => {
      const seen = new Set<string>([nodeId]);
      let ancestor = parentOf.get(nodeId) ?? null;
      let parentId: string | null = null;
      let depth = 0;
      while (ancestor !== null && !seen.has(ancestor)) {
        seen.add(ancestor);
        if (levelIds.has(ancestor)) {
          if (parentId === null) parentId = ancestor;
          depth += 1;
        }
        ancestor = parentOf.get(ancestor) ?? null;
      }
      return { parentId, depth };
    };

    /** Which side of the tree already covers this row's points. */
    const blockedBy = (nodeId: string): 'parent' | 'child' | null => {
      if (selectedSet.has(nodeId)) return null;
      const seen = new Set<string>([nodeId]);
      let ancestor = parentOf.get(nodeId) ?? null;
      while (ancestor !== null && !seen.has(ancestor)) {
        seen.add(ancestor);
        if (selectedSet.has(ancestor)) return 'parent';
        ancestor = parentOf.get(ancestor) ?? null;
      }
      for (const selected of selectedIds) {
        const walked = new Set<string>([selected]);
        let p = parentOf.get(selected) ?? null;
        while (p !== null && !walked.has(p)) {
          if (p === nodeId) return 'child';
          walked.add(p);
          p = parentOf.get(p) ?? null;
        }
      }
      return null;
    };

    return atLevel.map((n) => {
      const { parentId, depth } = placeInHierarchy(n.id);
      const blocker = blockedBy(n.id);
      return {
        id: n.id,
        title: n.title,
        points: n.effortPoints,
        inPlan: selectedSet.has(n.id),
        overlap: blocker !== null,
        blockedBy: blocker,
        parentId,
        depth,
      };
    });
  }, [domainNodes, forecastPlan, forecastChosenLevel]);

  const forecastLevelOptions = useMemo(() => {
    const count = (t: string) => domainNodes.filter((n) => n.nodeType === t).length;
    return [
      { level: 'Theme' as const, count: count('Theme'), enabled: count('Theme') > 0, blurb: 'Coarsest buckets. Fastest to rank, roughest points.' },
      { level: 'Component' as const, count: count('Component'), enabled: count('Component') > 0, blurb: 'Mid-level. Balances detail against how many rows you manage.' },
      { level: 'Feature' as const, count: count('Feature'), enabled: count('Feature') > 0, blurb: 'Finest detail. Most accurate points, longest list.' },
    ];
  }, [domainNodes]);

  const persistedVisualThemeId = (selectedProjectId
    ? coalescerRef.current?.getSnapshot(selectedProjectId, 'visual')?.fields.focusedThemeId
    : null) ?? visualFocusedThemeId;

  const visualThemeId = useMemo(() => {
    return resolveFocusedThemeId({
      nodes: domainNodes,
      currentFocusedNodeId: focusedNodeId,
      persistedFocusedThemeId: persistedVisualThemeId,
    });
  }, [domainNodes, focusedNodeId, persistedVisualThemeId]);

  // E10-FR12 / E10-AR9: the visual viewport (panX/panY/scale) lives on the
  // isolated Visual view-state lane, coalesced through the existing
  // mechanism, and never enters domain facts, revisions, undo/redo, portable
  // files, or exports. Computed inline (not memoized) so every render reads
  // the coalescer's optimistic merged snapshot — the canvas re-initializes
  // from this value on remount after a view/theme switch.
  //
  // Per-theme scoping: the lane is keyed by project+view, so the saved
  // viewport is only honored when the snapshot's focusedThemeId matches the
  // currently focused theme; a theme switch therefore refits rather than
  // restoring another theme's pan/zoom.
  const visualViewport = (() => {
    if (!selectedProjectId) return undefined;
    const snapshot = coalescerRef.current?.getSnapshot(selectedProjectId, 'visual');
    const fields = snapshot?.fields;
    if (!fields) return undefined;
    if (visualThemeId && snapshot?.fields.focusedThemeId && snapshot.fields.focusedThemeId !== visualThemeId) {
      return undefined;
    }
    if (fields.panX === 0 && fields.panY === 0 && fields.scale === 1) return undefined;
    return Object.freeze({ panX: fields.panX, panY: fields.panY, scale: fields.scale });
  })();

  const handleVisualViewportChange = useCallback(
    (next: ViewportTransform) => {
      if (!selectedProjectId || !coalescerRef.current) return;
      coalescerRef.current.submitPatch(selectedProjectId, 'visual', {
        panX: next.panX,
        panY: next.panY,
        scale: next.scale,
      });
    },
    [selectedProjectId],
  );

  // Story 8.1 Task 6/7: resolve and preview exact export scope.
  // check-flush-recheck: gate on a settled queue, flush the view-state coalescer,
  // re-check after the await yields, then resolve scope for the active view.
  const handleExportPreview = useCallback(async () => {
    if (!selectedProjectId || !outlineModel) return;
    const orchestrator = orchestratorRef.current;
    const coalescer = coalescerRef.current;
    if (!orchestrator || !coalescer) {
      setStatusMessage('Export blocked: repository not initialized.');
      return;
    }

    if (!orchestrator.isQueueSettled(selectedProjectId)) {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (orchestrator.isQueueSettled(selectedProjectId)) break;
      }
    }

    const firstDecision = decideExportEligibility({
      isQueueSettled: orchestrator.isQueueSettled(selectedProjectId),
      blockingCause: orchestrator.queueBlockingCause(selectedProjectId),
    });
    if (firstDecision.kind === 'Blocked') {
      setStatusMessage(`Export blocked: ${firstDecision.cause}`);
      return;
    }

    // Acknowledged preferences flush — never through dispatchCommand.
    // The Forecast destination is a planning surface, not a view-state lane
    // (UX-DR1); exports flush the outline lane's presentation instead.
    await coalescer.flush(selectedProjectId, activeViewId === 'forecast' ? 'outline' : activeViewId);

    // Re-check the queue after the await yielded to the event loop.
    const secondDecision = decideExportEligibility({
      isQueueSettled: orchestrator.isQueueSettled(selectedProjectId),
      blockingCause: orchestrator.queueBlockingCause(selectedProjectId),
    });
    if (secondDecision.kind === 'Blocked') {
      setStatusMessage(`Export blocked: ${secondDecision.cause}`);
      return;
    }

    const projectRevision = outlineModel.projectRevision;
    const nodes = outlineModel.nodes;
    let scope: ViewScope;

    if (activeViewId === 'visual') {
      if (!visualThemeId) {
        setStatusMessage('Export blocked: no focused theme in the visual tree.');
        return;
      }
      scope = resolveVisualExportScope({
        projectId: selectedProjectId,
        projectRevision,
        themeId: visualThemeId,
        nodes: domainNodes,
        unlockEdges: outlineModel.unlockEdges ?? [],
      });
    } else if (activeViewId === 'gantt') {
      const vs = (await queryViewState(selectedProjectId, 'gantt')).fields;
      const collapsedNodeIds = vs.collapsedNodeIds;
      const projection = projectGantt({
        projectId: selectedProjectId,
        projectRevision,
        nodes: domainNodes,
        collapsedNodeIds,
      });
      const windowStart = vs.dateWindowStart ?? projection.minProjectDate ?? '2026-01-01';
      const windowEnd = vs.dateWindowEnd ?? projection.maxProjectDate ?? '2026-12-31';
      const granularity = vs.granularity ?? 'month';
      scope = resolveGanttExportScope({
        projection,
        window: { dateWindowStart: windowStart, dateWindowEnd: windowEnd, granularity },
        collapsedNodeIds,
      });
    } else {
      const collapsedNodeIds = (await queryViewState(selectedProjectId, 'outline')).fields.collapsedNodeIds;
      scope = resolveOutlineExportScope(
        outlineModel,
        zoomRootId,
        new Set(collapsedNodeIds),
      );
    }

    const sentence = formatExportScopeSentence(scope, nodes);
    setExportPreview({ sentence, scope, format: defaultExportFormatForScope(scope) });
  }, [selectedProjectId, outlineModel, activeViewId, visualThemeId, domainNodes, zoomRootId]);

  // Story 8.5: confirm generation + atomic publish with typed failure states.
  // ScopeStale is re-checked at confirm time; retry republishes the same bytes.
  // UAT #5: the user picks the format in the preview modal; default follows the
  // invoking view (Gantt → PPTX, Outline/Visual → DOCX).
  const handleExportConfirm = useCallback(async (format: ExportFormat) => {
    if (!selectedProjectId || !outlineModel || !exportPreview) return;
    const projectRevision = outlineModel.projectRevision;

    // AC3: re-check scope freshness at confirm time before invoking the worker.
    const staleCheck = checkExportScopeFresh(
      exportPreview.scope.projectRevision,
      projectRevision,
    );
    if (staleCheck && !staleCheck.ok) {
      const fb = formatExportFailure(staleCheck.failure);
      setStatusMessage(`${fb.cause} ${fb.resultingState}`);
      setExportPreview(null);
      return;
    }

    const projectName = projects.find((p) => p.id === selectedProjectId)?.name ?? 'project';
    const generatedAt = new Date().toISOString();

    if (format === 'pptx') {
      // PowerPoint: Gantt slide.
      const vs = (await queryViewState(selectedProjectId, 'gantt')).fields;
      const collapsedNodeIds = vs.collapsedNodeIds;
      const projection = projectGantt({
        projectId: selectedProjectId,
        projectRevision,
        nodes: domainNodes,
        collapsedNodeIds,
      });
      const windowStart = vs.dateWindowStart ?? projection.minProjectDate ?? '2026-01-01';
      const windowEnd = vs.dateWindowEnd ?? projection.maxProjectDate ?? '2026-12-31';
      const granularity = vs.granularity ?? 'month';
      const scope = resolveGanttVisibleScope({
        projection,
        window: { dateWindowStart: windowStart, dateWindowEnd: windowEnd, granularity },
        collapsedNodeIds,
      });

      const gen = await exportGanttPptx({
        scope,
        phases: outlineModel.phases ?? [],
        nodes: domainNodes,
        unlockEdges: outlineModel.unlockEdges ?? [],
        projectName,
        projectId: selectedProjectId,
        projectRevision,
        generatedAt,
      });
      if (!gen.ok) {
        setStatusMessage(`Export failed: ${gen.error}`);
        setExportPreview(null);
        return;
      }

      const pkg: GeneratedPackage = {
        bytes: new Uint8Array(gen.value.bytes),
        filename: gen.value.filename,
        mimeType: EXPORT_MIME_TYPES.pptx,
        sourceProjectRevision: projectRevision,
      };
      const result = await publishExport(pkg);
      if (result.ok) {
        setStatusMessage(`Exported ${result.filename}.`);
      } else {
        const fb = formatExportFailure(result.failure);
        setStatusMessage(`${fb.cause} ${fb.resultingState}`);
      }
      setExportPreview(null);
      return;
    }

    // Word document: narrative document from the resolved scope.
    const docGen = await exportDocumentDocx({
      scope: exportPreview.scope,
      phases: outlineModel.phases ?? [],
      nodes: domainNodes,
      projectName,
      projectId: selectedProjectId,
      projectRevision,
      generatedAt,
      locale: 'en-US',
    });
    if (!docGen.ok) {
      setStatusMessage(`Export failed: ${docGen.error}`);
      setExportPreview(null);
      return;
    }

    const docPkg: GeneratedPackage = {
      bytes: new Uint8Array(docGen.value.bytes),
      filename: docGen.value.filename,
      mimeType: EXPORT_MIME_TYPES.docx,
      sourceProjectRevision: projectRevision,
    };
    const docResult = await publishExport(docPkg);
    if (docResult.ok) {
      setStatusMessage(`Exported ${docResult.filename}.`);
    } else {
      const fb = formatExportFailure(docResult.failure);
      setStatusMessage(`${fb.cause} ${fb.resultingState}`);
    }
    setExportPreview(null);
  }, [selectedProjectId, outlineModel, exportPreview, domainNodes, projects]);

  // Story 16.4 (E16-FR6): export the focused Feature as a standalone 1-Pager.
  const handleExportFeatureOnePager = useCallback(
    async (nodeId: string) => {
      if (!selectedProjectId || !outlineModel) return;
      const orchestrator = orchestratorRef.current;
      if (!orchestrator) {
        setStatusMessage('Export blocked: repository not initialized.');
        return;
      }
      if (!orchestrator.isQueueSettled(selectedProjectId)) {
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (orchestrator.isQueueSettled(selectedProjectId)) break;
        }
      }
      if (!orchestrator.isQueueSettled(selectedProjectId)) {
        setStatusMessage(`Export blocked: ${orchestrator.queueBlockingCause(selectedProjectId) ?? 'Pending commands in flight'}`);
        return;
      }

      const projectName = projects.find((p) => p.id === selectedProjectId)?.name ?? 'project';
      const openQuestionsByNode = new Map(
        outlineModel.nodes.map((n) => [n.id, n.openQuestions]),
      );
      const gen = await exportFeatureOnePagerDocx({
        featureNodeId: nodeId,
        phases: outlineModel.phases ?? [],
        nodes: domainNodes,
        unlockEdges: outlineModel.unlockEdges ?? [],
        openQuestionsByNode,
        projectName,
        projectId: selectedProjectId,
        projectRevision: outlineModel.projectRevision,
        generatedAt: new Date().toISOString(),
        locale: 'en-US',
      });
      if (!gen.ok) {
        setStatusMessage(`Export failed: ${gen.error}`);
        return;
      }

      const pkg: GeneratedPackage = {
        bytes: new Uint8Array(gen.value.bytes),
        filename: gen.value.filename,
        mimeType: EXPORT_MIME_TYPES.docx,
        sourceProjectRevision: outlineModel.projectRevision,
      };
      const result = await publishExport(pkg);
      if (result.ok) {
        setStatusMessage(`Exported ${result.filename}.`);
      } else {
        const fb = formatExportFailure(result.failure);
        setStatusMessage(`${fb.cause} ${fb.resultingState}`);
      }
    },
    [selectedProjectId, outlineModel, domainNodes, projects],
  );

  // Epic 13 Task 7: back up the active project from the title bar.
  // Finite state machine: idle | preparing | saving | blocked | failed | complete.
  const handleBackUpProject = useCallback(async () => {
    if (!selectedProjectId) {
      setBackupState({ kind: 'blocked', cause: 'No active project.' });
      return;
    }
    const orchestrator = orchestratorRef.current;
    if (!orchestrator) {
      setBackupState({ kind: 'blocked', cause: 'Repository is not initialized.' });
      return;
    }

    if (backupState.kind === 'preparing' || backupState.kind === 'saving') {
      return; // duplicate invocation is disabled while pending (E13-UX4)
    }

    setBackupState({ kind: 'preparing' });
    setStatusMessage('Preparing portable backup…');

    const result = await exportProject(selectedProjectId, {
      getProject: (id) => {
        const p = projects.find((proj) => proj.id === id);
        return p ? Object.freeze({ id: p.id, name: p.name, revision: p.revision }) : null;
      },
      isQueueSettled: (id) => orchestrator.isQueueSettled(id),
      queueBlockingCause: (id) => orchestrator.queueBlockingCause(id),
      readPortableSnapshot: (id) => queryPortableSnapshot(id),
      clock: { nowISO: () => new Date().toISOString() },
    });

    if (!result.ok) {
      setBackupState({ kind: result.code === 'QUEUE_NOT_SETTLED' || result.code === 'STALE_REVISION' ? 'blocked' : 'failed', cause: result.cause });
      setStatusMessage(`Backup blocked: ${result.cause}`);
      return;
    }

    setBackupState({ kind: 'saving' });
    setStatusMessage('Saving portable project file…');

    const filename = portableBackupFilename(result.envelope.project.name);
    const published = await saveGeneratedFile(new TextEncoder().encode(result.json), filename, 'application/json');

    if (published.ok) {
      setBackupState({ kind: 'complete', filename: published.filename });
      setStatusMessage(`Portable project file created: ${published.filename}. It can be imported later.`);
    } else if (published.failure.kind === 'SelectionCancelled') {
      // Cancellation is not an error; return quietly (E13-UX5).
      setBackupState({ kind: 'idle' });
      setStatusMessage(null);
    } else {
      setBackupState({ kind: 'failed', cause: published.failure.kind });
      setStatusMessage(`Backup failed (${published.failure.kind}). Your project is unchanged.`);
    }
  }, [selectedProjectId, projects, backupState.kind]);

  // Action declarations for Command Palette
  const actionDeclarations: readonly ActionDeclaration[] = useMemo(() => {
    return Object.freeze([
      {
        id: 'node.add-child',
        label: 'Add Child Item',
        keywords: ['child', 'nested', 'sub', 'add'],
        requirement: ['FR-5', 'FR-6'],
        scope: 'node',
        binding: { key: 'Enter', alt: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) void handleCreateChild(ctx.focusedNodeId);
        },
      },
      {
        id: 'node.duplicate-subtree',
        label: 'Duplicate Subtree',
        keywords: ['copy', 'clone'],
        requirement: ['FR-13'],
        scope: 'subtree',
        binding: { key: 'd', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) void handleDuplicateSubtree(ctx.focusedNodeId);
        },
      },
      {
        id: 'node.delete-subtree',
        label: 'Delete Subtree',
        keywords: ['remove', 'trash'],
        requirement: ['FR-13'],
        scope: 'subtree',
        binding: { key: 'Delete', shift: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) void handleDeleteSubtree(ctx.focusedNodeId);
        },
      },
      {
        id: 'edit.undo',
        label: 'Undo',
        keywords: ['revert', 'back'],
        requirement: ['FR-13'],
        scope: 'project',
        binding: { key: 'z', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          selectedProjectId && undoEngineRef.current?.canUndo(selectedProjectId)
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'Nothing to undo.' },
        run: () => {
          void handleUndo();
        },
      },
      {
        id: 'edit.redo',
        label: 'Redo',
        keywords: ['again', 'forward'],
        requirement: ['FR-13'],
        scope: 'project',
        binding: { key: 'z', ctrlOrMeta: true, shift: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          selectedProjectId && undoEngineRef.current?.canRedo(selectedProjectId)
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'Nothing to redo.' },
        run: () => {
          void handleRedo();
        },
      },
      {
        id: 'view.zoom-in',
        label: 'Zoom into Branch',
        keywords: ['focus branch', 'drill down'],
        requirement: ['FR-10'],
        scope: 'subtree',
        binding: { key: '.', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) {
            setZoomRootId(ctx.focusedNodeId);
            handleViewStateChange({ zoomRootId: ctx.focusedNodeId });
          }
        },
      },
      {
        id: 'view.zoom-out',
        label: 'Zoom Out to Parent Branch',
        keywords: ['back', 'up branch'],
        requirement: ['FR-10'],
        scope: 'view',
        binding: { key: ',', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          zoomRootId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'Already at root altitude.' },
        run: () => {
          setZoomRootId(null);
          handleViewStateChange({ zoomRootId: null });
        },
      },
      {
        id: 'search.jump-to-node',
        label: 'Jump to item',
        keywords: ['find', 'search', 'goto'],
        requirement: ['FR-12'],
        scope: 'workspace',
        binding: { key: '/', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () => ({ kind: 'Available' as const }),
        run: () => {
          setActiveSurface('jump');
        },
      },
      {
        id: 'phases.manage',
        label: 'Manage Project Phases',
        keywords: ['phase', 'milestone', 'stage'],
        requirement: ['FR-17'],
        scope: 'project',
        binding: null,
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () => ({ kind: 'Available' as const }),
        run: () => {
          outlineViewRef.current?.openPhaseManager();
        },
      },
      {
        id: 'node.edit-planning',
        label: 'Edit Planning & Metadata (Effort, Phase, Custom Fields)',
        keywords: ['effort', 'points', 'estimate', 'phase', 'custom fields', 'weight', 'planning'],
        requirement: ['FR-17'],
        scope: 'node',
        binding: null,
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) outlineViewRef.current?.openPlanningModal(ctx.focusedNodeId);
        },
      },
      {
        id: 'edges.inspect-unlocks',
        label: 'Inspect Unlock Relationships',
        keywords: ['unlock', 'dependencies', 'blocker', 'prerequisite'],
        requirement: ['FR-18', 'FR-19'],
        scope: 'subtree',
        binding: { key: 'u', ctrlOrMeta: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) =>
          ctx.focusedNodeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No item is focused.' },
        run: (ctx) => {
          if (ctx.focusedNodeId) outlineViewRef.current?.openEdgeInspector(ctx.focusedNodeId);
        },
      },
      {
        id: 'review.coherence',
        label: 'Open Coherence Review',
        keywords: ['coherence', 'review', 'conflicts', 'orphans', 'flags', 'audit'],
        requirement: ['FR-38'],
        scope: 'project',
        binding: { key: 'C', ctrlOrMeta: true, shift: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () => ({ kind: 'Available' as const }),
        run: () => {
          setIsCoherenceReviewOpen((prev) => !prev);
        },
      },
      {
        id: 'review.affected-work',
        label: 'Open Downstream Affected Review',
        keywords: ['affected', 'consequences', 'schedule changes', 'downstream'],
        requirement: ['FR-40', 'FR-41'],
        scope: 'project',
        binding: { key: 'A', ctrlOrMeta: true, shift: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () => ({ kind: 'Available' as const }),
        run: () => {
          setIsAffectedPanelOpen((prev) => !prev);
        },
      },
      {
        id: 'export.preview',
        label: 'Preview Export Scope',
        keywords: ['export', 'preview', 'generate', 'slide', 'document'],
        requirement: ['FR-51', 'FR-52', 'FR-53'],
        scope: 'view',
        binding: null,
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          selectedProjectId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No active project.' },
        run: () => {
          void handleExportPreview();
        },
      },
      {
        id: 'project.backup',
        label: 'Export Project',
        keywords: ['export', 'backup', 'back up', 'portable', 'save copy', 'migrate'],
        requirement: ['E13-FR2', 'E13-FR3'],
        scope: 'project',
        binding: null,
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          selectedProjectId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No active project.' },
        run: () => {
          void handleBackUpProject();
        },
      },
      {
        id: 'workspace.open-theme-in-visual',
        label: 'Open Theme in Visual Tree',
        keywords: ['focus theme', 'drill down', 'visual'],
        requirement: ['FR-36'],
        scope: 'view',
        binding: null,
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: (ctx) => {
          if (ctx.viewId !== 'overview') {
            return { kind: 'Unavailable' as const, reason: 'No theme row is focused in the workspace overview.' };
          }
          return focusedThemeId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No theme row is focused.' };
        },
        run: () => {
          if (focusedThemeId) {
            handleViewStateChange('visual', { focusedThemeId });
            setVisualFocusedThemeId(focusedThemeId);
            setFocusedNodeId(focusedThemeId);
            setActiveViewId('visual');
            setViewMode('project');
          }
        },
      },
      {
        id: 'forecast.open',
        label: 'Open Forecast',
        keywords: ['forecast', 'capacity', 'sprint', 'completion', 'planning'],
        requirement: ['FR-1', 'FR-2', 'FR-3'],
        scope: 'project',
        binding: { key: '4', alt: true },
        paletteVisibility: 'listed',
        focusPolicy: 'ReturnToInvoker',
        isAvailable: () =>
          selectedProjectId
            ? { kind: 'Available' as const }
            : { kind: 'Unavailable' as const, reason: 'No active project.' },
        run: () => {
          setActiveViewId('forecast');
          setViewMode('project');
        },
      },
    ]);
  }, [zoomRootId, handleDuplicateSubtree, handleDeleteSubtree, handleUndo, handleRedo, handleViewStateChange, focusedThemeId, setVisualFocusedThemeId, setFocusedNodeId, setActiveViewId, handleExportPreview, handleCreateChild, handleBackUpProject, selectedProjectId]);

  // Epic 15 (E15-FR6): extracted so SideNav's "New project" reuses the exact
  // FR-1 inline-name-focus behaviour WorkspaceOverview's own button already
  // has, instead of a second implementation.
  const handleCreateProject = useCallback(async () => {
    if (!orchestratorRef.current) return;
    setStatusMessage(null);
    const newProjId = createUuidV7();
    const cmd = createCreateProjectCommand(
      createDomainCreateProject({
        commandId: createUuidV7(),
        projectId: newProjId,
        name: 'New Project',
      }),
    );
    try {
      const outcome = await orchestratorRef.current.dispatchCommand(cmd);
      if (outcome.type === 'DependencyRejected') {
        setStatusMessage(`The project could not be created. ${outcome.cause}`);
        return;
      }
      if (outcome.result.type === 'ProductCommandRejected') {
        const feedback = formatCommandRejection(outcome.result);
        setStatusMessage(`${feedback.cause} ${feedback.resultingState}`);
        return;
      }

      const projs = await queryProjects();
      setProjects(projs);
      setSelectedProjectId(newProjId);
      await refreshWorkspaceOverview();
      setPendingRenameProjectId(newProjId);
    } catch {
      setStatusMessage('The project could not be created. Your existing projects are unchanged.');
    }
  }, []);

  // ── Epic 17: workspace registry handlers ──────────────────────────────

  /**
   * Apply one workspace mutation and resync everything scoped by workspace.
   *
   * Every mutation returns the refreshed registry, so the switcher updates
   * from the same read that performed the write — there is no window where
   * the menu shows a count the database disagrees with. Project list and
   * overview are re-queried because both are workspace-scoped.
   */
  const applyWorkspaceMutation = useCallback(
    async (
      mutation: Parameters<typeof mutateWorkspace>[0],
      onRejected?: (
        result: Extract<
          Awaited<ReturnType<typeof mutateWorkspace>>,
          { type: 'WorkspaceMutationRejected' }
        >,
      ) => void,
    ): Promise<boolean> => {
      setStatusMessage(null);
      try {
        const result = await mutateWorkspace(mutation);
        if (result.type === 'WorkspaceMutationRejected') {
          onRejected?.(result);
          return false;
        }
        setWorkspaceRegistry(result.registry);
        setProjects(await queryProjects());
        await refreshWorkspaceOverview();
        return true;
      } catch (err) {
        // A newer-schema refusal is not a generic workspace failure: show the
        // canonical reload guidance and mark storage read-only (Story 22.15 AC
        // 22.15-2/-3, review L2).
        if ((err as { code?: unknown } | null)?.code === 'UNSUPPORTED_NEWER_SCHEMA') {
          const refusalMessage = 'This project data was saved by a newer version of the app. Reload to update.';
          setCompatibilityError(refusalMessage);
          setHealth({
            kind: 'Denied',
            cause: refusalMessage,
            capabilities: Object.freeze({ canWrite: false, canPersist: false, isCertified: false }),
          });
          setStatusMessage(refusalMessage);
          return false;
        }
        setStatusMessage('That workspace change could not be saved. Nothing was modified.');
        return false;
      }
    },
    [],
  );

  const handleSwitchWorkspace = useCallback(
    async (workspaceId: string) => {
      const ok = await applyWorkspaceMutation({ kind: 'SetActive', workspaceId });
      if (!ok) return;
      // The previously-open project almost certainly lives in the workspace
      // we just left, so keeping the project view open would show work that
      // is no longer in scope. Land on the overview and clear the selection;
      // the user picks a project from the new workspace explicitly.
      setSelectedProjectId(null);
      appliedModelRef.current = null;
      setOutlineModel(null);
      setViewMode('workspace');
      // The outgoing project id is gone — drop its refresh chain (D1 AC 4).
      if (selectedProjectId) forecastRefreshChainRef.current.evict(selectedProjectId);
    },
    [applyWorkspaceMutation, selectedProjectId],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string) => {
      const target = workspaceRegistry?.workspaces.find((w) => w.id === workspaceId);
      if (!target) return;
      await applyWorkspaceMutation({ kind: 'Delete', workspaceId }, (rejected) => {
        // The refusal is the teaching moment — say exactly what blocks it
        // and what to do, rather than greying the menu item out.
        if (rejected.code === 'WORKSPACE_NOT_EMPTY' || rejected.code === 'LAST_WORKSPACE') {
          setStatusMessage(
            formatWorkspaceDeleteRefusal(
              rejected.code === 'LAST_WORKSPACE'
                ? { allowed: false, cause: 'LAST_WORKSPACE', projectCount: 0 }
                : {
                    allowed: false,
                    cause: 'WORKSPACE_NOT_EMPTY',
                    projectCount: rejected.projectCount ?? 0,
                  },
              target.name,
            ),
          );
          return;
        }
        setStatusMessage('That workspace could not be deleted.');
      });
    },
    [applyWorkspaceMutation, workspaceRegistry],
  );

  const handleLocalFileChanged = useCallback(async (projectId: string, revision: number) => {
    undoEngineRef.current?.clearProject(projectId);
    orchestratorRef.current?.adoptAuthoritativeRevision(projectId, revision);
    setProjects(await queryProjects());
    await refreshWorkspaceOverview();
    if (projectId !== selectedProjectId) return;
    appliedModelRef.current = null;
    const model = await queryProjectNodes(projectId);
    applyOutlineModel(model);
    searchIndexRef.current.rebuildFromNodes(model.nodes);
    setFocusedNodeId(null);
    setZoomRootId(null);
    setFocusedThemeId(null);
    setVisualFocusedThemeId(null);
    setAffectedReasons(await queryAffectedReasons(projectId));
    const snapshot = await queryAnalysisSnapshot(projectId);
    analysisClientRef.current?.sendSnapshot(snapshot);
    requestForecastFromSnapshot(snapshot);
    void refreshForecastRef.current?.(projectId);
  }, [selectedProjectId, applyOutlineModel, refreshWorkspaceOverview]);
  const localFiles = useLocalFileCollaboration({
    selectedProjectId,
    orchestrator: () => orchestratorRef.current,
    onChanged: handleLocalFileChanged,
    onStatus: setStatusMessage,
    onIncompatibleStorage: () => {
      const cause = 'This project data was saved by a newer version of the app. Reload to update.';
      setCompatibilityError(cause);
      setHealth({ kind: 'Denied', cause, capabilities: Object.freeze({ canWrite: false, canPersist: false, isCertified: false }) });
    },
  });

  return createElement(
    AppShell,
    { health, bootTime },
    compatibilityError
      ? createElement(
          'div',
          {
            role: 'alert',
            className: 'pm-compatibility-gate-banner',
            'data-testid': 'compatibility-gate-banner',
          },
          compatibilityError,
        )
      : createElement(SideNav, {
      collapsed: navCollapsed,
      onToggleCollapsed: handleToggleNavCollapsed,
      inProject: viewMode === 'project',
      activeViewId: viewMode === 'project' ? activeViewId : null,
      onSelectView: (v) => {
        if (viewMode === 'workspace') {
          // From the workspace overview, choosing a view under Current
          // Project explicitly enters that project at that view (Option A
          // interaction contract).
          if (selectedProjectId) {
            void (async () => {
              setStatusMessage(null);
              const outcome = await switchProject(selectedProjectId);
              if (outcome.kind === 'Switched' || outcome.kind === 'NoOp') {
                setActiveViewId(v);
                setViewMode('project');
              } else if (outcome.kind === 'Blocked') {
                setStatusMessage(outcome.cause);
              }
            })();
          }
          return;
        }
        void handleSwitchView(v);
      },
      projects,
      selectedProjectId,
      onSwitchProject: (projectId) => {
        void (async () => {
          setStatusMessage(null);
          if (viewMode === 'workspace') {
            // From the workspace overview, selecting a shelf project only
            // marks it selected — it must not auto-open a project view
            // (Option A interaction contract). The Current Project section
            // then exposes that project's views for an explicit choice.
            setSelectedProjectId(projectId);
            return;
          }
          const outcome = await switchProject(projectId);
          if (outcome.kind === 'Blocked') {
            setStatusMessage(outcome.cause);
          }
        })();
      },
      onOpenWorkspace: () => setViewMode('workspace'),
      onCreateProject: () => void handleCreateProject(),
      workspaces: workspaceRegistry?.workspaces ?? [],
      activeWorkspaceId: workspaceRegistry?.activeWorkspaceId ?? null,
      onSwitchWorkspace: (workspaceId) => void handleSwitchWorkspace(workspaceId),
      onCreateWorkspace: () => setWorkspaceDialog({ kind: 'create' }),
      onRenameWorkspace: (workspaceId) => {
        const target = workspaceRegistry?.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        setWorkspaceDialog({ kind: 'rename', workspaceId, currentName: target.name });
      },
      onDeleteWorkspace: (workspaceId) => void handleDeleteWorkspace(workspaceId),
      onOpenJump: () => setActiveSurface('jump'),
      onOpenExport: () => void handleExportPreview(),
      onBackUpProject: () => void handleBackUpProject(),
      backupBusy: backupState.kind === 'preparing' || backupState.kind === 'saving',
      importEnabled: true,
      onShareProject: COLLABORATION_BUILD && collabOrigin ? handleShareProject : undefined,
      onJoinProject: COLLABORATION_BUILD && collabOrigin ? () => { void loadCollaboration().then(() => { setJoinInitialLink(undefined); setJoinStatus({ kind: 'entry' }); }); } : undefined,
      shareLabel: collabSharedProjectId && collabSharedProjectId === selectedProjectId ? 'Sharing' : 'Share',
      onImportProject: () => void localFiles.pick(),
      onShareForEditing: () => void localFiles.share(),
      onRecoverLocalMerge: localFiles.recoveryAvailable ? () => void localFiles.openRecovery() : undefined,
      localFileBusy: localFiles.busy,
    }),
    viewMode === 'workspace'
      ? createElement(WorkspaceOverview, {
          overview: workspaceOverview ?? createEmptyOverview(),
          statusMessage,
          pendingRenameProjectId,
          onPendingRenameConsumed: () => setPendingRenameProjectId(null),
          onCreateProject: () => void handleCreateProject(),
          onRenameProject: async (projectId, name) => {
            if (!orchestratorRef.current) return;
            const target = projects.find((p) => p.id === projectId);
            if (!target) return;
            const cmd = createRenameProjectWireCommand(
              createDomainRenameProject({
                commandId: createUuidV7(),
                projectId,
                baseRevision: target.revision,
                name,
              }),
            );
            await orchestratorRef.current.dispatchCommand(cmd);
            const projs = await queryProjects();
            setProjects(projs);
            await refreshWorkspaceOverview();
          },
          onDeleteProject: async (projectId) => {
            if (!orchestratorRef.current) return;
            const target = projects.find((p) => p.id === projectId);
            if (!target) return;
            const cmd = createDeleteProjectWireCommand(
              createDomainDeleteProject({
                commandId: createUuidV7(),
                projectId,
                baseRevision: target.revision,
              }),
            );
            const outcome = await orchestratorRef.current.dispatchCommand(cmd);
            if (outcome.type === 'CommandDispatched' && outcome.result.type === 'ProductCommandApplied') {
              if (selectedProjectId === projectId) {
                setSelectedProjectId(null);
                appliedModelRef.current = null;
                setOutlineModel(null);
              }
              // A deleted project can never be refreshed again — drop its
              // retained refresh chain (Story 21.13 D1 AC 4).
              forecastRefreshChainRef.current.evict(projectId);
              const projs = await queryProjects();
              setProjects(projs);
        await refreshWorkspaceOverview();
            }
          },
          onOpenTheme: (projectId, themeId) => {
            setFocusedThemeId(themeId);
            setVisualFocusedThemeId(themeId);
            setFocusedNodeId(themeId);
            void (async () => {
              setStatusMessage(null);
              const outcome = await switchProject(projectId);
              if (outcome.kind === 'Switched' || outcome.kind === 'NoOp') {
                handleViewStateChange('visual', { focusedThemeId: themeId });
                setActiveViewId('visual');
                setViewMode('project');
              } else if (outcome.kind === 'Blocked') {
                setStatusMessage(outcome.cause);
              }
            })();
          },
          onOpenGantt: (projectId) => {
            void (async () => {
              setStatusMessage(null);
              try {
                // Guarded project switch, then the existing view route. Never
                // falls back to Outline or a previously selected project's
                // Gantt — the target project is switched first, and a blocked
                // switch surfaces its cause while the overview stays in place
                // (AC 24.2-5).
                const outcome = await switchProject(projectId);
                if (outcome.kind === 'Blocked') {
                  setStatusMessage(outcome.cause);
                  return;
                }
                setActiveViewId('gantt');
                setViewMode('project');
              } catch (err) {
                // A switch that throws (e.g. a read failure) must surface, not
                // become an unhandled rejection that silently strands the user
                // on the overview (Story 21.12 AC 4).
                console.error('[workspace] open Gantt failed:', err);
                setStatusMessage('The Gantt could not be opened. Your projects are safe; try again.');
              }
            })();
          },
        })
      : createElement(
      AppFrame,
      {
        toolbar: createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', width: '100%', gap: '18px' } },
          createElement(
            'span',
            { className: 'pm-toolbar-view-title' },
            activeViewId === 'outline' ? 'Outline' : activeViewId === 'visual' ? 'Visual Tree' : activeViewId === 'gantt' ? 'Gantt' : 'Forecast',
          ),
          createElement(
            'div',
            { className: 'pm-toolbar-location' },
            crumbs.length <= 1 &&
              createElement(
                'span',
                { className: 'pm-toolbar-location-current' },
                createElement('span', { className: 'pm-toolbar-location-separator', 'aria-hidden': 'true' }, '/'),
                crumbs[0]?.label ?? 'Project',
              ),
          ),
          createElement(Breadcrumb, {
            crumbs: activeViewId === 'visual' && visualThemeId
              ? [
                  { id: null, label: projects.find((p) => p.id === selectedProjectId)?.name ?? 'Project' },
                  { id: visualThemeId, label: projectThemes.find((t) => t.id === visualThemeId)?.title || 'Theme' },
                ]
              : crumbs,
            onSelectCrumb: (crumbId: string | null) => {
              if (activeViewId === 'visual') {
                if (crumbId === null) {
                  setActiveViewId('outline');
                }
              } else {
                setZoomRootId(crumbId);
                handleViewStateChange({ zoomRootId: crumbId });
              }
            },
          }),
          activeViewId === 'visual' &&
            createElement(ThemeChipRow, {
              themes: projectThemes.map((t) => ({ id: t.id, title: t.title })),
              focusedThemeId: visualThemeId,
              onSelectTheme: (themeId) => {
                setVisualFocusedThemeId(themeId);
                setFocusedNodeId(themeId);
                handleViewStateChange('visual', { focusedThemeId: themeId });
              },
              onOpenThemeJump: () => {
                setActiveSurface('jump-theme');
              },
              onFocusAdjacentTheme: (direction: 'previous' | 'next') => {
                if (!visualThemeId || projectThemes.length === 0) return;
                const idx = projectThemes.findIndex((t) => t.id === visualThemeId);
                if (idx === -1) return;
                const nextIdx =
                  direction === 'next'
                    ? (idx + 1) % projectThemes.length
                    : (idx - 1 + projectThemes.length) % projectThemes.length;
                const nextTheme = projectThemes[nextIdx];
                setVisualFocusedThemeId(nextTheme.id);
                setFocusedNodeId(nextTheme.id);
                handleViewStateChange('visual', { focusedThemeId: nextTheme.id });
              },
            }),
        ),
        statusLine: createElement(StatusLine, {
          sessionState: statusMessage ?? (coherenceReview.totalOpenCount > 0 ? riskCountPhrase(coherenceReview.totalOpenCount) : 'Synced'),
        }),
        isBusy: !outlineModel,
        children: createElement(
          'div',
          { style: { display: 'flex', width: '100%', height: '100%', overflow: 'hidden' } },
          createElement(
            'div',
            { style: { flex: 1, height: '100%', overflow: 'hidden' } },
            !(outlineModel && selectedProjectId)
              ? createElement(TreeRegion, { state: { kind: 'loading' } })
              : activeViewId === 'forecast'
                  ? createElement(ForecastWorkspace, {
                      projectId: selectedProjectId as string,
                      plan: forecastPlan,
                      result: forecastResult,
                      comparison: forecastComparison,
                      historicalAttributionAvailable: forecastHistoryAvailable,
                      resultPending: forecastPending,
                      resultError: forecastError,
                      onSaveConfiguration: (config) => void handleSaveForecastConfiguration(config),
                      onToggleMembership: (featureId, included) =>
                        handleToggleForecastMembership(featureId, included),
                      onSetEffort: (featureId, effortPoints) =>
                        void handleSetNodeEffort({ nodeId: featureId, effortPoints }),
                      onSetPointsDone: (featureId, effortPointsDone) =>
                        void handleSetNodePointsDone({ nodeId: featureId, effortPointsDone }),
                      onSetBlocker: (featureId, blocked) =>
                        void handleSetForecastBlocker(featureId, blocked),
                      eligibleFeatures: forecastRows,
                      backlogItems: forecastBacklogItems,
                      backlogWidth: forecastBacklogWidth,
                      onBacklogWidthChange: setForecastBacklogWidth,
                      levelOptions: forecastLevelOptions,
                      planningLevel: forecastPlan?.planningLevel ?? forecastChosenLevel,
                      onChoosePlanningLevel: (lvl) => setForecastChosenLevel(lvl),
                      onSetPlanningLevel: (lvl) => void handleSetForecastPlanningLevel(lvl),
                      onSetForecastSequence: (featureIds, groups) =>
                        void handleSetForecastSequence(featureIds, groups),
                      scenarios: forecastScenarios,
                      scenarioEvaluations,
                      // Any live node's current title, whatever its level (Story 23.8 AC 23.8-6).
                      nodeTitle: (id: string) => domainNodes.find((n) => n.id === id)?.title ?? '',
                      onCreateScenario: handleCreateForecastScenario,
                      onCaptureScenarioDraft: handleCaptureScenarioDraft,
                      onEvaluateScenarioDraft: handleEvaluateScenarioDraft,
                      onCancelScenarioDraft: handleCancelScenarioDraft,
                      onRemoveScenario: (id) => void handleRemoveForecastScenario(id),
                      onAddPerson: handleAddForecastPerson,
                      onUpdatePerson: handleUpdateForecastPerson,
                      onRemovePerson: handleRemoveForecastPerson,
                      onSetAssignments: handleSetForecastAssignments,
                      onSetPolicy: handleSetForecastPolicy,
                      onEvaluateWhatIf: handleEvaluateWhatIf,
                      onApplyWhatIf: handleApplyWhatIf,
                      onSaveWhatIf: handleSaveWhatIf,
                      onCaptureWhatIfBaseline: handleCaptureWhatIfBaseline,
                    })
                  : activeViewId === 'visual'
                  ? createElement(VisualTreeView, {
                    projectId: selectedProjectId as string,
                    projectRevision: (outlineModel as OutlineReadModel).projectRevision,
                    nodes: domainNodes,
                    unlockEdges: outlineModel.unlockEdges ?? [],
                    themeId: visualThemeId,
                    coherenceFindings,
                    onCreateNode: handleCreateNode,
                    onMoveNode: handleMoveNode,
                    onSetNodeTitle: handleSetNodeTitle,
                    onSetNodeBodyText: handleSetNodeBodyText,
                    onSetNodeType: handleSetNodeType,
                    onSetNodeSchedule: handleSetNodeSchedule,
                    onToggleNodeCompleted: handleToggleNodeCompleted,
                    onCreateUnlockEdge: handleCreateUnlockEdge,
                    onDeleteUnlockEdge: handleDeleteUnlockEdge,
                    isEdgeInspectorOpen,
                    onCloseEdgeInspector: () => setIsEdgeInspectorOpen(false),
                    onFocusNode: (id: string | null) => setFocusedNodeId(id),
                    onOpenInspector: ({ nodeId, tab }) => {
                      setFocusedNodeId(nodeId);
                      if (tab) {
                        setInspectorTab(tab);
                      }
                      setIsInspectorOpen(true);
                    },
                    viewport: visualViewport,
                    onViewportChange: handleVisualViewportChange,
                    autoFitOnOpen: true,
                  })
                : activeViewId === 'gantt'
                ? createElement(GanttView, {
                    projectId: selectedProjectId as string,
                    projectRevision: (outlineModel as OutlineReadModel).projectRevision,
                    nodes: domainNodes,
                    unlockEdges: outlineModel.unlockEdges ?? [],
                    phases: outlineModel.phases ?? [],
                    focusedNodeId,
                    collapsedNodeIds: coalescerRef.current?.getSnapshot(selectedProjectId, 'gantt')?.fields.collapsedNodeIds ?? [],
                    dateWindowStart: coalescerRef.current?.getSnapshot(selectedProjectId, 'gantt')?.fields.dateWindowStart ?? null,
                    dateWindowEnd: coalescerRef.current?.getSnapshot(selectedProjectId, 'gantt')?.fields.dateWindowEnd ?? null,
                    granularity: coalescerRef.current?.getSnapshot(selectedProjectId, 'gantt')?.fields.granularity ?? null,
                    hierarchyWidth: ganttHierarchyWidth,
                    onHierarchyWidthChange: setGanttHierarchyWidth,
                    onSelectNode: (id) => setFocusedNodeId(id),
                    onToggleCollapse: (id) => {
                      const curr = coalescerRef.current?.getSnapshot(selectedProjectId, 'gantt')?.fields.collapsedNodeIds ?? [];
                      const next = curr.includes(id) ? curr.filter((c) => c !== id) : [...curr, id];
                      handleViewStateChange('gantt', { collapsedNodeIds: next });
                    },
                    onCommitSchedule: (id, s) =>
                      handleSetNodeSchedule({
                        nodeId: id,
                        startDate: s.startDate,
                        endDate: s.endDate,
                        durationDays: s.durationDays,
                        sourceMode: s.scheduleSourceMode,
                      }),
                    onSetExplicitOverride: (id) => {
                      const node = domainNodes.find((n) => n.id === id);
                      if (node) {
                        handleSetNodeSchedule({
                          nodeId: id,
                          startDate: node.startDate ?? '2026-06-01',
                          endDate: node.endDate ?? '2026-06-30',
                          durationDays: 30,
                          sourceMode: 'start_end',
                        });
                      }
                    },
                    onViewStateChange: (patch) => handleViewStateChange('gantt', patch),
                  })
                : createElement(OutlineView, {
                  key: selectedProjectId,
                  ref: outlineViewRef,
                  model: outlineModel,
                projectName: projects.find((p) => p.id === selectedProjectId)?.name,
                zoomRootId,
                initialCollapsedNodeIds: coalescerRef.current?.getSnapshot(selectedProjectId, 'outline')?.fields.collapsedNodeIds ?? [],
                onFocusNode: (id: string | null) => setFocusedNodeId(id),
                onZoomChange: (id) => {
                  setZoomRootId(id);
                  handleViewStateChange({ zoomRootId: id });
                },
                onViewStateChange: handleViewStateChange,
                onCreateNode: handleCreateNode,
                onSetNodeTitle: handleSetNodeTitle,
                onSetNodeBodyText: handleSetNodeBodyText,
                onMoveNode: handleMoveNode,
                onDeleteSubtree: handleDeleteSubtree,
                onDuplicateSubtree: handleDuplicateSubtree,
                onSetNodeType: handleSetNodeType,
                onSetNodeCustomField: handleSetNodeCustomField,
                onPromoteFieldToTemplate: handlePromoteFieldToTemplate,
                onSetNodeSchedule: handleSetNodeSchedule,
                onToggleNodeCompleted: handleToggleNodeCompleted,
                onSetNodeEffort: handleSetNodeEffort,
                onSetDeliveryStatus: handleSetDeliveryStatus,
                onSetThemeWeight: handleSetThemeWeight,
                onCreatePhase: handleCreatePhase,
                onRenamePhase: handleRenamePhase,
                onReorderPhases: handleReorderPhases,
                onAssignNodePhase: handleAssignNodePhase,
                onDeletePhase: handleDeletePhase,
                onCreateUnlockEdge: handleCreateUnlockEdge,
                onDeleteUnlockEdge: handleDeleteUnlockEdge,
                coherenceFindings,
                onDismissFinding: handleDismissFinding,
                onUndo: handleUndo,
                onRedo: handleRedo,
                onOpenPalette: () => setActiveSurface('palette'),
                onOpenJump: () => setActiveSurface('jump'),
                onOpenInspector: ({ nodeId, tab }) => {
                  setFocusedNodeId(nodeId);
                  if (tab) {
                    setInspectorTab(tab);
                  }
                  setIsInspectorOpen(true);
                },
               }),
          ),
          createElement(CoherenceReviewPanel, {
            isOpen: isCoherenceReviewOpen,
            review: coherenceReview,
            onClose: () => setIsCoherenceReviewOpen(false),
            onFocusNode: (nodeId) => {
              setFocusedNodeId(nodeId);
            },
            onDismissFinding: handleDismissFinding,
          }),
          createElement(AffectedWorkPanel, {
            isOpen: isAffectedPanelOpen,
            reasons: affectedReasons,
            onClose: () => setIsAffectedPanelOpen(false),
            onFocusNode: (nodeId) => {
              setFocusedNodeId(nodeId);
            },
            onAcknowledgeReason: handleAcknowledgeAffectedReason,
          }),
          createElement(NodeInspectorDrawer, {
            isOpen: isInspectorOpen,
            activeTab: inspectorTab,
            width: inspectorWidth,
            onWidthChange: setInspectorWidth,
            node: focusedNodeId
              ? (outlineModel?.nodes.find((n) => n.id === focusedNodeId) ?? null)
              : null,
            nodes: outlineModel?.nodes ?? [],
            unlockEdges: outlineModel?.unlockEdges ?? [],
            changedBy: (() => {
              const mod = collabModuleRef.current;
              if (!COLLABORATION_BUILD || !mod || !focusedNodeId || collabSharedProjectId !== selectedProjectId) return null;
              const last = mod.lastChangedBy(activityView.changes, focusedNodeId);
              return last ? `${last.actorName} changed this · ${mod.relativeTime(last.confirmedAtISO, new Date().toISOString())}` : null;
            })(),
            onClose: () => setIsInspectorOpen(false),
            onTabChange: setInspectorTab,
            onSetNodeBodyText: (nodeId, bodyText) => void handleSetNodeBodyText({ nodeId, bodyText }),
            onAddQuestion: (nodeId, questionText) => void handleAddQuestion(nodeId, questionText),
            onResolveQuestion: (questionId, decisionText) => void handleResolveQuestion(questionId, decisionText),
            onDeleteQuestion: (questionId) => void handleDeleteQuestion(questionId),
            onToggleNodeCompleted: (nodeId, completed) => void handleToggleNodeCompleted({ nodeId, completed }),
            onFocusNode: (nodeId) => {
              setFocusedNodeId(nodeId);
              outlineViewRef.current?.focusNodeById(nodeId);
            },
            onCreateCriterion: (parentId, title) => void handleCreateCriterion(parentId, title),
            onDeleteCriterion: (criterionId) => void handleDeleteSubtree(criterionId),
            onCreateUnlockEdge: (sourceNodeId, targetNodeId) => void handleCreateUnlockEdge({ sourceNodeId, targetNodeId }),
            onDeleteUnlockEdge: (edgeId, sourceNodeId, targetNodeId) => void handleDeleteUnlockEdge({ edgeId, sourceNodeId, targetNodeId }),
            onExportFeatureOnePager: (nodeId) => void handleExportFeatureOnePager(nodeId),
            onSetNodeEffort: (params) => void handleSetNodeEffort(params),
          }),
          exportPreview &&
            createElement(ExportPreviewModal, {
              sentence: exportPreview.sentence,
              scope: exportPreview.scope,
              defaultFormat: exportPreview.format,
              onClose: () => setExportPreview(null),
              onConfirm: (format: ExportFormat) => void handleExportConfirm(format),
            }),
        ),
      },
    ),
    createElement(CommandSurfaceHost, {
      activeSurface,
      actions: actionDeclarations,
      actionContext,
      searchIndex: searchIndexRef.current,
      themeJumpNodeIds: new Set(projectThemes.map((t) => t.id)),
      onClose: () => setActiveSurface('none'),
      onSelectNode: (nodeId) => {
        if (activeSurface === 'jump-theme') {
          setVisualFocusedThemeId(nodeId);
          handleViewStateChange('visual', { focusedThemeId: nodeId });
        }
        setFocusedNodeId(nodeId);
        setActiveSurface('none');
        outlineViewRef.current?.focusNodeById(nodeId);
      },
      onCreateNodeFromSearch: (title) => {
        setActiveSurface('none');
        void handleCreateNode({
          nodeId: createUuidV7(),
          parentId: null,
          position: 4294967296n,
          title,
        });
      },
    }),
    localFiles.session && createElement(LocalFileDialog, {
      fileName: localFiles.session.fileName,
      projectName: localFiles.session.file.snapshot.projectName,
      projects,
      mode: localFiles.mode,
      onModeChange: localFiles.setMode,
      targetId: localFiles.targetId,
      onTargetChange: localFiles.setTargetId,
      parentId: localFiles.parentId,
      onParentChange: localFiles.setParentId,
      parents: localFiles.review?.local.nodes.map(node => ({ id: node.id, title: node.title })) ?? [],
      linked: localFiles.linked,
      canLink: Boolean(localFiles.session.file.bundle),
      onLinkedChange: localFiles.setLinked,
      review: localFiles.review,
      choices: localFiles.choices,
      onChoice: localFiles.onChoice,
      onAcceptSafe: localFiles.acceptSafe,
      onReviewDeclined: localFiles.reviewDeclined,
      showDeclined: localFiles.showDeclined,
      forceBranch: localFiles.forceBranch,
      onForceBranchChange: localFiles.setForceBranch,
      error: localFiles.error,
      busy: localFiles.busy,
      preparing: localFiles.preparing,
      onApprove: () => void localFiles.approve(),
      onCancel: localFiles.cancel,
    }),
    localFiles.recovering && createElement(LocalFileRecoveryDialog, {
      projectName: projects.find(project => project.id === localFiles.recovering?.projectId)?.name ?? 'Project',
      busy: localFiles.busy,
      error: localFiles.error,
      onConfirm: () => void localFiles.recover(),
      onCancel: localFiles.cancel,
    }),
    // Epic 17: the workspace create/rename dialog. Rendered last so its
    // fixed-position scrim sits above the shell without needing a z-index
    // fight with the command surface.
    workspaceDialog.kind !== 'none' &&
      createElement(WorkspaceNameDialog, {
        mode: workspaceDialog.kind,
        initialName: workspaceDialog.kind === 'rename' ? workspaceDialog.currentName : '',
        onCancel: () => setWorkspaceDialog({ kind: 'none' }),
        onConfirm: (name: string) => {
          const pending = workspaceDialog;
          setWorkspaceDialog({ kind: 'none' });
          void (async () => {
            if (pending.kind === 'create') {
              const created = await applyWorkspaceMutation(
                { kind: 'Create', workspaceId: createUuidV7(), name },
                () => setStatusMessage('That workspace name could not be used.'),
              );
              if (created) {
                // Create makes the new workspace active, and it is empty —
                // land on the overview so the empty state (and its "New
                // project" action) is what the user sees next.
                setSelectedProjectId(null);
                appliedModelRef.current = null;
                setOutlineModel(null);
                setViewMode('workspace');
                setStatusMessage(`Workspace “${name}” created.`);
                // Drop the outgoing project's refresh chain (Story 21.13 D1 AC 4).
                if (selectedProjectId) forecastRefreshChainRef.current.evict(selectedProjectId);
              }
              return;
            }
            if (pending.kind === 'rename') {
              await applyWorkspaceMutation(
                { kind: 'Rename', workspaceId: pending.workspaceId, name },
                () => setStatusMessage('That workspace name could not be used.'),
              );
            }
          })();
        },
      }),
    // Story 27.6/27.7/27.8 (AD-20): the collaboration surfaces render only when
    // the build flag is on and the open project is shared. With the flag off
    // this is `null` — the shell, CSP and network behaviour are unchanged, and a
    // local project never mounts it (TC-NFR1).
    COLLABORATION_BUILD && firstShare && collabModuleRef.current
      ? createElement(collabModuleRef.current.FirstShareDialog, {
          projectName: projects.find((p) => p.id === selectedProjectId)?.name ?? 'Project',
          status: firstShare,
          defaultName: '',
          onShare: (displayName: string) => { void handleFirstShare(displayName); },
          onShareCopy: (displayName: string) => { void handleShareCopy(displayName); },
          onCopyRecovery: (code: string) => copyText(code),
          onCopyInvite: (link: string) => copyText(link),
          onInviteRoleChange: (role: 'editor' | 'viewer') => { void handleFirstInviteRole(role); },
          onClose: () => setFirstShare(null),
        })
      : null,
    COLLABORATION_BUILD && memberDialog && collabModuleRef.current && selectedProjectId && collabSessionsRef.current.get(selectedProjectId)
      ? createElement(collabModuleRef.current.MemberDialog, {
          projectName: projects.find((p) => p.id === selectedProjectId)?.name ?? 'Project',
          role: collabSessionsRef.current.get(selectedProjectId)?.record.role === 'viewer' ? 'viewer' : 'editor',
          busy: memberDialog.busy,
          message: memberDialog.message,
          onClose: () => setMemberDialog(null),
          onLeave: () => {
            const projectId = selectedProjectId;
            const session = collabSessionsRef.current.get(projectId);
            const mod = collabModuleRef.current;
            const ports = collabPortsRef.current;
            if (!session || !mod || !ports) return;
            setMemberDialog({ busy: true, message: 'Leaving…' });
            void mod.leaveProject(ports, session.record).then(() => {
              session.close();
              collabSessionsRef.current.delete(projectId);
              setCollabReadOnly((prev) => new Set([...prev, projectId]));
              setCollabSyncState({ kind: 'revoked' });
              setMemberDialog(null);
              setStatusMessage('You left this project. This copy is read-only; you can delete it from the workspace.');
            }, (err) => {
              console.error('[collaboration] leave failed', err);
              setMemberDialog({ busy: false, message: 'You could not leave right now. Try again.' });
            });
          },
        })
      : null,
    COLLABORATION_BUILD && joinStatus && collabModuleRef.current
      ? createElement(collabModuleRef.current.JoinDialog, {
          key: joinInitialLink ?? 'manual',
          status: joinStatus,
          initialLink: joinInitialLink,
          onJoin: (link: string, displayName: string) => { void handleJoin(link, displayName); },
          onCheckAgain: () => { void handleCheckJoin(false); },
          onClose: () => setJoinStatus(null),
        })
      : null,
    COLLABORATION_BUILD && selectedProjectId && (collabSharedProjectId === selectedProjectId || collabReadOnly.has(selectedProjectId))
      ? createElement(CollaborationMount, {
          enabled: true,
          syncState: collabSyncState,
          rejected: collabRejected,
          present: collabPresent,
          onRetry: handleCollabRetry,
          onCopy: handleCollabCopy,
          onDiscard: handleCollabDiscard,
          shareDialog: collabShareDialogProps,
          notice: collabReadOnly.has(selectedProjectId)
            ? 'This copy is read-only. You can still read, copy or export it, or delete it from the workspace.'
            : collabSessionsRef.current.get(selectedProjectId)?.record.role === 'viewer'
              ? 'View only — ask an owner for edit access.'
              : null,
          viewOnly: collabReadOnly.has(selectedProjectId) || collabSessionsRef.current.get(selectedProjectId)?.record.role === 'viewer',
          activityOpen: activityView.open,
          onToggleActivity: () => {
            const opening = !activityView.open;
            setActivityView((prev) => ({ ...prev, open: opening }));
            if (opening && selectedProjectId) void refreshActivity(selectedProjectId, 200);
          },
          activity: collabModuleRef.current ? {
            rows: collabModuleRef.current.activityFeed(activityView.changes,
              (id) => currentBodyModelRef.current?.nodes.find((n) => n.id === id)?.title || 'an untitled item',
              { actorId: activityView.filterActorId ?? undefined, limit: activityView.limit }),
            nowISO: new Date().toISOString(),
            filterActorId: activityView.filterActorId,
            people: activityView.people,
            hasMore: activityView.changes.filter((c) => !activityView.filterActorId || c.actorId === activityView.filterActorId).length > activityView.limit,
            onFilterChange: (actorId) => setActivityView((prev) => ({ ...prev, filterActorId: actorId })),
            onLoadMore: () => setActivityView((prev) => ({ ...prev, limit: Math.min(200, prev.limit + 20) })),
          } : null,
        })
      : null,
  );
}

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Fatal: #root element not found in index.html');
  }
  const root = createRoot(rootEl);
  root.render(createElement(PMAppRoot));
}

boot().catch((err) => {
  console.error('Vantage boot failed:', err);
  const rootEl = document.getElementById('root');
  if (rootEl) {
    rootEl.textContent = `Vantage failed to start: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
});

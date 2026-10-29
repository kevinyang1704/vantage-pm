/**
 * Forecast Workspace (Epic 18, Story 18.5, UX-DR1..UX-DR3, UX-DR6..UX-DR9).
 *
 * The dedicated project destination opened from SideNav or the command
 * palette — after Gantt, never part of the Outline/Visual/Gantt peer-view
 * toggle (UX-DR1). Renders the planning list (Story 18.6) beside the forecast
 * rail with fixed section order: completion, coverage/validity, arithmetic,
 * assumptions, what changed, scenarios (UX-DR6).
 *
 * The completion card leads with sprint and calendar date, then
 * "capacity-derived" and `Conditional` when applicable. A stale date is
 * never presented as current: while a recompute is pending, or when the
 * background computation is unavailable, the card shows the transient state
 * instead of the previous number (UX-DR7).
 *
 * A single polite live region announces the settled forecast summary once per
 * settle — not per keystroke (UX-DR16, AC 18.7-4).
 *
 * Configuration opens as a non-modal rail panel while the list remains
 * visible; one Save commits the complete configuration group atomically
 * through one ConfigureForecastPlan command (UX-DR9, AC 18.5-3). Invalid
 * entries are passed through unchanged so the command layer can reject and
 * explain them — the UI never silently coerces them to null or zero
 * (AC 18.5-2, AR-11).
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual';
import type { Range } from '@tanstack/react-virtual';
import { describeCause, describeComparisonHeadline } from './change-summary';
import { explainForecast, type ForecastExplanation } from '../../../application/forecast/forecast-explain';
import { itemBar, timelineAxis, readableForecastDate, type ItemBar } from '../../../application/forecast/forecast-timeline';
import { personLanes } from '../../../application/forecast/forecast-lanes';
import { PersonLanes } from './person-lanes';
import { ForecastLevers } from './forecast-levers';
import { JumpTheLinePanel } from './jump-the-line-panel';
import { ScenarioCompare, type ScenarioSaveOutcome } from './scenario-compare';
import {
  explainForecastIssue,
  unavailableItemLabel,
  unavailablePersonLabel,
  type ScenarioNames,
} from './scenario-explain';

/** Staffing result codes whose domain message names raw IDs (Story 23.10). */
const STAFFING_ISSUE_CODES: ReadonlySet<string> = new Set([
  'CONCURRENT_ASSIGNMENT_CONFLICT',
  'MISSING_ASSIGNMENT',
  'UNKNOWN_PERSON',
  'ASSIGNMENT_TO_ZERO_WORK',
  'MISSING_ROSTER',
  'DUPLICATE_ASSIGNMENT',
  'ASSIGNMENT_TO_EXCLUDED_ITEM',
]);
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import type { PersistedForecastScenario, ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../../domain/forecast/scenario-evaluate';
import type { ForecastResult, ForecastArithmetic } from '../../../domain/forecast/forecast-result';
import type { ForecastPlan, ForecastParallelGroup, ForecastPolicyVersion, ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';
import type { FeatureTimeline } from '../../../domain/forecast/forecast-allocation';
import { formatRatio } from '../../../domain/forecast/forecast-canonical';
import {
  moveBlockToIndex as moveBlockToIndexPure,
  moveGroupMember,
  clampDropIndexForBuckets,
  calculateDropIndexFromIndexedMidpoints,
  toElementIndex,
  computeGrabMoveTarget,
  countPrioritySlots,
  slotPositionOfBlock,
  bucketLetterForIndex,
  formatRowPositionAnnouncement,
  formatBucketPositionAnnouncement,
  formatGrabCancelledAnnouncement,
} from './forecast-placement';
import type { MoveBlockResult, IndexedRowRect } from './forecast-placement';
import { BacklogPane } from './backlog-pane';
import {
  clampForecastBacklogWidth,
  FORECAST_BACKLOG_DEFAULT_WIDTH,
  FORECAST_BACKLOG_MIN_WIDTH,
  FORECAST_BACKLOG_MAX_WIDTH,
  FORECAST_BACKLOG_WIDTH_STEP,
} from '../../../application/forecast/forecast-backlog-width';
import { PlanningLevelStep } from './planning-level-step';
import type { PlanningLevelOption } from './planning-level-step';
import { PeopleEditor } from './people-editor';
import { ItemPeopleEditor } from './item-people-editor';
import './forecast.css';

export interface ForecastPlanningRow {
  readonly id: string;
  readonly title: string;
  readonly effortPoints: number | null;
  /** Story 26.5: recorded points done (null = not recorded). */
  readonly effortPointsDone?: number | null;
  /** Story 26.5 display rules: delivered ignores done; in-progress shows n/m. */
  readonly deliveryStatus?: import('../../../domain/tree/node.entity').DeliveryStatus;
  readonly included: boolean;
  /** Feature overlaps an already-selected ancestor/descendant (AC 18.6-4). */
  readonly overlap?: boolean;
  /** A selected reference that no longer resolves to a Feature (AC 18.1-4). */
  readonly invalid?: boolean;
}

export interface ForecastWorkspaceProps {
  readonly projectId: string;
  readonly plan: ForecastPlan | null;
  readonly result: ForecastResult | null;
  /** Typed change attribution vs. the previously-settled forecast (Story 20.2). */
  readonly comparison?: import('../../../domain/forecast/compare.policy').ForecastComparison | null;
  /** False when there is no retained baseline to attribute against (AC 20.2-6). */
  readonly historicalAttributionAvailable?: boolean;
  readonly resultPending: boolean;
  /** Recoverable "forecast unavailable" message, if any (AC 18.4-6). */
  readonly resultError?: string | null;
  readonly onSaveConfiguration: (config: {
    pointsPerSprint: number | null;
    sprintLengthDays: number | null;
    startSprintOrdinal: number | null;
    startDate: string | null;
  }) => void;
  readonly onToggleMembership: (featureId: string, included: boolean) => void | Promise<boolean>;
  readonly onSetEffort: (featureId: string, effortPoints: number | null) => void;
  /**
   * Story 26.5, FC-FR5: record (or clear) points done on an item. Rendered as
   * a labeled "Done" field beside the estimate; the value is never inferred
   * and never flips the delivery status.
   */
  readonly onSetPointsDone?: (featureId: string, effortPointsDone: number | null) => void;
  /**
   * Every peer-level item — ranked and unranked — for the Backlog pane
   * (2026-09-07 planning surface). The pane shows the unranked ones; ranked
   * ones appear dimmed with an `in plan` marker.
   */
  readonly backlogItems?: readonly import('./backlog-pane').BacklogItem[];
  /** Planning-level step options; Stage 1 enables Feature only. */
  readonly levelOptions?: readonly PlanningLevelOption[];
  readonly planningLevel?: import('./planning-level-step').PlanningLevel;
  readonly onChoosePlanningLevel?: (level: import('./planning-level-step').PlanningLevel) => void;
  /** Persist a planning-level switch (Epic 21, Story 21.10 AC 3). */
  readonly onSetPlanningLevel?: (level: import('./planning-level-step').PlanningLevel) => void;
  /**
   * Mark or clear a forecast-owned blocker on one included Feature (Story
   * 20.1). Turns an otherwise-complete result `Conditional` with no assumed
   * delay; it never forces order (AR-12).
   */
  readonly onSetBlocker?: (featureId: string, blocked: boolean) => void;
  readonly eligibleFeatures: readonly ForecastPlanningRow[];
  /** Atomically persists priority order and bounded-parallel membership. */
  readonly onSetForecastSequence?: (
    featureIds: readonly string[],
    parallelGroups: readonly ForecastParallelGroup[],
  ) => void;
  /** Saved historical scenarios and their pure evaluations (Story 20.5). */
  readonly scenarios?: readonly PersistedForecastScenario[];
  readonly scenarioEvaluations?: ReadonlyMap<string, ScenarioEvaluation>;
  /**
   * The current title of any live node, at any level. Saved scenarios store
   * item identities, not titles; a scenario captured at another level still
   * names its items (Story 23.8 AC 23.8-6).
   */
  readonly nodeTitle?: (id: string) => string;
  /** Save a draft with its captured expectations (Story 23.7). */
  readonly onCreateScenario?: (params: {
    label: string;
    patch: ForecastScenarioPatch;
    context: ScenarioDraftContext;
  }) => Promise<ScenarioSaveOutcome>;
  readonly onRemoveScenario?: (scenarioId: string) => void;
  /** Capture, evaluate (in the worker) and cancel scenario drafts (Story 23.7). */
  readonly onCaptureScenarioDraft?: () => Promise<ScenarioDraftContext>;
  readonly onEvaluateScenarioDraft?: (context: ScenarioDraftContext, patch: ForecastScenarioPatch) => Promise<ScenarioEvaluation>;
  readonly onCancelScenarioDraft?: (draftId: string) => void;
  /** Epic 22 roster operations (Story 22.3) */
  readonly onAddPerson?: (name: string, weightUnits: number) => Promise<boolean>;
  readonly onUpdatePerson?: (personId: string, name: string, weightUnits: number) => Promise<boolean>;
  readonly onRemovePerson?: (personId: string) => Promise<boolean>;
  /** Epic 22 staffing policy and assignment operations (Story 22.5) */
  readonly onSetAssignments?: (featureId: string, personIds: readonly string[]) => Promise<boolean | string>;
  readonly onSetPolicy?: (policyVersion: ForecastPolicyVersion) => Promise<boolean>;
  /**
   * Story 26.7 (FC-FR7/8): capture a baseline, evaluate a jump-the-line what-if
   * patch as of today, and apply or save it.
   */
  readonly onCaptureWhatIfBaseline?: () => Promise<ScenarioDraftContext>;
  readonly onEvaluateWhatIf?: (patch: ForecastScenarioPatch, addedFact: { id: string; fact: unknown } | undefined) => Promise<ScenarioEvaluation>;
  readonly onApplyWhatIf?: (params: { patch: ForecastScenarioPatch; addedFact?: { id: string; fact: unknown } }) => void;
  readonly onSaveWhatIf?: (label: string, patch: ForecastScenarioPatch) => void;
  /** Width in pixels of the left backlog panel (defaults to 280). */
  readonly backlogWidth?: number;
  /** Callback when the user resizes the left backlog panel. */
  readonly onBacklogWidthChange?: (width: number) => void;
}

interface GroupInfoEntry {
  readonly group: ForecastParallelGroup;
  readonly groupIndex: number;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}

/**
 * One rendered Priority-list element in the virtualized list (Story 23.11):
 * a parallel bucket (all members inside) or a single row.
 */
type ForecastSlot =
  | { readonly kind: 'row'; readonly key: string; readonly row: ForecastPlanningRow }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly groupIndex: number;
      readonly group: ForecastParallelGroup;
      readonly members: readonly ForecastPlanningRow[];
    }
  | { readonly kind: 'dropline'; readonly key: 'dropline' };

const EMPTY_ROSTER: readonly ForecastPerson[] = Object.freeze([]);
const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** Build the featureId → bucket member-info map for a group set. */
function buildGroupInfoMap(
  groups: readonly ForecastParallelGroup[],
): ReadonlyMap<string, GroupInfoEntry> {
  const map = new Map<string, GroupInfoEntry>();
  groups.forEach((group, gIdx) => {
    group.featureIds.forEach((id, fIdx) => {
      map.set(id, {
        group,
        groupIndex: gIdx,
        isFirst: fIdx === 0,
        isLast: fIdx === group.featureIds.length - 1,
      });
    });
  });
  return map;
}

function formatStateLabel(state: ForecastResult['state']): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'empty':
      return 'No features selected';
    case 'zero-work':
      return 'Zero estimated work';
    case 'incomplete':
      return 'Incomplete inputs';
    case 'invalid':
      return 'Invalid inputs';
    case 'overflow':
      return 'Inputs out of range';
    case 'conditional':
      return 'Conditional';
    default:
      return state;
  }
}

/**
 * Parse a nullable integer field WITHOUT coercing bad input to null: an empty
 * field is null (unconfigured), anything else is passed through as typed so
 * the command layer rejects and explains it (AC 18.5-2). Returns `NaN` for a
 * non-empty non-integer so the caller can still submit and surface the error.
 */
function parseConfigInt(raw: string): number | null {
  if (raw.trim() === '') return null;
  return Number(raw);
}

export function ForecastWorkspace({
  projectId,
  plan,
  result,
  comparison,
  historicalAttributionAvailable,
  resultPending,
  resultError,
  onSaveConfiguration,
  onToggleMembership,
  onSetEffort,
  onSetPointsDone,
  onSetBlocker,
  backlogItems,
  levelOptions,
  planningLevel,
  onChoosePlanningLevel,
  onSetPlanningLevel,
  eligibleFeatures,
  onSetForecastSequence,
  scenarios,
  scenarioEvaluations,
  nodeTitle,
  onCreateScenario,
  onRemoveScenario,
  onCaptureScenarioDraft,
  onEvaluateScenarioDraft,
  onCancelScenarioDraft,
  onAddPerson,
  onUpdatePerson,
  onRemovePerson,
  onSetAssignments,
  onSetPolicy,
  onCaptureWhatIfBaseline,
  onEvaluateWhatIf,
  onApplyWhatIf,
  onSaveWhatIf,
  backlogWidth,
  onBacklogWidthChange,
}: ForecastWorkspaceProps): React.ReactElement {
  const [localBacklogWidth, setLocalBacklogWidth] = useState<number>(
    backlogWidth ?? FORECAST_BACKLOG_DEFAULT_WIDTH,
  );

  useEffect(() => {
    if (backlogWidth !== undefined) {
      setLocalBacklogWidth(backlogWidth);
    }
  }, [backlogWidth]);

  const activeBacklogWidth = backlogWidth ?? localBacklogWidth;

  const [isResizingBacklog, setIsResizingBacklog] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const commitBacklogWidth = useCallback(
    (px: number): void => {
      const containerWidth =
        rootRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
      const clamped = clampForecastBacklogWidth(px, containerWidth);
      setLocalBacklogWidth(clamped);
      onBacklogWidthChange?.(clamped);
    },
    [onBacklogWidthChange],
  );

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    resizeStartRef.current = { x: e.clientX, width: activeBacklogWidth };
    setIsResizingBacklog(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = resizeStartRef.current;
    if (!start) return;
    commitBacklogWidth(start.width + (e.clientX - start.x));
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    resizeStartRef.current = null;
    setIsResizingBacklog(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? FORECAST_BACKLOG_WIDTH_STEP * 3 : FORECAST_BACKLOG_WIDTH_STEP;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      commitBacklogWidth(activeBacklogWidth + step);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      commitBacklogWidth(activeBacklogWidth - step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      commitBacklogWidth(FORECAST_BACKLOG_DEFAULT_WIDTH);
    }
  };

  const blockedSet = useMemo(
    () => new Set(plan?.blockedFeatureIds ?? []),
    [plan],
  );
  const [configOpen, setConfigOpen] = useState(false);
  const [peopleEditorOpen, setPeopleEditorOpen] = useState(false);
  const peopleButtonRef = useRef<HTMLButtonElement>(null);
  const [itemPeopleEditorState, setItemPeopleEditorState] = useState<{
    featureId: string;
    featureTitle: string;
  } | null>(null);
  const itemTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [modeError, setModeError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    pointsPerSprint: string;
    sprintLengthDays: string;
    startSprintOrdinal: string;
    startDate: string;
  } | null>(null);

  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [lastAnchorId, setLastAnchorId] = useState<string | null>(null);
  const [parallelSelectionMode, setParallelSelectionMode] = useState(false);
  /** Story 26.1 AC 26.1-3: the raw math tables live under one disclosure. */
  const [mathOpen, setMathOpen] = useState(false);
  /**
   * Per-row estimate text that is currently being edited (Story 25.1 AC
   * 25.1-4, O5). While present, the field shows the user's in-progress value
   * instead of the acknowledged plan value, so a concurrent commit in another
   * row (which changes `plan` identity) cannot overwrite an uncommitted edit.
   * Cleared on commit, Escape and blur-commit.
   */
  const [effortDrafts, setEffortDrafts] = useState<ReadonlyMap<string, string>>(new Map());

  /** Drop a row's in-progress estimate text (commit, Escape, blur). */
  const clearEffortDraft = useCallback((featureId: string) => {
    setEffortDrafts((current) => {
      if (!current.has(featureId)) return current;
      const next = new Map(current);
      next.delete(featureId);
      return next;
    });
  }, []);
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(new Set());
  const [groupSplitError, setGroupSplitError] = useState<string | null>(null);
  const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
  /**
   * When a bucket header drag is in flight, the dragged group object — so a
   * drop moves the whole contiguous block (AC 21.3-5), never just the member.
   */
  const draggedBucketGroupRef = useRef<ForecastParallelGroup | null>(null);
  /** Free-placement drag: index in orderedSelectedFeatures where the drop line sits. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  /**
   * Backlog items dropped at specific slots (AC 21.3-4): rendered
   * optimistically at `index` while the membership command lands, then slid
   * into place with one sequence command once each is in scope. A queue (not
   * a single slot) so two quick drops are neither lost nor overwritten
   * (Story 21.11 AC 15); an id that never lands is dropped by the effect.
   */
  const [pendingReorder, setPendingReorder] = useState<readonly { id: string; index: number }[]>([]);
  /**
   * A row that must receive focus once it is rendered (Story 23.11 AC
   * 23.11-2). The Priority list renders a bounded window, so a row the user
   * navigates to may not be mounted: the state both scrolls the virtualizer
   * and pins the target slot until focus lands.
   */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  /**
   * The logical arrow-navigation position while a focus move is in flight
   * (Story 23.11 AC 23.11-2). When the next row is outside the rendered
   * window, DOM focus lags behind the effect that scrolls it in; without
   * this, a key-repeat burst would recompute from the stale DOM-focused row
   * and never advance past the window boundary.
   */
  const arrowFocusOriginRef = useRef<string | null>(null);
  /** The scroller the virtualized Priority list measures against. */
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  /** The Forecast root — the scroller in the <900px single-column layout. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * Below 899px the layout reflows to a single column and the whole Forecast
   * root scrolls (`.pm-forecast__list` is `overflow-y: visible`); above it the
   * list itself scrolls. The virtualizer must follow whichever element owns
   * the scroll, or the rendered window never advances (Story 23.11).
   */
  const [singleColumnLayout, setSingleColumnLayout] = useState(false);
  /** The tall inner container holding the absolutely positioned slots. */
  const rowsInnerRef = useRef<HTMLDivElement | null>(null);
  /** Distance from the scroll container's content origin to the slot list. */
  const [rowsScrollMargin, setRowsScrollMargin] = useState(0);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 899px)');
    const update = (): void => setSingleColumnLayout(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const groupModeTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreGroupModeTriggerFocusRef = useRef(false);
  /**
   * Keyboard grab-and-drop (Story 21.4): a grabbed block — one row, a
   * Shift+↑/↓ selection, or a whole bucket — is held *provisionally* in local
   * state ("origin" is the pre-grab order), moves ±1 slot with ↑/↓, and is
   * committed once with a single SetForecastSequence on Space/Enter. Escape
   * or blur simply discards the provisional state — the pre-grab order is
   * never written back because it was never written out (Story 21.4 dev
   * note: "prefer holding the provisional order in local state and
   * committing once on drop").
   */
  const [grabState, setGrabState] = useState<{
    readonly itemIds: readonly string[];
    readonly originIndex: number;
    readonly currentIndex: number;
    readonly isBucket: boolean;
    readonly bucketLetter?: string;
    readonly title: string;
    /** The provisional full priority order while grabbed. */
    readonly ids: readonly string[];
    /** The provisional parallel-group set while grabbed. */
    readonly groups: readonly ForecastParallelGroup[];
  } | null>(null);

  const config = plan?.configuration ?? null;

  const openConfig = (): void => {
    setDraft({
      pointsPerSprint: config?.pointsPerSprint?.toString() ?? '',
      sprintLengthDays: config?.sprintLengthDays?.toString() ?? '',
      startSprintOrdinal: config?.startSprintOrdinal?.toString() ?? '',
      startDate: config?.startDate ?? '',
    });
    setConfigOpen(true);
  };

  const saveConfig = (): void => {
    if (!draft) return;
    onSaveConfiguration({
      pointsPerSprint: parseConfigInt(draft.pointsPerSprint),
      sprintLengthDays: parseConfigInt(draft.sprintLengthDays),
      startSprintOrdinal: parseConfigInt(draft.startSprintOrdinal),
      startDate: draft.startDate.trim() === '' ? null : draft.startDate.trim(),
    });
    setConfigOpen(false);
  };

  const arithmetic = result?.arithmetic ?? null;
  const issues = result?.issues ?? [];
  const isStaffed = (result?.policyVersion ?? plan?.policyVersion) === 'staffed-capacity-v1';
  // Story 23.10 (SF-UX5, SF-FR7): staffing issues name the people and items
  // involved and say how to resolve them; the domain message carries raw IDs.
  const liveNames: ScenarioNames = {
    person: (id) => plan?.roster?.find((p) => p.id === id)?.name ?? unavailablePersonLabel(id),
    item: (id) => nodeTitle?.(id) || eligibleFeatures.find((f) => f.id === id)?.title || unavailableItemLabel(id),
    level: plan?.planningLevel ?? 'Feature',
  };
  const missingAssignmentIds = issues
    .filter((i) => i.code === 'MISSING_ASSIGNMENT')
    .flatMap((i) => i.featureIds ?? []);
  const issueText = (issue: (typeof issues)[number]): string => {
    if (!STAFFING_ISSUE_CODES.has(issue.code)) return issue.message;
    const explained = explainForecastIssue(issue, liveNames);
    return explained ? `${explained.message}${explained.repair ? ` ${explained.repair}` : ''}` : issue.message;
  };

  const stale = resultPending || Boolean(resultError);
  // A `conditional` result carries the same complete arithmetic as `ready` —
  // it is shown as the real Sprint/date, labelled Conditional (Story 20.1,
  // UX-DR7).
  const showReady =
    !stale && (result?.state === 'ready' || result?.state === 'conditional') && arithmetic !== null;
  const blockerIssues = issues.filter((i) => i.code === 'CONDITIONAL_BLOCKER');

  const displayArithmetic = useMemo<ForecastArithmetic | null>(() => {
    if (arithmetic) return arithmetic;
    if (!config) return null;
    if (
      config.pointsPerSprint === null ||
      config.sprintLengthDays === null ||
      config.startSprintOrdinal === null ||
      config.startDate === null
    ) {
      return null;
    }
    return Object.freeze({
      totalPoints: result?.totalKnownPoints ?? 0,
      pointsPerSprint: config.pointsPerSprint,
      requiredSprints: Object.freeze({ numerator: 0, denominator: 1 }),
      occupiedSprints: 0,
      completionSprint: null,
      completionDate: null,
      sprintLengthDays: config.sprintLengthDays,
      startSprintOrdinal: config.startSprintOrdinal,
      startDate: config.startDate,
    });
  }, [arithmetic, config, result]);

  // Story 26.1 (FC-FR1, FC-UX1): the plain-language answer and reasons, all
  // derived from the same acknowledged result so they can never disagree with
  // the math. Policy IDs are kept out of this view and live in "Show the math".
  const explanation = useMemo<ForecastExplanation>(
    () => explainForecast(stale ? null : result),
    [result, stale],
  );

  // ── Polite live announcement of the settled summary (UX-DR16, UX-DR14) ─────────
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncedRef = useRef<string>('');
  const prevSettledRef = useRef<{ sprint: number | null; date: string | null } | null>(null);

  /**
   * Transient action narration (Story 21.11 AC 17): a *separate* polite region
   * from the settled-summary one, keyed by a monotonic counter so consecutive
   * distinct actions are each narrated and a transient announcement is never
   * overwritten by the settled summary (or vice versa). Each action gets a
   * fresh key, including successive drags with the same announcement text.
   */
  const [transientAnnouncement, setTransientAnnouncement] = useState('');
  const transientSeqRef = useRef(0);

  /**
   * Announce one transient action message (add, reorder, grab position,
   * cancellation). The sequence is internal and is not spoken.
   */
  const announce = useCallback((message: string) => {
    transientSeqRef.current += 1;
    setTransientAnnouncement(`${transientSeqRef.current}:${message}`);
  }, []);

  // Responsive drawers (Story 21.2, AC 21.2-11, UX-DR7): the Backlog opens as
  // a drawer over the Priority list below 1280px; the rail becomes a drawer
  // below 1100px. Open state is UI-only; drawers toggle instantly with no
  // CSS transition or animation (check:motion).
  const [backlogDrawerOpen, setBacklogDrawerOpen] = useState(false);
  const [railDrawerOpen, setRailDrawerOpen] = useState(false);
  const closeBacklogDrawer = useCallback(() => setBacklogDrawerOpen(false), []);
  const toggleRailDrawer = useCallback(() => setRailDrawerOpen((v) => !v), []);
  const closeRailDrawer = useCallback(() => setRailDrawerOpen(false), []);
  const backlogToggleRef = useRef<HTMLButtonElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const backlogCloseRef = useRef<HTMLButtonElement>(null);
  const railCloseRef = useRef<HTMLButtonElement>(null);

  // Story 21.10 AC 3: switching planning levels is a destructive scope reset
  // and MUST be preceded by an explicit confirmation dialog — a real
  // focus-trapped dialog with an accessible name, never window.confirm. The
  // dialog offers the three levels; confirming dispatches the chosen one.
  const [levelDialogOpen, setLevelDialogOpen] = useState(false);
  const [levelDialogChoice, setLevelDialogChoice] = useState<import('./planning-level-step').PlanningLevel>('Feature');
  const levelDialogRef = useRef<HTMLDivElement>(null);
  const levelConfirmRef = useRef<HTMLButtonElement>(null);
  const levelCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const clearDrag = (): void => {
      setDropIndex(null);
      setDraggedRowId(null);
      draggedBucketGroupRef.current = null;
    };
    // Backlog drags originate outside the Priority container; cancellation
    // must clear its indicator even when no dragleave is delivered there.
    document.addEventListener('dragend', clearDrag);
    window.addEventListener('blur', clearDrag);
    return () => {
      document.removeEventListener('dragend', clearDrag);
      window.removeEventListener('blur', clearDrag);
    };
  }, []);

  const openLevelDialog = useCallback(() => {
    setLevelDialogChoice(planningLevel ?? 'Feature');
    setLevelDialogOpen(true);
  }, [planningLevel]);

  const confirmLevelChange = useCallback(() => {
    if (!onSetPlanningLevel) return;
    onSetPlanningLevel(levelDialogChoice);
    setLevelDialogOpen(false);
  }, [levelDialogChoice, onSetPlanningLevel]);

  // Focus moves into the dialog on open and returns to the Change button on
  // close; Escape cancels (grabbed -> drawer -> dialog -> selection mode).
  useEffect(() => {
    if (levelDialogOpen) {
      levelConfirmRef.current?.focus();
    } else {
      levelCancelRef.current?.focus();
    }
  }, [levelDialogOpen]);

  // Reconcile drawer state when the viewport widens past the drawer
  // breakpoints: a drawer opened below 1280px must close (and its transparent
  // scrim unmount) once the pane is in flow again (Story 21.11 AC 26).
  useEffect(() => {
    const handleResize = (): void => {
      if (window.innerWidth >= 1280) {
        setBacklogDrawerOpen(false);
        setRailDrawerOpen(false);
      } else if (window.innerWidth >= 1100) {
        setRailDrawerOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Focus moves into a drawer on open and returns to its toggle on close
  // (Story 21.11 AC 27).
  useEffect(() => {
    if (backlogDrawerOpen) {
      backlogCloseRef.current?.focus();
    } else {
      backlogToggleRef.current?.focus();
    }
  }, [backlogDrawerOpen]);
  useEffect(() => {
    if (railDrawerOpen) {
      railCloseRef.current?.focus();
    } else {
      railToggleRef.current?.focus();
    }
  }, [railDrawerOpen]);

  useEffect(() => {
    if (resultPending) return;
    let summary: string;
    if (resultError) {
      summary = `Forecast temporarily unavailable — ${resultError}`;
    } else if (!result) {
      summary = '';
    } else if ((result.state === 'ready' || result.state === 'conditional') && result.arithmetic) {
      const curSprint = result.arithmetic.completionSprint;
      const curDate = result.arithmetic.completionDate;
      const prev = prevSettledRef.current;
      const conditionalNote = result.state === 'conditional' ? ' The result is conditional; no delay was assumed.' : '';

      // Story 20.2 / 20.6: one settled summary. "Same completion" only when
      // the whole-set date held while item timing moved.
      if (comparison?.sameCompletion || (prev && prev.sprint === curSprint && prev.date === curDate)) {
        summary = `Forecast settled — same completion (Sprint ${curSprint} on ${curDate}). Individual Feature timing updated.${conditionalNote}`;
      } else {
        summary = `Forecast settled — completion projected for sprint ${curSprint} on ${curDate}.${conditionalNote}`;
      }
      prevSettledRef.current = { sprint: curSprint, date: curDate };
    } else {
      const detail: Record<string, string> = {
        empty: 'no Features are selected yet',
        'zero-work': 'the selected Features carry no estimated points',
        incomplete: 'some required inputs are still missing',
        invalid: 'one or more inputs are not valid',
        overflow: 'the inputs are outside the supported range',
        conditional: 'the result is conditional',
      };
      const n = issues.length;
      summary = `Forecast settled — ${detail[result.state] ?? result.state}.${
        n > 0 ? ` ${n} ${n === 1 ? 'input needs' : 'inputs need'} attention.` : ''
      }`;
    }
    if (summary && summary !== lastAnnouncedRef.current) {
      lastAnnouncedRef.current = summary;
      setAnnouncement(summary);
    }
  }, [result, resultPending, resultError, issues.length, comparison]);

  // ── Planning list ordering & parallel groups (Story 19.4) ───────────────

  const { orderedSelectedFeatures } = useMemo(() => {
    const selectedIds = plan?.selectedFeatureIds ?? [];
    const featureMap = new Map(eligibleFeatures.map((f) => [f.id, f]));
    const ordered: ForecastPlanningRow[] = [];
    const seen = new Set<string>();

    for (const id of selectedIds) {
      seen.add(id);
      const f = featureMap.get(id);
      if (f) {
        ordered.push(f);
      } else {
        ordered.push({
          id,
          title: '(removed Feature)',
          effortPoints: null,
          included: true,
          invalid: true,
        });
      }
    }

    for (const f of eligibleFeatures) {
      if (f.included && !seen.has(f.id)) {
        ordered.push(f);
        seen.add(f.id);
      }
    }

    return { orderedSelectedFeatures: ordered };
  }, [plan?.selectedFeatureIds, eligibleFeatures]);

  // Once the acknowledged plan value converges with a held draft (the command
  // applied), drop it so the field tracks the plan again. A draft that differs
  // from the acknowledged value is retained — that is the whole point (25.1-4).
  // Pruning is computed OUTSIDE the state updater (which must stay pure), and
  // the matching focus origin is dropped alongside it.
  useEffect(() => {
    if (effortDrafts.size === 0) return;
    let changed = false;
    const next = new Map(effortDrafts);
    for (const [id, text] of effortDrafts) {
      const row =
        orderedSelectedFeatures.find((r) => r.id === id) ??
        eligibleFeatures.find((r) => r.id === id);
      if (!row) {
        // The row left scope (deleted or removed): drop the stale draft so it
        // cannot resurrect on a later item reusing the id.
        next.delete(id);
        changed = true;
        continue;
      }
      const acknowledged = row.effortPoints === null ? '' : String(row.effortPoints);
      const parsed = text.trim() === '' ? null : Number(text);
      if (parsed === row.effortPoints || text === acknowledged) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setEffortDrafts(next);
  }, [effortDrafts, orderedSelectedFeatures, eligibleFeatures]);

  /** Title for a planning row id (for accessible names and announcements). */
  const titleForId = useCallback(
    (featureId: string): string => {
      const row = orderedSelectedFeatures.find((r) => r.id === featureId) ??
        eligibleFeatures.find((r) => r.id === featureId);
      return row?.title ?? 'Untitled';
    },
    [orderedSelectedFeatures, eligibleFeatures],
  );

  const parallelGroups = useMemo(() => plan?.parallelGroups ?? [], [plan?.parallelGroups]);

  // Story 26.2 (FC-FR2): the shared sprint axis and the exact-finish marker,
  // both pure projections of the acknowledged result.
  const axis = useMemo(() => timelineAxis(stale ? null : result), [result, stale]);

  // Story 26.3 (FC-FR3): busy/idle lanes per person, from the result's
  // capacity events and the roster weights.
  const [lanePage, setLanePage] = useState(0);
  const lanes = useMemo(
    () => personLanes(stale ? null : result, plan?.roster ?? EMPTY_ROSTER),
    [result, stale, plan?.roster],
  );
  // Keep the lane page in range when the lane set shrinks (e.g. a shorter roster).
  useEffect(() => {
    const maxPage = Math.max(Math.ceil(lanes.lanes.length / 12) - 1, 0);
    if (lanePage > maxPage) setLanePage(maxPage);
  }, [lanes.lanes.length, lanePage]);

  const groupInfoByFeatureId = useMemo(
    () => buildGroupInfoMap(parallelGroups),
    [parallelGroups],
  );

  /**
   * Priority-list slots (Story 23.11 AC 23.11-2): the list is virtualized, so
   * the render model is a flat, stable-keyed slot list — one slot per rendered
   * element. A parallel bucket is ONE slot (its members render inside the
   * wrapper); every other row is a slot of its own. Slots are what
   * `defaultRangeExtractor` windows and what `measureElement` measures, so the
   * DOM holds a bounded number of them whatever the scope size.
   *
   * Built from `displayRows` (the optimistic/pending/grab-aware order) so the
   * optimistic drop rendering keeps working unchanged.
   */
  const buildSlots = useCallback(
    (
      rows: readonly ForecastPlanningRow[],
      groupInfo: ReadonlyMap<string, GroupInfoEntry>,
    ): readonly ForecastSlot[] => {
      const slots: ForecastSlot[] = [];
      const rendered = new Set<ForecastParallelGroup>();
      for (const f of rows) {
        const info = groupInfo.get(f.id);
        if (info) {
          if (rendered.has(info.group)) continue;
          rendered.add(info.group);
          slots.push({
            kind: 'group',
            key: `group-${info.groupIndex}`,
            groupIndex: info.groupIndex,
            group: info.group,
            members: rows.filter((m) => info.group.featureIds.includes(m.id)),
          });
        } else {
          slots.push({ kind: 'row', key: f.id, row: f });
        }
      }
      return slots;
    },
    [],
  );

  /**
   * Rows that must stay mounted while they hold focus or an uncommitted edit,
   * plus the row being dragged (its drag image and dragend depend on the
   * mounted element) and any expanded row (its Details panel is open).
   * Returning these indexes from `rangeExtractor` pins them into the window
   * (Story 23.11 AC 23.11-2: "a focused or edited row is never unmounted
   * while it holds focus or an uncommitted draft").
   */
  const pinnedSlotIndexes = useCallback(
    (slots: readonly ForecastSlot[]): readonly number[] => {
      const pinned: number[] = [];
      const pinnedIds = new Set<string>();
      if (pendingFocusId) pinnedIds.add(pendingFocusId);
      if (draggedRowId) pinnedIds.add(draggedRowId);
      if (grabState) for (const id of grabState.itemIds) pinnedIds.add(id);
      for (const id of expandedRowIds) pinnedIds.add(id);
      for (const id of effortDrafts.keys()) pinnedIds.add(id);
      // The focused element, if it sits in this list, is pinned so focus can
      // never be destroyed by a scroll-induced unmount. Guard on `document`
      // first: unit specs server-render this component where no DOM globals
      // (not even `HTMLElement`) exist.
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (active !== null && typeof document !== 'undefined' && active instanceof HTMLElement) {
        for (const [id, el] of rowRefs.current) {
          if (el === active || el.contains(active)) {
            pinnedIds.add(id);
            break;
          }
        }
      }
      slots.forEach((slot, index) => {
        if (slot.kind === 'row') {
          if (pinnedIds.has(slot.row.id)) pinned.push(index);
        } else if (slot.kind === 'group' && slot.members.some((m) => pinnedIds.has(m.id))) {
          pinned.push(index);
        }
      });
      return pinned;
    },
    [pendingFocusId, draggedRowId, grabState, expandedRowIds, effortDrafts],
  );

  /**
   * The display order and its slot list (Story 23.11): `displayRows` keeps the
   * optimistic/pending/grab-aware ordering, and `renderSlots` collapses it
   * into the virtualized element list.
   */
  const renderSlots = useMemo<readonly ForecastSlot[]>(() => {
    // While a keyboard grab is in flight the *provisional* order and group
    // set render (Story 21.4 dev note: hold the provisional order locally,
    // commit once on drop), so ↑/↓ moves are visible immediately and Escape
    // restores the pre-grab order for free.
    const renderGroups = grabState ? grabState.groups : parallelGroups;
    const renderOrder = grabState
      ? (() => {
          // Stable sort: rows absent from the grab snapshot retain their
          // relative order instead of sorting to the top via indexOf === -1
          // under a non-total comparator (Story 21.11 AC 21).
          const position = new Map(grabState.ids.map((id, i) => [id, i]));
          return orderedSelectedFeatures.slice().sort((a, b) => {
            const ia = position.get(a.id) ?? Number.MAX_SAFE_INTEGER;
            const ib = position.get(b.id) ?? Number.MAX_SAFE_INTEGER;
            return ia - ib;
          });
        })()
      : null;
    const renderGroupInfo = grabState ? buildGroupInfoMap(renderGroups) : groupInfoByFeatureId;
    const rows = renderOrder ?? orderedSelectedFeatures;

    // Backlog drops mid-reconcile render optimistically at their target slots
    // (AC 21.3-4): build a synthetic display order with each pending item
    // inserted at its item-space target. The queue is applied in order so two
    // quick drops are both visible (Story 21.11 AC 15).
    let displayRows: readonly ForecastPlanningRow[] = rows;
    if (!grabState && pendingReorder.length > 0) {
      let display = rows;
      for (const pending of pendingReorder) {
        const pendingItem = eligibleFeatures.find((r) => r.id === pending.id);
        if (!pendingItem) continue;
        const base = display.filter((r) => r.id !== pending.id);
        const at = Math.max(0, Math.min(pending.index, base.length));
        const optimisticRow: ForecastPlanningRow = {
          id: pendingItem.id,
          title: pendingItem.title,
          effortPoints: pendingItem.effortPoints,
          included: true,
          overlap: false,
          invalid: false,
        };
        display = [...base.slice(0, at), optimisticRow, ...base.slice(at)];
      }
      displayRows = display;
    }

    const slots = buildSlots(displayRows, renderGroupInfo);

    // Drop line at the current insertion index (free placement). The computed
    // index is item-space; buckets collapse N members into one rendered
    // wrapper, so map to element space before splicing (Story 21.1 AC 5).
    if (dropIndex !== null) {
      const elementIndex = toElementIndex(
        dropIndex,
        parallelGroups,
        (plan?.selectedFeatureIds ?? []).slice(),
      );
      const at = Math.max(0, Math.min(slots.length, elementIndex));
      return [...slots.slice(0, at), { kind: 'dropline', key: 'dropline' } as const, ...slots.slice(at)];
    }
    return slots;
  }, [
    grabState,
    parallelGroups,
    orderedSelectedFeatures,
    groupInfoByFeatureId,
    pendingReorder,
    eligibleFeatures,
    buildSlots,
    dropIndex,
    plan?.selectedFeatureIds,
  ]);

  const virtualizer = useVirtualizer({
    count: renderSlots.length,
    getScrollElement: () => (singleColumnLayout ? rootRef.current : listScrollRef.current),
    // A non-zero starting window so the first render (and server rendering,
    // where no element can be measured) has rows to show; the real height
    // replaces it synchronously in the mount layout effect.
    initialRect: { width: 0, height: 800 },
    // Defer the rect observer to an animation frame: the list re-lays-out
    // while slots mount/unmount, and a synchronous measurement inside the
    // observer raises "loop completed with undelivered notifications".
    useAnimationFrameWithResizeObserver: true,
    // Estimates only position unmounted slots; mounted slots are measured.
    // A bucket is header + members, a row with Details open is taller.
    estimateSize: (index) => {
      const slot = renderSlots[index];
      if (!slot) return 54;
      if (slot.kind === 'group') return 64 + slot.members.length * 54 + (slot.members.length - 1) * 6;
      if (slot.kind === 'dropline') return 2;
      return expandedRowIds.has(slot.row.id) ? 320 : 54;
    },
    overscan: 12,
    gap: 6,
    scrollMargin: rowsScrollMargin,
    getItemKey: (index) => renderSlots[index]?.key ?? index,
    rangeExtractor: (range: Range) => {
      const pinned = pinnedSlotIndexes(renderSlots);
      if (pinned.length === 0) return defaultRangeExtractor(range);
      // Union of the scrolled window and the pinned slots, deduplicated and
      // ascending — the virtualizer renders `getVirtualItems()` in order.
      const start = Math.max(range.startIndex - range.overscan, 0);
      const end = Math.min(range.endIndex + range.overscan, range.count - 1);
      const wanted = new Set<number>();
      for (let i = start; i <= end; i += 1) wanted.add(i);
      for (const i of pinned) if (i >= 0 && i < range.count) wanted.add(i);
      return [...wanted].sort((a, b) => a - b);
    },
  });

  // The slot list starts below the header/selection chrome, so the scroll
  // margin must be the inner container's offset within the scroller. The
  // scroller itself changes with the layout (list box vs the root at <900px).
  // The state update is deferred out of the observer callback: measuring and
  // re-rendering synchronously inside a ResizeObserver notification is what
  // raises "loop completed with undelivered notifications".
  useEffect(() => {
    const scroller = singleColumnLayout ? rootRef.current : listScrollRef.current;
    const inner = rowsInnerRef.current;
    if (!scroller || !inner) return;
    let frame: number | null = null;
    const measureMargin = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollerRect = scroller.getBoundingClientRect();
        const innerRect = inner.getBoundingClientRect();
        const margin = innerRect.top - scrollerRect.top + scroller.scrollTop;
        setRowsScrollMargin((prev) => (Math.abs(prev - margin) < 0.5 ? prev : margin));
      });
    };
    measureMargin();
    const observer = new ResizeObserver(measureMargin);
    observer.observe(scroller);
    observer.observe(inner);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [singleColumnLayout]);

  /**
   * Bring a requested row into view and focus it (Story 23.11 AC 23.11-2:
   * focus identity survives a row that was scrolled out). The target slot is
   * pinned by `rangeExtractor` while pending, so it is always mounted once
   * `scrollToIndex` settles; the effect retries across renders until focus
   * lands, then clears.
   */
  useEffect(() => {
    if (!pendingFocusId) return;
    const slotIndex = renderSlots.findIndex((slot) =>
      slot.kind === 'row'
        ? slot.row.id === pendingFocusId
        : slot.kind === 'group' && slot.members.some((m) => m.id === pendingFocusId),
    );
    if (slotIndex === -1) {
      setPendingFocusId(null);
      return;
    }
    const mounted = rowRefs.current.get(pendingFocusId);
    if (mounted) {
      mounted.focus();
      if (document.activeElement === mounted || mounted.contains(document.activeElement)) {
        setPendingFocusId(null);
      }
      return;
    }
    virtualizer.scrollToIndex(slotIndex, { align: 'auto' });
  }, [
    pendingFocusId,
    renderSlots,
    virtualizer,
    // Re-run after each window change so focus lands once the target mounts.
    virtualizer.range?.startIndex,
    virtualizer.range?.endIndex,
  ]);

  const timelineByFeatureId = useMemo(() => {
    const map = new Map<string, FeatureTimeline>();
    for (const t of result?.allocation?.timelines ?? []) {
      map.set(t.featureId, t);
    }
    return map;
  }, [result?.allocation?.timelines]);

  /**
   * Events are the policy's inspectable evidence, rather than a UI-derived
   * percentage.  A feature participates in every interval after its start and
   * through its finish; zero-work milestones deliberately have none.
   */
  const capacityEventsForTimeline = useCallback(
    (timeline: FeatureTimeline | undefined) => {
      if (!timeline || timeline.isMilestone || !timeline.startOffset || !timeline.finishOffset) return [];
      return (result?.allocation?.events ?? []).filter(
        (event) =>
          event.finishOffset.numerator / event.finishOffset.denominator >
            timeline.startOffset!.numerator / timeline.startOffset!.denominator &&
          event.startOffset.numerator / event.startOffset.denominator <
            timeline.finishOffset!.numerator / timeline.finishOffset!.denominator,
      );
    },
    [result?.allocation?.events],
  );

  const canGroup = useMemo(() => {
    if (selectedRowIds.size < 2) return false;
    const indices: number[] = [];
    orderedSelectedFeatures.forEach((f, idx) => {
      if (selectedRowIds.has(f.id)) indices.push(idx);
    });
    if (indices.length !== selectedRowIds.size) return false;
    const min = Math.min(...indices);
    const max = Math.max(...indices);
    return max - min + 1 === selectedRowIds.size;
  }, [selectedRowIds, orderedSelectedFeatures]);

  const selectionSplitsGroup = useMemo(
    () => parallelGroups.some((group) => {
      const selectedMembers = group.featureIds.filter((id) => selectedRowIds.has(id)).length;
      return selectedMembers > 0 && selectedMembers < group.featureIds.length;
    }),
    [parallelGroups, selectedRowIds],
  );

  const canCreateParallelGroup = canGroup && !selectionSplitsGroup;
  const selectionMatchesExistingGroup = useMemo(
    () => parallelGroups.some((group) =>
      group.featureIds.length === selectedRowIds.size &&
      group.featureIds.every((id) => selectedRowIds.has(id))),
    [parallelGroups, selectedRowIds],
  );
  const canConfirmParallelGroup = canCreateParallelGroup && !selectionMatchesExistingGroup;
  const parallelSelectionGuidance = selectionSplitsGroup
    ? 'Select the whole existing group, or cancel and ungroup it first.'
    : selectedRowIds.size === 0
      ? 'Select at least two adjacent included Features.'
      : selectedRowIds.size === 1
        ? 'Select one more adjacent included Feature.'
        : !canGroup
          ? 'Selected Features must be adjacent in forecast order.'
          : selectionMatchesExistingGroup
            ? 'These Features are already grouped for parallel work.'
          : `${selectedRowIds.size} adjacent Features ready to group.`;

  const enterParallelSelectionMode = useCallback(() => {
    setSelectedRowIds(new Set());
    setLastAnchorId(null);
    setGroupSplitError(null);
    setParallelSelectionMode(true);
  }, []);

  const exitParallelSelectionMode = useCallback(() => {
    setSelectedRowIds(new Set());
    setLastAnchorId(null);
    setGroupSplitError(null);
    restoreGroupModeTriggerFocusRef.current = true;
    setParallelSelectionMode(false);
  }, []);

  useEffect(() => {
    if (!parallelSelectionMode && restoreGroupModeTriggerFocusRef.current) {
      restoreGroupModeTriggerFocusRef.current = false;
      groupModeTriggerRef.current?.focus();
    }
  }, [parallelSelectionMode]);

  useEffect(() => {
    setParallelSelectionMode(false);
    setSelectedRowIds(new Set());
    setLastAnchorId(null);
    setGroupSplitError(null);
  }, [projectId]);

  const handleGroupSelected = useCallback(() => {
    if (!onSetForecastSequence || !plan || !canGroup) return;
    const blockIds = orderedSelectedFeatures
      .filter((f) => selectedRowIds.has(f.id))
      .map((f) => f.id);

    // A new group may not silently steal only part of an existing one. The
    // user must select the whole group, ungroup it, or use a valid boundary.
    if (parallelGroups.some((g) => {
      const selectedMembers = g.featureIds.filter((id) => selectedRowIds.has(id)).length;
      return selectedMembers > 0 && selectedMembers < g.featureIds.length;
    })) {
      setGroupSplitError('That selection splits a parallel group. Select the whole group, or ungroup first.');
      return;
    }
    const remaining = parallelGroups.filter((g) => !g.featureIds.some((id) => selectedRowIds.has(id)));

    const newGroup: ForecastParallelGroup = Object.freeze({ featureIds: Object.freeze(blockIds) });
    const nextGroups = [...remaining, newGroup].sort((a, b) => {
      const idxA = orderedSelectedFeatures.findIndex((f) => f.id === a.featureIds[0]);
      const idxB = orderedSelectedFeatures.findIndex((f) => f.id === b.featureIds[0]);
      return idxA - idxB;
    });

    // Check staffing concurrency conflict in staffed mode (Story 22.6 AC 22.6-1)
    if (plan.policyVersion === 'staffed-capacity-v1' && plan.assignments && plan.roster) {
      for (const group of nextGroups) {
        for (const person of plan.roster) {
          const conflicting = group.featureIds.filter((id) => {
            const hasPerson = plan.assignments[id]?.includes(person.id);
            if (!hasPerson) return false;
            const row = orderedSelectedFeatures.find((f) => f.id === id) ?? eligibleFeatures.find((f) => f.id === id);
            return row && row.effortPoints !== null && row.effortPoints > 0;
          });
          if (conflicting.length > 1) {
            const itemNames = conflicting.map((id) => titleForId(id)).join(' and ');
            const errorMsg = `Cannot group items in staffed mode: ${person.name} is assigned to multiple items (${itemNames}). A person cannot work in parallel across positive-point items.`;
            setGroupSplitError(errorMsg);
            announce(errorMsg);
            return;
          }
        }
      }
    }

    setPendingFocusId(blockIds[0]);
    onSetForecastSequence(plan.selectedFeatureIds, nextGroups);
    setSelectedRowIds(new Set());
    setLastAnchorId(null);
    setGroupSplitError(null);
    setParallelSelectionMode(false);
  }, [onSetForecastSequence, plan, canGroup, orderedSelectedFeatures, eligibleFeatures, selectedRowIds, parallelGroups, titleForId, announce]);

  const handleUngroup = useCallback(
    (group: ForecastParallelGroup) => {
      if (!onSetForecastSequence || !plan) return;
      const nextGroups = parallelGroups.filter((g) => g !== group);
      setPendingFocusId(group.featureIds[0] ?? null);
      onSetForecastSequence(plan.selectedFeatureIds, nextGroups);
      setGroupSplitError(null);
    },
    [onSetForecastSequence, plan, parallelGroups]
  );

  /**
   * Apply a pure placement result: persist the new order/groups, or surface
   * the group-split refusal with the standard explanatory banner and focus
   * restore — the order is never partially mutated (AC 21.1-2). A mouse-drag
   * reorder restores focus to the moved row (Story 21.11 AC 18) — the one
   * path that otherwise leaves focus on `<body>`.
   */
  const applyMoveResult = useCallback(
    (result: MoveBlockResult, focusId?: string) => {
      if (!onSetForecastSequence) return;
      if (!result.success) {
        setGroupSplitError(result.error);
        return;
      }
      setGroupSplitError(null);
      announce('Order updated');
      if (focusId) setPendingFocusId(focusId);
      onSetForecastSequence(result.ids, result.groups);
    },
    [onSetForecastSequence, announce],
  );

  // A Backlog item dropped at a specific position renders optimistically at
  // that slot (AC 21.3-4): once the membership command lands in scope, the
  // sequence command slides it to the target index — one slide, no end-then-
  // bottom flicker. Failed membership commands remove their provisional row;
  // only IDs present in the acknowledged plan are persisted as a sequence.
  useEffect(() => {
    if (pendingReorder.length === 0) return;
    const ids = plan?.selectedFeatureIds ?? [];
    const stillPending = pendingReorder.filter((pending) => !ids.includes(pending.id));
    const ready = pendingReorder.filter((pending) => ids.includes(pending.id));
    if (stillPending.length !== pendingReorder.length) {
      setPendingReorder(stillPending);
    }
    let nextIds = ids;
    let nextGroups = parallelGroups;
    for (const pending of ready) {
      const moved = moveBlockToIndexPure(nextIds, [pending.id], pending.index, nextGroups);
      if (!moved.success) {
        setGroupSplitError(moved.error);
        return;
      }
      nextIds = moved.ids;
      nextGroups = moved.groups;
    }
    // Reconcile all acknowledged drops against one evolving order. Dispatching
    // once per drop from the same old snapshot would overwrite earlier moves.
    if (ready.length > 0 && nextIds.some((id, index) => id !== ids[index])) {
      applyMoveResult({ success: true, ids: nextIds, groups: nextGroups }, ready[ready.length - 1].id);
    }
  }, [plan?.selectedFeatureIds, pendingReorder, parallelGroups, applyMoveResult]);

  const handleRowSelect = useCallback(
    (featureId: string, shiftKey: boolean) => {
      setSelectedRowIds((prev) => {
        const next = new Set(prev);
        if (shiftKey && lastAnchorId && lastAnchorId !== featureId) {
          const idxA = orderedSelectedFeatures.findIndex((f) => f.id === lastAnchorId);
          const idxB = orderedSelectedFeatures.findIndex((f) => f.id === featureId);
          if (idxA !== -1 && idxB !== -1) {
            const start = Math.min(idxA, idxB);
            const end = Math.max(idxA, idxB);
            for (let i = start; i <= end; i++) {
              next.add(orderedSelectedFeatures[i].id);
            }
            return next;
          }
        }
        if (next.has(featureId)) {
          next.delete(featureId);
        } else {
          next.add(featureId);
        }
        return next;
      });
      setLastAnchorId(featureId);
    },
    [lastAnchorId, orderedSelectedFeatures]
  );

  const toggleExpanded = useCallback((featureId: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(featureId)) {
        next.delete(featureId);
      } else {
        next.add(featureId);
      }
      return next;
    });
  }, []);

  // ── Keyboard grab-and-drop (Story 21.4, AC 21.4-1..12) ──────────────

  /** The block a grab acts on: a full bucket, a contiguous selection, or a row. */
  const grabBlockFor = useCallback(
    (featureId: string, bucketHeader: boolean): { ids: readonly string[]; isBucket: boolean } => {
      const groupInfo = groupInfoByFeatureId.get(featureId);
      if (groupInfo && bucketHeader) {
        return { ids: groupInfo.group.featureIds, isBucket: true };
      }
      // A contiguous Shift+↑/↓ selection (or parallel-selection checkboxes)
      // grabbing together — AC 21.4-4/10.
      if (canGroup && selectedRowIds.has(featureId)) {
        const indices = orderedSelectedFeatures
          .map((f, i) => (selectedRowIds.has(f.id) ? i : -1))
          .filter((i) => i !== -1);
        const isContiguous = indices.length > 0 && Math.max(...indices) - Math.min(...indices) + 1 === indices.length;
        if (isContiguous) {
          return {
            ids: orderedSelectedFeatures.filter((f) => selectedRowIds.has(f.id)).map((f) => f.id),
            isBucket: false,
          };
        }
      }
      return { ids: Object.freeze([featureId]), isBucket: false };
    },
    [canGroup, selectedRowIds, orderedSelectedFeatures, groupInfoByFeatureId],
  );

  const startGrab = useCallback(
    (featureId: string, bucketHeader: boolean) => {
      const block = grabBlockFor(featureId, bucketHeader);
      const ids = (plan?.selectedFeatureIds ?? []).slice();
      const row = orderedSelectedFeatures.find((r) => r.id === featureId);
      const groupInfo = groupInfoByFeatureId.get(featureId);
      const isBucket = block.isBucket && groupInfo !== undefined;
      const letter = isBucket ? bucketLetterForIndex(groupInfo.groupIndex) : undefined;
      const title = isBucket
        ? letter ?? 'A'
        : (row?.title ?? titleForId(featureId));
      const position = slotPositionOfBlock(ids, block.ids, parallelGroups);
      setGrabState({
        itemIds: block.ids,
        originIndex: position,
        currentIndex: position,
        isBucket,
        bucketLetter: letter,
        title,
        ids,
        groups: parallelGroups.slice(),
      });
      announce(
        isBucket
          ? formatBucketPositionAnnouncement(letter ?? 'A', block.ids.length, position, countPrioritySlots(ids, parallelGroups))
          : formatRowPositionAnnouncement(title, position, countPrioritySlots(ids, parallelGroups)),
      );
    },
    [grabBlockFor, plan, orderedSelectedFeatures, titleForId, groupInfoByFeatureId, parallelGroups, announce],
  );

  const moveGrabbed = useCallback(
    (direction: -1 | 1) => {
      if (!grabState) return;
      const target = computeGrabMoveTarget(grabState.ids, grabState.itemIds, grabState.groups, direction);
      if (target === null) {
        const position = slotPositionOfBlock(grabState.ids, grabState.itemIds, grabState.groups);
        const slots = countPrioritySlots(grabState.ids, grabState.groups);
        announce(grabState.isBucket
          ? formatBucketPositionAnnouncement(grabState.bucketLetter ?? 'A', grabState.itemIds.length, position, slots)
          : formatRowPositionAnnouncement(grabState.title, position, slots));
        return;
      }
      // A grabbed multi-row selection or whole bucket moves as one contiguous
      // block; a single row moves through the same free-placement math.
      const result = moveBlockToIndexPure(
        grabState.ids,
        grabState.itemIds,
        target,
        grabState.groups,
      );
      if (!result.success) return;
      const position = slotPositionOfBlock(
        result.ids,
        result.ids.filter((id) => grabState.itemIds.includes(id)),
        result.groups,
      );
      setGrabState((prev) =>
        prev
          ? {
              ...prev,
              ids: result.ids,
              groups: result.groups,
              currentIndex: position,
            }
          : prev,
      );
      announce(
        grabState.isBucket
          ? formatBucketPositionAnnouncement(grabState.bucketLetter ?? 'A', grabState.itemIds.length, position, countPrioritySlots(result.ids, result.groups))
          : formatRowPositionAnnouncement(grabState.title, position, countPrioritySlots(result.ids, result.groups)),
      );
    },
    [grabState, announce],
  );

  const dropGrab = useCallback(() => {
    if (!grabState || !onSetForecastSequence) return;
    onSetForecastSequence(grabState.ids, grabState.groups);
    setPendingFocusId(grabState.itemIds[0] ?? null);
    setGrabState(null);
    announce('Order updated');
  }, [grabState, onSetForecastSequence, announce]);

  const cancelGrab = useCallback(() => {
    if (!grabState) return;
    const label = grabState.isBucket ? grabState.bucketLetter ?? 'A' : grabState.title;
    setGrabState(null);
    announce(formatGrabCancelledAnnouncement(grabState.isBucket, label));
  }, [grabState, announce]);

  // Escape precedence (AC 21.4-8, Story 21.11 AC 27, Story 21.10 AC 3):
  // grabbed -> drawer -> level dialog -> parallel-selection mode -> nothing.
  // One listener, one action per press — never both.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (grabState) {
        event.preventDefault();
        cancelGrab();
        return;
      }
      if (backlogDrawerOpen) {
        event.preventDefault();
        closeBacklogDrawer();
        return;
      }
      if (railDrawerOpen) {
        event.preventDefault();
        closeRailDrawer();
        return;
      }
      if (levelDialogOpen) {
        event.preventDefault();
        setLevelDialogOpen(false);
        return;
      }
      if (parallelSelectionMode) {
        event.preventDefault();
        exitParallelSelectionMode();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [grabState, parallelSelectionMode, cancelGrab, exitParallelSelectionMode,
    backlogDrawerOpen, closeBacklogDrawer, railDrawerOpen, closeRailDrawer, levelDialogOpen]);

  // Blur the window while grabbed cancels the operation (AC 21.4-5).
  useEffect(() => {
    if (!grabState) return;
    const handleBlur = (): void => cancelGrab();
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [grabState, cancelGrab]);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, featureId: string) => {
      const target = e.target;
      const isInteractive = target instanceof HTMLElement && target !== e.currentTarget &&
        Boolean(target.closest('button, input, textarea, select, a, [contenteditable="true"]'));
      if (isInteractive) return;

      const grabbedHere = grabState && grabState.itemIds.includes(featureId);

      if (e.key === ' ') {
        e.preventDefault();
        // Space grabs (or drops) only when focus is on the row container
        // itself — inner controls activate normally (AC 21.4-9).
        if (grabbedHere) {
          dropGrab();
        } else {
          // A grab is in flight on another row: pressing Space there cancels
          // the first grab explicitly with the standard cancellation
          // announcement — never silently abandoned (Story 21.11 AC 20).
          if (grabState) cancelGrab();
          startGrab(featureId, e.currentTarget.classList.contains('pm-forecast__group-header'));
        }
        return;
      }
      if (e.key === 'Enter' && grabbedHere) {
        e.preventDefault();
        dropGrab();
        return;
      }
      if (e.key === 'ArrowUp' && grabbedHere) {
        e.preventDefault();
        moveGrabbed(-1);
        return;
      }
      if (e.key === 'ArrowDown' && grabbedHere) {
        e.preventDefault();
        moveGrabbed(1);
        return;
      }
      // Arrow navigation while grabbing skips the list rows (keys belong to
      // the grabbed block).
      if (grabState && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;

      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Shift+↑/↓ extends a contiguous row selection (AC 21.4-4/10): the
        // anchor is the row where the range started (or this row on first
        // use); focus follows to the next row.
        e.preventDefault();
        const idx = orderedSelectedFeatures.findIndex((r) => r.id === featureId);
        if (idx === -1) return;
        const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= orderedSelectedFeatures.length) return;
        const anchorId = lastAnchorId ?? featureId;
        const anchorIdx = orderedSelectedFeatures.findIndex((r) => r.id === anchorId);
        if (anchorIdx === -1) return;
        const from = Math.min(anchorIdx, nextIdx);
        const to = Math.max(anchorIdx, nextIdx);
        const range = orderedSelectedFeatures.slice(from, to + 1).map((r) => r.id);
        setSelectedRowIds(new Set(range));
        setLastAnchorId(anchorId);
        // A mounted target focuses synchronously (rapid key-repeat must
        // advance one row per press); otherwise route through the
        // pending-focus path, which scrolls it in first (Story 23.11-2).
        const nextRow = rowRefs.current.get(orderedSelectedFeatures[nextIdx].id);
        if (nextRow) nextRow.focus();
        else setPendingFocusId(orderedSelectedFeatures[nextIdx].id);
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Plain ↑/↓ move focus between Priority rows (roving focus). The
        // origin is the logical position: a key-repeat burst that crosses the
        // window boundary must advance from the row being scrolled to, not
        // from the stale DOM-focused row (Story 23.11 AC 23.11-2).
        e.preventDefault();
        const originId = arrowFocusOriginRef.current ?? featureId;
        const idx = orderedSelectedFeatures.findIndex((r) => r.id === originId);
        if (idx === -1) return;
        const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= orderedSelectedFeatures.length) return;
        const nextId = orderedSelectedFeatures[nextIdx].id;
        const nextRow = rowRefs.current.get(nextId);
        if (nextRow) {
          nextRow.focus();
          arrowFocusOriginRef.current = nextId;
        } else {
          arrowFocusOriginRef.current = nextId;
          setPendingFocusId(nextId);
        }
        return;
      }

      if (e.key === 'g' || e.key === 'G') {
        // Focused on a bucket header: G ungroups the whole bucket (AC 21.4-7).
        const headerInfo = groupInfoByFeatureId.get(featureId);
        if (headerInfo && headerInfo.isFirst) {
          e.preventDefault();
          handleUngroup(headerInfo.group);
          return;
        }
        if (canConfirmParallelGroup) {
          // A contiguous Shift+arrow selection groups directly; entering selection
          // mode first would clear it (AC 21.4-7).
          e.preventDefault();
          handleGroupSelected();
        } else if (!parallelSelectionMode && onSetForecastSequence && orderedSelectedFeatures.length >= 2) {
          e.preventDefault();
          enterParallelSelectionMode();
        }
        return;
      }
      if (e.key === 'u' || e.key === 'U') {
        const info = groupInfoByFeatureId.get(featureId);
        if (info) {
          e.preventDefault();
          handleUngroup(info.group);
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Return the focused row to the Backlog (AC 21.2-6, FR-8, UX-DR9).
        // A grab in flight is cancelled first so a later drop cannot
        // re-commit a pre-removal snapshot and resurrect the removed row
        // (Story 21.11 AC 19).
        e.preventDefault();
        if (grabState) cancelGrab();
        const hadAssignments = (plan?.assignments?.[featureId]?.length ?? 0) > 0;
        onToggleMembership(featureId, false);
        announce(`Removed ${titleForId(featureId)} from Priority list${hadAssignments ? ' and cleared assignments' : ''}`);
      }
    },
    [grabState, startGrab, dropGrab, moveGrabbed, cancelGrab,
      parallelSelectionMode, exitParallelSelectionMode, onSetForecastSequence,
      orderedSelectedFeatures.length, enterParallelSelectionMode, canConfirmParallelGroup,
      handleGroupSelected, groupInfoByFeatureId, handleUngroup, onToggleMembership,
      announce, titleForId, plan?.assignments]
  );

  const renderRow = (f: ForecastPlanningRow, isGroupMember: boolean = false) => {
    const isSelected = selectedRowIds.has(f.id);
    const isExpanded = expandedRowIds.has(f.id);
    const timeline = timelineByFeatureId.get(f.id);
    const selectedIndex = orderedSelectedFeatures.findIndex((row) => row.id === f.id);
    const isGrabbed = Boolean(grabState && grabState.itemIds.includes(f.id));
    // Story 26.2 AC 26.2-2: one exact bar per included row. The bar is a pure
    // projection of the acknowledged result, so it never disagrees with the
    // Details numbers or the rail.
    const bar: ItemBar | null =
      axis && f.included
        ? itemBar(timeline, {
            axis,
            rank: selectedIndex + 1,
            previousRank: selectedIndex > 0 ? selectedIndex : null,
            title: f.title,
            isStaffed,
            pointsPerSprint: arithmetic?.pointsPerSprint ?? 0,
            pointsDone: f.effortPointsDone ?? null,
            deliveryStatus: f.deliveryStatus,
          })
        : null;

    return (
      <div key={f.id} className="pm-forecast__row-wrapper">
        <div
          ref={(el) => {
            if (el) rowRefs.current.set(f.id, el);
            else rowRefs.current.delete(f.id);
          }}
          tabIndex={0}
          className={`pm-forecast__row${f.invalid ? ' pm-forecast__row--invalid' : ''}${
            isSelected ? ' pm-forecast__row--selected' : ''
          }${isGroupMember ? ' pm-forecast__row--member' : ''}${
            isGrabbed ? ' pm-forecast__row--grabbed' : ''
          }`}
          draggable={f.included && !isGrabbed}
          onDragStart={(event) => {
            setDraggedRowId(f.id);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', f.id);
          }}
          onDragEnd={() => { setDraggedRowId(null); setDropIndex(null); }}
          onKeyDown={(e) => handleRowKeyDown(e, f.id)}
          onFocus={() => {
            // Focus that did not arrive from arrow navigation resets the
            // logical navigation origin, so a later ↑/↓ starts from the row
            // the user actually focused (Story 23.11 AC 23.11-2). Arrow
            // navigation focuses its own target, so the origin still matches
            // here and is kept.
            if (arrowFocusOriginRef.current !== null && arrowFocusOriginRef.current !== f.id) {
              arrowFocusOriginRef.current = null;
            }
          }}
          onBlur={(event) => {
            if (isGrabbed && !event.currentTarget.contains(event.relatedTarget)) cancelGrab();
          }}
        >
          {/* Priority / Rank & Inclusion column */}
          <div className="pm-forecast__row-priority">
            <span
              className={`pm-forecast__row-rank${f.included ? '' : ' pm-forecast__row-rank--unselected'}`}
              title={f.included ? `Priority rank ${selectedIndex + 1}` : 'Not in forecast'}
            >
              {f.included && selectedIndex !== -1 ? String(selectedIndex + 1).padStart(2, '0') : '—'}
            </span>
            <div className="pm-forecast__row-inclusion">
              {parallelSelectionMode && f.included ? (
                <input
                  type="checkbox"
                  className="pm-forecast__row-select-check"
                  aria-label={`Select ${f.title || 'Untitled'} for parallel group`}
                  title={`Select ${f.title || 'Untitled'} for parallel group`}
                  checked={isSelected}
                  onChange={(e) => handleRowSelect(f.id, (e.nativeEvent as MouseEvent).shiftKey)}
                />
              ) : parallelSelectionMode ? (
                <span className="pm-forecast__row-select-placeholder" aria-hidden="true" />
              ) : f.included ? (
                <button
                  type="button"
                  className="pm-forecast__row-remove"
                  aria-label={`Remove ${f.title || 'Untitled'} from the priority list`}
                  title={`Remove ${f.title || 'Untitled'} from the priority list`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const hadAssignments = (plan?.assignments?.[f.id]?.length ?? 0) > 0;
                    onToggleMembership(f.id, false);
                    announce(`Removed ${f.title || 'Untitled'} from Priority list${hadAssignments ? ' and cleared assignments' : ''}`);
                  }}
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>

          {/* Feature title & Actions column */}
          <div className="pm-forecast__row-feature-col">
            <span className="pm-forecast__row-title">
              {f.title || 'Untitled'}
              {f.invalid && (
                <span className="pm-forecast__row-flag"> · invalid reference — exclude to resolve</span>
              )}
              {!f.invalid && f.overlap && (
                <span className="pm-forecast__row-flag"> · overlaps a selected Feature</span>
              )}
              {f.included && blockedSet.has(f.id) && (
                <span className="pm-forecast__row-flag pm-forecast__row-flag--blocked"> · blocked (no delay assumed)</span>
              )}
              {isStaffed && f.included && timeline?.isBottleneck && (
                <span className="pm-forecast__row-bottleneck-tag" title="Determines block completion (bottleneck)">
                  Bottleneck
                </span>
              )}
            </span>
            {f.included && (
              <div className="pm-forecast__row-actions">
                <button
                  type="button"
                  className="pm-forecast__row-expand"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Hide' : 'Show'} timeline details for ${f.title || 'Untitled'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(f.id);
                  }}
                >
                  {isExpanded ? '▾ Details' : '▸ Details'}
                </button>
                {onSetBlocker && !f.invalid && (
                  <button
                    type="button"
                    className={`pm-forecast__row-btn${blockedSet.has(f.id) ? ' pm-forecast__row-btn--blocked' : ''}`}
                    aria-pressed={blockedSet.has(f.id)}
                    aria-label={
                      blockedSet.has(f.id)
                        ? `Clear blocker on ${f.title || 'Untitled'}`
                        : `Mark ${f.title || 'Untitled'} as blocked`
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onSetBlocker(f.id, !blockedSet.has(f.id));
                    }}
                  >
                    {blockedSet.has(f.id) ? 'Clear blocker' : 'Mark blocked'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Assigned people & Pace column */}
          <div className="pm-forecast__row-assignment-cell">
            {f.included && onSetAssignments && (() => {
              const assignedIds = plan?.assignments?.[f.id] ?? [];
              const assignedPeople = assignedIds
                .map((id) => plan?.roster?.find((p) => p.id === id))
                .filter((p): p is NonNullable<typeof p> => Boolean(p));

              if (f.effortPoints === 0) {
                return (
                  <div className="pm-forecast__assignment-stack">
                    <span className="pm-forecast__row-milestone-tag">Milestone</span>
                  </div>
                );
              }

              let triggerNode: React.ReactNode;
              if (assignedPeople.length > 0) {
                const names = assignedPeople.map((p) => p.name).join(', ');
                triggerNode = (
                  <button
                    ref={(el) => {
                      if (el) itemTriggerRefs.current.set(f.id, el);
                      else itemTriggerRefs.current.delete(f.id);
                    }}
                    type="button"
                    className="pm-forecast__row-assign pm-forecast__row-assign--assigned"
                    aria-label={`Assigned to ${f.title || 'Untitled'}: ${names}. Click to edit.`}
                    title={`Assigned: ${names}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setItemPeopleEditorState({ featureId: f.id, featureTitle: f.title });
                    }}
                  >
                    {names}
                  </button>
                );
              } else if (isStaffed) {
                triggerNode = (
                  <button
                    ref={(el) => {
                      if (el) itemTriggerRefs.current.set(f.id, el);
                      else itemTriggerRefs.current.delete(f.id);
                    }}
                    type="button"
                    className="pm-forecast__row-assign pm-forecast__row-assign--missing"
                    aria-label={`Assign people to ${f.title || 'Untitled'} (required)`}
                    title="Needs assignment"
                    onClick={(e) => {
                      e.stopPropagation();
                      setItemPeopleEditorState({ featureId: f.id, featureTitle: f.title });
                    }}
                  >
                    Needs assignment
                  </button>
                );
              } else {
                triggerNode = (
                  <button
                    ref={(el) => {
                      if (el) itemTriggerRefs.current.set(f.id, el);
                      else itemTriggerRefs.current.delete(f.id);
                    }}
                    type="button"
                    className="pm-forecast__row-assign pm-forecast__row-assign--unassigned"
                    aria-label={`Assign people to ${f.title || 'Untitled'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setItemPeopleEditorState({ featureId: f.id, featureTitle: f.title });
                    }}
                  >
                    Whole team
                  </button>
                );
              }

              return (
                <div className="pm-forecast__assignment-stack">
                  {triggerNode}
                  {bar?.paceLabel && (
                    <span className="pm-forecast__row-pace">{bar.paceLabel}</span>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Points & Points Done column */}
          <div className="pm-forecast__row-points-col">
            {f.invalid ? (
              <span className="pm-forecast__row-points-input" aria-hidden="true">
                —
              </span>
            ) : (
              <input
                type="number"
                className="pm-forecast__row-points-input"
                aria-label={`Points for ${f.title || 'Untitled'}`}
                min={0}
                step={1}
                value={effortDrafts.has(f.id) ? effortDrafts.get(f.id)! : (f.effortPoints ?? '')}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value;
                  const nextPoints = v.trim() === '' ? null : Number(v);
                  setEffortDrafts((current) => {
                    const next = new Map(current);
                    next.set(f.id, v);
                    return next;
                  });
                  const hadAssignments = (plan?.assignments?.[f.id]?.length ?? 0) > 0;
                  onSetEffort(f.id, nextPoints);
                  if (hadAssignments && (nextPoints === 0 || nextPoints === null)) {
                    announce(`Points set to 0 for ${f.title || 'Untitled'} and cleared assignments`);
                  }
                }}
                onBlur={() => clearEffortDraft(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    if (e.key === 'Escape') e.preventDefault();
                    clearEffortDraft(f.id);
                  }
                }}
              />
            )}
            {!f.invalid && onSetPointsDone && f.deliveryStatus !== 'delivered' && (f.effortPoints ?? 0) > 0 && (
              f.deliveryStatus === 'not_started' ? (
                <span
                  className="pm-forecast__row-done-hint"
                  title="Points done recorded; item not started"
                >
                  {f.effortPointsDone !== null && f.effortPointsDone !== undefined
                    ? `${f.effortPointsDone} done recorded (not started)`
                    : ''}
                </span>
              ) : (
                <label className="pm-forecast__row-done">
                  <span className="pm-forecast__row-done-label">Done</span>
                  <input
                    type="number"
                    className="pm-forecast__row-done-input"
                    aria-label={`Points done for ${f.title || 'Untitled'}`}
                    min={0}
                    max={f.effortPoints ?? undefined}
                    step={1}
                    value={f.effortPointsDone ?? ''}
                    placeholder="—"
                    onChange={(e) => {
                      const v = e.target.value;
                      const parsed = v.trim() === '' ? null : Number(v);
                      if (parsed !== null && (!Number.isSafeInteger(parsed) || parsed < 0)) return;
                      onSetPointsDone(f.id, parsed);
                    }}
                  />
                </label>
              )
            )}
          </div>

          {/* Column 5: Timeline Track */}
          <div className="pm-forecast__row-timeline">
            {bar && (
              bar.withheldReason ? (
                <span className="pm-forecast__row-timeline-note">{bar.withheldReason}</span>
              ) : (
                <div
                  className={`pm-forecast__row-timeline-track${
                    bar.isMilestone ? ' pm-forecast__row-timeline-track--milestone' : ''
                  }`}
                  role="img"
                  aria-label={bar.label}
                  style={axis ? ({ '--pm-axis-sprints': axis.spanSprints } as React.CSSProperties) : undefined}
                >
                  {bar.waits && (
                    <>
                      <span
                        className="pm-forecast__row-timeline-connector"
                        style={{ width: `${bar.left * 100}%` }}
                        aria-hidden="true"
                      />
                      {selectedIndex > 0 && (
                        <span
                          className="pm-forecast__row-timeline-waits-label"
                          aria-hidden="true"
                        >
                          waits for {String(selectedIndex).padStart(2, '0')}
                        </span>
                      )}
                    </>
                  )}
                  {bar.isMilestone ? (
                    <span
                      className="pm-forecast__row-timeline-marker"
                      style={{ left: `${bar.left * 100}%` }}
                    />
                  ) : (
                    <div
                      className="pm-forecast__row-timeline-bar"
                      style={{
                        left: `${bar.left * 100}%`,
                        width: `${bar.width * 100}%`,
                        backgroundColor: isGroupMember ? 'var(--pm-flag-effort)' : 'var(--pm-accent-strong)',
                      }}
                    >
                      <span className="pm-forecast__row-timeline-duration">
                        {`${(bar.width * axis!.spanSprints).toFixed(1)} sprint`}
                      </span>
                    </div>
                  )}
                  <span
                    className="pm-forecast__row-timeline-workdone"
                    style={{ left: `${bar.finishFraction * 100}%` }}
                    aria-hidden="true"
                    title={`Work done ≈ ${readableForecastDate(timeline?.completionDate ?? '')}`}
                  />
                  {bar.doneFraction !== null && (
                    <span
                      className="pm-forecast__row-timeline-done"
                      style={{
                        left: `${bar.left * 100}%`,
                        width: `${Math.max((bar.doneFraction - bar.left) * 100, 0)}%`,
                      }}
                      aria-hidden="true"
                      title="Done so far"
                    />
                  )}
                </div>
              )
            )}
          </div>
        </div>

        {isExpanded && (
          <div
            className="pm-forecast__timeline-details"
            role="region"
            aria-label={`Timeline details for ${f.title || 'Untitled'}`}
          >
            {timeline && timeline.startSprintOrdinal !== null ? (
              <div className="pm-forecast__timeline-grid">
                <div className="pm-forecast__timeline-item">
                  <span className="pm-forecast__timeline-label">Sprint window</span>
                  <span className="pm-forecast__timeline-value">
                    {timeline.startSprintOrdinal === timeline.completionSprintOrdinal
                      ? `Sprint ${timeline.startSprintOrdinal}`
                      : `Sprints ${timeline.startSprintOrdinal}–${timeline.completionSprintOrdinal}`}
                  </span>
                </div>
                <div className="pm-forecast__timeline-item">
                  <span className="pm-forecast__timeline-label">Exact offset</span>
                  <span className="pm-forecast__timeline-value">
                    {timeline.startOffset && timeline.finishOffset
                      ? `${formatRatio(timeline.startOffset)} → ${formatRatio(timeline.finishOffset)} sprints`
                      : '—'}
                  </span>
                </div>
                <div className="pm-forecast__timeline-item">
                  <span className="pm-forecast__timeline-label">Capacity events</span>
                  <span className="pm-forecast__timeline-value">
                    {timeline.isMilestone
                      ? 'Milestone (0 points · instant)'
                      : capacityEventsForTimeline(timeline).map((event, index, events) => {
                          const previous = events[index - 1];
                          const redistributed = previous && formatRatio(previous.shareRate) !== formatRatio(event.shareRate);
                          return (
                            <span className="pm-forecast__capacity-event" key={event.eventIndex}>
                              {formatRatio(event.startOffset)}→{formatRatio(event.finishOffset)}: {formatRatio(event.shareRate)} pts/sprint
                              {redistributed ? ' (capacity redistributed)' : ''}
                            </span>
                          );
                        })}
                  </span>
                </div>
                {isStaffed && (
                  <>
                    {timeline.isBottleneck && (
                      <div className="pm-forecast__timeline-item">
                        <span className="pm-forecast__timeline-label">Bottleneck</span>
                        <span className="pm-forecast__timeline-value">
                          Determines block completion (bottleneck)
                        </span>
                      </div>
                    )}
                    {(() => {
                      const groupIndex =
                        timeline.parallelGroupIndex ??
                        parallelGroups.findIndex((g) => g.featureIds.includes(f.id));
                      if (groupIndex !== -1 && groupIndex !== null && groupIndex !== undefined) {
                        const group = parallelGroups[groupIndex];
                        if (group && timeline.finishOffset) {
                          const groupTimelines = group.featureIds
                            .map((id) => timelineByFeatureId.get(id))
                            .filter((t): t is FeatureTimeline => Boolean(t?.finishOffset));
                          const maxFinish = Math.max(
                            ...groupTimelines.map(
                              (t) => t.finishOffset!.numerator / t.finishOffset!.denominator
                            )
                          );
                          const thisFinish =
                            timeline.finishOffset.numerator / timeline.finishOffset.denominator;
                          const idleDuration = maxFinish - thisFinish;
                          if (idleDuration > 0.001) {
                            const assignedIds =
                              plan?.assignments?.[f.id] ?? timeline.assignedPersonIds ?? [];
                            const personNames =
                              assignedIds
                                .map((pid) => plan?.roster?.find((p) => p.id === pid)?.name ?? pid)
                                .join(', ') || 'Assigned person';
                            const sprintWord =
                              idleDuration === 1
                                ? 'one-sprint'
                                : idleDuration === 2
                                ? 'two-sprint'
                                : idleDuration === 3
                                ? 'three-sprint'
                                : `${idleDuration}-sprint`;
                            return (
                              <div className="pm-forecast__timeline-item">
                                <span className="pm-forecast__timeline-label">Idle period</span>
                                <span className="pm-forecast__timeline-value">
                                  {personNames}: {sprintWord} idle period (idle until bucket completes)
                                </span>
                              </div>
                            );
                          }
                        }
                      }
                      return null;
                    })()}
                  </>
                )}
              </div>
            ) : (
              <p className="pm-forecast__timeline-note">
                Timeline details withheld until required estimates and configuration are provided.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`pm-forecast${isResizingBacklog ? ' pm-forecast--resizing' : ''}`} ref={rootRef}>
      <div
        aria-live="polite"
        role="status"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {announcement}
      </div>

      {/* Transient action narration — separate polite region so a grab/add/
          reorder announcement is never overwritten by the settled summary
          (Story 21.11 AC 17). */}
      <div
        aria-live="polite"
        role="status"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        <span key={transientSeqRef.current}>{transientAnnouncement.slice(transientAnnouncement.indexOf(':') + 1)}</span>
      </div>

      {backlogDrawerOpen && (
        <button
          type="button"
          className="pm-forecast__backdrop"
          aria-label="Close the Add work drawer"
          onClick={closeBacklogDrawer}
        />
      )}

      {plan && backlogItems && (
        <BacklogPane
          key={projectId}
          levelLabel={planningLevel === 'Feature' || !planningLevel ? 'Features' : `${planningLevel}s`}
          items={backlogItems}
          width={activeBacklogWidth}
          onAdd={(id) => onToggleMembership(id, true)}
          onSetPoints={onSetEffort}
          onAnnounce={announce}
          onCloseDrawer={closeBacklogDrawer}
          drawerOpen={backlogDrawerOpen}
          closeButtonRef={backlogCloseRef}
          onDragPlannedStart={setDraggedRowId}
        />
      )}

      {plan && backlogItems && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize backlog panel"
          aria-valuemin={FORECAST_BACKLOG_MIN_WIDTH}
          aria-valuemax={FORECAST_BACKLOG_MAX_WIDTH}
          aria-valuenow={Math.round(activeBacklogWidth)}
          tabIndex={0}
          title="Drag to resize backlog panel (double-click to reset)"
          className={`pm-forecast__resizer${isResizingBacklog ? ' pm-forecast__resizer--resizing' : ''}`}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          onDoubleClick={() => commitBacklogWidth(FORECAST_BACKLOG_DEFAULT_WIDTH)}
          onKeyDown={handleResizeKeyDown}
        />
      )}

      <div className="pm-forecast__list" role="region" aria-label="Forecast planning list" ref={listScrollRef}>
        {!plan ? (
          levelOptions && onChoosePlanningLevel ? (
            <PlanningLevelStep options={levelOptions} onChoose={(lvl) => { onChoosePlanningLevel(lvl); openConfig(); }} />
          ) : (
            <div className="pm-forecast__empty">
              <p className="pm-forecast__empty-title">No forecast configured</p>
              <p className="pm-forecast__empty-copy">
                Configure one team's sprint capacity and start anchor, then select and estimate
                existing Features to obtain a persisted, deterministic completion forecast.
              </p>
              <button type="button" className="pm-forecast__button pm-forecast__button--primary" onClick={openConfig}>
                Configure plan
              </button>
            </div>
          )
        ) : (
          <div
            className="pm-forecast__rows"
            onDragOver={(e) => {
              // Accept a reordered row or a Backlog add; show the drop line
              // at the nearest gap (free placement, not adjacent-swap).
              const types = e.dataTransfer.types;
              if (!types.includes('text/plain') && !types.includes('application/x-forecast-backlog')) return;
              e.preventDefault();
              // Item-space index from the rendered rows' vertical midpoints
              // (per item, never per rendered element — buckets are one
              // wrapper each). Only the scrolled window is mounted (Story
              // 23.11), so each rect carries its own item index; a pinned row
              // far from the window therefore cannot shift the index by the
              // gap it skips. Rows without a registered ref are excluded —
              // a `{top: 0, height: 0}` rect always compares as "above" and
              // shifts every subsequent index (Story 21.11 AC 13).
              const ids = (plan?.selectedFeatureIds ?? []).slice();
              const rects: IndexedRowRect[] = [];
              orderedSelectedFeatures.forEach((f, itemIndex) => {
                const el = rowRefs.current.get(f.id);
                if (!el) return;
                const r = el.getBoundingClientRect();
                rects.push({ top: r.top, height: r.height, itemIndex });
              });
              const rawIndex = calculateDropIndexFromIndexedMidpoints(e.clientY, rects);
              // A member dragged within its own bucket may land between
              // members (tie-display reorder, AC 21.3-6); the exterior-
              // boundary snap (UX-DR5, AC 21.3-2) applies only to outside
              // rows and Backlog items.
              const draggedInfo = draggedRowId ? groupInfoByFeatureId.get(draggedRowId) : undefined;
              const memberLandingOutsideItsBucket = draggedInfo
                ? (() => {
                    const positions = draggedInfo.group.featureIds
                      .map((id) => ids.indexOf(id))
                      .filter((i) => i !== -1);
                    const first = Math.min(...positions);
                    const last = Math.max(...positions);
                    return rawIndex <= first || rawIndex > last;
                  })()
                : true;
              const dropIndexFinal = memberLandingOutsideItsBucket
                ? clampDropIndexForBuckets(rawIndex, parallelGroups, ids)
                : rawIndex;
              setDropIndex(dropIndexFinal);
            }}
            onDragLeave={() => {
              // Unconditional reset (AC 21.3-3, Story 21.11 AC 12): a
              // dragleave bubbling from a child row or a cancelled Backlog
              // drag must clear the drop line — no currentTarget guard.
              setDropIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const at = dropIndex ?? orderedSelectedFeatures.length;
              setDropIndex(null);
              const backlogId = e.dataTransfer.getData('application/x-forecast-backlog');
              if (backlogId) {
                // Add from the Backlog and render optimistically at the drop
                // slot; the pending-reorder effect slides it once in scope
                // (AC 21.3-4 — no flash to the list end). Record placement
                // before dispatch; remove it if membership fails.
                setPendingReorder((prev) => [...prev.filter((pending) => pending.id !== backlogId), { id: backlogId, index: at }]);
                const outcome = onToggleMembership(backlogId, true);
                const applied = (value: boolean): void => {
                  if (!value) {
                    setPendingReorder((prev) => prev.filter((pending) => pending.id !== backlogId));
                    announce(`Could not add ${titleForId(backlogId)} to the Priority list`);
                  }
                };
                if (outcome) {
                  void outcome.then(applied).catch(() => {
                    applied(false);
                  });
                } else {
                  applied(true);
                }
                return;
              }
              const rowId = draggedRowId ?? e.dataTransfer.getData('text/plain');
              setDraggedRowId(null);
              if (!rowId) return;
              // A bucket-header drag moves the whole contiguous block.
              const bucketGroup = draggedBucketGroupRef.current;
              draggedBucketGroupRef.current = null;
              if (bucketGroup) {
                applyMoveResult(
                  moveBlockToIndexPure(
                    (plan?.selectedFeatureIds ?? []).slice(),
                    bucketGroup.featureIds,
                    at,
                    parallelGroups,
                  ),
                  bucketGroup.featureIds[0],
                );
                return;
              }
              const groupInfo = groupInfoByFeatureId.get(rowId);
              if (groupInfo) {
                const result = moveGroupMember(
                  (plan?.selectedFeatureIds ?? []).slice(),
                  rowId,
                  at,
                  parallelGroups,
                );
                applyMoveResult(result, rowId);
              } else {
                applyMoveResult(moveBlockToIndexPure((plan?.selectedFeatureIds ?? []).slice(), [rowId], at, parallelGroups), rowId);
              }
            }}
          >
            <div className="pm-forecast__header-meta">
              {planningLevel && (
                <div className="pm-forecast__level-chip">
                  <span>▚ Level: <b>{planningLevel === 'Feature' ? 'Features' : `${planningLevel}s`}</b></span>
                  {onSetPlanningLevel && (
                    <button
                      ref={levelCancelRef}
                      type="button"
                      className="pm-forecast__level-chip-change"
                      onClick={openLevelDialog}
                    >
                      Change
                    </button>
                  )}
                </div>
              )}
              {onSetPolicy && (
                <div className="pm-forecast__mode-chip" role="group" aria-label="Forecast calculation mode">
                  <span className="pm-forecast__mode-label">Mode:</span>
                  <select
                    className="pm-forecast__mode-select"
                    aria-label="Forecast calculation mode"
                    value={plan?.policyVersion ?? 'shared-capacity-v1'}
                    onChange={async (e) => {
                      const newPolicy = e.target.value as ForecastPolicyVersion;
                      setModeError(null);
                      const ok = await onSetPolicy(newPolicy);
                      if (ok === false) {
                        setModeError(
                          'Could not switch to assigned people. Resolve parallel bucket conflicts before activating staffed forecast.',
                        );
                      }
                    }}
                  >
                <option value="shared-capacity-v1">Whole team</option>
                <option value="staffed-capacity-v1">Assigned people</option>
                  </select>
                </div>
              )}
            </div>

            {modeError && (
              <div className="pm-forecast__rejection-banner" role="alert">
                <span className="pm-forecast__rejection-text">{modeError}</span>
                <button
                  type="button"
                  className="pm-forecast__rejection-dismiss"
                  onClick={() => setModeError(null)}
                  aria-label="Dismiss error"
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="pm-forecast__drawer-toggles">
              <button
                ref={backlogToggleRef}
                type="button"
                className="pm-forecast__drawer-toggle pm-forecast__drawer-toggle--add-work"
                aria-expanded={backlogDrawerOpen}
                onClick={() => setBacklogDrawerOpen((v) => !v)}
              >
                ＋ Add work
              </button>
              <button
                ref={railToggleRef}
                type="button"
                className="pm-forecast__drawer-toggle pm-forecast__drawer-toggle--rail"
                aria-expanded={railDrawerOpen}
                onClick={toggleRailDrawer}
              >
                Completion summary
              </button>
            </div>
            {eligibleFeatures.length === 0 && (
              <p className="pm-forecast__empty-copy">No eligible Features in this project yet.</p>
            )}

            {eligibleFeatures.length > 0 && (
              <div className="pm-forecast__table-header">
                <span className="pm-forecast__th pm-forecast__th--rank" aria-hidden="true">Rank</span>
                <span className="pm-forecast__th pm-forecast__th--title" aria-hidden="true">Feature</span>
                <span className="pm-forecast__th pm-forecast__th--assign" aria-hidden="true">Assigned</span>
                <span className="pm-forecast__th pm-forecast__th--points" aria-hidden="true">Pts</span>
                <div className="pm-forecast__axis" role="group" aria-label="Sprint timeline axis">
                  <div className="pm-forecast__axis-track">
                    {axis && axis.columns.length > 0 ? (
                      axis.columns.map((column) => (
                        <span key={column.sprint} className="pm-forecast__axis-column">
                          {column.label}
                        </span>
                      ))
                    ) : (
                      <span className="pm-forecast__axis-column">Timeline</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Inline group-split rejection feedback */}
            {groupSplitError && (
              <div className="pm-forecast__rejection-banner" role="alert">
                <span className="pm-forecast__rejection-text">{groupSplitError}</span>
                <button
                  type="button"
                  className="pm-forecast__rejection-dismiss"
                  onClick={() => setGroupSplitError(null)}
                  aria-label="Dismiss error"
                >
                  Dismiss
                </button>
              </div>
            )}

            {onSetForecastSequence && (
              parallelSelectionMode ? (
                <section className="pm-forecast__selection-mode" aria-label="Create parallel group">
                  <div className="pm-forecast__selection-mode-copy">
                    <strong className="pm-forecast__selection-mode-title">Select Features for parallel work</strong>
                    <span aria-live="polite">{parallelSelectionGuidance}</span>
                  </div>
                  <div className="pm-forecast__selection-mode-actions">
                    <span className="pm-forecast__selection-count">{selectedRowIds.size} selected</span>
                    <button
                      type="button"
                      className="pm-forecast__button pm-forecast__button--primary pm-forecast__button--small"
                      disabled={!canConfirmParallelGroup}
                      onClick={handleGroupSelected}
                    >
                      Create parallel group
                    </button>
                    <button
                      type="button"
                      className="pm-forecast__button pm-forecast__button--small"
                      onClick={exitParallelSelectionMode}
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              ) : orderedSelectedFeatures.length >= 2 ? (
                <div className="pm-forecast__selection-entry">
                  <button
                    ref={groupModeTriggerRef}
                    type="button"
                    className="pm-forecast__button pm-forecast__button--small"
                    onClick={enterParallelSelectionMode}
                  >
                    Group parallel work…
                  </button>
                  <span className="pm-forecast__selection-hint">
                    Combine adjacent included Features that share team capacity.
                  </span>
                </div>
              ) : null
            )}

            {/* Selected features in sequence with parallel groups. The list is
                virtualized (Story 23.11 AC 23.11-2): only the scrolled window
                plus pinned slots (focus, drafts, grabs, dragged and expanded
                rows) is mounted, however many items the scope holds. */}
            <div ref={rowsInnerRef} className="pm-forecast__rows-inner" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const slot = renderSlots[virtualItem.index];
                if (!slot) return null;
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="pm-forecast__slot"
                    style={{ transform: `translateY(${virtualItem.start - rowsScrollMargin}px)` }}
                  >
                    {slot.kind === 'dropline' ? (
                      <div className="pm-forecast__dropline" aria-hidden="true" />
                    ) : slot.kind === 'row' ? (
                      renderRow(slot.row, false)
                    ) : (
                      (() => {
                        const groupMembers = slot.members;
                        return (
                          <div
                            className="pm-forecast__group"
                            role="group"
                            aria-label={`Bucket ${bucketLetterForIndex(slot.groupIndex)}: parallel group, ${slot.group.featureIds.length} items, ${isStaffed ? 'fixed assignments' : 'equal capacity share'}`}
                          >
                            <div
                              className="pm-forecast__group-header"
                              draggable
                              tabIndex={0}
                              title="Drag to move the whole bucket"
                              onKeyDown={(e) => handleRowKeyDown(e, slot.group.featureIds[0])}
                              onBlur={(event) => {
                                if (grabState?.isBucket && grabState.itemIds.includes(slot.group.featureIds[0]) &&
                                    !event.currentTarget.contains(event.relatedTarget)) cancelGrab();
                              }}
                              onDragStart={(e) => {
                                // `groupIndex` is the group's array position —
                                // the deterministic letter source (UX-DR6). The
                                // drag payload is the group's first member id so
                                // the drop handler can resolve the whole block.
                                e.dataTransfer.setData('text/plain', slot.group.featureIds[0]);
                                e.dataTransfer.effectAllowed = 'move';
                                setDraggedRowId(slot.group.featureIds[0]);
                                draggedBucketGroupRef.current = slot.group;
                              }}
                              onDragEnd={() => { setDraggedRowId(null); setDropIndex(null); draggedBucketGroupRef.current = null; }}
                            >
                              <div className="pm-forecast__group-info">
                                <span className="pm-forecast__group-badge">
                                  ⣿ BUCKET {bucketLetterForIndex(slot.groupIndex)} ·{' '}
                                  {slot.group.featureIds.length} ITEMS · {isStaffed ? 'FIXED ASSIGNMENTS' : 'EQUAL CAPACITY SHARE'}
                                </span>
                                <span className="pm-forecast__group-explanation">
                                  {isStaffed ? (
                                    <>
                                      Fixed assignments — individual capacity applies. Longest duration determines bucket finish; idle people do not assist other items.
                                      {(() => {
                                        const bucketTimelines = slot.group.featureIds
                                          .map((id) => timelineByFeatureId.get(id))
                                          .filter((t): t is FeatureTimeline => Boolean(t && t.finishOffset));
                                        if (bucketTimelines.length === 0) return null;
                                        const maxFinish = Math.max(
                                          ...bucketTimelines.map(
                                            (t) => t.finishOffset!.numerator / t.finishOffset!.denominator
                                          )
                                        );
                                        const bottlenecks = groupMembers.filter((m) => {
                                          const tl = timelineByFeatureId.get(m.id);
                                          if (tl?.isBottleneck !== undefined) return tl.isBottleneck;
                                          const finishVal = tl?.finishOffset
                                            ? tl.finishOffset.numerator / tl.finishOffset.denominator
                                            : 0;
                                          return Math.abs(finishVal - maxFinish) < 1e-6;
                                        });
                                        const bottleneckNames = bottlenecks
                                          .map((b) => b.title || 'Untitled')
                                          .join(', ');
                                        const idleNotes: string[] = [];
                                        for (const m of groupMembers) {
                                          const tl = timelineByFeatureId.get(m.id);
                                          if (tl?.finishOffset) {
                                            const finishVal =
                                              tl.finishOffset.numerator / tl.finishOffset.denominator;
                                            const idleDuration = maxFinish - finishVal;
                                            if (idleDuration > 0.001) {
                                              const assignedIds =
                                                plan?.assignments?.[m.id] ?? tl.assignedPersonIds ?? [];
                                              const personNames =
                                                assignedIds
                                                  .map(
                                                    (pid) =>
                                                      plan?.roster?.find((p) => p.id === pid)?.name ?? pid
                                                  )
                                                  .join(', ') || 'Assigned person';
                                              const sprintWord =
                                                idleDuration === 1
                                                  ? 'one-sprint'
                                                  : idleDuration === 2
                                                  ? 'two-sprint'
                                                  : idleDuration === 3
                                                  ? 'three-sprint'
                                                  : `${idleDuration}-sprint`;
                                              idleNotes.push(
                                                `${personNames}'s ${sprintWord} idle period (${idleDuration} sprints idle until bucket completes)`
                                              );
                                            }
                                          }
                                        }
                                        return (
                                          <>
                                            {bottleneckNames ? ` ${bottleneckNames} is the bottleneck.` : ''}
                                            {idleNotes.length > 0 ? ` ${idleNotes.join('; ')}.` : ''}
                                          </>
                                        );
                                      })()}
                                    </>
                                  ) : (
                                    `Items in this bucket progress concurrently, each receiving 1/${slot.group.featureIds.length} of the team's capacity per sprint. Total capacity consumed is unchanged.`
                                  )}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="pm-forecast__button pm-forecast__button--small"
                                aria-label="Ungroup parallel group"
                                onClick={() => handleUngroup(slot.group)}
                              >
                                Ungroup
                              </button>
                            </div>
                            <div className="pm-forecast__group-members">
                              {groupMembers.map((m) => renderRow(m, true))}
                            </div>
                          </div>
                        );
                      })()
                    )}
                  </div>
                );
              })}
            </div>

            {axis && orderedSelectedFeatures.length > 0 && (
              <div className="pm-forecast__summary-markers">
                <span />
                <span />
                <span />
                <span />
                <div className="pm-forecast__summary-markers-timeline">
                  {result?.arithmetic?.completionDate && (() => {
                    const span = Math.max(axis.spanSprints, 1);
                    const reqSprints = result.arithmetic.requiredSprints
                      ? result.arithmetic.requiredSprints.numerator / result.arithmetic.requiredSprints.denominator
                      : 0;
                    const doneLeft = Math.min(Math.max((reqSprints / span) * 100, 0), 100);
                    return (
                      <>
                        <div
                          className="pm-forecast__summary-tick pm-forecast__summary-tick--workdone"
                          style={{ left: `${doneLeft}%` }}
                        />
                        <div
                          className="pm-forecast__summary-label pm-forecast__summary-label--workdone"
                          style={{ left: `${doneLeft}%` }}
                        >
                          <span className="pm-forecast__axis-workdone">
                            {`Work done ≈ ${readableForecastDate(result.arithmetic.completionDate)}`}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                  {axis.columns.length > 0 && (() => {
                    const span = Math.max(axis.spanSprints, 1);
                    const occupied = result?.arithmetic?.occupiedSprints ?? axis.spanSprints;
                    const forecastLeft = Math.min(Math.max((occupied / span) * 100, 0), 100);
                    return (
                      <>
                        <div
                          className="pm-forecast__summary-tick pm-forecast__summary-tick--forecast"
                          style={{ left: `${forecastLeft}%` }}
                        />
                        <div
                          className="pm-forecast__summary-label pm-forecast__summary-label--forecast"
                          style={{ left: `${forecastLeft}%` }}
                        >
                          <span className="pm-forecast__axis-forecast">
                            {`Forecast · end of Sprint ${axis.completionSprint} · ${readableForecastDate(
                              axis.columns[axis.columns.length - 1]?.isoDate ?? '',
                            )}`}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                  {axis.asOfDate && axis.asOfOffset && (() => {
                    const span = Math.max(axis.spanSprints, 1);
                    const asOfVal = axis.asOfOffset.numerator / axis.asOfOffset.denominator;
                    const todayLeft = Math.min(Math.max((asOfVal / span) * 100, 0), 100);
                    return (
                      <>
                        <div
                          className="pm-forecast__summary-tick pm-forecast__summary-tick--today"
                          style={{ left: `${todayLeft}%` }}
                        />
                        <div
                          className="pm-forecast__summary-label pm-forecast__summary-label--today"
                          style={{ left: `${todayLeft}%` }}
                        >
                          <span className="pm-forecast__axis-asof">Today · {axis.asOfDate}</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {orderedSelectedFeatures.length === 0 && (
              <p className="pm-forecast__empty-copy">
                Nothing ranked yet. Add {planningLevel === 'Feature' || !planningLevel ? 'Features' : `${planningLevel}s`} from the Backlog on the left.
              </p>
            )}

            {/* Story 26.3 (FC-FR3): who is busy when, on the 26.2 axis. */}
            {lanes && lanes.lanes.length > 0 && orderedSelectedFeatures.length > 0 && (
              <PersonLanes
                view={lanes}
                axis={axis}
                page={lanePage}
                onPage={setLanePage}
                nameForFeature={liveNames.item}
              />
            )}
          </div>
        )}
      </div>

      {railDrawerOpen && (
        <button
          type="button"
          className="pm-forecast__backdrop pm-forecast__backdrop--rail"
          aria-label="Close the completion summary drawer"
          onClick={closeRailDrawer}
        />
      )}

      <aside
        role="region"
        aria-label="Forecast"
        className={`pm-forecast__rail${railDrawerOpen ? ' pm-forecast__rail--open' : ''}`}
      >
        <div className="pm-forecast__rail-head">
          <button
            ref={railCloseRef}
            type="button"
            className="pm-forecast__rail-close"
            aria-label="Close the completion summary drawer"
            onClick={closeRailDrawer}
          >
            ✕
          </button>
        </div>
        {/* ── Live plan (the answer) ─────────────────────────────────── */}
        <section className="pm-forecast__section">
          <p className="pm-forecast__section-title">Live plan</p>
          <div className="pm-forecast__completion" aria-label="Live plan completion">
            {resultError ? (
              <>
                <span className="pm-forecast__completion-label">Projected completion</span>
                <span className="pm-forecast__completion-value">Unavailable</span>
              </>
            ) : resultPending ? (
              <>
                <span className="pm-forecast__completion-label">Projected completion</span>
                <span className="pm-forecast__completion-value">Updating…</span>
                {result && (
                  <span className="pm-forecast__completion-note">
                    Previous: {result.state === 'ready' && result.arithmetic
                      ? `Sprint ${result.arithmetic.completionSprint} · ${result.arithmetic.completionDate}`
                      : formatStateLabel(result.state)}
                  </span>
                )}
              </>
            ) : !result ? (
              <p className="pm-forecast__completion-note">No forecast yet.</p>
            ) : explanation.answer && showReady && displayArithmetic ? (
              <>
                <span className="pm-forecast__completion-label">Projected completion</span>
                <span className="pm-forecast__completion-value">
                  Sprint {explanation.answer.sprint}
                </span>
                <span className="pm-forecast__completion-date">{explanation.answer.isoDate}</span>
                <span className="pm-forecast__completion-note">
                  {explanation.answer.date} · capacity-derived
                  {explanation.asOfDate ? ' · as of today' : ''}
                </span>
              </>
            ) : (
              <span className="pm-forecast__completion-value">
                {result.state === 'incomplete' && missingAssignmentIds.length > 0
                  ? 'Assignment needed'
                  : formatStateLabel(result.state)}
              </span>
            )}
          </div>
          {/* Warning notes sit on the rail ground, not the tinted answer card,
              so their status colour keeps sufficient contrast (WCAG 2.2 AA). */}
          {resultError ? (
            <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">{resultError}</p>
          ) : result?.state === 'conditional' ? (
            <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">
              Conditional —{' '}
              {blockerIssues
                .map((i) => {
                  const id = i.featureIds?.[0];
                  return eligibleFeatures.find((f) => f.id === id)?.title || id || 'a Feature';
                })
                .join(', ')}{' '}
              {blockerIssues.length === 1 ? 'is' : 'are'} blocked. No delay duration was assumed.
            </p>
          ) : null}
          {result?.state === 'incomplete' && missingAssignmentIds.length > 0 && (
            <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">
              {missingAssignmentIds.map(liveNames.item).join(', ')}{' '}
              {missingAssignmentIds.length === 1 ? 'has' : 'have'} work but nobody assigned.
            </p>
          )}
          {result && result.state !== 'ready' && result.state !== 'conditional' && issues.length > 0 && (
            <p className="pm-forecast__completion-note pm-forecast__completion-note--warning">
              {issues.length} {issues.length === 1 ? 'input needs' : 'inputs need'} attention
            </p>
          )}
          {/* ── Why, in plain words (AC 26.1-2) ─────────────────────── */}
          {explanation.reasons.length > 0 && (
            <ul className="pm-forecast__reasons">
              {explanation.reasons.map((reason) => (
                <li key={reason.key} className="pm-forecast__reason">
                  {reason.text}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Show the math (AC 26.1-3): the existing tables, folded ── */}
        <section className="pm-forecast__section">
          <button
            type="button"
            className="pm-forecast__disclosure"
            aria-expanded={mathOpen}
            aria-controls="pm-fc-math"
            onClick={() => setMathOpen((v) => !v)}
          >
            <span>Show the math</span>
            <span className="pm-forecast__disclosure-summary">
              {result && result.issues.length > 0
                ? `${result.issues.length} ${result.issues.length === 1 ? 'issue' : 'issues'}`
                : 'coverage, ratios, policy'}
            </span>
            <span className="pm-forecast__disclosure-indicator" aria-hidden="true">
              {mathOpen ? '▾' : '▸'}
            </span>
          </button>
          <div id="pm-fc-math" hidden={!mathOpen} className="pm-forecast__math">
        {/* ── Coverage / validity ───────────────────────────────────── */}
        {result && (
          <section className="pm-forecast__section">
            <p className="pm-forecast__section-title">Coverage</p>
            <div className="pm-forecast__arithmetic">
              <div className="pm-forecast__arithmetic-row">
                <span>Selected</span>
                <span className="pm-forecast__arithmetic-value">{result.coverage.selectedCount}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Estimated</span>
                <span className="pm-forecast__arithmetic-value">{result.coverage.estimatedCount}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Known points</span>
                <span className="pm-forecast__arithmetic-value">{result.totalKnownPoints}</span>
              </div>
            </div>
            {issues.map((issue, idx) => (
              <div key={`${issue.code}-${idx}`} className="pm-forecast__issue">
                {issueText(issue)}
                {issue.code === 'MISSING_ASSIGNMENT' &&
                  onSetAssignments &&
                  (issue.featureIds ?? []).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="pm-forecast__button pm-forecast__button--small"
                      onClick={() => setItemPeopleEditorState({ featureId: id, featureTitle: liveNames.item(id) })}
                    >
                      Assign people to {liveNames.item(id)}
                    </button>
                  ))}
              </div>
            ))}
          </section>
        )}

        {/* ── Arithmetic ────────────────────────────────────────────── */}
        {displayArithmetic && (
          <section className="pm-forecast__section">
            <p className="pm-forecast__section-title">Arithmetic</p>
            <div className="pm-forecast__arithmetic">
              <div className="pm-forecast__arithmetic-row">
                <span>Total points</span>
                <span className="pm-forecast__arithmetic-value">{displayArithmetic.totalPoints}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Capacity / sprint</span>
                <span className="pm-forecast__arithmetic-value">{displayArithmetic.pointsPerSprint}</span>
              </div>
              {isStaffed ? (
                <>
                  <div className="pm-forecast__arithmetic-row">
                    <span>Work/capacity lower bound</span>
                    <span className="pm-forecast__arithmetic-value">
                      {displayArithmetic.requiredSprints.denominator === 1
                        ? displayArithmetic.requiredSprints.numerator
                        : formatRatio(displayArithmetic.requiredSprints)}{' '}
                      sprints
                    </span>
                  </div>
                  {displayArithmetic.elapsedStaffingDuration && (
                    <div className="pm-forecast__arithmetic-row">
                      <span>Elapsed staffing duration</span>
                      <span className="pm-forecast__arithmetic-value">
                        {displayArithmetic.elapsedStaffingDuration.denominator === 1
                          ? displayArithmetic.elapsedStaffingDuration.numerator
                          : formatRatio(displayArithmetic.elapsedStaffingDuration)}{' '}
                        sprints
                      </span>
                    </div>
                  )}
                  {(displayArithmetic.idleCapacityPoints || displayArithmetic.idlePointsEquivalent) && (
                    <div className="pm-forecast__arithmetic-row">
                      <span>Idle capacity</span>
                      <span className="pm-forecast__arithmetic-value">
                        {(() => {
                          const idle =
                            displayArithmetic.idleCapacityPoints ??
                            displayArithmetic.idlePointsEquivalent!;
                          const val = idle.denominator === 1 ? idle.numerator : formatRatio(idle);
                          return `${val} pts equivalent`;
                        })()}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="pm-forecast__arithmetic-row">
                  <span>Exact ratio</span>
                  <span className="pm-forecast__arithmetic-value">
                    {formatRatio(displayArithmetic.requiredSprints)}
                  </span>
                </div>
              )}
              <div className="pm-forecast__arithmetic-row">
                <span>Occupied sprints</span>
                <span className="pm-forecast__arithmetic-value">{displayArithmetic.occupiedSprints}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Sprint length</span>
                <span className="pm-forecast__arithmetic-value">{displayArithmetic.sprintLengthDays} days</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Start anchor</span>
                <span className="pm-forecast__arithmetic-value">
                  Sprint {displayArithmetic.startSprintOrdinal} · {displayArithmetic.startDate}
                </span>
              </div>
            </div>
          </section>
        )}

        {/* ── Assumptions ───────────────────────────────────────────── */}
        {result && (
          <section className="pm-forecast__section">
            <p className="pm-forecast__section-title">Assumptions</p>
            <div className="pm-forecast__arithmetic">
              <div className="pm-forecast__arithmetic-row">
                <span>Policy</span>
                <span className="pm-forecast__arithmetic-value">{result.assumptions.policyVersion}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Cadence</span>
                <span className="pm-forecast__arithmetic-value">{result.assumptions.cadence}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Grouping</span>
                <span className="pm-forecast__arithmetic-value">{result.assumptions.groupingPremise}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Rounding</span>
                <span className="pm-forecast__arithmetic-value">{result.assumptions.rounding}</span>
              </div>
              <div className="pm-forecast__arithmetic-row">
                <span>Blocker condition</span>
                <span className="pm-forecast__arithmetic-value">
                  {blockerIssues.length === 0
                    ? 'none'
                    : `${blockerIssues.length} blocked Feature${blockerIssues.length === 1 ? '' : 's'} — no delay assumed`}
                </span>
              </div>
            </div>
          </section>
        )}
          </div>
        </section>

        {/* ── What changed (Story 20.2, UX-DR6, UX-DR14) ────────────── */}
        {result && (
          <section className="pm-forecast__section" aria-label="What changed">
            <p className="pm-forecast__section-title">What changed</p>
            {!historicalAttributionAvailable || !comparison ? (
              <p className="pm-forecast__completion-note">
                Historical attribution is unavailable — no earlier forecast is retained to compare against.
              </p>
            ) : comparison.causes.length === 0 ? (
              <p className="pm-forecast__completion-note">No material change since the last forecast.</p>
            ) : (
              <>
                <p className="pm-forecast__completion-note">{describeComparisonHeadline(comparison)}</p>
                <ul className="pm-forecast__cause-list">
                  {comparison.causes.map((cause, idx) => (
                    <li key={`${cause.kind}-${idx}`} className="pm-forecast__cause">
                      {describeCause(cause, (id) => eligibleFeatures.find((f) => f.id === id)?.title ?? '')}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {/* ── Scenarios (Story 20.5, UX-DR6 — 6th section) ─────────── */}
        {onCreateScenario && onRemoveScenario && onCaptureScenarioDraft && onEvaluateScenarioDraft && (
          <ScenarioCompare
            projectId={projectId}
            scenarios={scenarios ?? []}
            evaluations={scenarioEvaluations ?? new Map()}
            liveResult={result}
            livePlanningLevel={plan?.planningLevel}
            policyVersion={plan?.policyVersion}
            // Story 23.7 AC 23.7-1: a draft captures the plan's canonical
            // inputs, so an incomplete or invalid live forecast can still be
            // explored; only an unreadable plan (no result) blocks drafting.
            canCreate={Boolean(result && !resultError)}
            onCaptureDraft={onCaptureScenarioDraft}
            onEvaluateDraft={onEvaluateScenarioDraft}
            onCancelDraft={onCancelScenarioDraft}
            onCreate={onCreateScenario}
            onRemove={onRemoveScenario}
          />
        )}

        {/* ── Jump-the-line what-if (Story 26.7, FC-FR7/8) ───────────── */}
        {onEvaluateWhatIf && onApplyWhatIf && onSaveWhatIf && onCaptureWhatIfBaseline && (
          <JumpTheLinePanel
            result={result}
            eligibleFeatures={eligibleFeatures}
            roster={(plan?.roster ?? []).map((p) => ({ id: p.id, name: p.name }))}
            onCaptureBaseline={onCaptureWhatIfBaseline}
            onEvaluate={onEvaluateWhatIf}
            onApply={onApplyWhatIf}
            onSave={onSaveWhatIf}
            names={liveNames.item}
          />
        )}

        {/* ── Levers and preview (Story 26.4, FC-FR4, FC-UX3) ───────── */}
        {onCaptureScenarioDraft && onEvaluateScenarioDraft && onCreateScenario && (
          <ForecastLevers
            plan={plan}
            result={result}
            canPreview={Boolean(result && !resultError)}
            onCaptureDraft={onCaptureScenarioDraft}
            onEvaluateDraft={onEvaluateScenarioDraft}
            onCancelDraft={onCancelScenarioDraft}
            onSaveScenario={onCreateScenario}
            onApplyPolicy={onSetPolicy ?? (async () => false)}
            onApplyConfiguration={onSaveConfiguration}
            onApplyGroups={
              onSetForecastSequence
                ? (featureIds, groups) => onSetForecastSequence(featureIds, groups)
                : undefined
            }
          />
        )}

        {/* ── People & Capacity (Epic 22, Story 22.3) ────────────────── */}
        <section className="pm-forecast__section">
          <p className="pm-forecast__section-title">People</p>
          <div className="pm-forecast__arithmetic">
            <div className="pm-forecast__arithmetic-row">
              <span>Team members</span>
              <span className="pm-forecast__arithmetic-value">{plan?.roster?.length ?? 0}</span>
            </div>
            {plan?.roster && plan.roster.length > 0 && (
              <div className="pm-forecast__arithmetic-row">
                <span>Total weight</span>
                <span className="pm-forecast__arithmetic-value">
                  {(plan.roster.reduce((sum, p) => sum + p.weightUnits, 0) / 100).toFixed(2)}
                </span>
              </div>
            )}
          </div>
          {onAddPerson && onUpdatePerson && onRemovePerson && (
            <button
              ref={peopleButtonRef}
              type="button"
              className="pm-forecast__button"
              style={{ marginTop: 'var(--pm-space-2)' }}
              onClick={() => setPeopleEditorOpen(true)}
            >
              {plan?.roster && plan.roster.length > 0 ? 'Manage people…' : 'Add people…'}
            </button>
          )}
        </section>

        {/* ── Configuration ─────────────────────────────────────────── */}
        <section className="pm-forecast__section">
          <p className="pm-forecast__section-title">Configuration</p>
          {!configOpen ? (
            <button type="button" className="pm-forecast__button" onClick={openConfig}>
              {config ? 'Edit configuration…' : 'Configure plan…'}
            </button>
          ) : (
            <div className="pm-forecast__config">
              <div className="pm-forecast__config-field">
                <label className="pm-forecast__config-label" htmlFor="pm-fc-capacity">
                  Points per sprint
                </label>
                <input
                  id="pm-fc-capacity"
                  className="pm-forecast__config-input"
                  type="number"
                  min={0}
                  step={1}
                  value={draft?.pointsPerSprint ?? ''}
                  onChange={(e) => setDraft((d) => (d ? { ...d, pointsPerSprint: e.target.value } : d))}
                />
              </div>
              <div className="pm-forecast__config-field">
                <label className="pm-forecast__config-label" htmlFor="pm-fc-length">
                  Sprint length (days)
                </label>
                <input
                  id="pm-fc-length"
                  className="pm-forecast__config-input"
                  type="number"
                  min={1}
                  step={1}
                  value={draft?.sprintLengthDays ?? ''}
                  onChange={(e) => setDraft((d) => (d ? { ...d, sprintLengthDays: e.target.value } : d))}
                />
              </div>
              <div className="pm-forecast__config-field">
                <label className="pm-forecast__config-label" htmlFor="pm-fc-ordinal">
                  Start sprint
                </label>
                <input
                  id="pm-fc-ordinal"
                  className="pm-forecast__config-input"
                  type="number"
                  min={1}
                  step={1}
                  value={draft?.startSprintOrdinal ?? ''}
                  onChange={(e) => setDraft((d) => (d ? { ...d, startSprintOrdinal: e.target.value } : d))}
                />
              </div>
              <div className="pm-forecast__config-field">
                <label className="pm-forecast__config-label" htmlFor="pm-fc-date">
                  First date
                </label>
                <input
                  id="pm-fc-date"
                  className="pm-forecast__config-input"
                  type="date"
                  value={draft?.startDate ?? ''}
                  onChange={(e) => setDraft((d) => (d ? { ...d, startDate: e.target.value } : d))}
                />
              </div>
              <div className="pm-forecast__config-actions">
                <button type="button" className="pm-forecast__button pm-forecast__button--primary" onClick={saveConfig}>
                  Save
                </button>
                <button type="button" className="pm-forecast__button" onClick={() => setConfigOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      </aside>

      {levelDialogOpen && (
        <div
          ref={levelDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm planning level change"
          className="pm-forecast__level-dialog"
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked',
            ));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="pm-forecast__level-dialog-card">
            <p className="pm-forecast__level-dialog-title">Switch planning level?</p>
            <p className="pm-forecast__level-dialog-copy">
              Switching to {levelDialogChoice} clears the current ranking, buckets, blockers, and assignments. Roster, capacity, and mode are preserved. Proceed?
            </p>
            <div className="pm-forecast__level-dialog-options" role="radiogroup" aria-label="New planning level">
              {(['Theme', 'Component', 'Feature'] as const).map((level) => (
                <label key={level} className="pm-forecast__level-dialog-option">
                  <input
                    type="radio"
                    name="level-dialog-choice"
                    checked={levelDialogChoice === level}
                    onChange={() => setLevelDialogChoice(level)}
                  />
                  <span>{level === 'Feature' ? 'Features' : `${level}s`}</span>
                </label>
              ))}
            </div>
            <div className="pm-forecast__level-dialog-actions">
              <button
                ref={levelConfirmRef}
                type="button"
                className="pm-forecast__button pm-forecast__button--primary"
                onClick={confirmLevelChange}
              >
                Switch level
              </button>
              <button
                type="button"
                className="pm-forecast__button"
                onClick={() => setLevelDialogOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {onAddPerson && onUpdatePerson && onRemovePerson && (
        <PeopleEditor
          isOpen={peopleEditorOpen}
          onClose={() => setPeopleEditorOpen(false)}
          roster={plan?.roster ?? []}
          assignments={plan?.assignments ?? {}}
          items={eligibleFeatures}
          pointsPerSprint={plan?.configuration.pointsPerSprint ?? null}
          onAddPerson={onAddPerson}
          onUpdatePerson={onUpdatePerson}
          onRemovePerson={onRemovePerson}
          triggerRef={peopleButtonRef}
        />
      )}

      {itemPeopleEditorState && onSetAssignments && (
        <ItemPeopleEditor
          isOpen={Boolean(itemPeopleEditorState)}
          onClose={() => setItemPeopleEditorState(null)}
          featureId={itemPeopleEditorState.featureId}
          featureTitle={itemPeopleEditorState.featureTitle}
          roster={plan?.roster ?? EMPTY_ROSTER}
          currentPersonIds={plan?.assignments?.[itemPeopleEditorState.featureId] ?? EMPTY_IDS}
          onSaveAssignments={onSetAssignments}
          triggerRef={{ current: itemTriggerRefs.current.get(itemPeopleEditorState.featureId) ?? null }}
          onOpenRoster={() => setPeopleEditorOpen(true)}
        />
      )}
    </div>
  );
}

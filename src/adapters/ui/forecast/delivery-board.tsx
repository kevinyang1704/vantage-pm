/**
 * Delivery Board (design direction A, refined v2).
 *
 * The default Forecast surface: ranked work is grouped by delivery block into
 * sprint columns, each sprint states what ships, and a trade-off bench previews
 * capacity/scope/parallel changes. The detailed ForecastWorkspace remains the
 * List view for math, scenarios, people and precise keyboard work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForecastWorkspaceProps, ForecastPlanningRow } from './forecast-workspace';
import type { BacklogItem } from './backlog-pane';
import type { PlanningLevel, PlanningLevelOption } from './planning-level-step';
import { PlanningLevelStep } from './planning-level-step';
import { PeopleEditor } from './people-editor';
import { ItemPeopleEditor } from './item-people-editor';
import { DeliveryBacklog } from './delivery-backlog';
import { DeliveryTeamPanel } from './delivery-team-panel';
import { SprintBoard } from './sprint-board';
import { buildSprintBoard } from '../../../application/forecast/sprint-board-projection';
import { localTodayIso } from '../workspace/use-local-today';
import { moveBlockToIndex, placeFeatureBefore } from './forecast-placement';
import { explainForecast } from '../../../application/forecast/forecast-explain';
import { readableForecastDate } from '../../../application/forecast/forecast-timeline';
import {
  buildDeliveryBoard,
  type DeliveryBlock,
  type DeliveryCard,
  type DeliveryColumn,
  type DeliverySourceRow,
} from '../../../application/forecast/delivery-board-projection';
import type { ForecastPolicyVersion } from '../../../domain/forecast/forecast-plan.entity';
import './delivery-board.css';

export interface DeliveryBoardProps extends ForecastWorkspaceProps {
  /** Nearest Theme/Component title for a milestone label. */
  readonly groupTitle?: (id: string) => string | null;
  /** Unlock edges between nodes: an item waits for the items that unlock it. */
  readonly unlockEdges?: readonly Readonly<{ sourceNodeId: string; targetNodeId: string }>[];
  /** Save the sprint plan; `addFeatureId` joins the plan first (one undo step). */
  readonly onSetSprintPlan?: (
    sprintPlan: import('../../../domain/forecast/forecast-plan.entity').ForecastSprintPlan,
    addFeatureId?: string,
  ) => Promise<boolean>;
}

const SPRINTS_PER_PAGE = 4;

type Announcement = Readonly<{ seq: number; text: string }>;

function PackageIcon(): React.ReactElement {
  return (
    <svg className="pm-delivery__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.2 13.2 4.8v6.4L8 13.8 2.8 11.2V4.8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2.8 4.8 8 7.4l5.2-2.6M8 7.4v6.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function FlagIcon(): React.ReactElement {
  return (
    <svg className="pm-delivery__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 14V2.5M4 3h8l-1.6 2.6L12 8.2H4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon(): React.ReactElement {
  return (
    <svg className="pm-delivery__icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.2 14 13H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.2v3.1M8 11.4v.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DragIcon(): React.ReactElement {
  return (
    <svg className="pm-delivery__icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="4" r="1" fill="currentColor" />
      <circle cx="10" cy="4" r="1" fill="currentColor" />
      <circle cx="6" cy="8" r="1" fill="currentColor" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="10" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function resultStateLabel(state: NonNullable<ForecastWorkspaceProps['result']>['state']): string {
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

function levelLabel(level: PlanningLevel | undefined): string {
  if (!level) return 'Features';
  return level === 'Feature' ? 'Features' : `${level}s`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}

function toSourceRows(rows: readonly ForecastPlanningRow[]): readonly DeliverySourceRow[] {
  return rows
    .filter((row) => row.included)
    .map((row) => ({
      id: row.id,
      title: row.title,
      effortPoints: row.effortPoints,
      effortPointsDone: row.effortPointsDone,
      deliveryStatus: row.deliveryStatus,
      invalid: row.invalid,
    }));
}

function cardStatus(card: DeliveryCard): string {
  if (card.blocked) return 'Blocked';
  if (card.deliveryStatus === 'delivered') return 'Delivered';
  if (card.deliveryStatus === 'in_progress') return 'In progress';
  return 'On track';
}

function issueText(
  issue: { readonly code: string; readonly message: string; readonly featureIds?: readonly string[] },
  titleFor: (id: string) => string,
): string {
  const names = (issue.featureIds ?? []).map((id) => titleFor(id)).filter(Boolean);
  if (names.length > 0) {
    const subject = names.join(', ');
    if (issue.code.includes('BLOCKER')) {
      return `${subject} ${names.length === 1 ? 'is' : 'are'} blocked. No delay duration was assumed.`;
    }
    if (issue.code === 'MISSING_ASSIGNMENT') {
      return `${subject} ${names.length === 1 ? 'needs' : 'need'} an owner.`;
    }
    return `${subject}: ${issue.message}`;
  }
  return issue.message;
}

function contiguousSelection(
  ids: readonly string[],
  selected: ReadonlySet<string>,
): readonly string[] {
  const ordered = ids.filter((id) => selected.has(id));
  if (ordered.length === 0) return ordered;
  const indices = ordered.map((id) => ids.indexOf(id)).filter((index) => index >= 0);
  const contiguous = indices.every((index, position) => position === 0 || index === indices[position - 1] + 1);
  return contiguous ? ordered : Object.freeze([]) as readonly string[];
}

function moveTargetForColumn(
  plan: { selectedFeatureIds: readonly string[] },
  column: DeliveryColumn,
  allColumns: readonly DeliveryColumn[],
): number {
  const lastBlock = column.blocks[column.blocks.length - 1];
  if (lastBlock) {
    const lastId = lastBlock.featureIds[lastBlock.featureIds.length - 1];
    const index = plan.selectedFeatureIds.indexOf(lastId);
    return index === -1 ? plan.selectedFeatureIds.length : index + 1;
  }
  const laterColumn = allColumns.find((candidate) => candidate.sprint > column.sprint && candidate.blocks.length > 0);
  if (laterColumn) {
    const firstId = laterColumn.blocks[0].featureIds[0];
    const index = plan.selectedFeatureIds.indexOf(firstId);
    if (index !== -1) return index;
  }
  return plan.selectedFeatureIds.length;
}

export function DeliveryBoard(props: DeliveryBoardProps): React.ReactElement {
  const {
    plan,
    result,
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
    onAddPerson,
    onUpdatePerson,
    onRemovePerson,
    onSetAssignments,
    onSetPolicy,
    onSwitchView,
    groupTitle,
    unlockEdges,
    onSetSprintPlan,
  } = props;

  const rows = useMemo(() => toSourceRows(eligibleFeatures), [eligibleFeatures]);
  const stale = resultPending || Boolean(resultError);
  const explanation = useMemo(() => explainForecast(stale ? null : result), [result, stale]);
  const projection = useMemo(
    () => buildDeliveryBoard({ result: stale ? null : result, plan, rows, groupTitle }),
    [result, stale, plan, rows, groupTitle],
  );
  const showReady =
    !stale &&
    (result?.state === 'ready' || result?.state === 'conditional') &&
    Boolean(explanation.answer);
  const noUpcomingDelivery = showReady && projection.milestones.length === 0;

  const fallbackCards = useMemo<readonly DeliveryCard[]>(() => {
    if (!plan) return [];
    const included = new Map(eligibleFeatures.filter((feature) => feature.included).map((feature) => [feature.id, feature] as const));
    return plan.selectedFeatureIds.map((featureId, index) => {
      const row = included.get(featureId);
      return {
        featureId,
        title: row?.title ?? 'Untitled work',
        rank: index + 1,
        effortPoints: row?.effortPoints ?? null,
        effortPointsDone: row?.effortPointsDone ?? null,
        deliveryStatus: row?.deliveryStatus ?? null,
        invalid: row?.invalid ?? false,
        blocked: plan.blockedFeatureIds.includes(featureId),
        parallelGroupIndex: null,
        startSprint: null,
        finishSprint: null,
        startDate: null,
        finishDate: null,
        spanSprints: 1,
        assignedPersonIds: plan.assignments?.[featureId] ?? [],
        isMilestone: false,
        withheldReason: 'Set an estimate to place this work on the timeline.',
      } satisfies DeliveryCard;
    });
  }, [plan, eligibleFeatures]);

  const config = plan?.configuration ?? null;
  const configComplete =
    Boolean(config) &&
    config?.pointsPerSprint !== null &&
    config?.sprintLengthDays !== null &&
    config?.startSprintOrdinal !== null &&
    config?.startDate !== null;
  const isStaffed = plan?.policyVersion === 'staffed-capacity-v1';
  const displayLevel = plan?.planningLevel ?? planningLevel ?? 'Feature';

  // The sprint board places hand-placed work first and lets the forecast fill
  // the rest. It needs only the plan's configuration, so it stays available
  // while the whole-plan forecast is incomplete (an unestimated item is just
  // held back with its reason).
  const asOfDate = result?.arithmetic?.asOfDate ?? localTodayIso();
  const sprintBoard = useMemo(() => {
    if (!plan || !configComplete) return null;
    return buildSprintBoard({
      plan,
      rows: eligibleFeatures.map((feature) => ({
        id: feature.id,
        title: feature.title,
        effortPoints: feature.effortPoints,
        effortPointsDone: feature.effortPointsDone ?? null,
        deliveryStatus: feature.deliveryStatus,
        included: feature.included,
        invalid: feature.invalid,
      })),
      unlockEdges: unlockEdges ?? [],
      // Same capacity the Team panel shows; a pending result keeps its last value.
      teamCapacity: result?.arithmetic?.pointsPerSprint ?? null,
      asOfDate,
    });
  }, [plan, configComplete, eligibleFeatures, unlockEdges, result, asOfDate]);
  const deliveredIds = useMemo(
    () => new Set(eligibleFeatures.filter((feature) => feature.deliveryStatus === 'delivered').map((feature) => feature.id)),
    [eligibleFeatures],
  );
  const [boardPage, setBoardPage] = useState(0);
  const waiting = sprintBoard ? sprintBoard.held.length + sprintBoard.unscheduled.length : 0;

  const [announcement, setAnnouncement] = useState<Announcement>({ seq: 0, text: '' });
  const announce = useCallback((text: string) => {
    setAnnouncement((current) => ({ seq: current.seq + 1, text }));
  }, []);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [effortDrafts, setEffortDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const clearEffortDraft = useCallback((featureId: string): void => {
    setEffortDrafts((current) => {
      if (!current.has(featureId)) return current;
      const next = new Map(current);
      next.delete(featureId);
      return next;
    });
  }, []);

  useEffect(() => {
    setEffortDrafts((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Map(current);
      for (const [id, raw] of current) {
        const row = rows.find((candidate) => candidate.id === id);
        const acknowledged = row?.effortPoints === null || row?.effortPoints === undefined ? '' : String(row.effortPoints);
        if (acknowledged === raw) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rows]);
  useEffect(() => {
    if (!plan) return;
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => plan.selectedFeatureIds.includes(id)));
      return next.size === current.size ? current : next;
    });
  }, [plan?.selectedFeatureIds, plan]);

  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  // A Backlog item being dragged onto the board, and one that was dropped and
  // is waiting for the membership command to land before it is positioned.
  const [draggedBacklogId, setDraggedBacklogId] = useState<string | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{ featureId: string; beforeId: string | null } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [peopleEditorOpen, setPeopleEditorOpen] = useState(false);
  const [itemPeople, setItemPeople] = useState<{ featureId: string; title: string } | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupDraft, setSetupDraft] = useState({
    pointsPerSprint: '',
    sprintLengthDays: '',
    startSprintOrdinal: '',
    startDate: '',
  });
  const [levelOpen, setLevelOpen] = useState(false);
  const [levelChoice, setLevelChoice] = useState<PlanningLevel>(displayLevel);
  const levelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [sprintPage, setSprintPage] = useState(0);
  const levelFirstRef = useRef<HTMLInputElement | null>(null);

  const pageCount = Math.max(1, Math.ceil(projection.milestones.length / SPRINTS_PER_PAGE));
  useEffect(() => {
    if (sprintPage >= pageCount) setSprintPage(pageCount - 1);
  }, [pageCount, sprintPage]);

  const pageStart = sprintPage * SPRINTS_PER_PAGE;
  const visibleColumns = projection.columns.slice(pageStart, pageStart + SPRINTS_PER_PAGE);
  const visibleMilestones = projection.milestones.slice(pageStart, pageStart + SPRINTS_PER_PAGE);

  useEffect(() => {
    if (!levelOpen) return;
    queueMicrotask(() => levelFirstRef.current?.focus());
  }, [levelOpen]);

  const closeLevelDialog = useCallback((): void => {
    setLevelOpen(false);
    queueMicrotask(() => levelTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!levelOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLevelDialog();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [levelOpen, closeLevelDialog]);

  const openSetup = (): void => {
    setSetupDraft({
      pointsPerSprint: config?.pointsPerSprint?.toString() ?? '',
      sprintLengthDays: config?.sprintLengthDays?.toString() ?? '',
      startSprintOrdinal: config?.startSprintOrdinal?.toString() ?? '',
      startDate: config?.startDate ?? '',
    });
    setSetupError(null);
    setSetupOpen(true);
  };

  const saveSetup = (): void => {
    const parse = (value: string): number | null => {
      if (value.trim() === '') return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) return Number.NaN;
      return parsed;
    };
    const next = {
      pointsPerSprint: parse(setupDraft.pointsPerSprint),
      sprintLengthDays: parse(setupDraft.sprintLengthDays),
      startSprintOrdinal: parse(setupDraft.startSprintOrdinal),
      startDate: setupDraft.startDate.trim() === '' ? null : setupDraft.startDate.trim(),
    };
    if (
      [next.pointsPerSprint, next.sprintLengthDays, next.startSprintOrdinal].some(
        (value) => value !== null && Number.isNaN(value),
      )
    ) {
      setSetupError('Capacity, sprint length and start sprint must be whole numbers.');
      return;
    }
    if (
      next.pointsPerSprint === null ||
      next.sprintLengthDays === null ||
      next.startSprintOrdinal === null ||
      next.startDate === null
    ) {
      setSetupError('All four baseline fields are required.');
      return;
    }
    setSetupError(null);
    onSaveConfiguration(next);
    setSetupOpen(false);
  };

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selection = plan ? contiguousSelection(plan.selectedFeatureIds, selectedIds) : [];
  const selectedGroups = plan
    ? [...selectedIds].filter((id) =>
      plan.parallelGroups.some((group) => group.featureIds.includes(id)),
    )
    : [];
  const canGroup =
    Boolean(plan && onSetForecastSequence) &&
    selection.length >= 2 &&
    selection.length === selectedIds.size &&
    selectedGroups.length === 0;

  const groupSelection = (): void => {
    if (!plan || !onSetForecastSequence || !canGroup) return;
    const groups = [
      ...plan.parallelGroups.map((group) => Object.freeze({ featureIds: Object.freeze([...group.featureIds]) })),
      Object.freeze({ featureIds: Object.freeze([...selection]) }),
    ];
    onSetForecastSequence(plan.selectedFeatureIds, groups);
    setSelectedIds(new Set());
    announce(`Running ${selection.length} features in parallel. The launch date is unchanged.`);
  };

  const ungroup = (block: DeliveryBlock): void => {
    if (!plan || !onSetForecastSequence) return;
    const groups = plan.parallelGroups
      .filter((group) => !group.featureIds.includes(block.featureIds[0]))
      .map((group) => Object.freeze({ featureIds: Object.freeze([...group.featureIds]) }));
    onSetForecastSequence(plan.selectedFeatureIds, groups);
    announce(`Removed the parallel group. The launch date is unchanged.`);
  };

  const applyMove = (block: DeliveryBlock, targetIndex: number): void => {
    if (!plan || !onSetForecastSequence) return;
    const moved = moveBlockToIndex(plan.selectedFeatureIds, block.featureIds, targetIndex, plan.parallelGroups);
    if (!moved.success) {
      setDropError(moved.error);
      return;
    }
    setDropError(null);
    onSetForecastSequence(moved.ids, moved.groups);
    announce(`Moved ${block.label}. The launch date is unchanged.`);
  };

  const blockDragProps = (block: DeliveryBlock) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => {
      setDraggedKey(block.key);
      setDraggedBacklogId(null);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', block.key);
    },
    onDragEnd: () => {
      setDraggedKey(null);
      setDropTargetKey(null);
    },
  });

  // Dropping a Backlog item adds it to the plan, then places it at the drop
  // point once the new plan arrives (membership appends it to the order).
  const addFromBacklog = (featureId: string, targetIndex: number): void => {
    if (!plan) return;
    const beforeId = plan.selectedFeatureIds[targetIndex] ?? null;
    const title = backlogItems?.find((item) => item.id === featureId)?.title || 'Untitled work';
    setDropError(null);
    setPendingPlacement({ featureId, beforeId });
    const settled = (applied: boolean): void => {
      if (!applied) setPendingPlacement(null);
      announce(applied ? `Added ${title} to the plan.` : `Could not add ${title} to the plan.`);
    };
    const outcome = onToggleMembership(featureId, true);
    if (outcome && typeof outcome.then === 'function') {
      void outcome.then(settled).catch(() => settled(false));
    } else {
      settled(true);
    }
  };

  useEffect(() => {
    if (!pendingPlacement || !plan) return;
    if (!plan.selectedFeatureIds.includes(pendingPlacement.featureId)) return;
    setPendingPlacement(null);
    if (!onSetForecastSequence) return;
    const placed = placeFeatureBefore(
      plan.selectedFeatureIds,
      pendingPlacement.featureId,
      pendingPlacement.beforeId,
      plan.parallelGroups,
    );
    if (!placed) return;
    if (!placed.success) {
      setDropError(placed.error);
      return;
    }
    onSetForecastSequence(placed.ids, placed.groups);
  }, [pendingPlacement, plan, onSetForecastSequence]);

  const moveBlockEarlier = (block: DeliveryBlock): void => {
    if (!plan) return;
    const index = projection.blocks.findIndex((candidate) => candidate.key === block.key);
    const previous = projection.blocks[index - 1];
    if (!previous) return;
    const target = plan.selectedFeatureIds.indexOf(previous.featureIds[0]);
    if (target !== -1) applyMove(block, target);
  };

  const moveBlockLater = (block: DeliveryBlock): void => {
    if (!plan) return;
    const index = projection.blocks.findIndex((candidate) => candidate.key === block.key);
    const next = projection.blocks[index + 1];
    if (!next) return;
    const lastId = next.featureIds[next.featureIds.length - 1];
    const target = plan.selectedFeatureIds.indexOf(lastId);
    if (target !== -1) applyMove(block, target + 1);
  };

  const dropOnBlock = (target: DeliveryBlock, event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const backlogId = draggedBacklogId;
    setDraggedBacklogId(null);
    const source = projection.blocks.find((block) => block.key === draggedKey);
    setDraggedKey(null);
    if (!plan || (!backlogId && (!source || source.key === target.key))) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const first = plan.selectedFeatureIds.indexOf(target.featureIds[0]);
    if (first === -1) return;
    const targetIndex = after ? first + target.featureIds.length : first;
    if (backlogId) addFromBacklog(backlogId, targetIndex);
    else if (source) applyMove(source, targetIndex);
  };

  const dropOnColumn = (column: DeliveryColumn, event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    const backlogId = draggedBacklogId;
    setDraggedBacklogId(null);
    const source = projection.blocks.find((block) => block.key === draggedKey);
    setDraggedKey(null);
    if (!plan) return;
    const targetIndex = moveTargetForColumn(plan, column, projection.columns);
    if (backlogId) addFromBacklog(backlogId, targetIndex);
    else if (source) applyMove(source, targetIndex);
  };

  const openLevelDialog = (): void => {
    if (!onSetPlanningLevel) return;
    setLevelChoice(displayLevel);
    setLevelOpen(true);
  };

  const confirmLevel = (): void => {
    if (!onSetPlanningLevel) return;
    onSetPlanningLevel(levelChoice);
    closeLevelDialog();
    announce(`Planning level changed to ${levelLabel(levelChoice)}.`);
  };

  const switchPolicy = async (policy: ForecastPolicyVersion): Promise<void> => {
    if (!onSetPolicy) return;
    setModeError(null);
    const ok = await onSetPolicy(policy);
    if (!ok) {
      setModeError(
        'Could not switch mode. Resolve parallel group conflicts before activating Assigned people.',
      );
    }
  };


  const renderMilestone = (column: DeliveryColumn): React.ReactElement => {
    const milestone = column.milestone;
    const isLast = milestone.sprint === projection.axis?.completionSprint;
    return (
      <div
        key={milestone.sprint}
        className={`pm-delivery__milestone${milestone.ships ? '' : ' is-empty'}${isLast ? ' is-last' : ''}`}
      >
        <div className="pm-delivery__milestone-head">
          <span>Sprint {milestone.sprint}</span>
          <span className="pm-delivery__milestone-date">{milestone.dateRange}</span>
          <span className="pm-delivery__milestone-cap">{milestone.capacity}/sprint</span>
        </div>
        <div className="pm-delivery__milestone-ship">
          {milestone.ships ? (
            <span className="pm-delivery__ships-pill">
              <PackageIcon /> Ships
            </span>
          ) : (
            <span className="pm-delivery__ships-pill is-empty">
              {milestone.inProgressCount > 0 ? 'In progress' : 'No delivery'}
            </span>
          )}
        </div>
        <div className="pm-delivery__milestone-name">{milestone.label}</div>
        {milestone.blockedCount > 0 && (
          <div className="pm-delivery__milestone-risk">
            <AlertIcon /> {milestone.blockedCount} blocked &middot; conditional
          </div>
        )}
      </div>
    );
  };

  const renderCard = (
    card: DeliveryCard,
    inParallel: boolean,
    block?: DeliveryBlock,
  ): React.ReactElement => {
    const assignedPeople = isStaffed
      ? (plan?.roster ?? []).filter((person) => card.assignedPersonIds.includes(person.id))
      : [];
    return (
      <article
        key={card.featureId}
        className={`pm-delivery__card${card.blocked ? ' is-blocked' : ''}${inParallel ? ' is-parallel' : ''}`}
      >
        <div className="pm-delivery__card-top">
          <label className="pm-delivery__select">
            <input
              type="checkbox"
              checked={selectedIds.has(card.featureId)}
              onChange={() => toggleSelected(card.featureId)}
              aria-label={`Select ${card.title} for a parallel group`}
              disabled={Boolean(plan?.parallelGroups.some((group) => group.featureIds.includes(card.featureId)))}
            />
          </label>
          <span className="pm-delivery__rank" aria-label={`Rank ${card.rank}`}>
            {String(card.rank).padStart(2, '0')}
          </span>
          <span
            className={`pm-delivery__card-title${block ? ' is-draggable' : ''}`}
            {...(block ? { ...blockDragProps(block), title: 'Drag to move' } : {})}
          >
            {card.title}
          </span>
          <input
            type="number"
            className="pm-delivery__effort"
            aria-label={`Points for ${card.title}`}
            min={0}
            step={1}
            value={effortDrafts.has(card.featureId) ? effortDrafts.get(card.featureId)! : (card.effortPoints ?? '')}
            placeholder="-"
            onChange={(event) => {
              const raw = event.target.value;
              setEffortDrafts((current) => {
                const next = new Map(current);
                next.set(card.featureId, raw);
                return next;
              });
              const next = raw.trim() === '' ? null : Number(raw);
              if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
              onSetEffort(card.featureId, next);
            }}
            onBlur={() => clearEffortDraft(card.featureId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Escape') {
                if (event.key === 'Escape') event.preventDefault();
                clearEffortDraft(card.featureId);
              }
            }}
          />
        </div>

        <div className="pm-delivery__card-meta">
          <span className="pm-delivery__card-status">{cardStatus(card)}</span>
          {card.spanSprints > 1 && (
            <span className="pm-delivery__span">spans {card.spanSprints} sprints</span>
          )}
          {card.isMilestone && <span className="pm-delivery__span">milestone</span>}
        </div>

        {isStaffed && (
          <div className="pm-delivery__assign-row">
            {assignedPeople.length > 0 ? (
              <span className="pm-delivery__avatars">
                {assignedPeople.map((person) => (
                  <span className="pm-delivery__avatar pm-delivery__avatar--small" key={person.id} title={person.name}>
                    {initials(person.name)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="pm-delivery__missing-assignment">Needs assignment</span>
            )}
            {onSetAssignments && (
              <button
                type="button"
                className="pm-delivery__inline-button"
                onClick={() => setItemPeople({ featureId: card.featureId, title: card.title })}
              >
                Assign
              </button>
            )}
          </div>
        )}

        {card.deliveryStatus === 'in_progress' && onSetPointsDone && (
          <label className="pm-delivery__done">
            <span>Done</span>
            <input
              type="number"
              min={0}
              max={card.effortPoints ?? undefined}
              step={1}
              value={card.effortPointsDone ?? ''}
              aria-label={`Points done for ${card.title}`}
              onChange={(event) => {
                const raw = event.target.value;
                const next = raw.trim() === '' ? null : Number(raw);
                if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
                onSetPointsDone(card.featureId, next);
              }}
            />
          </label>
        )}

        <div className="pm-delivery__card-actions">
          {onSetBlocker && (
            <button
              type="button"
              className={`pm-delivery__card-action${card.blocked ? ' is-risk' : ''}`}
              aria-pressed={card.blocked}
              onClick={() => {
                onSetBlocker(card.featureId, !card.blocked);
                announce(card.blocked ? `Cleared the blocker on ${card.title}.` : `Marked ${card.title} blocked.`);
              }}
            >
              {card.blocked ? 'Blocked' : 'Block'}
            </button>
          )}
          <button
            type="button"
            className="pm-delivery__card-action"
            onClick={() => {
              const outcome = onToggleMembership(card.featureId, false);
              const applied = (ok: boolean): void => {
                announce(ok ? `Returned ${card.title} to the Backlog.` : `Could not return ${card.title}.`);
              };
              if (outcome && typeof outcome.then === 'function') {
                void outcome.then(applied).catch(() => applied(false));
              } else {
                applied(true);
              }
            }}
          >
            Return
          </button>
        </div>
      </article>
    );
  };

  const renderBlock = (block: DeliveryBlock): React.ReactElement => {
    const blockIndex = projection.blocks.findIndex((candidate) => candidate.key === block.key);
    const canMoveEarlier = blockIndex > 0;
    const canMoveLater = blockIndex >= 0 && blockIndex < projection.blocks.length - 1;
    if (block.kind === 'parallel') {
      return (
        <div
          className={`pm-delivery__block pm-delivery__block--parallel${dropTargetKey === block.key ? ' is-drop-target' : ''}`}
          key={block.key}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTargetKey(block.key);
          }}
          onDrop={(event) => {
            setDropTargetKey(null);
            dropOnBlock(block, event);
          }}
        >
          <div className="pm-delivery__block-head">
            <span className="pm-delivery__drag" aria-hidden="true" {...blockDragProps(block)} title="Drag to move"><DragIcon /></span>
            <span className="pm-delivery__parallel-label">Parallel</span>
            <span className="pm-delivery__block-meta">{block.cards.length} features</span>
            <span className="pm-delivery__block-actions">
              <button
                type="button"
                className="pm-delivery__icon-button"
                aria-label={`Move ${block.label} earlier`}
                disabled={!canMoveEarlier}
                onClick={() => moveBlockEarlier(block)}
              >
                &larr;
              </button>
              <button
                type="button"
                className="pm-delivery__icon-button"
                aria-label={`Move ${block.label} later`}
                disabled={!canMoveLater}
                onClick={() => moveBlockLater(block)}
              >
                &rarr;
              </button>
              <button
                type="button"
                className="pm-delivery__inline-button"
                onClick={() => ungroup(block)}
              >
                Ungroup
              </button>
            </span>
          </div>
          <div className="pm-delivery__parallel-cards">
            {block.cards.map((card) => renderCard(card, true, block))}
          </div>
        </div>
      );
    }
    const card = block.cards[0];
    return (
      <div
        className={`pm-delivery__block${dropTargetKey === block.key ? ' is-drop-target' : ''}`}
        key={block.key}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDropTargetKey(block.key);
        }}
        onDrop={(event) => {
          setDropTargetKey(null);
          dropOnBlock(block, event);
        }}
      >
        <div className="pm-delivery__block-actions pm-delivery__block-actions--single">
          <span className="pm-delivery__drag" aria-hidden="true" {...blockDragProps(block)} title="Drag to move"><DragIcon /></span>
          <button
            type="button"
            className="pm-delivery__icon-button"
            aria-label={`Move ${block.label} earlier`}
            disabled={!canMoveEarlier}
            onClick={() => moveBlockEarlier(block)}
          >
            &larr;
          </button>
          <button
            type="button"
            className="pm-delivery__icon-button"
            aria-label={`Move ${block.label} later`}
            disabled={!canMoveLater}
            onClick={() => moveBlockLater(block)}
          >
            &rarr;
          </button>
        </div>
        {renderCard(card, false, block)}
      </div>
    );
  };

  const renderColumn = (column: DeliveryColumn): React.ReactElement => {
    const milestone = column.milestone;
    return (
      <section
        className={`pm-delivery__column${dropTargetKey === `column-${column.sprint}` ? ' is-drop-target' : ''}`}
        key={column.sprint}
        aria-label={`Sprint ${column.sprint}: ${milestone.label}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTargetKey(`column-${column.sprint}`);
        }}
        onDrop={(event) => {
          setDropTargetKey(null);
          dropOnColumn(column, event);
        }}
      >
        <div className="pm-delivery__column-head">
          <div className="pm-delivery__column-title">
            <span>Sprint {column.sprint}</span>
            <em>{milestone.dateRange}</em>
          </div>
          <span className="pm-delivery__column-cap">{milestone.capacity}/sprint</span>
          <div className={`pm-delivery__column-ships${milestone.ships ? '' : ' is-empty'}`}>
            {milestone.ships ? <PackageIcon /> : <AlertIcon />}
            <span>{milestone.ships ? 'Ships' : milestone.inProgressCount > 0 ? 'In progress' : 'No delivery'}</span>
            <b>{milestone.label}</b>
          </div>
        </div>

        <div className="pm-delivery__column-body">
          {column.blocks.map((block) => renderBlock(block))}
          {column.blocks.length > 0 && column.inProgress.length > 0 && (
            <div className="pm-delivery__inprogress-inline">
              In progress: {column.inProgress.slice(0, 3).map((card) => card.title).join(', ')}
              {column.inProgress.length > 3 ? ` +${column.inProgress.length - 3}` : ''}
            </div>
          )}
          {column.blocks.length === 0 && column.inProgress.length > 0 && (
            <div className="pm-delivery__inprogress">
              <span>In progress</span>
              {column.inProgress.slice(0, 3).map((card) => (
                <b key={card.featureId}>{card.title}</b>
              ))}
              {column.inProgress.length > 3 && <span>+{column.inProgress.length - 3}</span>}
            </div>
          )}
          {column.blocks.length === 0 && column.inProgress.length === 0 && (
            <div className="pm-delivery__column-empty">No delivery this sprint</div>
          )}
          <div className={`pm-delivery__dropzone${draggedKey || draggedBacklogId ? ' is-active' : ''}`}>
            {draggedBacklogId ? 'Drop to add to this sprint' : 'Drop work here'}
          </div>
        </div>
      </section>
    );
  };

  const rankedCount = plan?.selectedFeatureIds.length ?? 0;
  const titleForIssue = (id: string): string =>
    rows.find((row) => row.id === id)?.title ?? eligibleFeatures.find((feature) => feature.id === id)?.title ?? 'Untitled work';
  const firstIssue = result?.issues[0] ? issueText(result.issues[0], titleForIssue) : null;

  // The board is planned by hand; the whole-plan forecast's status belongs to List view.
  const livePlanBadge = null;

  const setupForm = (
    <section className="pm-delivery__setup" aria-label="Configure the forecast">
      <div className="pm-delivery__setup-head">
        <h3>Set the delivery baseline</h3>
        <p>Capacity, sprint length and start anchor turn ranked work into dates.</p>
      </div>
      <div className="pm-delivery__setup-grid">
        <label>
          <span>Points per sprint</span>
          <input
            type="number"
            min={0}
            step={1}
            value={setupDraft.pointsPerSprint}
            onChange={(event) => setSetupDraft((draft) => ({ ...draft, pointsPerSprint: event.target.value }))}
          />
        </label>
        <label>
          <span>Sprint length (days)</span>
          <input
            type="number"
            min={1}
            step={1}
            value={setupDraft.sprintLengthDays}
            onChange={(event) => setSetupDraft((draft) => ({ ...draft, sprintLengthDays: event.target.value }))}
          />
        </label>
        <label>
          <span>Start sprint</span>
          <input
            type="number"
            min={1}
            step={1}
            value={setupDraft.startSprintOrdinal}
            onChange={(event) => setSetupDraft((draft) => ({ ...draft, startSprintOrdinal: event.target.value }))}
          />
        </label>
        <label>
          <span>First date</span>
          <input
            type="date"
            value={setupDraft.startDate}
            onChange={(event) => setSetupDraft((draft) => ({ ...draft, startDate: event.target.value }))}
          />
        </label>
      </div>
      {setupError && <p className="pm-delivery__note pm-delivery__note--warn" role="alert">{setupError}</p>}
      <div className="pm-delivery__setup-actions">
        <button type="button" className="pm-delivery__button pm-delivery__button--primary" onClick={saveSetup}>
          Save baseline
        </button>
        <button type="button" className="pm-delivery__button" onClick={() => setSetupOpen(false)}>
          Cancel
        </button>
      </div>
    </section>
  );

  if (!plan) {
    return (
      <div className="pm-delivery">
        <DeliveryHeader
          displayLevel={displayLevel}
          isStaffed={isStaffed}
          onSetPolicy={onSetPolicy}
          onSwitchPolicy={switchPolicy}
          onSwitchView={onSwitchView}
          onOpenLevel={undefined}
          levelTriggerRef={levelTriggerRef}
          modeError={modeError}
          onDismissModeError={() => setModeError(null)}
          livePlanBadge={livePlanBadge}
        />
        <div className="pm-delivery__empty-state">
          {setupOpen ? (
            setupForm
          ) : levelOptions && onChoosePlanningLevel ? (
            <PlanningLevelStep
              options={levelOptions}
              onChoose={(level) => {
                onChoosePlanningLevel(level);
                openSetup();
              }}
            />
          ) : (
            <p className="pm-delivery__note">Configure a forecast to see the delivery board.</p>
          )}
        </div>
        {levelOpen && (
          <LevelDialog
            options={levelOptions}
            current={displayLevel}
            choice={levelChoice}
            onChange={setLevelChoice}
            onConfirm={confirmLevel}
            onClose={closeLevelDialog}
            firstRef={levelFirstRef}
          />
        )}
        <div className="pm-delivery__sr-only" role="status" aria-live="polite">
          <span key={announcement.seq}>{announcement.text}</span>
        </div>
      </div>
    );
  }

  if (!configComplete) {
    return (
      <div className="pm-delivery">
        <DeliveryHeader
          displayLevel={displayLevel}
          isStaffed={isStaffed}
          onSetPolicy={onSetPolicy}
          onSwitchPolicy={switchPolicy}
          onSwitchView={onSwitchView}
          onOpenLevel={onSetPlanningLevel ? openLevelDialog : undefined}
          levelTriggerRef={levelTriggerRef}
          modeError={modeError}
          onDismissModeError={() => setModeError(null)}
          livePlanBadge={livePlanBadge}
        />
        {!setupOpen ? (
          <div className="pm-delivery__empty-state">
            <p className="pm-delivery__empty-title">Finish the plan configuration</p>
            <p className="pm-delivery__note">
              The board needs capacity, sprint length and a start anchor before it can place work.
            </p>
            <button type="button" className="pm-delivery__button pm-delivery__button--primary" onClick={openSetup}>
              Configure plan
            </button>
          </div>
        ) : (
          setupForm
        )}
        <div className="pm-delivery__sr-only" role="status" aria-live="polite">
          <span key={announcement.seq}>{announcement.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pm-delivery">
      <div className="pm-delivery__sr-only" role="status" aria-live="polite">
        <span key={announcement.seq}>{announcement.text}</span>
      </div>

      <DeliveryHeader
        displayLevel={displayLevel}
        isStaffed={isStaffed}
        onSetPolicy={onSetPolicy}
        onSwitchPolicy={switchPolicy}
        onSwitchView={onSwitchView}
        onOpenLevel={onSetPlanningLevel ? openLevelDialog : undefined}
        levelTriggerRef={levelTriggerRef}
        modeError={modeError}
        onDismissModeError={() => setModeError(null)}
        livePlanBadge={livePlanBadge}
      />

      {dropError && (
        <div className="pm-delivery__banner" role="alert">
          <span>{dropError}</span>
          <button type="button" className="pm-delivery__inline-button" onClick={() => setDropError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {sprintBoard ? (
        <section className="pm-delivery__outcome" aria-label="Sprint plan outcome">
          <div className="pm-delivery__launch">
            <span className="pm-delivery__eyebrow">Projected launch</span>
            {sprintBoard.launchSprint !== null ? (
              <>
                <strong>Sprint {sprintBoard.launchSprint}</strong>
                <span className="pm-delivery__launch-date">
                  {sprintBoard.launchDate ? `${readableForecastDate(sprintBoard.launchDate)} \u00b7 ${sprintBoard.launchDate}` : ''}
                </span>
                <span className="pm-delivery__launch-note">
                  {waiting > 0
                    ? `${waiting} item${waiting === 1 ? ' is' : 's are'} not in a sprint yet.`
                    : 'Every item in the plan has a sprint.'}
                </span>
              </>
            ) : (
              <>
                <strong>Nothing scheduled</strong>
                <span className="pm-delivery__launch-note">Drag Backlog work into a sprint to start the plan.</span>
              </>
            )}
          </div>

          <div className="pm-delivery__milestones-wrap">
            <div className="pm-delivery__milestones-head">
              <span><b>What ships</b> &middot; by sprint</span>
              <span className="pm-delivery__milestones-meta">
                {`Today \u00b7 ${readableForecastDate(asOfDate)} \u00b7 ${sprintBoard.scheduledPoints} pts scheduled \u00b7 team ${sprintBoard.teamCapacity}/sprint`}
              </span>
            </div>
            <div className="pm-delivery__milestones">
              {sprintBoard.columns
                .slice(boardPage * SPRINTS_PER_PAGE, boardPage * SPRINTS_PER_PAGE + SPRINTS_PER_PAGE)
                .map((column) => {
                  const ships = column.finishing.length > 0;
                  const isLast = column.sprint === sprintBoard.launchSprint;
                  const names = column.finishing.map((card) => card.title);
                  return (
                    <div
                      key={column.sprint}
                      className={`pm-delivery__milestone${ships ? '' : ' is-empty'}${isLast ? ' is-last' : ''}`}
                    >
                      <div className="pm-delivery__milestone-head">
                        <span>Sprint {column.sprint}</span>
                        <span className="pm-delivery__milestone-date">{column.dateRange}</span>
                        <span className="pm-delivery__milestone-cap">
                          {column.placedPoints + column.forecastPoints}/{column.capacity}
                        </span>
                      </div>
                      <div className="pm-delivery__milestone-ship">
                        <span className={`pm-delivery__ships-pill${ships ? '' : ' is-empty'}`}>
                          {ships ? <><PackageIcon /> Ships</> : column.continuing.length > 0 || column.cards.length > 0 ? 'In progress' : 'No delivery'}
                        </span>
                      </div>
                      <div className="pm-delivery__milestone-name">
                        {ships ? `${names.slice(0, 2).join(' + ')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : '\u00a0'}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          <div className="pm-delivery__verdict">
            {waiting > 0 ? (
              <span className="pm-delivery__verdict-chip">
                <AlertIcon /> {waiting} not in a sprint
              </span>
            ) : (
              <span className="pm-delivery__verdict-chip is-ok">All scheduled</span>
            )}
            <p>
              {sprintBoard.held.length > 0
                ? `${sprintBoard.held[0].title}: ${sprintBoard.held[0].held}`
                : sprintBoard.unscheduled.length > 0
                  ? 'Drag work from the Backlog into a sprint. Nothing goes into a sprint on its own.'
                  : 'Every item in the plan is in a sprint.'}
            </p>
          </div>
        </section>
      ) : (
      <section className="pm-delivery__outcome" aria-label="Forecast outcome">
        <div className="pm-delivery__launch">
          <span className="pm-delivery__eyebrow">Projected launch</span>
          {stale ? (
            <>
              <strong>{resultPending ? 'Updating...' : 'Unavailable'}</strong>
              <span className="pm-delivery__launch-note">
                {resultPending ? 'The previous forecast is hidden until the update settles.' : resultError}
              </span>
            </>
          ) : showReady && explanation.answer ? (
            <>
              <strong>Sprint {explanation.answer.sprint}</strong>
              <span className="pm-delivery__launch-date">{explanation.answer.date} &middot; {explanation.answer.isoDate}</span>
              <span className="pm-delivery__launch-note">
                {result?.state === 'conditional' ? 'Conditional date. No delay is assumed.' : 'Capacity-derived.'}
              </span>
            </>
          ) : (
            <>
              <strong>{result ? resultStateLabel(result.state) : 'No forecast yet'}</strong>
              <span className="pm-delivery__launch-note">
                {firstIssue ?? 'Add work and finish the plan configuration.'}
              </span>
            </>
          )}
        </div>

        <div className="pm-delivery__milestones-wrap">
          <div className="pm-delivery__milestones-head">
            <span><b>What ships</b> &middot; by sprint</span>
            <span className="pm-delivery__milestones-meta">
              {projection.axis
                ? `${result?.arithmetic?.asOfDate ? `Today \u00b7 ${readableForecastDate(result.arithmetic.asOfDate)}` : 'Today'} \u00b7 ${projection.milestones.length} sprints \u00b7 ${projection.totalPoints} effort \u00b7 ${projection.capacity}/sprint`
                : 'Timeline withheld'}
            </span>
          </div>
          {showReady && visibleMilestones.length > 0 ? (
            <>
              <div className="pm-delivery__milestones">
                {visibleColumns.map((column) => renderMilestone(column))}
              </div>
              {pageCount > 1 && (
                <div className="pm-delivery__pager">
                  <button
                    type="button"
                    className="pm-delivery__inline-button"
                    disabled={sprintPage === 0}
                    onClick={() => setSprintPage((page) => Math.max(0, page - 1))}
                  >
                    &larr; Earlier sprints
                  </button>
                  <span>
                    Sprints {visibleMilestones[0]?.sprint ?? pageStart + 1}-{visibleMilestones[visibleMilestones.length - 1]?.sprint ?? pageStart + SPRINTS_PER_PAGE} of {projection.axis?.completionSprint ?? projection.milestones.length}
                  </span>
                  <button
                    type="button"
                    className="pm-delivery__inline-button"
                    disabled={sprintPage >= pageCount - 1}
                    onClick={() => setSprintPage((page) => Math.min(pageCount - 1, page + 1))}
                  >
                    Later sprints &rarr;
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="pm-delivery__note">
              {resultPending
                ? 'Updating the delivery timeline...'
                : resultError ?? (noUpcomingDelivery
                  ? 'All ranked work is in the past as of today.'
                  : 'The delivery timeline is not available yet.')}
            </p>
          )}
        </div>

        <div className="pm-delivery__verdict">
          {result?.state === 'conditional' ? (
            <span className="pm-delivery__verdict-chip">
              <AlertIcon /> Conditional
            </span>
          ) : result?.state === 'ready' ? (
            <span className="pm-delivery__verdict-chip is-ok">On track</span>
          ) : (
            <span className="pm-delivery__verdict-chip is-neutral">{result ? resultStateLabel(result.state) : 'No forecast'}</span>
          )}
          <p>
            {result?.state === 'conditional'
              ? `${plan.blockedFeatureIds.length} blocked feature${plan.blockedFeatureIds.length === 1 ? '' : 's'}. The date holds.`
              : explanation.reasons[0]?.text ?? firstIssue ?? 'Rank features, then watch the launch date and delivery order.'}
          </p>
        </div>
      </section>
      )}

      <div className="pm-delivery__body">
        <div className="pm-delivery__rail">
          <DeliveryTeamPanel
            plan={plan}
            result={stale ? null : result}
            onSaveConfiguration={onSaveConfiguration}
            onOpenPeople={
              onAddPerson && onUpdatePerson && onRemovePerson
                ? () => setPeopleEditorOpen(true)
                : undefined
            }
          />
        </div>

        <div className="pm-delivery__work">
          <div className="pm-delivery__board-head">
            <span className="pm-delivery__board-title">{sprintBoard ? 'Sprints' : 'Delivery order'}</span>
            <span className="pm-delivery__board-desc">
              {sprintBoard
                ? 'Drag cards from the Backlog into a sprint. A sprint takes work until it is full.'
                : showReady
                  ? 'Sprint columns left to right; features top to bottom.'
                  : 'Work in plan; resolve the inputs to place it on the timeline.'}
            </span>
            <span className="pm-delivery__board-meta">
              {rankedCount > 0 ? `01 \u2192 ${String(rankedCount).padStart(2, '0')}` : 'No ranked work'}
              <span className="pm-delivery__board-hint">
                {sprintBoard
                  ? 'Only cards you drag in are in a sprint'
                  : showReady ? 'Drag from the Backlog or between sprints' : 'Set estimates and assignments'}
              </span>
            </span>
          </div>

          {selectedIds.size > 0 && (
            <div className="pm-delivery__selection-bar" role="status">
              <span>{selectedIds.size} selected</span>
              <span className="pm-delivery__selection-note">
                {canGroup
                  ? 'Adjacent features can run in parallel.'
                  : selectedGroups.length > 0
                    ? 'Ungroup the existing parallel group first.'
                    : 'Select adjacent features to group them.'}
              </span>
              <button
                type="button"
                className="pm-delivery__button pm-delivery__button--small"
                onClick={groupSelection}
                disabled={!canGroup}
              >
                Run in parallel
              </button>
              <button
                type="button"
                className="pm-delivery__inline-button"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </div>
          )}

          {sprintBoard ? (
            <SprintBoard
              board={sprintBoard}
              levelLabel={levelLabel(displayLevel)}
              backlogItems={(backlogItems ?? []) as readonly BacklogItem[]}
              deliveredIds={deliveredIds}
              isStaffed={isStaffed}
              roster={plan.roster}
              page={boardPage}
              onPageChange={setBoardPage}
              onSetSprintPlan={onSetSprintPlan}
              onAdd={(id) => onToggleMembership(id, true)}
              onRemove={(id) => onToggleMembership(id, false)}
              onSetEffort={onSetEffort}
              onSetPointsDone={onSetPointsDone}
              onSetBlocker={onSetBlocker}
              onAssign={onSetAssignments ? (featureId, title) => setItemPeople({ featureId, title }) : undefined}
              onAnnounce={announce}
              onError={setDropError}
            />
          ) : (
          <div
            className="pm-delivery__grid"
            style={{ gridTemplateColumns: `196px repeat(${Math.max(visibleColumns.length, 1)}, minmax(170px, 1fr))` }}
          >
            {backlogItems ? (
              <DeliveryBacklog
                levelLabel={levelLabel(displayLevel)}
                items={backlogItems as readonly BacklogItem[]}
                onAdd={(id) => onToggleMembership(id, true)}
                onDragItemStart={
                  showReady && onSetForecastSequence
                    ? (id) => {
                        setDraggedKey(null);
                        setDraggedBacklogId(id);
                      }
                    : undefined
                }
                onDragItemEnd={() => {
                  setDraggedBacklogId(null);
                  setDropTargetKey(null);
                }}
                onSetPoints={onSetEffort}
                onAnnounce={announce}
              />
            ) : (
              <section className="pm-delivery__backlog" aria-label="Backlog">
                <p className="pm-delivery__note">No Backlog available.</p>
              </section>
            )}
            {showReady && visibleColumns.length > 0 ? (
              visibleColumns.map((column) => renderColumn(column))
            ) : !showReady && rankedCount > 0 ? (
              <div className="pm-delivery__attention">
                <div className="pm-delivery__attention-copy">
                  <strong>Work in plan</strong>
                  <span>
                    {resultPending
                      ? 'Updating the delivery timeline...'
                      : firstIssue ?? 'Resolve the forecast inputs to place this work on the timeline.'}
                  </span>
                  {onSwitchView && (
                    <button type="button" className="pm-delivery__inline-button" onClick={onSwitchView}>
                      Resolve in List view
                    </button>
                  )}
                </div>
                <div className="pm-delivery__attention-grid">
                  {fallbackCards.map((card) => renderCard(card, false))}
                </div>
              </div>
            ) : (
              <div className="pm-delivery__board-empty">
                <p className="pm-delivery__empty-title">
                  {noUpcomingDelivery
                    ? 'No upcoming delivery'
                    : result?.state === 'empty'
                      ? 'No features selected'
                      : 'No delivery timeline yet'}
                </p>
                <p className="pm-delivery__note">
                  {noUpcomingDelivery
                    ? 'All ranked work is in the past as of today. Open List view to review the timeline.'
                    : resultPending
                      ? 'Updating the delivery timeline...'
                      : result?.state === 'empty'
                        ? 'Add work from the Backlog to start the delivery plan.'
                        : firstIssue ?? 'Resolve the forecast inputs to place work on the timeline.'}
                </p>
                {onSwitchView && (noUpcomingDelivery || result?.state !== 'empty') && (
                  <button type="button" className="pm-delivery__button" onClick={onSwitchView}>
                    Resolve in List view
                  </button>
                )}
              </div>
            )}
          </div>
          )}

          <div className="pm-delivery__board-foot">
            <span>
              {sprintBoard
                ? 'A card waits for anything that unlocks it: that work has to finish in an earlier sprint. Blocked cards stay in the Backlog.'
                : 'Order changes what ships when. Capacity or scope changes the date.'}
            </span>
          </div>
        </div>
      </div>

      {setupOpen && setupForm}

      {onAddPerson && onUpdatePerson && onRemovePerson && (
        <PeopleEditor
          isOpen={peopleEditorOpen}
          onClose={() => setPeopleEditorOpen(false)}
          roster={plan.roster}
          assignments={plan.assignments}
          items={eligibleFeatures.map((feature) => ({ id: feature.id, title: feature.title }))}
          pointsPerSprint={plan.configuration.pointsPerSprint}
          onAddPerson={onAddPerson}
          onUpdatePerson={onUpdatePerson}
          onRemovePerson={onRemovePerson}
        />
      )}

      {itemPeople && onSetAssignments && (
        <ItemPeopleEditor
          isOpen
          onClose={() => setItemPeople(null)}
          featureId={itemPeople.featureId}
          featureTitle={itemPeople.title}
          roster={plan.roster}
          currentPersonIds={plan.assignments?.[itemPeople.featureId] ?? []}
          onSaveAssignments={onSetAssignments}
          onOpenRoster={() => {
            setItemPeople(null);
            setPeopleEditorOpen(true);
          }}
        />
      )}

      {levelOpen && (
        <LevelDialog
          options={levelOptions}
          current={displayLevel}
          choice={levelChoice}
          onChange={setLevelChoice}
          onConfirm={confirmLevel}
          onClose={closeLevelDialog}
          firstRef={levelFirstRef}
        />
      )}
    </div>
  );
}

interface DeliveryHeaderProps {
  readonly displayLevel: PlanningLevel;
  readonly isStaffed: boolean;
  readonly onSetPolicy?: (policy: ForecastPolicyVersion) => Promise<boolean>;
  readonly onSwitchPolicy: (policy: ForecastPolicyVersion) => Promise<void>;
  readonly onSwitchView?: () => void;
  readonly onOpenLevel?: () => void;
  readonly levelTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  readonly modeError: string | null;
  readonly onDismissModeError?: () => void;
  readonly livePlanBadge: React.ReactNode;
}

function DeliveryHeader({
  displayLevel,
  isStaffed,
  onSetPolicy,
  onSwitchPolicy,
  onSwitchView,
  onOpenLevel,
  levelTriggerRef,
  modeError,
  onDismissModeError,
  livePlanBadge,
}: DeliveryHeaderProps): React.ReactElement {
  return (
    <>
      <header className="pm-delivery__header">
        <div>
          <h2>Delivery board</h2>
          <p>Plan sprints by hand: drag work in, sprint by sprint. Use List view for forecasts and scenarios.</p>
        </div>
        <div className="pm-delivery__header-actions">
          {livePlanBadge && <span className="pm-delivery__live-chip-wrap">{livePlanBadge}</span>}
          <span className="pm-delivery__level-chip">
            Level: <b>{levelLabel(displayLevel)}</b>
            {onOpenLevel && (
              <button ref={levelTriggerRef} type="button" className="pm-delivery__inline-button" onClick={onOpenLevel}>
                Change
              </button>
            )}
          </span>
          {onSetPolicy && (
            <label className="pm-delivery__mode">
              <span>Mode</span>
              <select
                value={isStaffed ? 'staffed-capacity-v1' : 'shared-capacity-v1'}
                aria-label="Forecast calculation mode"
                onChange={(event) => {
                  void onSwitchPolicy(event.target.value as ForecastPolicyVersion);
                }}
              >
                <option value="shared-capacity-v1">Whole team</option>
                <option value="staffed-capacity-v1">Assigned people</option>
              </select>
            </label>
          )}
          {onSwitchView && (
            <button type="button" className="pm-delivery__button" onClick={onSwitchView}>
              List view
            </button>
          )}
        </div>
      </header>
      {modeError && (
        <div className="pm-delivery__banner" role="alert">
          <span>{modeError}</span>
          {onDismissModeError && (
            <button type="button" className="pm-delivery__inline-button" onClick={onDismissModeError}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </>
  );
}

interface LevelDialogProps {
  readonly options?: readonly PlanningLevelOption[];
  readonly current: PlanningLevel;
  readonly choice: PlanningLevel;
  readonly onChange: (level: PlanningLevel) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly firstRef: React.RefObject<HTMLInputElement | null>;
}

function LevelDialog({
  options,
  current,
  choice,
  onChange,
  onConfirm,
  onClose,
  firstRef,
}: LevelDialogProps): React.ReactElement {
  const levels: readonly PlanningLevel[] = ['Theme', 'Component', 'Feature'];
  return (
    <div className="pm-delivery__dialog-backdrop" onClick={onClose}>
      <div
        className="pm-delivery__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Switch planning level"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]',
            ),
          );
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
        <h3>Switch planning level?</h3>
        <p>
          Switching clears the current ranking, parallel groups, blockers and assignments. Roster,
          capacity and mode are preserved.
        </p>
        <div className="pm-delivery__level-options" role="radiogroup" aria-label="New planning level">
          {levels.map((level) => {
            const option = options?.find((candidate) => candidate.level === level);
            const disabled = option ? !option.enabled : level !== 'Feature';
            return (
              <label key={level} className="pm-delivery__level-option">
                <input
                  ref={level === current ? firstRef : undefined}
                  type="radio"
                  name="pm-delivery-level"
                  checked={choice === level}
                  disabled={disabled}
                  onChange={() => onChange(level)}
                />
                <span>{levelLabel(level)}</span>
                {option && <em>{option.count} available</em>}
              </label>
            );
          })}
        </div>
        <div className="pm-delivery__dialog-actions">
          <button
            type="button"
            className="pm-delivery__button pm-delivery__button--primary"
            onClick={onConfirm}
            disabled={choice === current}
          >
            Switch level
          </button>
          <button type="button" className="pm-delivery__button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

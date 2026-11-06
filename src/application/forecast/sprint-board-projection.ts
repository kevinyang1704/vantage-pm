/**
 * Sprint board projection (Delivery Board sprint plan).
 *
 * Pure view model: turns the plan's scope, its sprint plan (hand placements
 * and per-sprint capacities), the items' estimates and delivery status, and
 * the unlock edges between items into sprint columns. Which sprint each item
 * lands in comes from `calculateSprintPlacement`; this module only adds dates,
 * titles and the reasons an item is held back, in words.
 */

import type { ForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import { createForecastSprintPlan } from '../../domain/forecast/forecast-plan.entity';
import { addDays } from '../../domain/forecast/forecast-allocation';
import {
  calculateSprintPlacement,
  evaluateSprintPlanChange,
  type HoldReason,
  type SprintDependency,
  type SprintPlacementInput,
  type SprintPlanVerdict,
} from '../../domain/forecast/sprint-placement.policy';
import { readableForecastDate } from './forecast-timeline';

export type SprintBoardRow = Readonly<{
  id: string;
  title: string;
  effortPoints: number | null;
  effortPointsDone?: number | null;
  deliveryStatus?: 'not_started' | 'in_progress' | 'delivered';
  /** In the plan's scope. Rows outside it only matter as dependencies. */
  included: boolean;
  invalid?: boolean;
}>;

export type SprintBoardCard = Readonly<{
  id: string;
  title: string;
  /** 1-based rank in the plan's scope. */
  rank: number;
  effortPoints: number | null;
  remainingPoints: number | null;
  effortPointsDone: number | null;
  deliveryStatus: 'not_started' | 'in_progress' | 'delivered' | null;
  blocked: boolean;
  /** 'placed' = dropped into a sprint by hand. Nothing is auto-filled on the board. */
  source: 'placed' | 'forecast' | null;
  startSprint: number | null;
  finishSprint: number | null;
  /** Points in each sprint the card occupies. */
  slices: readonly Readonly<{ sprint: number; points: number }>[];
  /** Titles of the items this card waits for. */
  dependsOn: readonly string[];
  held: string | null;
  assignedPersonIds: readonly string[];
}>;

export type SprintBoardColumn = Readonly<{
  sprint: number;
  startDate: string;
  endDate: string;
  dateRange: string;
  capacity: number;
  overridden: boolean;
  placedPoints: number;
  forecastPoints: number;
  /** No room left for another hand-placed card. */
  full: boolean;
  /** Cards that start in this sprint. */
  cards: readonly SprintBoardCard[];
  /** Cards started earlier that carry into this sprint. */
  continuing: readonly Readonly<{ card: SprintBoardCard; points: number }>[];
  /** Cards that finish in this sprint. */
  finishing: readonly SprintBoardCard[];
}>;

export type SprintBoardProjection = Readonly<{
  firstSprint: number;
  teamCapacity: number;
  columns: readonly SprintBoardColumn[];
  /** In the plan but cannot go in a sprint yet, each with the reason. */
  held: readonly SprintBoardCard[];
  /** In the plan, free to schedule, not in a sprint yet: waiting to be dragged in. */
  unscheduled: readonly SprintBoardCard[];
  delivered: readonly SprintBoardCard[];
  /** The last sprint with scheduled work, or null when nothing is scheduled. */
  launchSprint: number | null;
  launchDate: string | null;
  scheduledPoints: number;
  input: SprintPlacementInput;
  cards: ReadonlyMap<string, SprintBoardCard>;
}>;

export type SprintBoardInput = Readonly<{
  plan: ForecastPlan;
  rows: readonly SprintBoardRow[];
  unlockEdges: readonly Readonly<{ sourceNodeId: string; targetNodeId: string }>[];
  /** Team points per sprint; null falls back to the plan's configuration. */
  teamCapacity?: number | null;
  /** Today, as YYYY-MM-DD: sprints before the one holding it are in the past. */
  asOfDate: string;
  /** Sprints to show at least, from the current one (default 8: two pages). */
  minColumns?: number;
}>;

const DAY_MS = 86_400_000;

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

/** The sprint ordinal holding `asOfDate`, never before the plan's start sprint. */
export function currentSprintOrdinal(plan: ForecastPlan, asOfDate: string): number | null {
  const { startDate, startSprintOrdinal, sprintLengthDays } = plan.configuration;
  if (startDate === null || startSprintOrdinal === null || sprintLengthDays === null || sprintLengthDays <= 0) return null;
  const elapsed = daysBetween(startDate, asOfDate);
  if (elapsed <= 0) return startSprintOrdinal;
  return startSprintOrdinal + Math.floor(elapsed / sprintLengthDays);
}

export function sprintStartDate(plan: ForecastPlan, sprint: number): string | null {
  const { startDate, startSprintOrdinal, sprintLengthDays } = plan.configuration;
  if (startDate === null || startSprintOrdinal === null || sprintLengthDays === null) return null;
  return addDays(startDate, (sprint - startSprintOrdinal) * sprintLengthDays);
}

function remainingOf(row: SprintBoardRow | undefined): number | null {
  if (!row || row.invalid || row.effortPoints === null) return null;
  if (row.deliveryStatus === 'in_progress' && typeof row.effortPointsDone === 'number') {
    return Math.max(row.effortPoints - row.effortPointsDone, 0);
  }
  return row.effortPoints;
}

/** Plain-language reason a card is held back or a drop was refused. */
export function describeHold(
  reason: HoldReason | Readonly<{ kind: 'delivered' }> | Readonly<{ kind: 'past'; sprint: number }>,
  titleOf: (id: string) => string,
): string {
  const names = (ids: readonly string[]) => ids.map(titleOf).join(', ');
  switch (reason.kind) {
    case 'blocked':
      return 'Blocked. Clear the blocker before putting it in a sprint.';
    case 'unestimated':
      return 'Needs an estimate before it can go in a sprint.';
    case 'waiting':
      return `Waiting on ${names(reason.on)}. That has to be in an earlier sprint first.`;
    case 'outside':
      return `Depends on ${names(reason.on)}, which is not in the plan.`;
    case 'cycle':
      return `Its dependencies loop back to it${reason.on.length > 0 ? ` (${names(reason.on)})` : ''}.`;
    case 'full':
      return `Sprint ${reason.sprint} is full.`;
    case 'overflow':
      return `Doesn't fit: Sprint ${reason.sprint} has no room for the rest of it.`;
    case 'no-room':
      return 'No sprint has room for it.';
    case 'delivered':
      return 'Already delivered.';
    case 'past':
      return `Sprint ${reason.sprint} is in the past.`;
    default:
      return 'Cannot be placed.';
  }
}

export function buildSprintBoard(input: SprintBoardInput): SprintBoardProjection | null {
  const { plan, rows, unlockEdges, asOfDate } = input;
  const firstSprint = currentSprintOrdinal(plan, asOfDate);
  const teamCapacity = input.teamCapacity ?? plan.configuration.pointsPerSprint;
  if (firstSprint === null || teamCapacity === null || plan.configuration.sprintLengthDays === null) return null;

  const sprintPlan = createForecastSprintPlan(plan.sprintPlan);
  const rowById = new Map(rows.map((row) => [row.id, row] as const));
  const inScope = new Set(plan.selectedFeatureIds);
  const blocked = new Set(plan.blockedFeatureIds);
  const titleOf = (id: string): string => rowById.get(id)?.title || 'Untitled work';

  const outsideItems = new Map<string, { delivered: boolean }>();
  for (const row of rows) {
    if (!inScope.has(row.id)) outsideItems.set(row.id, { delivered: row.deliveryStatus === 'delivered' });
  }
  const dependencies: SprintDependency[] = unlockEdges
    .filter((edge) => rowById.has(edge.sourceNodeId) && inScope.has(edge.targetNodeId))
    .map((edge) => ({ sourceId: edge.sourceNodeId, targetId: edge.targetNodeId }));

  const placementInput: SprintPlacementInput = {
    items: plan.selectedFeatureIds.map((id) => {
      const row = rowById.get(id);
      return {
        id,
        points: remainingOf(row),
        delivered: row?.deliveryStatus === 'delivered',
        blocked: blocked.has(id),
      };
    }),
    outsideItems,
    dependencies,
    teamCapacity,
    capacities: sprintPlan.capacities,
    placements: sprintPlan.placements,
    firstSprint,
    // Only work dragged into a sprint is in it; the rest waits in the Backlog.
    autoFill: false,
  };
  const placement = calculateSprintPlacement(placementInput);

  const cards = new Map<string, SprintBoardCard>();
  plan.selectedFeatureIds.forEach((id, index) => {
    const row = rowById.get(id);
    const allocation = placement.allocations.get(id);
    const hold = placement.held.get(id);
    cards.set(
      id,
      Object.freeze({
        id,
        title: titleOf(id),
        rank: index + 1,
        effortPoints: row?.effortPoints ?? null,
        remainingPoints: remainingOf(row),
        effortPointsDone: row?.effortPointsDone ?? null,
        deliveryStatus: row?.deliveryStatus ?? null,
        blocked: blocked.has(id),
        source: allocation?.source ?? null,
        startSprint: allocation?.startSprint ?? null,
        finishSprint: allocation?.finishSprint ?? null,
        slices: allocation?.slices ?? Object.freeze([]),
        dependsOn: Object.freeze(dependencies.filter((edge) => edge.targetId === id).map((edge) => titleOf(edge.sourceId))),
        held: hold ? describeHold(hold, titleOf) : null,
        assignedPersonIds: Object.freeze([...(plan.assignments?.[id] ?? [])]),
      }),
    );
  });

  const loads = new Map(placement.sprints.map((load) => [load.sprint, load] as const));
  const hasWork = placement.allocations.size > 0;
  const launchSprint = hasWork ? placement.lastSprint : null;
  const lastColumn = Math.max(
    (launchSprint ?? firstSprint) + 1,
    firstSprint + Math.max((input.minColumns ?? 8) - 1, 0),
  );
  const sprintLength = plan.configuration.sprintLengthDays;
  const columns: SprintBoardColumn[] = [];
  for (let sprint = firstSprint; sprint <= lastColumn; sprint += 1) {
    const startDate = sprintStartDate(plan, sprint) ?? asOfDate;
    const endDate = addDays(startDate, Math.max(sprintLength - 1, 0));
    const load = loads.get(sprint);
    const override = sprintPlan.capacities[String(sprint)];
    const capacity = typeof override === 'number' ? override : teamCapacity;
    const columnCards = [...cards.values()]
      .filter((card) => card.startSprint === sprint)
      .sort((a, b) => (a.source === b.source ? a.rank - b.rank : a.source === 'placed' ? -1 : 1));
    const continuing = [...cards.values()]
      .filter((card) => card.startSprint !== null && card.startSprint < sprint)
      .flatMap((card) => {
        const slice = card.slices.find((candidate) => candidate.sprint === sprint);
        return slice ? [Object.freeze({ card, points: slice.points })] : [];
      });
    const placedPoints = load?.placedPoints ?? 0;
    columns.push(
      Object.freeze({
        sprint,
        startDate,
        endDate,
        dateRange: `${readableForecastDate(startDate)} - ${readableForecastDate(endDate)}`,
        capacity,
        overridden: typeof override === 'number',
        placedPoints,
        forecastPoints: load?.forecastPoints ?? 0,
        full: capacity - placedPoints <= 0,
        cards: Object.freeze(columnCards),
        continuing: Object.freeze(continuing),
        finishing: Object.freeze([...cards.values()].filter((card) => card.finishSprint === sprint)),
      }),
    );
  }

  const held = [...cards.values()].filter((card) => card.held !== null && card.deliveryStatus !== 'delivered');
  const unscheduled = [...cards.values()].filter(
    (card) => card.held === null && card.source === null && card.deliveryStatus !== 'delivered',
  );
  const delivered = [...cards.values()].filter((card) => card.deliveryStatus === 'delivered');
  const launchStart = launchSprint !== null ? sprintStartDate(plan, launchSprint) : null;
  let scheduledPoints = 0;
  for (const allocation of placement.allocations.values()) {
    for (const slice of allocation.slices) scheduledPoints += slice.points;
  }

  return Object.freeze({
    firstSprint,
    teamCapacity,
    columns: Object.freeze(columns),
    held: Object.freeze(held),
    unscheduled: Object.freeze(unscheduled),
    delivered: Object.freeze(delivered),
    launchSprint,
    launchDate: launchStart ? addDays(launchStart, Math.max(sprintLength - 1, 0)) : null,
    scheduledPoints,
    input: placementInput,
    cards,
  });
}

/**
 * Check dropping `itemId` into `sprint`. An item not in the plan yet is
 * treated as appended to the end of the scope, the way adding it would.
 */
export function evaluateSprintDrop(
  board: SprintBoardProjection,
  item: Readonly<{ id: string; points: number | null; delivered: boolean; blocked: boolean }>,
  sprint: number,
): SprintPlanVerdict {
  const known = board.input.items.some((candidate) => candidate.id === item.id);
  const input: SprintPlacementInput = known
    ? board.input
    : {
        ...board.input,
        items: [...board.input.items, item],
        outsideItems: new Map([...(board.input.outsideItems ?? new Map())].filter(([id]) => id !== item.id)),
      };
  return evaluateSprintPlanChange(
    input,
    { placements: board.input.placements, capacities: board.input.capacities },
    { itemId: item.id, sprint },
  );
}

/** Check setting a sprint's capacity (null = back to the team capacity). */
export function evaluateSprintCapacity(
  board: SprintBoardProjection,
  sprint: number,
  points: number | null,
): SprintPlanVerdict {
  const capacities: Record<string, number> = { ...board.input.capacities };
  if (points === null) delete capacities[String(sprint)];
  else capacities[String(sprint)] = points;
  return evaluateSprintPlanChange(board.input, { placements: board.input.placements, capacities });
}

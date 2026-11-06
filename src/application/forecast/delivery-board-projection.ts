/**
 * Delivery Board projection (design direction A, refined v2).
 *
 * Pure view model over one acknowledged `ForecastResult` + `ForecastPlan`.
 * The board groups the ranked scope into execution blocks, then places each
 * block in the sprint where the block finishes. A parallel block keeps its
 * members together and delivers in its latest member's completion sprint.
 * No arithmetic is performed here beyond deriving date ranges from the
 * result's existing arithmetic.
 */

import type { ForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../domain/forecast/forecast-result';
import type { FeatureTimeline } from '../../domain/forecast/forecast-allocation';
import { addDays, partitionBlocks } from '../../domain/forecast/forecast-allocation';
import { readableForecastDate, timelineAxis, type TimelineAxis } from './forecast-timeline';

export type DeliverySourceRow = Readonly<{
  id: string;
  title: string;
  effortPoints: number | null;
  effortPointsDone?: number | null;
  deliveryStatus?: 'not_started' | 'in_progress' | 'delivered';
  invalid?: boolean;
}>;

export type DeliveryCard = Readonly<{
  featureId: string;
  title: string;
  /** 1-based rank in the plan's ordered scope. */
  rank: number;
  effortPoints: number | null;
  effortPointsDone: number | null;
  deliveryStatus: 'not_started' | 'in_progress' | 'delivered' | null;
  invalid: boolean;
  blocked: boolean;
  parallelGroupIndex: number | null;
  startSprint: number | null;
  finishSprint: number | null;
  startDate: string | null;
  finishDate: string | null;
  spanSprints: number;
  assignedPersonIds: readonly string[];
  isMilestone: boolean;
  withheldReason: string | null;
}>;

export type DeliveryBlock = Readonly<{
  key: string;
  kind: 'singleton' | 'parallel';
  groupIndex: number | null;
  featureIds: readonly string[];
  cards: readonly DeliveryCard[];
  /** Sprint where the whole block finishes; null when timelines are withheld. */
  deliverySprint: number | null;
  startSprint: number | null;
  blocked: boolean;
  label: string;
  withheld: boolean;
}>;

export type DeliveryMilestone = Readonly<{
  sprint: number;
  startDate: string;
  endDate: string;
  dateRange: string;
  label: string;
  ships: boolean;
  deliveredBlockCount: number;
  featureCount: number;
  blockedCount: number;
  inProgressCount: number;
  capacity: number;
}>;

export type DeliveryColumn = Readonly<{
  sprint: number;
  startDate: string;
  endDate: string;
  milestone: DeliveryMilestone;
  blocks: readonly DeliveryBlock[];
  inProgress: readonly DeliveryCard[];
}>;

export type DeliveryBoardProjection = Readonly<{
  axis: TimelineAxis | null;
  columns: readonly DeliveryColumn[];
  milestones: readonly DeliveryMilestone[];
  blocks: readonly DeliveryBlock[];
  unplaced: readonly DeliveryBlock[];
  rankedCount: number;
  capacity: number;
  totalPoints: number;
}>;

export type DeliveryProjectionInput = Readonly<{
  result: ForecastResult | null;
  plan: ForecastPlan | null;
  rows: readonly DeliverySourceRow[];
  groupTitle?: (id: string) => string | null;
}>;

const EMPTY: DeliveryBoardProjection = Object.freeze({
  axis: null,
  columns: Object.freeze([]),
  milestones: Object.freeze([]),
  blocks: Object.freeze([]),
  unplaced: Object.freeze([]),
  rankedCount: 0,
  capacity: 0,
  totalPoints: 0,
});

function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const trimmed = label.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function shortList(labels: readonly string[]): string {
  const unique = uniqueLabels(labels);
  if (unique.length === 0) return 'Untitled work';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} + ${unique[1]}`;
  return `${unique[0]} + ${unique[1]} +${unique.length - 2}`;
}

function blockLabel(
  cards: readonly DeliveryCard[],
  groupTitle: ((id: string) => string | null) | undefined,
): string {
  const groupLabels = cards
    .map((card) => groupTitle?.(card.featureId) ?? null)
    .filter((label): label is string => label !== null && label.trim() !== '');
  if (groupLabels.length > 0) {
    const unique = uniqueLabels(groupLabels);
    if (unique.length === 1) return unique[0];
    return shortList(unique);
  }
  return shortList(cards.map((card) => card.title));
}

function milestoneLabel(blocks: readonly DeliveryBlock[], inProgress: readonly DeliveryCard[]): string {
  if (blocks.length > 0) return shortList(blocks.map((block) => block.label));
  if (inProgress.length > 0) return shortList(inProgress.map((card) => card.title));
  return 'No delivery';
}

export function buildDeliveryBoard(input: DeliveryProjectionInput): DeliveryBoardProjection {
  const { result, plan, rows, groupTitle } = input;
  const arithmetic = result?.arithmetic ?? null;
  if (!result || !plan || !arithmetic) return EMPTY;
  if (result.state !== 'ready' && result.state !== 'conditional') return EMPTY;
  if (!result.allocation) return EMPTY;

  const axis = timelineAxis(result);
  if (!axis) return EMPTY;

  const rowById = new Map(rows.map((row) => [row.id, row] as const));
  const timelineById = new Map(
    result.allocation.timelines.map((timeline) => [timeline.featureId, timeline] as const),
  );
  const blockedSet = new Set(plan.blockedFeatureIds);
  const selectedIndex = new Map(plan.selectedFeatureIds.map((id, index) => [id, index] as const));

  const blocks: DeliveryBlock[] = partitionBlocks(
    plan.selectedFeatureIds,
    plan.parallelGroups,
  ).map((block) => {
    const featureIds = block.kind === 'singleton' ? [block.featureId] : [...block.featureIds];
    const cards: DeliveryCard[] = featureIds.map((featureId) => {
      const row = rowById.get(featureId);
      const timeline: FeatureTimeline | undefined = timelineById.get(featureId);
      const rank = (selectedIndex.get(featureId) ?? 0) + 1;
      const startSprint = timeline?.startSprintOrdinal ?? null;
      const finishSprint = timeline?.completionSprintOrdinal ?? null;
      const withheldReason =
        !timeline || startSprint === null || finishSprint === null
          ? 'Timeline withheld - provide the estimate and configuration.'
          : null;
      return Object.freeze({
        featureId,
        title: row?.title ?? 'Untitled work',
        rank,
        effortPoints: row?.effortPoints ?? timeline?.estimate ?? null,
        effortPointsDone: row?.effortPointsDone ?? null,
        deliveryStatus: row?.deliveryStatus ?? null,
        invalid: row?.invalid ?? false,
        blocked: blockedSet.has(featureId),
        parallelGroupIndex: timeline?.parallelGroupIndex ?? (block.kind === 'parallel' ? block.groupIndex : null),
        startSprint,
        finishSprint,
        startDate: timeline?.startDate ?? null,
        finishDate: timeline?.completionDate ?? null,
        spanSprints:
          startSprint !== null && finishSprint !== null
            ? Math.max(finishSprint - startSprint + 1, 1)
            : 1,
        assignedPersonIds: Object.freeze([
          ...(plan.assignments?.[featureId] ?? timeline?.assignedPersonIds ?? []),
        ]),
        isMilestone: timeline?.isMilestone ?? false,
        withheldReason,
      });
    });

    const completionSprints = cards
      .map((card) => card.finishSprint)
      .filter((value): value is number => value !== null);
    const startSprints = cards
      .map((card) => card.startSprint)
      .filter((value): value is number => value !== null);
    const deliverySprint = completionSprints.length > 0 ? Math.max(...completionSprints) : null;
    const startSprint = startSprints.length > 0 ? Math.min(...startSprints) : null;

    return Object.freeze({
      key: cards[0]?.featureId ?? `block-${block.kind}`,
      kind: block.kind,
      groupIndex: block.kind === 'parallel' ? block.groupIndex : null,
      featureIds: Object.freeze(featureIds),
      cards: Object.freeze(cards),
      deliverySprint,
      startSprint,
      blocked: cards.some((card) => card.blocked),
      label: blockLabel(cards, groupTitle),
      withheld: cards.some((card) => card.withheldReason !== null),
    });
  });

  const asOfOffset = axis.asOfOffset;
  const asOfSprint = asOfOffset
    ? axis.startSprint + Math.floor(asOfOffset.numerator / asOfOffset.denominator)
    : axis.startSprint;
  const firstVisibleSprint = Math.max(axis.startSprint, asOfSprint);

  const columns: DeliveryColumn[] = axis.columns
    .filter((column) => column.sprint >= firstVisibleSprint)
    .map((column) => {
    const delivered = blocks.filter((block) => block.deliverySprint === column.sprint);
    const inProgress: DeliveryCard[] = [];
    const seen = new Set<string>();
    for (const block of blocks) {
      if (block.deliverySprint === null || block.startSprint === null) continue;
      if (block.startSprint <= column.sprint && block.deliverySprint > column.sprint) {
        for (const card of block.cards) {
          if (!seen.has(card.featureId)) {
            seen.add(card.featureId);
            inProgress.push(card);
          }
        }
      }
    }
    const endDate = addDays(column.isoDate, Math.max(arithmetic.sprintLengthDays - 1, 0));
    const milestone: DeliveryMilestone = Object.freeze({
      sprint: column.sprint,
      startDate: column.isoDate,
      endDate,
      dateRange: `${readableForecastDate(column.isoDate)} - ${readableForecastDate(endDate)}`,
      label: milestoneLabel(delivered, inProgress),
      ships: delivered.length > 0,
      deliveredBlockCount: delivered.length,
      featureCount: delivered.reduce((count, block) => count + block.cards.length, 0),
      blockedCount: delivered.reduce(
        (count, block) => count + block.cards.filter((card) => card.blocked).length,
        0,
      ),
      inProgressCount: inProgress.length,
      capacity: arithmetic.pointsPerSprint,
    });
    return Object.freeze({
      sprint: column.sprint,
      startDate: column.isoDate,
      endDate,
      milestone,
      blocks: Object.freeze(delivered),
      inProgress: Object.freeze(inProgress),
    });
  });

  return Object.freeze({
    axis,
    columns: Object.freeze(columns),
    milestones: Object.freeze(columns.map((column) => column.milestone)),
    blocks: Object.freeze(blocks),
    unplaced: Object.freeze(blocks.filter((block) => block.deliverySprint === null)),
    rankedCount: plan.selectedFeatureIds.length,
    capacity: arithmetic.pointsPerSprint,
    totalPoints: result.totalKnownPoints,
  });
}

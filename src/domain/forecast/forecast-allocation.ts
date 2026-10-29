/**
 * Forecast allocation and feature timeline calculation (Story 19.1, FR-4, FR-13).
 *
 * Implements the `shared-capacity-v1` timeline policy:
 * - Sequential execution is the default; explicit parallel groups share one
 *   conserved team capacity equally (AR-5..AR-11).
 * - Capacity released by finished members is immediately redistributed among
 *   remaining active members (AR-8).
 * - The next block waits for the current block to complete before starting (AR-7).
 * - Zero-point members consume no capacity, finish at their block start, and
 *   use explicit milestone presentation (AR-11).
 * - Advance by exact rational intervals; derive containing-sprint windows and
 *   dates without rounded windows feeding back into arithmetic (AR-8, AR-15).
 * - Bounded O(m log m) computation and O(m) compact event storage (AR-16, AC 19.1-6).
 */

import { Temporal } from 'temporal-polyfill';
import type { ReducedRatio } from './forecast-canonical';
import { reduceRatio } from './forecast-canonical';
import type { ForecastInputs, ForecastArithmetic } from './forecast-result';

export type FeatureTimeline = Readonly<{
  featureId: string;
  estimate: number | null;
  /** True when estimate is 0 (milestone marker). */
  isMilestone: boolean;
  /** Exact rational start offset in sprints (null if timelines withheld). */
  startOffset: ReducedRatio | null;
  /** Exact rational finish offset in sprints (null if timelines withheld). */
  finishOffset: ReducedRatio | null;
  /** Containing sprint ordinal for start (null if withheld). */
  startSprintOrdinal: number | null;
  /** Containing sprint ordinal for completion (null if withheld). */
  completionSprintOrdinal: number | null;
  /** Inclusive ISO YYYY-MM-DD start date (null if withheld). */
  startDate: string | null;
  /** Inclusive ISO YYYY-MM-DD completion date (null if withheld). */
  completionDate: string | null;
  /** Zero-based index of the parallel group, or null if ungrouped. */
  parallelGroupIndex: number | null;
  /** In staffing mode: assigned person IDs (Story 22.2) */
  assignedPersonIds?: readonly string[];
  /** In staffing mode: effective item rate r_i in points/sprint (Story 22.2) */
  itemRate?: ReducedRatio;
  /** In staffing mode: duration d_i in sprints (Story 22.2) */
  duration?: ReducedRatio;
  /** In staffing mode: whether this item determines its block's finish (Story 22.2) */
  isBottleneck?: boolean;
}>;

export type CapacityShareEvent = Readonly<{
  eventIndex: number;
  startOffset: ReducedRatio;
  finishOffset: ReducedRatio;
  activeCount: number;
  /** Capacity points per sprint per active member: C / activeCount (in shared) or activeRate (in staffed) */
  shareRate: ReducedRatio;
  /**
   * Expanded only for an event the caller has declared visible. Omitting this
   * detail keeps the ordinary projection compact while preserving its linear
   * event summary.
   */
  finishedFeatureIds?: readonly string[];
  /** Zero-based index of the parallel group, or null if sequential */
  parallelGroupIndex: number | null;
  /** In staffing mode: sum of active item rates during this interval (Story 22.2) */
  activeRate?: ReducedRatio;
  /** In staffing mode: C - activeRate during this interval (Story 22.2) */
  idleRate?: ReducedRatio;
  /** In staffing mode: IDs of people finishing at this event boundary (Story 22.2) */
  finishedPersonIds?: readonly string[];
  /** In staffing mode: IDs of people idle during this interval (Story 22.2) */
  idlePersonIds?: readonly string[];
}>;

export type ForecastAllocation = Readonly<{
  timelines: readonly FeatureTimeline[];
  events: readonly CapacityShareEvent[];
}>;

export type AllocationVisibility = Readonly<{
  visibleEventIndexes?: readonly number[];
}>;

/** Add two reduced ratios exactly using BigInt to prevent intermediate overflow. */
export function addRatios(a: ReducedRatio, b: ReducedRatio): ReducedRatio {
  const num = BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator);
  const den = BigInt(a.denominator) * BigInt(b.denominator);
  const g = bigIntGcd(num < 0n ? -num : num, den);
  const reducedNum = Number(num / g);
  const reducedDen = Number(den / g);
  return reduceRatio(reducedNum, reducedDen);
}

export function bigIntGcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

/** Integer floor of non-negative rational ratio. */
export function ratioFloor(r: ReducedRatio): number {
  return Math.floor(r.numerator / r.denominator);
}

/** Integer ceil of non-negative rational ratio. */
export function ratioCeil(r: ReducedRatio): number {
  return Math.floor(r.numerator / r.denominator) + (r.numerator % r.denominator === 0 ? 0 : 1);
}

export function addDays(dateStr: string, days: number): string {
  return Temporal.PlainDate.from(dateStr).add({ days }).toString();
}

export type ExecutionBlock = Readonly<
  | {
      kind: 'singleton';
      featureId: string;
    }
  | {
      kind: 'parallel';
      groupIndex: number;
      featureIds: readonly string[];
    }
>;

/**
 * Partition selected features into sequential blocks based on validated parallel groups.
 * Features in a group form one contiguous parallel block; ungrouped features form singletons.
 */
export function partitionBlocks(
  selectedIds: readonly string[],
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[],
): readonly ExecutionBlock[] {
  const groupMembership = new Map<string, { groupIndex: number; group: Readonly<{ featureIds: readonly string[] }> }>();
  parallelGroups.forEach((group, groupIndex) => {
    for (const id of group.featureIds) {
      groupMembership.set(id, { groupIndex, group });
    }
  });

  const blocks: ExecutionBlock[] = [];
  let i = 0;
  while (i < selectedIds.length) {
    const id = selectedIds[i];
    const groupInfo = groupMembership.get(id);
    if (groupInfo) {
      blocks.push(
        Object.freeze({
          kind: 'parallel' as const,
          groupIndex: groupInfo.groupIndex,
          featureIds: Object.freeze([...groupInfo.group.featureIds]),
        }),
      );
      i += groupInfo.group.featureIds.length;
    } else {
      blocks.push(
        Object.freeze({
          kind: 'singleton' as const,
          featureId: id,
        }),
      );
      i += 1;
    }
  }
  return Object.freeze(blocks);
}

/**
 * Calculate exact feature timelines and compact capacity share events under `shared-capacity-v1`.
 * Pure, deterministic, framework-free.
 */
export function calculateAllocation(
  inputs: ForecastInputs,
  arithmetic: ForecastArithmetic,
  visibility: AllocationVisibility = Object.freeze({}),
  asOfOffset: ReducedRatio = reduceRatio(0, 1),
): ForecastAllocation {
  const C = arithmetic.pointsPerSprint;
  const startOrdinal = arithmetic.startSprintOrdinal;
  const startDate = arithmetic.startDate;
  const sprintLengthDays = arithmetic.sprintLengthDays;

  const blocks = partitionBlocks(inputs.selectedFeatureIds, inputs.parallelGroups);
  const timelines: FeatureTimeline[] = [];
  const events: CapacityShareEvent[] = [];

  let currentOffset: ReducedRatio = asOfOffset;
  let eventCounter = 0;
  const visibleEventIndexes = new Set(visibility.visibleEventIndexes ?? []);

  for (const block of blocks) {
    if (block.kind === 'singleton') {
      const id = block.featureId;
      const points = inputs.estimates[id] ?? 0;

      if (points === 0) {
        const startOffset = currentOffset;
        const finishOffset = currentOffset;
        const sprint = startOrdinal + ratioFloor(startOffset);
        const date = addDays(startDate, ratioFloor(startOffset) * sprintLengthDays);

        timelines.push(
          Object.freeze({
            featureId: id,
            estimate: 0,
            isMilestone: true,
            startOffset,
            finishOffset,
            startSprintOrdinal: sprint,
            completionSprintOrdinal: sprint,
            startDate: date,
            completionDate: date,
            parallelGroupIndex: null,
          }),
        );
      } else {
        const startOffset = currentOffset;
        const duration = reduceRatio(points, C);
        const finishOffset = addRatios(startOffset, duration);

        const startSprint = startOrdinal + ratioFloor(startOffset);
        const completionSprint = startOrdinal + ratioCeil(finishOffset) - 1;
        const sDate = addDays(startDate, ratioFloor(startOffset) * sprintLengthDays);
        const cDate = addDays(startDate, ratioCeil(finishOffset) * sprintLengthDays - 1);

        timelines.push(
          Object.freeze({
            featureId: id,
            estimate: points,
            isMilestone: false,
            startOffset,
            finishOffset,
            startSprintOrdinal: startSprint,
            completionSprintOrdinal: completionSprint,
            startDate: sDate,
            completionDate: cDate,
            parallelGroupIndex: null,
          }),
        );

        const eventIndex = eventCounter++;
        events.push(
          Object.freeze({
            eventIndex,
            startOffset,
            finishOffset,
            activeCount: 1,
            shareRate: reduceRatio(C, 1),
            ...(visibleEventIndexes.has(eventIndex) ? { finishedFeatureIds: Object.freeze([id]) } : {}),
            parallelGroupIndex: null,
          }),
        );

        currentOffset = finishOffset;
      }
    } else {
      // Parallel block
      const blockStartOffset = currentOffset;
      const groupMembers = block.featureIds;
      const groupIndex = block.groupIndex;

      // Handle zero-point members first: milestones at block start offset
      const positiveMembers: { id: string; points: number }[] = [];
      for (const id of groupMembers) {
        const p = inputs.estimates[id] ?? 0;
        if (p === 0) {
          const sprint = startOrdinal + ratioFloor(blockStartOffset);
          const date = addDays(startDate, ratioFloor(blockStartOffset) * sprintLengthDays);
          timelines.push(
            Object.freeze({
              featureId: id,
              estimate: 0,
              isMilestone: true,
              startOffset: blockStartOffset,
              finishOffset: blockStartOffset,
              startSprintOrdinal: sprint,
              completionSprintOrdinal: sprint,
              startDate: date,
              completionDate: date,
              parallelGroupIndex: groupIndex,
            }),
          );
        } else {
          positiveMembers.push({ id, points: p });
        }
      }

      if (positiveMembers.length === 0) {
        // All members in this group were zero-point milestones
        continue;
      }

      // O(m log m) threshold sorting algorithm for positive members
      let prevThreshold = 0;
      let activeCount = positiveMembers.length;
      let stageStartOffset = blockStartOffset;
      // Sort once, then consume equal-estimate runs. The previous form scanned
      // every member once per distinct threshold (O(m²)); this remains O(m log m)
      // while retaining scope-priority ordering inside a simultaneous finish.
      const scopePosition = new Map(inputs.selectedFeatureIds.map((id, index) => [id, index]));
      const byThreshold = [...positiveMembers].sort(
        (a, b) => a.points - b.points || (scopePosition.get(a.id)! - scopePosition.get(b.id)!),
      );
      let cursor = 0;
      while (cursor < byThreshold.length) {
        const threshold = byThreshold[cursor].points;
        let end = cursor + 1;
        while (end < byThreshold.length && byThreshold[end].points === threshold) end += 1;
        const stepPoints = threshold - prevThreshold;
        // In this interval, activeCount members each advance by stepPoints.
        // Total work done = stepPoints * activeCount.
        // Duration in sprints = (stepPoints * activeCount) / C.
        const delta = reduceRatio(stepPoints * activeCount, C);
        const stageFinishOffset = addRatios(stageStartOffset, delta);

        // Members finishing at this threshold, preserved in scope priority order
        const finishedIds = byThreshold.slice(cursor, end).map((m) => m.id);

        for (const id of finishedIds) {
          const startSprint = startOrdinal + ratioFloor(blockStartOffset);
          const completionSprint = startOrdinal + ratioCeil(stageFinishOffset) - 1;
          const sDate = addDays(startDate, ratioFloor(blockStartOffset) * sprintLengthDays);
          const cDate = addDays(startDate, ratioCeil(stageFinishOffset) * sprintLengthDays - 1);

          timelines.push(
            Object.freeze({
              featureId: id,
              estimate: threshold,
              isMilestone: false,
              startOffset: blockStartOffset,
              finishOffset: stageFinishOffset,
              startSprintOrdinal: startSprint,
              completionSprintOrdinal: completionSprint,
              startDate: sDate,
              completionDate: cDate,
              parallelGroupIndex: groupIndex,
            }),
          );
        }

        const eventIndex = eventCounter++;
        events.push(
          Object.freeze({
            eventIndex,
            startOffset: stageStartOffset,
            finishOffset: stageFinishOffset,
            activeCount,
            shareRate: reduceRatio(C, activeCount),
            ...(visibleEventIndexes.has(eventIndex) ? { finishedFeatureIds: Object.freeze(finishedIds) } : {}),
            parallelGroupIndex: groupIndex,
          }),
        );

        activeCount -= finishedIds.length;
        prevThreshold = threshold;
        stageStartOffset = stageFinishOffset;
        cursor = end;
      }

      currentOffset = stageStartOffset;
    }
  }

  // Sort timelines back into original scope priority order
  const scopeIndex = new Map(inputs.selectedFeatureIds.map((id, idx) => [id, idx]));
  timelines.sort((a, b) => (scopeIndex.get(a.featureId) ?? 0) - (scopeIndex.get(b.featureId) ?? 0));

  return Object.freeze({
    timelines: Object.freeze(timelines),
    events: Object.freeze(events),
  });
}

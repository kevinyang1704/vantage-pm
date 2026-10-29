/**
 * Staffed forecast calculation policy (Story 22.2, SF-FR8, SF-FR9, SF-FR10, SF-NFR1, SF-NFR2, SF-NFR5, SF-AR4, SF-AR10).
 *
 * Implements the `staffed-capacity-v1` timeline policy:
 * - Each item uses only assigned people's shares; unused capacity stays idle.
 * - Total roster weight W = sum(w_p for p in R).
 * - Person rate c_p = C * w_p / W.
 * - Item rate r_i = sum(c_p for p in A(i)) = C * sum(w_p for p in A(i)) / W.
 * - Item duration d_i = points_i / r_i (positive work) or 0 (zero-point milestone).
 * - Block barrier D_b = max(d_i for i in block b).
 * - Total elapsed duration T = sum(D_b for all blocks).
 * - Lower bound Q = P / C.
 * - Idle capacity I = C * T - P in point-equivalents.
 * - Occupied sprints = ceil(T).
 * - Completion sprint = startSprint + occupiedSprints - 1.
 * - Completion date = startDate + occupiedSprints * sprintLengthDays - 1 calendar days.
 * - Compact capacity events at distinct item finish offsets: identify finished items,
 *   active rate, and idle rate.
 *
 * Exactness (Story 22.11, R5): every derived quantity is formed from exact
 * `bigint` intermediates and reduced BEFORE the safe-integer check, so an
 * unsafe unreduced product never rejects a representable result. A quantity
 * whose reduced form is still unsafe throws {@link StaffedArithmeticOverflow},
 * which the whole-set policy turns into its typed `overflow` result.
 *
 * Bounds (Story 22.11, R6): a parallel block sorts its members by finish once
 * and walks the finishes with running aggregates, so event construction is
 * O(N log N + E) for N items and E assignment edges, plus O(R) roster work
 * shared by the whole calculation. Identity arrays (finished items, finished
 * people, idle people) are built only for events named in
 * `visibility.visibleEventIndexes`, the same contract as the shared policy.
 */

import type { ReducedRatio } from './forecast-canonical';
import { reduceRatio, sortIdsLexically } from './forecast-canonical';
import type { ForecastInputs } from './forecast-result';
import type { FeatureTimeline, CapacityShareEvent, AllocationVisibility } from './forecast-allocation';
import { bigIntGcd, ratioFloor, ratioCeil, addDays, partitionBlocks } from './forecast-allocation';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ZERO: ReducedRatio = reduceRatio(0, 1);

/**
 * An exact staffed quantity whose reduced form cannot be represented with
 * safe integers. Caught by the whole-set policy and reported as the typed
 * `overflow` state; never a NaN, an Infinity or a rounded substitute.
 */
export class StaffedArithmeticOverflow extends Error {
  constructor(quantity: string) {
    super(`STAFFED_ARITHMETIC_OVERFLOW:${quantity}`);
    this.name = 'StaffedArithmeticOverflow';
  }
}

/** Convert an exact integer to a safe `number`, or throw a typed overflow. */
function toSafeNumber(value: bigint, quantity: string): number {
  if (value > MAX_SAFE || value < -MAX_SAFE) throw new StaffedArithmeticOverflow(quantity);
  return Number(value);
}

/**
 * Reduce an exact `numerator/denominator` and convert it. The safe-range
 * check applies to the reduced form only (AC 22.11-1).
 */
export function ratioFromBigInts(numerator: bigint, denominator: bigint, quantity = 'ratio'): ReducedRatio {
  if (denominator <= 0n) throw new StaffedArithmeticOverflow(`${quantity} denominator`);
  if (numerator === 0n) return ZERO;
  const g = bigIntGcd(numerator < 0n ? -numerator : numerator, denominator);
  return Object.freeze({
    numerator: toSafeNumber(numerator / g, quantity),
    denominator: toSafeNumber(denominator / g, quantity),
  });
}

/** Compare two reduced ratios exactly. Returns -1 if a < b, 1 if a > b, 0 if equal. */
export function compareRatios(a: ReducedRatio, b: ReducedRatio): number {
  const diff = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/** Return the maximum of two reduced ratios. */
export function maxRatio(a: ReducedRatio, b: ReducedRatio): ReducedRatio {
  return compareRatios(a, b) >= 0 ? a : b;
}

/** Add ratio b to ratio a exactly (a + b). */
export function addRatiosExact(a: ReducedRatio, b: ReducedRatio, quantity = 'sum'): ReducedRatio {
  return ratioFromBigInts(
    BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
    quantity,
  );
}

/** Subtract ratio b from ratio a exactly (a - b). */
export function subtractRatios(a: ReducedRatio, b: ReducedRatio, quantity = 'difference'): ReducedRatio {
  return ratioFromBigInts(
    BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
    quantity,
  );
}

/** Multiply a reduced ratio by an integer exactly. */
export function multiplyRatioByInt(r: ReducedRatio, n: number, quantity = 'product'): ReducedRatio {
  return ratioFromBigInts(BigInt(r.numerator) * BigInt(n), BigInt(r.denominator), quantity);
}

/** `startSprintOrdinal + ordinalOffset - 1`, exactly — never a float round trip. */
export function sprintOrdinalAt(startSprintOrdinal: number, ordinalOffset: number): number {
  return toSafeNumber(BigInt(startSprintOrdinal) + BigInt(ordinalOffset) - 1n, 'sprint ordinal');
}

/** Whole calendar days for `sprints * sprintLengthDays`, exactly. */
function dayOffset(sprints: number, sprintLengthDays: number): number {
  return toSafeNumber(BigInt(sprints) * BigInt(sprintLengthDays), 'calendar day offset');
}

export type StaffedAllocationResult = Readonly<{
  timelines: readonly FeatureTimeline[];
  events: readonly CapacityShareEvent[];
  totalStaffingDuration: ReducedRatio;
}>;

type PositiveMember = {
  readonly id: string;
  readonly scopePosition: number;
  readonly points: number;
  readonly assignedIds: readonly string[];
  readonly rate: ReducedRatio;
  readonly duration: ReducedRatio;
  readonly finishOffset: ReducedRatio;
};

/**
 * Calculate exact feature timelines and compact capacity share events under `staffed-capacity-v1`.
 * Pure, deterministic, framework-free.
 */
export function calculateStaffedAllocation(
  inputs: ForecastInputs,
  pointsPerSprint: number,
  sprintLengthDays: number,
  startSprintOrdinal: number,
  startDate: string,
  visibility: AllocationVisibility = Object.freeze({}),
  asOfOffset: ReducedRatio = ZERO,
): StaffedAllocationResult {
  const C = BigInt(pointsPerSprint);
  const capacity = reduceRatio(pointsPerSprint, 1);
  const assignments = inputs.assignments ?? {};
  const visibleEventIndexes = new Set(visibility.visibleEventIndexes ?? []);

  // The only roster pass on the default path: person weights and W.
  const personWeights = new Map<string, bigint>();
  const rosterIds: string[] = [];
  let W = 0n;
  for (const person of inputs.roster ?? []) {
    const weight = BigInt(person.weightUnits);
    personWeights.set(person.id, weight);
    rosterIds.push(person.id);
    W += weight;
  }
  // Sorted once, and only if some event asks for its idle people.
  let sortedRosterIds: readonly string[] | null = null;
  const idlePeople = (isActive: (personId: string) => boolean): readonly string[] => {
    sortedRosterIds ??= sortIdsLexically(rosterIds);
    return Object.freeze(sortedRosterIds.filter((id) => !isActive(id)));
  };

  /** r_i and d_i from exact intermediates, reduced before any range check. */
  const rateAndDuration = (points: number, assignedIds: readonly string[]) => {
    let assignedWeight = 0n;
    for (const pid of assignedIds) assignedWeight += personWeights.get(pid) ?? 0n;
    const rate = ratioFromBigInts(C * assignedWeight, W, 'item rate');
    const duration = ratioFromBigInts(BigInt(points) * W, C * assignedWeight, 'item duration');
    return { rate, duration };
  };

  const milestone = (id: string, offset: ReducedRatio, groupIndex: number | null): FeatureTimeline => {
    const whole = ratioFloor(offset);
    const date = addDays(startDate, dayOffset(whole, sprintLengthDays));
    const sprint = sprintOrdinalAt(startSprintOrdinal, whole + 1);
    return Object.freeze({
      featureId: id,
      estimate: 0,
      isMilestone: true,
      startOffset: offset,
      finishOffset: offset,
      startSprintOrdinal: sprint,
      completionSprintOrdinal: sprint,
      startDate: date,
      completionDate: date,
      parallelGroupIndex: groupIndex,
      assignedPersonIds: Object.freeze([...(assignments[id] ?? [])]),
      itemRate: ZERO,
      duration: ZERO,
      isBottleneck: false,
    });
  };

  const positiveTimeline = (
    m: PositiveMember,
    startOffset: ReducedRatio,
    groupIndex: number | null,
    isBottleneck: boolean,
  ): FeatureTimeline => {
    const startWhole = ratioFloor(startOffset);
    const finishCeil = ratioCeil(m.finishOffset);
    return Object.freeze({
      featureId: m.id,
      estimate: m.points,
      isMilestone: false,
      startOffset,
      finishOffset: m.finishOffset,
      startSprintOrdinal: sprintOrdinalAt(startSprintOrdinal, startWhole + 1),
      completionSprintOrdinal: sprintOrdinalAt(startSprintOrdinal, finishCeil),
      startDate: addDays(startDate, dayOffset(startWhole, sprintLengthDays)),
      completionDate: addDays(startDate, dayOffset(finishCeil, sprintLengthDays) - 1),
      parallelGroupIndex: groupIndex,
      assignedPersonIds: Object.freeze([...m.assignedIds]),
      itemRate: m.rate,
      duration: m.duration,
      isBottleneck,
    });
  };

  const blocks = partitionBlocks(inputs.selectedFeatureIds, inputs.parallelGroups);
  const scopeIndex = new Map(inputs.selectedFeatureIds.map((id, idx) => [id, idx]));

  let currentOffset: ReducedRatio = asOfOffset;
  let totalStaffingDuration: ReducedRatio = ZERO;
  const timelines: FeatureTimeline[] = [];
  const events: CapacityShareEvent[] = [];
  let eventCounter = 0;

  for (const block of blocks) {
    const isParallel = block.kind === 'parallel';
    const groupIndex = isParallel ? block.groupIndex : null;
    const itemIds = isParallel ? block.featureIds : [block.featureId];
    const blockStartOffset = currentOffset;

    const positiveMembers: PositiveMember[] = [];
    for (const id of itemIds) {
      const points = inputs.estimates[id] ?? 0;
      const assignedIds = assignments[id] ?? [];
      if (points === 0) {
        timelines.push(milestone(id, blockStartOffset, groupIndex));
        continue;
      }
      const { rate, duration } = rateAndDuration(points, assignedIds);
      positiveMembers.push({
        id,
        scopePosition: scopeIndex.get(id) ?? 0,
        points,
        assignedIds,
        rate,
        duration,
        finishOffset: addRatiosExact(blockStartOffset, duration, 'finish offset'),
      });
    }
    if (positiveMembers.length === 0) continue;

    // Finish order, ties in scope priority: one sort replaces the per-finish
    // dedupe/filter scans (AC 22.11-4).
    positiveMembers.sort(
      (a, b) => compareRatios(a.finishOffset, b.finishOffset) || a.scopePosition - b.scopePosition,
    );
    const blockDuration = positiveMembers[positiveMembers.length - 1].duration;
    for (const m of positiveMembers) {
      // A singleton is always its own bottleneck; in a bucket, every member
      // whose duration equals the barrier is.
      timelines.push(positiveTimeline(m, blockStartOffset, groupIndex, compareRatios(m.duration, blockDuration) === 0));
    }

    // Running aggregates over the finish-ordered members.
    let activeRate = ZERO;
    for (const m of positiveMembers) activeRate = addRatiosExact(activeRate, m.rate, 'active rate');
    let remaining = positiveMembers.length;
    // Active assignment edges per person, for idle detail on requested events.
    const activeEdges = new Map<string, number>();
    for (const m of positiveMembers) {
      for (const pid of m.assignedIds) activeEdges.set(pid, (activeEdges.get(pid) ?? 0) + 1);
    }

    let intervalStart = blockStartOffset;
    for (let i = 0; i < positiveMembers.length; ) {
      const finish = positiveMembers[i].finishOffset;
      let j = i;
      while (j < positiveMembers.length && compareRatios(positiveMembers[j].finishOffset, finish) === 0) j += 1;
      const finishing = positiveMembers.slice(i, j);

      const eventIndex = eventCounter++;
      const detail = visibleEventIndexes.has(eventIndex)
        ? {
            finishedFeatureIds: Object.freeze(finishing.map((m) => m.id)),
            finishedPersonIds: sortIdsLexically(finishing.flatMap((m) => m.assignedIds)),
            idlePersonIds: idlePeople((pid) => (activeEdges.get(pid) ?? 0) > 0),
          }
        : {};
      events.push(
        Object.freeze({
          eventIndex,
          startOffset: intervalStart,
          finishOffset: finish,
          activeCount: remaining,
          shareRate: activeRate,
          parallelGroupIndex: groupIndex,
          activeRate,
          idleRate: subtractRatios(capacity, activeRate, 'idle rate'),
          ...detail,
        }),
      );

      for (const m of finishing) {
        activeRate = subtractRatios(activeRate, m.rate, 'active rate');
        for (const pid of m.assignedIds) activeEdges.set(pid, (activeEdges.get(pid) ?? 0) - 1);
      }
      remaining -= finishing.length;
      intervalStart = finish;
      i = j;
    }

    currentOffset = addRatiosExact(blockStartOffset, blockDuration, 'block finish offset');
    totalStaffingDuration = addRatiosExact(totalStaffingDuration, blockDuration, 'elapsed duration');
  }

  // Sort timelines back into original scope priority order
  timelines.sort((a, b) => (scopeIndex.get(a.featureId) ?? 0) - (scopeIndex.get(b.featureId) ?? 0));

  return Object.freeze({
    timelines: Object.freeze(timelines),
    events: Object.freeze(events),
    totalStaffingDuration,
  });
}

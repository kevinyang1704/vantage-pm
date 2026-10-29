/**
 * Person busy/idle lanes (Epic 26, Story 26.3, FC-FR3, FC-NFR1, FC-NFR3).
 *
 * Pure projection over one acknowledged staffed `ForecastResult`. A lane shows
 * each person's busy segments (from the items assigned to them) and their idle
 * gaps from the plan start to the exact finish. Idle is
 * `c_p × (T − Σ_{i∈p} d_i)`, the person's exact capacity share times the time
 * they are not on any of their items. Because `Σ_p c_p = C`, the per-person
 * idle point-equivalents sum, exactly, to the result's reported idle capacity
 * `I = C·T − P` (AC 26.3-2). In shared mode a single "Whole team" lane covers
 * the team (AC 26.3-3).
 */

import type { ReducedRatio } from '../../domain/forecast/forecast-canonical';
import { reduceRatio } from '../../domain/forecast/forecast-canonical';
import type { ForecastResult } from '../../domain/forecast/forecast-result';
import type { FeatureTimeline } from '../../domain/forecast/forecast-allocation';
import { addRatios } from '../../domain/forecast/forecast-allocation';
import {
  compareRatios,
  subtractRatios,
  ratioFromBigInts,
} from '../../domain/forecast/staffed-calculation.policy';

export type LaneSegment = Readonly<{
  kind: 'busy' | 'idle';
  /** Exact start/finish offsets in sprints. */
  startOffset: ReducedRatio;
  finishOffset: ReducedRatio;
  /** Busy: the item being worked. Idle: null. */
  featureId: string | null;
}>;

export type PersonLane = Readonly<{
  personId: string;
  name: string;
  segments: readonly LaneSegment[];
  /** Exact idle duration in sprints. */
  idleSprints: ReducedRatio;
  /** Exact idle point-equivalents = c_p × idle duration. */
  idlePoints: ReducedRatio;
  /** True when the person has capacity but no busy work. */
  entirelyIdle: boolean;
  /** Accessible sentence: "Ada: busy on X, idle for N sprints". */
  text: string;
}>;

export type LanesView = Readonly<{
  mode: 'staffed' | 'whole-team';
  lanes: readonly PersonLane[];
  /** Exact total idle point-equivalents across the shown lanes. */
  totalIdlePoints: ReducedRatio;
}>;

const WHOLE_TEAM = 'whole-team';
const ZERO = reduceRatio(0, 1);

/** Exact product of two reduced ratios. */
function multiplyRatio(a: ReducedRatio, b: ReducedRatio): ReducedRatio {
  return ratioFromBigInts(
    BigInt(a.numerator) * BigInt(b.numerator),
    BigInt(a.denominator) * BigInt(b.denominator),
    'idle points',
  );
}

function ratioValue(r: ReducedRatio): number {
  return r.numerator / r.denominator;
}

/** True for a positive-duration item timeline with exact offsets. */
type DatedTimeline = FeatureTimeline & {
  startOffset: ReducedRatio;
  finishOffset: ReducedRatio;
  duration: ReducedRatio;
};

function isDated(t: FeatureTimeline): t is DatedTimeline {
  return Boolean(!t.isMilestone && t.startOffset && t.finishOffset && t.duration);
}

/**
 * Interleave a person's busy items with the idle gaps between 0 and the total
 * staffing duration. A person with no busy work gets one idle segment for the
 * whole plan.
 */
function buildSegments(busy: readonly DatedTimeline[], total: ReducedRatio): readonly LaneSegment[] {
  if (busy.length === 0) {
    return Object.freeze([
      Object.freeze({ kind: 'idle' as const, startOffset: ZERO, finishOffset: total, featureId: null }),
    ]);
  }
  const segments: LaneSegment[] = [];
  let cursor = ZERO;
  for (const t of busy) {
    if (compareRatios(t.startOffset, cursor) > 0) {
      segments.push(Object.freeze({ kind: 'idle' as const, startOffset: cursor, finishOffset: t.startOffset, featureId: null }));
    }
    segments.push(
      Object.freeze({
        kind: 'busy' as const,
        startOffset: compareRatios(t.startOffset, cursor) > 0 ? t.startOffset : cursor,
        finishOffset: t.finishOffset,
        featureId: t.featureId,
      }),
    );
    cursor = compareRatios(t.finishOffset, cursor) > 0 ? t.finishOffset : cursor;
  }
  if (compareRatios(cursor, total) < 0) {
    segments.push(Object.freeze({ kind: 'idle' as const, startOffset: cursor, finishOffset: total, featureId: null }));
  }
  return Object.freeze(segments);
}

/**
 * Build person lanes from a staffed result. `roster` supplies each person's
 * weight (units of 1/100); the exact capacity share is `C × w_p / W`.
 */
export function personLanes(
  result: ForecastResult | null,
  roster: readonly { id: string; name: string; weightUnits: number }[],
): LanesView {
  const empty: LanesView = Object.freeze({
    mode: 'staffed',
    lanes: Object.freeze([]),
    totalIdlePoints: ZERO,
  });
  if (!result) return empty;
  const timelines = result.allocation?.timelines ?? [];
  const isStaffed = result.policyVersion === 'staffed-capacity-v1';

  if (!isStaffed) {
    // AC 26.3-3: one team lane through the exact finish, no invented split.
    const finish = timelines.reduce<ReducedRatio | null>((max, t) => {
      if (!t.finishOffset) return max;
      return max === null || compareRatios(t.finishOffset, max) > 0 ? t.finishOffset : max;
    }, null);
    if (finish === null) return empty;
    const lane: PersonLane = Object.freeze({
      personId: WHOLE_TEAM,
      name: 'Whole team',
      segments: Object.freeze([
        Object.freeze({ kind: 'busy' as const, startOffset: ZERO, finishOffset: finish, featureId: null }),
      ]),
      idleSprints: ZERO,
      idlePoints: ZERO,
      entirelyIdle: false,
      text: 'Whole team: busy through the plan finish.',
    });
    return Object.freeze({ mode: 'whole-team', lanes: Object.freeze([lane]), totalIdlePoints: ZERO });
  }

  const total = result.arithmetic?.elapsedStaffingDuration ?? null;
  const capacity = result.arithmetic?.pointsPerSprint ?? 0;
  const totalWeight = roster.reduce((sum, p) => sum + p.weightUnits, 0);
  if (total === null || totalWeight === 0) return empty;

  const lanes: PersonLane[] = [];
  let totalIdle = ZERO;

  for (const person of roster) {
    const busy = timelines
      .filter(isDated)
      .filter((t) => t.assignedPersonIds?.includes(person.id))
      .sort((a, b) => compareRatios(a.startOffset, b.startOffset));

    // Exact idle = share × (T − Σ durations).
    const share = ratioFromBigInts(BigInt(capacity) * BigInt(person.weightUnits), BigInt(totalWeight), 'capacity share');
    let busySprints = ZERO;
    for (const t of busy) busySprints = addRatios(busySprints, t.duration);
    const rawIdle = subtractRatios(total, busySprints, 'idle sprints');
    const idleSprints = rawIdle.numerator < 0 ? ZERO : rawIdle;
    const idlePoints = multiplyRatio(share, idleSprints);
    totalIdle = addRatios(totalIdle, idlePoints);

    const firstBusy = busy[0] ?? null;
    const text = firstBusy
      ? `${person.name}: busy on ${firstBusy.featureId} from ${ratioValue(firstBusy.startOffset).toFixed(1)} sprints, idle for ${ratioValue(idleSprints).toFixed(1)} sprints.`
      : `${person.name}: idle for the whole plan.`;

    lanes.push(
      Object.freeze({
        personId: person.id,
        name: person.name,
        segments: buildSegments(busy, total),
        idleSprints,
        idlePoints,
        entirelyIdle: busy.length === 0,
        text,
      }),
    );
  }

  return Object.freeze({
    mode: 'staffed',
    lanes: Object.freeze(lanes),
    totalIdlePoints: totalIdle,
  });
}

/** The lane cap for AC 26.3-4 (at most 12 lanes rendered at once). */
export const LANE_PAGE_SIZE = 12;

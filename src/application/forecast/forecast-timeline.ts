/**
 * Sprint-timeline view models (Epic 26, Story 26.2, FC-FR2, FC-NFR1, FC-NFR3).
 *
 * Pure projections over one acknowledged `ForecastResult`: a shared sprint
 * axis (AC 26.2-1) and one item bar per row (AC 26.2-2). Every position comes
 * from the result's existing exact `FeatureTimeline` start/finish offsets —
 * no new arithmetic and no rounding that feeds back into the result.
 */

import type { ReducedRatio } from '../../domain/forecast/forecast-canonical';
import type { ForecastResult } from '../../domain/forecast/forecast-result';
import type { FeatureTimeline } from '../../domain/forecast/forecast-allocation';
import { addDays, ratioFloor } from '../../domain/forecast/forecast-allocation';
import { compareRatios } from '../../domain/forecast/staffed-calculation.policy';

export type TimelineAxisColumn = Readonly<{
  sprint: number;
  /** "Sprint 12 · Sep 7" */
  label: string;
  /** Inclusive ISO date of the sprint's first day. */
  isoDate: string;
}>;

export type TimelineAxis = Readonly<{
  startSprint: number;
  completionSprint: number;
  /** Whole sprints covered by the axis, at least 1. */
  spanSprints: number;
  columns: readonly TimelineAxisColumn[];
  /** Story 26.6: the injected as-of date, or null. */
  asOfDate: string | null;
  /** Story 26.6: exact as-of offset in sprints, or null when not evaluated. */
  asOfOffset: ReducedRatio | null;
}>;

export type ItemBar = Readonly<{
  featureId: string;
  /** Fraction of the axis 0..1 where the bar starts. */
  left: number;
  /** Fraction of the axis 0..1 the bar spans (0 for a milestone). */
  width: number;
  isMilestone: boolean;
  /** Fraction 0..1 of the exact finished-work marker. */
  finishFraction: number;
  /** True when the item waits for earlier work before it can start. */
  waits: boolean;
  /** Accessible sentence: "starts Sprint N, finishes ≈ date, takes X sprints". */
  label: string;
  /** Pace in plain words: "whole team" or "21.4 pts/sprint". */
  paceLabel: string;
  /** Present when the timeline is withheld; the row's existing reason. */
  withheldReason: string | null;
  /**
   * Story 26.6 (AC 26.6-3): fraction 0..1 of the axis already done for an
   * in-progress item with points done, or null when not applicable.
   */
  doneFraction: number | null;
}>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Sep 7" from an ISO date in UTC; never a locale-dependent month name. */
export function readableForecastDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number(part));
  if (!year || !month || !day || month < 1 || month > 12) return isoDate;
  return `${MONTHS[month - 1]} ${day}`;
}

function ratioValue(r: ReducedRatio): number {
  return r.numerator / r.denominator;
}

/**
 * Build the shared axis from the result: sprint columns from the start sprint
 * through the completion sprint, each labelled "Sprint N · date". Returns null
 * when the result has no usable arithmetic.
 */
export function timelineAxis(result: ForecastResult | null): TimelineAxis | null {
  const arithmetic = result?.arithmetic;
  if (!result || !arithmetic || arithmetic.completionSprint === null) return null;
  const startSprint = arithmetic.startSprintOrdinal;
  const completionSprint = arithmetic.completionSprint;
  const spanSprints = Math.max(completionSprint - startSprint + 1, 1);
  const columns: TimelineAxisColumn[] = [];
  for (let i = 0; i < spanSprints; i += 1) {
    const sprint = startSprint + i;
    const isoDate = addDays(arithmetic.startDate, i * arithmetic.sprintLengthDays);
    columns.push(
      Object.freeze({ sprint, label: `Sprint ${sprint} · ${readableForecastDate(isoDate)}`, isoDate }),
    );
  }
  return Object.freeze({
    startSprint,
    completionSprint,
    spanSprints,
    columns: Object.freeze(columns),
    asOfDate: arithmetic.asOfDate ?? null,
    asOfOffset: arithmetic.asOfOffset ?? null,
  });
}

export type ItemBarContext = Readonly<{
  axis: TimelineAxis;
  /** 1-based rank in the priority list, or null when unranked. */
  rank: number | null;
  /** Rank of the item immediately before it, or null for the first. */
  previousRank: number | null;
  title: string;
  isStaffed: boolean;
  /** Shared capacity in points/sprint; used for the "whole team" pace. */
  pointsPerSprint: number;
  /** Story 26.6: recorded points done for the item, or null. */
  pointsDone?: number | null;
  /** Story 26.6: the item's delivery status. */
  deliveryStatus?: 'not_started' | 'in_progress' | 'delivered';
}>;

const PACES = ['sprint', 'sprints'] as const;

/** Build one item's bar from its exact timeline (AC 26.2-2/-3). */
export function itemBar(timeline: FeatureTimeline | undefined, ctx: ItemBarContext): ItemBar | null {
  if (!timeline) return null;
  if (timeline.startOffset === null || timeline.finishOffset === null) {
    return Object.freeze({
      featureId: timeline.featureId,
      left: 0,
      width: 0,
      isMilestone: false,
      finishFraction: 0,
      waits: false,
      label: '',
      paceLabel: '',
      withheldReason: 'Timeline withheld — provide the estimate and configuration.',
      doneFraction: null,
    });
  }

  const span = Math.max(ctx.axis.spanSprints, 1);
  const start = ratioValue(timeline.startOffset);
  const finish = ratioValue(timeline.finishOffset);
  const duration = Math.max(finish - start, 0);
  const left = Math.min(Math.max(start / span, 0), 1);
  const width = Math.min(Math.max(duration / span, 0), 1 - left);
  const finishFraction = Math.min(Math.max(finish / span, 0), 1);

  const paceLabel = ctx.isStaffed
    ? `${ratioValue(timeline.itemRate ?? { numerator: 0, denominator: 1 }).toFixed(1)} pts/sprint`
    : 'whole team';

  const durationSprints = duration;
  const sprintWord = durationSprints === 1 ? PACES[0] : PACES[1];
  const finishDate = readableForecastDate(timeline.completionDate ?? '');
  const label =
    timeline.isMilestone
      ? `Milestone at Sprint ${timeline.completionSprintOrdinal ?? ctx.axis.startSprint}`
      : `Starts Sprint ${timeline.startSprintOrdinal}, finishes ≈ ${finishDate}, takes ${durationSprints.toFixed(1)} ${sprintWord}`;

  const waits =
    !timeline.isMilestone &&
    compareRatios(timeline.startOffset, ctx.axis.asOfOffset ?? { numerator: 0, denominator: 1 }) > 0 &&
    ctx.previousRank !== null;

  /**
   * Story 26.6 (AC 26.6-3): for an in-progress item with points done, the
   * portion of its bar already done lies before today — drawn as a muted
   * segment from the axis start to `min(finish, asOf)`. Null otherwise.
   */
  let doneEndFraction: number | null = null;
  if (
    ctx.deliveryStatus === 'in_progress' &&
    ctx.pointsDone != null &&
    ctx.pointsDone > 0 &&
    !timeline.isMilestone
  ) {
    const asOfFraction = ctx.axis.asOfOffset
      ? Math.min(ratioValue(ctx.axis.asOfOffset) / span, 1)
      : 0;
    doneEndFraction = Math.min(finishFraction, asOfFraction);
  }

  return Object.freeze({
    featureId: timeline.featureId,
    left,
    width,
    isMilestone: timeline.isMilestone,
    finishFraction,
    waits,
    label,
    paceLabel,
    withheldReason: null,
    doneFraction: doneEndFraction,
  });
}

/** Whole-sprint count of an item's duration, floored for a stable display. */
export function barDurationSprints(timeline: FeatureTimeline | undefined): number {
  if (!timeline?.startOffset || !timeline.finishOffset) return 0;
  const duration = ratioValue(timeline.finishOffset) - ratioValue(timeline.startOffset);
  return Math.max(ratioFloor({ numerator: Math.round(duration * 1000), denominator: 1000 }), 0);
}

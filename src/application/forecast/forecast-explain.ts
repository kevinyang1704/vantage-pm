/**
 * Plain-language forecast explanation (Epic 26, Story 26.1, FC-FR1, FC-UX1,
 * FC-UX2, FC-NFR1).
 *
 * A pure view model over one acknowledged `ForecastResult`. It derives the
 * answer (completion sprint + full date), a small ordered list of reasons in
 * plain words, and the exact work-done date next to the sprint-rounded
 * forecast. It reads only from the result — it performs no arithmetic of its
 * own beyond reducing the exact-offset fact the result already carries, so
 * every number it shows agrees with the math for the same revision (AC
 * 26.1-2). Policy IDs never appear here; they stay inside "Show the math".
 */

import type { ReducedRatio } from '../../domain/forecast/forecast-canonical';
import { compareRatios } from '../../domain/forecast/staffed-calculation.policy';
import { addDays, ratioCeil, ratioFloor } from '../../domain/forecast/forecast-allocation';
import type { ForecastResult, ForecastArithmetic } from '../../domain/forecast/forecast-result';

/** One reason line: a stable key for tests plus the user-facing sentence. */
export type ForecastReason = Readonly<{
  key: 'order' | 'pace' | 'exact-finish' | 'blocked';
  text: string;
}>;

export type ForecastExplanation = Readonly<{
  /** Present only when the result is ready/conditional and has arithmetic. */
  answer:
    | Readonly<{
        sprint: number;
        /** Full readable completion date, e.g. "Oct 13". */
        date: string;
        /** ISO completion date for aria/text equivalence. */
        isoDate: string;
      }>
    | null;
  /** Plain-language why; empty when there is no answer. */
  reasons: readonly ForecastReason[];
  /** Exact "work done" finish date when it differs from the rounded forecast. */
  exactFinish:
    | Readonly<{
        /** e.g. "Oct 5" */
        date: string;
        isoDate: string;
        /** e.g. "Oct 13" — the sprint-rounded forecast date. */
        forecastDate: string;
      }>
    | null;
  /** Story 26.6 (AC 26.6-3): the as-of date this answer was evaluated for. */
  asOfDate: string | null;
}>;

/** The last exact finish offset across every timeline, or null when withheld. */
function overallFinishOffset(result: ForecastResult): ReducedRatio | null {
  let max: ReducedRatio | null = null;
  for (const t of result.allocation?.timelines ?? []) {
    if (!t.finishOffset) continue;
    if (max === null || compareRatios(t.finishOffset, max) > 0) max = t.finishOffset;
  }
  return max;
}

/** Whole calendar days from the start date to the exact fractional finish. */
function exactFinishDays(offset: ReducedRatio, sprintLengthDays: number): number {
  const dayCount = (offset.numerator * sprintLengthDays) / offset.denominator;
  return Math.round(dayCount);
}

/** "Oct 13" from an ISO date in UTC; never a locale-dependent month name. */
function formatReadableDate(isoDate: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const [year, month, day] = isoDate.split('-').map((part) => Number(part));
  if (!year || !month || !day || month < 1 || month > 12) return isoDate;
  return `${months[month - 1]} ${day}`;
}

function paceReason(result: ForecastResult, arithmetic: ForecastArithmetic): string {
  const capacity = Number.isFinite(arithmetic.pointsPerSprint) ? arithmetic.pointsPerSprint : 0;
  if (result.assumptions.policyVersion === 'staffed-capacity-v1') {
    return `Each item is paced by its assigned people's share of the team capacity (${capacity} pts/sprint in total).`;
  }
  return `The whole team paces the work at ${capacity} pts/sprint.`;
}

/**
 * Explain a settled forecast result in plain language. Non-ready states return
 * an empty explanation (the completion card already shows their named reason),
 * never a blank card or a fabricated answer.
 */
export function explainForecast(result: ForecastResult | null): ForecastExplanation {
  const empty: ForecastExplanation = Object.freeze({
    answer: null,
    reasons: Object.freeze([]),
    exactFinish: null,
    asOfDate: null,
  });
  if (!result) return empty;
  const ready = result.state === 'ready' || result.state === 'conditional';
  const arithmetic = result.arithmetic;
  if (!ready || !arithmetic || arithmetic.completionSprint === null || arithmetic.completionDate === null) {
    return empty;
  }

  const reasons: ForecastReason[] = [];

  const groupCount = result.allocation
    ? new Set(result.allocation.timelines.map((t) => t.parallelGroupIndex).filter((i) => i !== null)).size
    : 0;
  reasons.push(
    Object.freeze({
      key: 'order',
      text:
        groupCount > 0
          ? `Items run in ranked order, with ${groupCount} parallel ${groupCount === 1 ? 'group' : 'groups'} whose members run side by side.`
          : 'Items run one after another in rank order, each waiting for the one before it.',
    }),
  );

  reasons.push(Object.freeze({ key: 'pace', text: paceReason(result, arithmetic) }));

  let exactFinish: ForecastExplanation['exactFinish'] = null;
  const finishOffset = overallFinishOffset(result);
  if (finishOffset && arithmetic.startDate) {
    const exactIso = addDays(arithmetic.startDate, exactFinishDays(finishOffset, arithmetic.sprintLengthDays) - 1);
    // The rounded date is the last day of the completion sprint; only surface
    // the exact date when the rounded sprint actually rounds past it.
    const roundsUp = ratioCeil(finishOffset) > ratioFloor(finishOffset);
    if (roundsUp && exactIso !== arithmetic.completionDate) {
      exactFinish = Object.freeze({
        date: formatReadableDate(exactIso),
        isoDate: exactIso,
        forecastDate: formatReadableDate(arithmetic.completionDate),
      });
      reasons.push(
        Object.freeze({
          key: 'exact-finish',
          text: `Work is done ≈ ${formatReadableDate(exactIso)}; the forecast rounds up to the end of Sprint ${arithmetic.completionSprint} (${formatReadableDate(arithmetic.completionDate)}).`,
        }),
      );
    }
  }

  if (result.state === 'conditional') {
    reasons.push(
      Object.freeze({
        key: 'blocked',
        text: 'A blocked item is included with no delay assumed, so the completion may move.',
      }),
    );
  }

  return Object.freeze({
    answer: Object.freeze({
      sprint: arithmetic.completionSprint,
      date: formatReadableDate(arithmetic.completionDate),
      isoDate: arithmetic.completionDate,
    }),
    reasons: Object.freeze(reasons),
    exactFinish,
    asOfDate: arithmetic.asOfDate ?? null,
  });
}

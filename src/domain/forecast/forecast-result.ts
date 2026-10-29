/**
 * Forecast result-state types and immutable envelopes (Story 18.1, AC 18.1-5,
 * Story 18.3, AR-10, AR-11, AR-15).
 *
 * The output distinguishes `invalid`, `incomplete`, `empty`, `zero-work`,
 * `overflow`, `conditional`, and `ready`. `stale` is a presentation/request
 * state rather than an alternative calculated answer. Hard invalid data
 * prevents a ready result; missing configuration/estimates prevent ready;
 * a selected-point total (or derived sprint-day span) outside the safe
 * integer range yields the distinct `overflow` state rather than throwing
 * (AC 18.3-4); explicitly identified unresolved blockers make the
 * capacity-derived target conditional (blocker input arrives in Epic 20).
 *
 * ForecastInputs is the immutable normalization product from one snapshot;
 * ForecastResult is a disposable pure output — never a table or portable
 * field (AD-21).
 */

import type { ForecastPolicyVersion, ForecastPerson } from './forecast-plan.entity';
import type { ReducedRatio } from './forecast-canonical';
import type { ForecastAllocation } from './forecast-allocation';

export type ForecastResultState =
  | 'invalid'
  | 'incomplete'
  | 'empty'
  | 'zero-work'
  | 'overflow'
  | 'conditional'
  | 'ready';

/** A sorted issue with stable ordering (code, field, involved-ID tuple). */
export type ForecastIssue = Readonly<{
  code: string;
  field: string;
  message: string;
  featureIds?: readonly string[];
  personIds?: readonly string[];
}>;

/** Coverage of the selected scope by known estimates. */
export type ForecastCoverage = Readonly<{
  selectedCount: number;
  estimatedCount: number;
  /** 0..1; empty scope uses explicit empty coverage, never a misleading 100%. */
  ratio: ReducedRatio;
}>;

/** The exact arithmetic operands and rounded result (AR-8, AR-15). */
export type ForecastArithmetic = Readonly<{
  totalPoints: number;
  pointsPerSprint: number;
  /** Exact required capacity P/C, reduced with positive denominator. (Q in staffing mode) */
  requiredSprints: ReducedRatio;
  /** Occupied sprint count: ceil(P/C) in shared, ceil(T) in staffing. */
  occupiedSprints: number;
  /** Inclusive completion sprint ordinal. */
  completionSprint: number | null;
  /** Inclusive completion date (ISO YYYY-MM-DD). */
  completionDate: string | null;
  sprintLengthDays: number;
  startSprintOrdinal: number;
  startDate: string;
  /** In staffed-capacity-v1: exact elapsed staffing duration T (sum of block durations) (Story 22.2) */
  elapsedStaffingDuration?: ReducedRatio;
  /** In staffed-capacity-v1: exact unused capacity I = C * T - P in point-equivalents (Story 22.2) */
  idleCapacityPoints?: ReducedRatio;
  idlePointsEquivalent?: ReducedRatio;
  /** Story 26.6: exact as-of offset (sprints) from the start date to `today`. */
  asOfOffset?: ReducedRatio;
  /** Story 26.6: the injected local date this result was evaluated as of. */
  asOfDate?: string | null;
}>;

/** Assumptions the result exposes (NFR-2, AR-15). */
export type ForecastAssumptions = Readonly<{
  policyVersion: ForecastPolicyVersion;
  cadence: 'fixed-contiguous';
  groupingPremise: 'sequential-only' | 'bounded-parallel-equal-share' | 'fixed-assignments';
  rounding: 'ceil-once';
}>;

/**
 * Immutable normalized calculation inputs from one acknowledged snapshot.
 * Carries project, revision, policy, ordered scope, configuration, and the
 * exact relevant Feature estimate facts (AR-15, AD-21).
 */
export type ForecastInputs = Readonly<{
  projectId: string;
  projectRevision: number;
  policyVersion: ForecastPolicyVersion;
  selectedFeatureIds: readonly string[];
  /** Exact relevant Feature estimate facts, keyed by Feature ID. */
  estimates: Readonly<Record<string, number | null>>;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  startSprintOrdinal: number | null;
  startDate: string | null;
  /**
   * Story 26.6 (FC-FR6): the injected local "today" date (ISO). When present
   * and on/after the start date, work begins at the exact offset of today from
   * the start date (fractions of a sprint) and all item offsets shift by it.
   * Absent or null preserves the pre-26.6 behaviour exactly.
   */
  today?: string | null;
  /** Exact as-of offset in sprints derived from `today`, or 0 when unchanged. */
  asOfOffset?: ReducedRatio;
  /** Delivered items are listed as done and count zero points (Story 26.6). */
  deliveredFeatureIds?: readonly string[];
  /** Recorded points done per item, for the remaining-work display. */
  pointsDone?: Readonly<Record<string, number | null>>;
  /** Bounded parallel groups sharing team capacity equally (Story 19.1, AR-5). */
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  /**
   * Forecast-owned explicitly-blocked Feature IDs (Story 20.1, AR-12). In
   * scope-priority order. Any in-scope blocked member turns an otherwise
   * ready/zero-work result `conditional` with no assumed delay; it never
   * withholds a timeline that a missing estimate would not already withhold.
   */
  blockedFeatureIds: readonly string[];
  /** Project roster of people for staffed forecasting (Story 22.1, SF-FR2). */
  roster?: readonly ForecastPerson[];
  /** Per-item assigned person IDs, keyed by item ID (Story 22.1, SF-FR4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * The disposable pure forecast result envelope. Never persisted, never
 * written to authored schedule fields (AD-21).
 */
export type ForecastResult = Readonly<{
  state: ForecastResultState;
  projectId: string;
  projectRevision: number;
  policyVersion: ForecastPolicyVersion;
  /** Lowercase SHA-256 material-input fingerprint. */
  materialFingerprint: string;
  coverage: ForecastCoverage;
  /** Known total points (may be present even when timelines are withheld). */
  totalKnownPoints: number;
  arithmetic: ForecastArithmetic | null;
  assumptions: ForecastAssumptions;
  /** Sorted issues; empty when the result is ready. */
  issues: readonly ForecastIssue[];
  /** Feature timelines and capacity events (withheld when state is not ready or zero-work). */
  allocation: ForecastAllocation | null;
}>;

export function createForecastAssumptions(
  groupingPremise: 'sequential-only' | 'bounded-parallel-equal-share' | 'fixed-assignments' = 'sequential-only',
  policyVersion: ForecastPolicyVersion = 'shared-capacity-v1',
): ForecastAssumptions {
  return Object.freeze({
    policyVersion,
    cadence: 'fixed-contiguous',
    groupingPremise,
    rounding: 'ceil-once',
  });
}

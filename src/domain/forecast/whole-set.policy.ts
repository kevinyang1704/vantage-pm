/**
 * Whole-set forecast policy (Story 18.3, AD-19, AR-7..AR-11, AR-14..AR-16).
 *
 * Pure, framework-free exact capacity arithmetic:
 *
 *   q = P / C                            exact required sprint capacity
 *   n = floor(P / C) + (P mod C != 0)    occupied sprint count (single ceil,
 *                                        exact integer arithmetic — never float
 *                                        division)
 *   completionSprint = startOrdinal + n - 1
 *   completionDate = startDate + (n * sprintLengthDays - 1) calendar days
 *
 * Rounding occurs exactly once (ceil for the containing completion sprint);
 * rounded dates never feed back into capacity arithmetic. Missing estimates,
 * empty scope, zero work, absent/zero capacity, invalid configuration,
 * overlap, unsupported policy, and safe-integer overflow each produce their
 * distinct typed state without infinity, fallback capacity, fabricated
 * defaults, or a thrown exception. The calculation neither reads locale/current
 * time nor writes dates, plan facts, graph data, or persistence (AC 18.3-6).
 *
 * Graph-level scope issues (foreign / non-Feature / parent-descendant overlap)
 * cannot be derived from the immutable inputs alone — they are computed by
 * `normalizeForecastInputs` against the node graph and passed in via
 * `externalIssues`. They are blocking: any present withholds every timeline
 * (AR-4, AC 18.1-3, AC 18.3-4).
 *
 * Non-empty parallel groups are preserved but their allocation policy is not
 * active until Epic 19. A well-formed non-empty group produces an advisory
 * `UNSUPPORTED_GROUPS` issue and never changes the whole-set result — it is
 * never flattened or interpreted as sequential silently.
 *
 * The material fingerprint covers only material facts — ordered IDs, nulls,
 * point values, parallel membership, configuration, and policy. Revision is
 * a separate freshness token: unchanged material facts share a fingerprint
 * across revisions (FORECAST-DESIGN §3.6, AC 18.4-4).
 */

import { Temporal } from 'temporal-polyfill';
import { FORECAST_POLICY_VERSION, STAFFED_FORECAST_POLICY_VERSION } from './forecast-plan.entity';
import { reduceRatio, computeForecastFingerprint, sortIdsLexically } from './forecast-canonical';
import type { ReducedRatio } from './forecast-canonical';
import type { AllocationVisibility, FeatureTimeline } from './forecast-allocation';
import { ratioCeil, ratioFloor, calculateAllocation, addRatios } from './forecast-allocation';
import type { ForecastInputs, ForecastResult, ForecastArithmetic, ForecastCoverage } from './forecast-result';
import { createForecastAssumptions } from './forecast-result';
import type { ForecastIssue } from './forecast-validators';
import { isValidIsoDateOnly, validateRoster, validateStaffingAssignments } from './forecast-validators';
import {
  ratioFromBigInts,
  sprintOrdinalAt,
  calculateStaffedAllocation,
  StaffedArithmeticOverflow,
  type StaffedAllocationResult,
} from './staffed-calculation.policy';

/** Sorted issue ordering: code, then field, then involved-ID tuple (AR-16). */
function sortIssues(issues: readonly ForecastIssue[]): readonly ForecastIssue[] {
  return Object.freeze(
    [...issues].sort((a, b) => {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      if (a.field !== b.field) return a.field < b.field ? -1 : 1;
      const aIds = (a.featureIds ?? []).join(',');
      const bIds = (b.featureIds ?? []).join(',');
      if (aIds !== bIds) return aIds < bIds ? -1 : 1;
      const aPids = (a.personIds ?? []).join(',');
      const bPids = (b.personIds ?? []).join(',');
      return aPids < bPids ? -1 : aPids > bPids ? 1 : 0;
    }),
  );
}

function addDays(dateStr: string, days: number): string {
  return Temporal.PlainDate.from(dateStr).add({ days }).toString();
}

/**
 * Material facts only — revision is a separate freshness token (AC 18.4-4).
 * Semantically unordered collections are canonically ordered so materially
 * equal plans share a fingerprint regardless of source array order (AR-16).
 */
export function forecastMaterialFacts(inputs: ForecastInputs): unknown {
  const priority = new Map(inputs.selectedFeatureIds.map((id, index) => [id, index]));
  const canonicalGroups = inputs.parallelGroups
    .map((group) => Object.freeze({
      featureIds: Object.freeze([...group.featureIds].sort(
        (a, b) => (priority.get(a) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b) ?? Number.MAX_SAFE_INTEGER),
      )),
    }))
    .sort((a, b) =>
      (priority.get(a.featureIds[0]) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(b.featureIds[0]) ?? Number.MAX_SAFE_INTEGER),
    );

  const baseSharedFacts = {
    policyVersion: inputs.policyVersion,
    selectedFeatureIds: inputs.selectedFeatureIds,
    estimates: inputs.estimates,
    pointsPerSprint: inputs.pointsPerSprint,
    sprintLengthDays: inputs.sprintLengthDays,
    startSprintOrdinal: inputs.startSprintOrdinal,
    startDate: inputs.startDate,
    parallelGroups: canonicalGroups,
    // Blocked set is material: marking/clearing a blocker changes the
    // fingerprint so a stale conditional/ready result is not accepted (FR-4).
    // Only in-scope IDs matter, in scope-priority order.
    blockedFeatureIds: inputs.selectedFeatureIds.filter((id) => inputs.blockedFeatureIds.includes(id)),
    // Story 26.6: the injected as-of date changes the result, so it is material
    // when present. Emitted ONLY when set, so a plan evaluated without an
    // injected date keeps its pre-26.6 fingerprint byte-for-byte — the native
    // bridge and portable files build the material facts without these keys.
    ...(inputs.today != null || inputs.asOfOffset != null
      ? { asOfOffset: inputs.asOfOffset ?? null, today: inputs.today ?? null }
      : {}),
  };

  if (inputs.policyVersion === FORECAST_POLICY_VERSION) {
    return Object.freeze(baseSharedFacts);
  }

  // Staffed mode material facts (AC 22.1-3, SF-AR3):
  // All roster weights, including idle people, remain material.
  // Names and unordered serialization order do not participate.
  const canonicalRoster = Object.freeze(
    [...(inputs.roster ?? [])]
      .map((p) => Object.freeze({ id: p.id, weightUnits: p.weightUnits }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  const canonicalAssignments = Object.freeze(
    inputs.selectedFeatureIds
      .filter((id) => (inputs.assignments?.[id]?.length ?? 0) > 0)
      .map((id) => Object.freeze({
        featureId: id,
        personIds: sortIdsLexically(inputs.assignments![id]),
      }))
      .sort((a, b) => a.featureId.localeCompare(b.featureId)),
  );

  return Object.freeze({
    ...baseSharedFacts,
    roster: canonicalRoster,
    assignments: canonicalAssignments,
  });
}

/** Graph-derived scope issues that a `calculateForecast` caller must supply. */
const BLOCKING_EXTERNAL_CODES: ReadonlySet<string> = new Set([
  'FOREIGN_FEATURE',
  'NOT_A_FEATURE',
  'OVERLAPPING_SCOPE',
]);

/**
 * Calculate the whole-set forecast from immutable normalized inputs.
 * Pure: no I/O, no clock, no locale, no writes (AC 18.3-6). Never throws for
 * a data condition — every failure mode is a typed state.
 *
 * `externalIssues` carries graph-level scope issues computed by the caller
/**
 * Calculate the whole-set forecast under `staffed-capacity-v1`.
 * Pure, deterministic, framework-free (Story 22.2).
 */
async function calculateStaffedForecast(
  inputs: ForecastInputs,
  externalIssues: readonly ForecastIssue[] = [],
  allocationVisibility: AllocationVisibility = Object.freeze({}),
): Promise<ForecastResult> {
  const assumptions = createForecastAssumptions('fixed-assignments', STAFFED_FORECAST_POLICY_VERSION);

  // ── Blocking issues: graph-level (external) + scope + group + configuration ─
  const blockingIssues: ForecastIssue[] = [];
  for (const issue of externalIssues) {
    if (BLOCKING_EXTERNAL_CODES.has(issue.code)) blockingIssues.push(issue);
  }
  blockingIssues.push(...validateScopeIssues(inputs));
  blockingIssues.push(...validateGroupIssues(inputs));
  blockingIssues.push(...validateConfigIssues(inputs));

  // ── Staffing validation ───────────────────────────────────────────────
  const roster = inputs.roster ?? [];
  const assignments = inputs.assignments ?? {};
  const rosterIssues = validateRoster(roster);
  const assignmentIssues = validateStaffingAssignments({
    assignments,
    roster,
    selectedFeatureIds: inputs.selectedFeatureIds,
    estimates: inputs.estimates,
    parallelGroups: inputs.parallelGroups,
  });

  const incompleteIssues: ForecastIssue[] = [];
  for (const issue of rosterIssues) {
    blockingIssues.push(issue);
  }
  for (const issue of assignmentIssues) {
    if (issue.code === 'MISSING_ASSIGNMENT') {
      incompleteIssues.push(issue);
    } else {
      blockingIssues.push(issue);
    }
  }

  // ── Conditional blockers (Story 20.1, AR-12) ──────────────────────────
  const blockedSet = new Set(inputs.blockedFeatureIds);
  const seenBlocked = new Set<string>();
  const blockedInScopeIds = inputs.selectedFeatureIds.filter((id) => {
    if (!blockedSet.has(id) || seenBlocked.has(id)) return false;
    seenBlocked.add(id);
    return true;
  });
  const blockerIssues: ForecastIssue[] = blockedInScopeIds.map((id) =>
    Object.freeze({
      code: 'CONDITIONAL_BLOCKER',
      field: 'blockedFeatureIds',
      message: `Feature ${id} is blocked. No delay duration was assumed.`,
      featureIds: Object.freeze([id]),
    }),
  );

  // ── Known totals ──────────────────────────────────────────────────────
  let totalKnownPoints = 0;
  let estimatedCount = 0;
  const missingEstimateIds: string[] = [];
  const seenForTotals = new Set<string>();
  for (const id of inputs.selectedFeatureIds) {
    if (seenForTotals.has(id)) continue;
    seenForTotals.add(id);
    const points = inputs.estimates[id];
    if (points === null || points === undefined) {
      missingEstimateIds.push(id);
    } else {
      totalKnownPoints += points;
      estimatedCount += 1;
    }
  }
  const totalsOverflow = !Number.isSafeInteger(totalKnownPoints);

  const coverage: ForecastCoverage = Object.freeze({
    selectedCount: inputs.selectedFeatureIds.length,
    estimatedCount,
    ratio: reduceRatio(estimatedCount, Math.max(seenForTotals.size, 1)),
  });

  const fingerprint = await computeForecastFingerprint(forecastMaterialFacts(inputs));

  const base = {
    projectId: inputs.projectId,
    projectRevision: inputs.projectRevision,
    policyVersion: inputs.policyVersion,
    materialFingerprint: fingerprint,
    coverage,
    assumptions,
    allocation: null,
  } as const;

  // ── Hard invalid state: scope/group/policy/config/staffing errors withhold all ─
  if (blockingIssues.length > 0) {
    return Object.freeze({
      ...base,
      state: 'invalid',
      totalKnownPoints: totalsOverflow ? 0 : totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([...blockingIssues, ...blockerIssues]),
    });
  }

  // ── Overflow: selected-point total outside the safe integer range (AR-10) ─
  if (totalsOverflow) {
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints: 0,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'estimates',
          message: 'The selected point total exceeds the safe integer range; no timeline can be computed.',
        }),
        ...blockerIssues,
      ]),
    });
  }

  // ── Empty scope: explicit empty result, no implied commitment (AR-10) ──
  if (inputs.selectedFeatureIds.length === 0) {
    return Object.freeze({
      ...base,
      state: 'empty',
      totalKnownPoints: 0,
      arithmetic: null,
      issues: sortIssues(blockerIssues),
    });
  }

  // ── Missing estimates: withhold every timeline, keep known totals ──────
  if (missingEstimateIds.length > 0) {
    return Object.freeze({
      ...base,
      state: 'incomplete',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        ...missingEstimateIds.map((id) =>
          Object.freeze({
            code: 'MISSING_ESTIMATE',
            field: 'estimates',
            message: `Feature ${id} has no estimate.`,
            featureIds: Object.freeze([id]),
          }),
        ),
        ...incompleteIssues,
        ...blockerIssues,
      ]),
    });
  }

  // ── Configuration completeness gate ────────────────────────────────────
  const pointsPerSprint = inputs.pointsPerSprint;
  const sprintLengthDays = inputs.sprintLengthDays;
  const startSprintOrdinal = inputs.startSprintOrdinal;
  const startDate = inputs.startDate;
  if (
    pointsPerSprint === null ||
    sprintLengthDays === null ||
    startSprintOrdinal === null ||
    startDate === null
  ) {
    const missingIssues: ForecastIssue[] = [];
    if (pointsPerSprint === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_CAPACITY', field: 'pointsPerSprint', message: 'Shared capacity is not configured.' }),
      );
    }
    if (sprintLengthDays === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_SPRINT_LENGTH', field: 'sprintLengthDays', message: 'Sprint length is not configured.' }),
      );
    }
    if (startSprintOrdinal === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_START_ORDINAL', field: 'startSprintOrdinal', message: 'Start sprint is not configured.' }),
      );
    }
    if (startDate === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_START_DATE', field: 'startDate', message: 'Start date is not configured.' }),
      );
    }
    return Object.freeze({
      ...base,
      state: 'incomplete',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([...missingIssues, ...incompleteIssues, ...blockerIssues]),
    });
  }

  // ── Zero capacity: never yields an ordinary ready forecast (AR-10) ─────
  if (pointsPerSprint === 0) {
    return Object.freeze({
      ...base,
      state: 'invalid',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'ZERO_CAPACITY',
          field: 'pointsPerSprint',
          message: 'Shared capacity is zero; no division is possible.',
        }),
      ]),
    });
  }

  // ── All-zero work (M10): exact zero required capacity, no sprint consumed ────
  if (totalKnownPoints === 0) {
    const asOfZero = inputs.asOfOffset ?? reduceRatio(0, 1);
    const milestoneWhole = ratioFloor(asOfZero);
    const milestoneSprint = startSprintOrdinal + milestoneWhole;
    const milestoneDate = addDays(startDate, milestoneWhole * sprintLengthDays);
    const arithmetic: ForecastArithmetic = Object.freeze({
      totalPoints: 0,
      pointsPerSprint,
      requiredSprints: reduceRatio(0, pointsPerSprint),
      occupiedSprints: 0,
      completionSprint: milestoneSprint,
      completionDate: milestoneDate,
      sprintLengthDays,
      startSprintOrdinal,
      startDate,
      elapsedStaffingDuration: reduceRatio(0, 1),
      idleCapacityPoints: reduceRatio(0, 1),
      idlePointsEquivalent: reduceRatio(0, 1),
      asOfOffset: asOfZero,
      asOfDate: inputs.today ?? null,
    });

    const timelines: FeatureTimeline[] = inputs.selectedFeatureIds.map((id) =>
      Object.freeze({
        featureId: id,
        estimate: 0,
        isMilestone: true,
        startOffset: asOfZero,
        finishOffset: asOfZero,
        startSprintOrdinal: milestoneSprint,
        completionSprintOrdinal: milestoneSprint,
        startDate: milestoneDate,
        completionDate: milestoneDate,
        parallelGroupIndex: null,
        assignedPersonIds: Object.freeze([...(assignments[id] ?? [])]),
        itemRate: reduceRatio(0, 1),
        duration: reduceRatio(0, 1),
        isBottleneck: false,
      }),
    );

    return Object.freeze({
      ...base,
      state: blockedInScopeIds.length > 0 ? 'conditional' : 'zero-work',
      totalKnownPoints: 0,
      arithmetic,
      allocation: Object.freeze({
        timelines: Object.freeze(timelines),
        events: Object.freeze([]),
      }),
      issues: sortIssues([...blockerIssues]),
    });
  }

  // ── Check missing roster for positive-point work ─────────────────────────
  if (roster.length === 0) {
    incompleteIssues.push(
      Object.freeze({
        code: 'MISSING_ROSTER',
        field: 'roster',
        message: 'Project roster is empty; staffing requires at least one person.',
      }),
    );
  }

  // ── Incomplete staffing issues (missing roster or missing assignments) ────
  if (incompleteIssues.length > 0) {
    return Object.freeze({
      ...base,
      state: 'incomplete',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([...incompleteIssues, ...blockerIssues]),
    });
  }

  // ── Calculate staffed allocation ────────────────────────────────────────
  let staffedAllocation: StaffedAllocationResult;
  try {
    staffedAllocation = calculateStaffedAllocation(
      inputs,
      pointsPerSprint,
      sprintLengthDays,
      startSprintOrdinal,
      startDate,
      allocationVisibility,
      inputs.asOfOffset ?? reduceRatio(0, 1),
    );
  } catch {
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'estimates',
          message: 'The staffing calculation encountered arithmetic overflow; no timeline can be computed.',
        }),
        ...blockerIssues,
      ]),
    });
  }

  const T = staffedAllocation.totalStaffingDuration;
  const Q = reduceRatio(totalKnownPoints, pointsPerSprint);
  // Story 26.6 (AC 26.6-2): staffed work also begins at the as-of offset.
  const asOf = inputs.asOfOffset ?? reduceRatio(0, 1);
  const occupiedSprints = ratioCeil(addRatios(asOf, T));

  // Idle capacity I = C*T - P, formed as ONE exact expression inside the
  // typed overflow contract (Story 22.11, AC 22.11-1/-3). The safe-range check
  // applies to the reduced final value only: the intermediate C*T can exceed
  // the safe range while the complete C*T - P is representable, so it must not
  // be range-checked apart (an unrepresentable FINAL idle quantity is still an
  // `overflow` result, never a rejected calculation).
  let idlePoints: ReducedRatio;
  try {
    idlePoints = ratioFromBigInts(
      BigInt(T.numerator) * BigInt(pointsPerSprint) - BigInt(totalKnownPoints) * BigInt(T.denominator),
      BigInt(T.denominator),
      'idle capacity',
    );
  } catch (error) {
    if (!(error instanceof StaffedArithmeticOverflow)) throw error;
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'estimates',
          message: 'The staffing calculation encountered arithmetic overflow; no timeline can be computed.',
        }),
        ...blockerIssues,
      ]),
    });
  }

  let completionDate: string;
  let completionSprint: number;
  try {
    // Exact: `start + occupied - 1` in floating point can round an unsafe
    // ordinal back into the safe range (AC 22.11-3).
    completionSprint = sprintOrdinalAt(startSprintOrdinal, occupiedSprints);
    const spanDays = occupiedSprints * sprintLengthDays;
    if (!Number.isSafeInteger(spanDays)) {
      throw new RangeError('span out of range');
    }
    completionDate = addDays(startDate, spanDays - 1);
  } catch {
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'sprintLengthDays',
          message: 'The projected sprint span is outside the supported calendar range; no completion date can be computed.',
        }),
        ...blockerIssues,
      ]),
    });
  }

  const arithmetic: ForecastArithmetic = Object.freeze({
    totalPoints: totalKnownPoints,
    pointsPerSprint,
    requiredSprints: Q,
    occupiedSprints,
    completionSprint,
    completionDate,
    sprintLengthDays,
    startSprintOrdinal,
    startDate,
    elapsedStaffingDuration: T,
    idleCapacityPoints: idlePoints,
    idlePointsEquivalent: idlePoints,
    asOfOffset: asOf,
    asOfDate: inputs.today ?? null,
  });

  return Object.freeze({
    ...base,
    state: blockedInScopeIds.length > 0 ? 'conditional' : 'ready',
    totalKnownPoints,
    arithmetic,
    allocation: Object.freeze({
      timelines: staffedAllocation.timelines,
      events: staffedAllocation.events,
    }),
    issues: sortIssues([...blockerIssues]),
  });
}

/**
 * Calculate the whole-set forecast from immutable normalized inputs.
 * Pure: no I/O, no clock, no locale, no writes (AC 18.3-6). Never throws for
 * a data condition — every failure mode is a typed state.
 *
 * `externalIssues` carries graph-level scope issues computed by the caller
 * (`normalizeForecastInputs`); only recognised blocking codes are honoured.
 */
export async function calculateForecast(
  inputs: ForecastInputs,
  externalIssues: readonly ForecastIssue[] = [],
  allocationVisibility: AllocationVisibility = Object.freeze({}),
): Promise<ForecastResult> {
  // ── Dispatch staffed policy explicitly ──────────────────────────────────
  if (inputs.policyVersion === STAFFED_FORECAST_POLICY_VERSION) {
    return calculateStaffedForecast(inputs, externalIssues, allocationVisibility);
  }

  const groupingPremise =
    inputs.parallelGroups.length > 0 ? 'bounded-parallel-equal-share' : 'sequential-only';
  const assumptions = createForecastAssumptions(groupingPremise);

  // ── Policy gate ────────────────────────────────────────────────────────
  if (inputs.policyVersion !== FORECAST_POLICY_VERSION) {
    return Object.freeze({
      state: 'invalid',
      projectId: inputs.projectId,
      projectRevision: inputs.projectRevision,
      policyVersion: inputs.policyVersion,
      materialFingerprint: await computeForecastFingerprint(forecastMaterialFacts(inputs)),
      coverage: Object.freeze({ selectedCount: inputs.selectedFeatureIds.length, estimatedCount: 0, ratio: reduceRatio(0, 1) }),
      totalKnownPoints: 0,
      arithmetic: null,
      assumptions,
      issues: Object.freeze([
        Object.freeze({
          code: 'UNSUPPORTED_POLICY',
          field: 'policyVersion',
          message: `Unsupported forecast policy version: ${inputs.policyVersion}.`,
        }),
      ]),
      allocation: null,
    });
  }

  // ── Blocking issues: graph-level (external) + scope + group + configuration ─
  const blockingIssues: ForecastIssue[] = [];
  for (const issue of externalIssues) {
    if (BLOCKING_EXTERNAL_CODES.has(issue.code)) blockingIssues.push(issue);
  }
  blockingIssues.push(...validateScopeIssues(inputs));
  blockingIssues.push(...validateGroupIssues(inputs));
  blockingIssues.push(...validateConfigIssues(inputs));

  // ── Advisory issues (Story 19.1: parallel groups are active and supported) ─
  const advisoryIssues: ForecastIssue[] = [];

  // ── Conditional blockers (Story 20.1, AR-12) ──────────────────────────
  // One issue per in-scope explicitly-blocked Feature. These never withhold a
  // timeline on their own and never force order — they turn an otherwise
  // ready/zero-work result `conditional` and state that no delay was assumed.
  // They stay visible alongside a missing-estimate diagnostic (AC 20.1-4).
  const blockedSet = new Set(inputs.blockedFeatureIds);
  const seenBlocked = new Set<string>();
  const blockedInScopeIds = inputs.selectedFeatureIds.filter((id) => {
    if (!blockedSet.has(id) || seenBlocked.has(id)) return false;
    seenBlocked.add(id);
    return true;
  });
  const blockerIssues: ForecastIssue[] = blockedInScopeIds.map((id) =>
    Object.freeze({
      code: 'CONDITIONAL_BLOCKER',
      field: 'blockedFeatureIds',
      message: `Feature ${id} is blocked. No delay duration was assumed.`,
      featureIds: Object.freeze([id]),
    }),
  );

  // ── Known totals (deduplicated; retained even when timelines are withheld) ─
  let totalKnownPoints = 0;
  let estimatedCount = 0;
  const missingEstimateIds: string[] = [];
  const seenForTotals = new Set<string>();
  for (const id of inputs.selectedFeatureIds) {
    if (seenForTotals.has(id)) continue;
    seenForTotals.add(id);
    const points = inputs.estimates[id];
    if (points === null || points === undefined) {
      missingEstimateIds.push(id);
    } else {
      totalKnownPoints += points;
      estimatedCount += 1;
    }
  }
  const totalsOverflow = !Number.isSafeInteger(totalKnownPoints);

  const coverage: ForecastCoverage = Object.freeze({
    selectedCount: inputs.selectedFeatureIds.length,
    estimatedCount,
    ratio: reduceRatio(estimatedCount, Math.max(seenForTotals.size, 1)),
  });

  const fingerprint = await computeForecastFingerprint(forecastMaterialFacts(inputs));

  const base = {
    projectId: inputs.projectId,
    projectRevision: inputs.projectRevision,
    policyVersion: inputs.policyVersion,
    materialFingerprint: fingerprint,
    coverage,
    assumptions,
    allocation: null,
  } as const;

  // ── Hard invalid state: scope/group/policy/config problems withhold all ─
  if (blockingIssues.length > 0) {
    return Object.freeze({
      ...base,
      state: 'invalid',
      totalKnownPoints: totalsOverflow ? 0 : totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([...blockingIssues, ...blockerIssues, ...advisoryIssues]),
    });
  }

  // ── Overflow: selected-point total outside the safe integer range (AR-10) ─
  if (totalsOverflow) {
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints: 0,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'estimates',
          message: 'The selected point total exceeds the safe integer range; no timeline can be computed.',
        }),
        ...blockerIssues,
        ...advisoryIssues,
      ]),
    });
  }

  // ── Empty scope: explicit empty result, no implied commitment (AR-10) ──
  if (inputs.selectedFeatureIds.length === 0) {
    return Object.freeze({
      ...base,
      state: 'empty',
      totalKnownPoints: 0,
      arithmetic: null,
      issues: sortIssues(advisoryIssues),
    });
  }

  // ── Missing estimates: withhold every timeline, keep known totals ──────
  if (missingEstimateIds.length > 0) {
    return Object.freeze({
      ...base,
      state: 'incomplete',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        ...missingEstimateIds.map((id) =>
          Object.freeze({
            code: 'MISSING_ESTIMATE',
            field: 'estimates',
            message: `Feature ${id} has no estimate.`,
            featureIds: Object.freeze([id]),
          }),
        ),
        ...blockerIssues,
        ...blockerIssues,
        ...advisoryIssues,
      ]),
    });
  }

  // ── Configuration completeness gate ────────────────────────────────────
  const pointsPerSprint = inputs.pointsPerSprint;
  const sprintLengthDays = inputs.sprintLengthDays;
  const startSprintOrdinal = inputs.startSprintOrdinal;
  const startDate = inputs.startDate;
  if (
    pointsPerSprint === null ||
    sprintLengthDays === null ||
    startSprintOrdinal === null ||
    startDate === null
  ) {
    const missingIssues: ForecastIssue[] = [];
    if (pointsPerSprint === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_CAPACITY', field: 'pointsPerSprint', message: 'Shared capacity is not configured.' }),
      );
    }
    if (sprintLengthDays === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_SPRINT_LENGTH', field: 'sprintLengthDays', message: 'Sprint length is not configured.' }),
      );
    }
    if (startSprintOrdinal === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_START_ORDINAL', field: 'startSprintOrdinal', message: 'Start sprint is not configured.' }),
      );
    }
    if (startDate === null) {
      missingIssues.push(
        Object.freeze({ code: 'MISSING_START_DATE', field: 'startDate', message: 'Start date is not configured.' }),
      );
    }
    return Object.freeze({
      ...base,
      state: 'incomplete',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([...missingIssues, ...blockerIssues, ...advisoryIssues]),
    });
  }

  // ── Zero capacity: never yields an ordinary ready forecast (AR-10) ─────
  if (pointsPerSprint === 0) {
    return Object.freeze({
      ...base,
      state: 'invalid',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'ZERO_CAPACITY',
          field: 'pointsPerSprint',
          message: 'Shared capacity is zero; no division is possible.',
        }),
        ...advisoryIssues,
      ]),
    });
  }

  // ── All-zero work: exact zero required capacity, no sprint consumed ────
  if (totalKnownPoints === 0) {
    const asOfZero = inputs.asOfOffset ?? reduceRatio(0, 1);
    // With zero work no sprint is consumed; milestones sit at the as-of offset.
    // Completion follows the containing sprint of that offset (AC 26.6-2),
    // reducing to the start sprint when no as-of is applied.
    const milestoneWhole = ratioFloor(asOfZero);
    const arithmetic: ForecastArithmetic = Object.freeze({
      totalPoints: 0,
      pointsPerSprint,
      requiredSprints: reduceRatio(0, pointsPerSprint),
      occupiedSprints: 0,
      completionSprint: startSprintOrdinal + milestoneWhole,
      completionDate: addDays(startDate, milestoneWhole * sprintLengthDays),
      sprintLengthDays,
      startSprintOrdinal,
      startDate,
      asOfOffset: asOfZero,
      asOfDate: inputs.today ?? null,
    });
    return Object.freeze({
      ...base,
      state: blockedInScopeIds.length > 0 ? 'conditional' : 'zero-work',
      totalKnownPoints: 0,
      arithmetic,
       allocation: calculateAllocation(inputs, arithmetic, allocationVisibility, asOfZero),
      issues: sortIssues([...blockerIssues, ...advisoryIssues]),
    });
  }

  // ── Ready: exact rational arithmetic, single ceil, calendar completion ──
  const requiredSprints = reduceRatio(totalKnownPoints, pointsPerSprint);
  // Story 26.6 (AC 26.6-2): work begins at the as-of offset; completion is
  // startSprintOrdinal + ceil(asOfOffset + T) − 1. With no as-of (the default)
  // this reduces exactly to the pre-26.6 behaviour.
  const asOf = inputs.asOfOffset ?? reduceRatio(0, 1);
  const workSpan = addRatios(asOf, requiredSprints);
  const occupiedSprints = ratioCeil(workSpan);
  const spanDays = occupiedSprints * sprintLengthDays;
  const completionSprint = startSprintOrdinal + occupiedSprints - 1;

  let completionDate: string;
  try {
    if (!Number.isSafeInteger(spanDays) || !Number.isSafeInteger(completionSprint)) {
      throw new RangeError('span out of range');
    }
    completionDate = addDays(startDate, spanDays - 1);
  } catch {
    return Object.freeze({
      ...base,
      state: 'overflow',
      totalKnownPoints,
      arithmetic: null,
      issues: sortIssues([
        Object.freeze({
          code: 'OVERFLOW',
          field: 'sprintLengthDays',
          message: 'The projected sprint span is outside the supported calendar range; no completion date can be computed.',
        }),
        ...advisoryIssues,
      ]),
    });
  }

  const arithmetic: ForecastArithmetic = Object.freeze({
    totalPoints: totalKnownPoints,
    pointsPerSprint,
    requiredSprints,
    occupiedSprints,
    completionSprint,
    completionDate,
    sprintLengthDays,
    startSprintOrdinal,
    startDate,
    asOfOffset: asOf,
    asOfDate: inputs.today ?? null,
  });

  return Object.freeze({
    ...base,
    state: blockedInScopeIds.length > 0 ? 'conditional' : 'ready',
    totalKnownPoints,
    arithmetic,
     allocation: calculateAllocation(inputs, arithmetic, allocationVisibility, asOf),
    issues: sortIssues([...blockerIssues, ...advisoryIssues]),
  });
}

function validateScopeIssues(inputs: ForecastInputs): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  const seen = new Set<string>();
  for (const id of inputs.selectedFeatureIds) {
    if (seen.has(id)) {
      issues.push(
        Object.freeze({
          code: 'DUPLICATE_MEMBER',
          field: 'selectedFeatureIds',
          message: `Feature ${id} occurs more than once in forecast scope.`,
          featureIds: Object.freeze([id]),
        }),
      );
    }
    seen.add(id);
    const points = inputs.estimates[id];
    if (points !== null && points !== undefined && (!Number.isSafeInteger(points) || points < 0)) {
      issues.push(
        Object.freeze({
          code: 'INVALID_POINTS',
          field: 'estimates',
          message: `Feature ${id} has an invalid estimate.`,
          featureIds: Object.freeze([id]),
        }),
      );
    }
  }
  return Object.freeze(issues);
}

function validateGroupIssues(inputs: ForecastInputs): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  const position = new Map(inputs.selectedFeatureIds.map((id, idx) => [id, idx]));
  const seen = new Set<string>();
  for (const group of inputs.parallelGroups) {
    if (group.featureIds.length < 2) {
      issues.push(
        Object.freeze({
          code: 'INVALID_GROUP',
          field: 'parallelGroups',
          message: 'A parallel group must contain at least two Features.',
          featureIds: Object.freeze([...group.featureIds]),
        }),
      );
      continue;
    }
    const positions: number[] = [];
    for (const id of group.featureIds) {
      if (seen.has(id)) {
        issues.push(
          Object.freeze({
            code: 'INVALID_GROUP',
            field: 'parallelGroups',
            message: `Feature ${id} appears in more than one parallel group.`,
            featureIds: Object.freeze([id]),
          }),
        );
        continue;
      }
      seen.add(id);
      const pos = position.get(id);
      if (pos === undefined) {
        issues.push(
          Object.freeze({
            code: 'INVALID_GROUP',
            field: 'parallelGroups',
            message: `Feature ${id} is not in forecast scope.`,
            featureIds: Object.freeze([id]),
          }),
        );
        continue;
      }
      positions.push(pos);
    }
    if (positions.length > 0) {
      const sorted = [...positions].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] !== sorted[i - 1] + 1) {
          issues.push(
            Object.freeze({
              code: 'INVALID_GROUP',
              field: 'parallelGroups',
              message: 'A parallel group must be contiguous in forecast priority order.',
              featureIds: Object.freeze([...group.featureIds]),
            }),
          );
          break;
        }
      }
    }
  }
  return Object.freeze(issues);
}

function validateConfigIssues(inputs: ForecastInputs): readonly ForecastIssue[] {
  const issues: ForecastIssue[] = [];
  if (inputs.pointsPerSprint !== null && (!Number.isSafeInteger(inputs.pointsPerSprint) || inputs.pointsPerSprint < 0)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_CAPACITY',
        field: 'pointsPerSprint',
        message: 'Shared capacity must be a finite non-negative safe integer or null.',
      }),
    );
  }
  if (inputs.sprintLengthDays !== null && (!Number.isSafeInteger(inputs.sprintLengthDays) || inputs.sprintLengthDays <= 0)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_SPRINT_LENGTH',
        field: 'sprintLengthDays',
        message: 'Sprint length must be a positive safe integer or null.',
      }),
    );
  }
  if (inputs.startSprintOrdinal !== null && (!Number.isSafeInteger(inputs.startSprintOrdinal) || inputs.startSprintOrdinal <= 0)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_START_ORDINAL',
        field: 'startSprintOrdinal',
        message: 'Start sprint ordinal must be a positive safe integer or null.',
      }),
    );
  }
  // Strict calendar validation — a well-formed-but-impossible date (e.g.
  // 2026-02-30) must be a typed issue here, never a thrown RangeError later.
  if (inputs.startDate !== null && !isValidIsoDateOnly(inputs.startDate)) {
    issues.push(
      Object.freeze({
        code: 'INVALID_START_DATE',
        field: 'startDate',
        message: 'Start date must be a strict ISO YYYY-MM-DD calendar date or null.',
      }),
    );
  }
  return Object.freeze(issues);
}

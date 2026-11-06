/**
 * Forecast plan domain entity (Story 18.1, AD-18, AD-19).
 *
 * One project-owned forecast plan: an ordered unique Feature scope, disjoint
 * contiguous parallel groups, shared capacity, cadence/start anchor, and the
 * supported policy version. Forecast inputs are project facts; forecast
 * outputs are disposable deterministic projections (AD-21).
 *
 * The complete plan shape is reserved from this epic — including the empty
 * parallel-group collection — so Epic 19 requires no immediate schema
 * migration. Nonempty imported groups are preserved but reported as
 * unsupported until Story 19.1 activates the complete `shared-capacity-v1`
 * allocation policy; they are never flattened or interpreted as sequential.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

/** The one supported forecast policy version (AD-19, AD-20). */
export const FORECAST_POLICY_VERSION = 'shared-capacity-v1' as const;
export const STAFFED_FORECAST_POLICY_VERSION = 'staffed-capacity-v1' as const;

export type ForecastPolicyVersion =
  | typeof FORECAST_POLICY_VERSION
  | typeof STAFFED_FORECAST_POLICY_VERSION;

/** Contiguous cadence: sprints run back-to-back with no gaps (OQ-4A). */
export type ForecastCadence = 'fixed-contiguous';

export const FORECAST_CADENCE: ForecastCadence = 'fixed-contiguous';

/**
 * The node hierarchy level a forecast plan operates at (Epic 21, D4). Every
 * row in the plan is a node of exactly this type, so a point means the same
 * thing on every row and the whole-set arithmetic is like-for-like.
 */
export type ForecastNodeLevel = 'Theme' | 'Component' | 'Feature';

/** The default planning level for a plan created without one (Epic 21). */
export const DEFAULT_FORECAST_NODE_LEVEL: ForecastNodeLevel = 'Feature';

/**
 * A person in the project-owned forecast roster (Story 22.1, SF-FR2, SF-AR2).
 * Identity is a project-scoped UUIDv7; display name is non-empty plain text;
 * weightUnits is a positive safe integer of hundredths (1.00 -> 100).
 */
export type ForecastPerson = Readonly<{
  id: string;
  name: string;
  weightUnits: number;
}>;

/**
 * Shared-team capacity configuration. Every field is explicitly nullable:
 * an incomplete configuration is valid plan state and is displayed as such —
 * never coerced to a fabricated default (AR-10, UX-DR9).
 */
export type ForecastConfiguration = Readonly<{
  /** Points per sprint for the whole shared team. Null = unconfigured. */
  pointsPerSprint: number | null;
  /** Sprint length in calendar days. Null = unconfigured. */
  sprintLengthDays: number | null;
  /** Contiguous cadence tag. Always 'fixed-contiguous' in v1. */
  cadence: ForecastCadence;
  /** Ordinal of the first sprint (positive safe integer). Null = unconfigured. */
  startSprintOrdinal: number | null;
  /** ISO YYYY-MM-DD first date of the start sprint. Null = unconfigured. */
  startDate: string | null;
}>;

/**
 * A bounded parallel group: at least two unique selected Feature IDs that are
 * contiguous in forecast priority order. Groups are disjoint; members share
 * the team capacity equally under `shared-capacity-v1` (AR-5, AR-18).
 */
export type ForecastParallelGroup = Readonly<{
  readonly featureIds: readonly string[];
}>;

/**
 * Canonicalize a forecast-owned blocked Feature ID set (Story 20.1, AR-12):
 * keep only IDs that are in the selected scope, dedupe, and order by scope
 * priority so a materially equal plan always hashes the same. Blockers are an
 * explicit forecast-owned marker — never inferred from unlock edges, cycles,
 * or delivery status, and never a fourth `Node.deliveryStatus`.
 */
function canonicalizeBlockedFeatureIds(
  blockedFeatureIds: readonly string[],
  selectedFeatureIds: readonly string[],
): readonly string[] {
  const priority = new Map(selectedFeatureIds.map((id, index) => [id, index]));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of blockedFeatureIds) {
    if (seen.has(id) || !priority.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  kept.sort((a, b) => (priority.get(a) ?? 0) - (priority.get(b) ?? 0));
  return Object.freeze(kept);
}

/**
 * The project-owned forecast plan. One per project; created lazily by the
 * first forecast mutation with explicit nullable configuration, empty ordered
 * scope, empty parallel groups, and the supported policy version (AC 18.1-1).
 *
 * Glossary (AR-8, Epic 21): the `*FeatureIds` fields mean "scope members at
 * `planningLevel`" — ids of nodes whose type equals the plan's planning
 * level, which is only sometimes the `Feature` node type. The names are
 * retained for schema stability; they are not a claim about node type.
 */
export type ForecastPlan = Readonly<{
  projectId: string;
  /** Ordered unique selected scope-member IDs — the forecast scope (AR-2, AR-3). */
  selectedFeatureIds: readonly string[];
  /** Disjoint contiguous parallel groups over the selected scope (AR-5). */
  parallelGroups: readonly ForecastParallelGroup[];
  /**
   * Forecast-owned explicitly-blocked scope-member IDs (Story 20.1, AR-12). A
   * subset of `selectedFeatureIds`, ordered by scope priority. Marking a
   * member makes an otherwise-complete numeric result `conditional` with no
   * assumed delay; it never forces order or suppresses calculation.
   */
  blockedFeatureIds: readonly string[];
  configuration: ForecastConfiguration;
  policyVersion: ForecastPolicyVersion;
  /** The node hierarchy level this plan operates at (Epic 21, D4). */
  planningLevel: ForecastNodeLevel;
  /** Project roster of people for staffed forecasting (Story 22.1, SF-FR2). */
  roster: readonly ForecastPerson[];
  /** Per-item assigned person IDs, keyed by item ID (Story 22.1, SF-FR4). */
  assignments: Readonly<Record<string, readonly string[]>>;
  /**
   * Hand-placed sprints and per-sprint capacity overrides for the Delivery
   * Board. Optional so plans built before the sprint plan existed stay valid;
   * a missing value reads as the empty sprint plan.
   */
  sprintPlan?: ForecastSprintPlan;
}>;

/** One hand placement: the item starts in `sprint`. */
export type ForecastSprintPlacement = Readonly<{ itemId: string; sprint: number }>;

/**
 * The Delivery Board's hand-authored sprint plan.
 *
 * `placements` lists the items dropped into a sprint, in the order they were
 * placed (an item appears at most once; re-placing it moves it to the end).
 * Earlier placements keep their room in a sprint when a later one arrives.
 * `capacities` maps a sprint ordinal, written as a decimal string, to that
 * sprint's capacity in points when it differs from the team's points per
 * sprint. Both are project facts; the board's placement of every other item
 * is a disposable projection over them.
 */
export type ForecastSprintPlan = Readonly<{
  placements: readonly ForecastSprintPlacement[];
  capacities: Readonly<Record<string, number>>;
}>;

export const EMPTY_FORECAST_SPRINT_PLAN: ForecastSprintPlan = Object.freeze({
  placements: Object.freeze([]),
  capacities: Object.freeze({}),
});

/** Upper bound on stored entries, so a hostile import cannot balloon a plan. */
export const MAX_FORECAST_SPRINT_PLAN_ENTRIES = 10_000;

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate and canonicalize a sprint plan: one placement per item (the last
 * wins, at its position), capacity keys in sprint order. Throws
 * `INVALID_SPRINT_PLAN` on any malformed entry rather than dropping it, so a
 * damaged stored value is reported instead of silently rewritten.
 */
export function createForecastSprintPlan(input: unknown): ForecastSprintPlan {
  if (input === undefined || input === null) return EMPTY_FORECAST_SPRINT_PLAN;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_SPRINT_PLAN');
  const raw = input as { placements?: unknown; capacities?: unknown };
  const placementsIn = raw.placements ?? [];
  const capacitiesIn = raw.capacities ?? {};
  if (!Array.isArray(placementsIn) || typeof capacitiesIn !== 'object' || capacitiesIn === null || Array.isArray(capacitiesIn)) {
    throw new Error('INVALID_SPRINT_PLAN');
  }
  const capacityEntries = Object.entries(capacitiesIn as Record<string, unknown>);
  if (placementsIn.length + capacityEntries.length > MAX_FORECAST_SPRINT_PLAN_ENTRIES) {
    throw new Error('INVALID_SPRINT_PLAN');
  }
  const lastIndex = new Map<string, number>();
  placementsIn.forEach((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_SPRINT_PLAN');
    const { itemId, sprint } = entry as { itemId?: unknown; sprint?: unknown };
    if (typeof itemId !== 'string') throw new Error('INVALID_SPRINT_PLAN');
    assertUuidV7(itemId, 'INVALID_SPRINT_PLAN');
    if (!isPositiveSafeInt(sprint)) throw new Error('INVALID_SPRINT_PLAN');
    lastIndex.set(itemId, index);
  });
  const placements: ForecastSprintPlacement[] = [];
  placementsIn.forEach((entry: { itemId: string; sprint: number }, index) => {
    if (lastIndex.get(entry.itemId) === index) {
      placements.push(Object.freeze({ itemId: entry.itemId, sprint: entry.sprint }));
    }
  });
  const capacities: Record<string, number> = {};
  for (const [key, points] of capacityEntries.sort(([a], [b]) => Number(a) - Number(b))) {
    if (!/^[1-9][0-9]*$/.test(key) || !isPositiveSafeInt(Number(key))) throw new Error('INVALID_SPRINT_PLAN');
    if (!isNonNegativeSafeInt(points)) throw new Error('INVALID_SPRINT_PLAN');
    capacities[key] = points;
  }
  return Object.freeze({ placements: Object.freeze(placements), capacities: Object.freeze(capacities) });
}

/** True when two sprint plans hold the same facts. */
export function sameForecastSprintPlan(a: ForecastSprintPlan, b: ForecastSprintPlan): boolean {
  const ca = createForecastSprintPlan(a);
  const cb = createForecastSprintPlan(b);
  return JSON.stringify(ca) === JSON.stringify(cb);
}

export function createEmptyForecastPlan(
  projectId: string,
  planningLevel: ForecastNodeLevel = DEFAULT_FORECAST_NODE_LEVEL,
): ForecastPlan {
  assertUuidV7(projectId, 'ForecastPlan.projectId must be a valid UUIDv7');
  return Object.freeze({
    projectId,
    selectedFeatureIds: Object.freeze([]),
    parallelGroups: Object.freeze([]),
    blockedFeatureIds: Object.freeze([]),
    configuration: Object.freeze({
      pointsPerSprint: null,
      sprintLengthDays: null,
      cadence: FORECAST_CADENCE,
      startSprintOrdinal: null,
      startDate: null,
    }),
    policyVersion: FORECAST_POLICY_VERSION,
    planningLevel,
    roster: Object.freeze([]),
    assignments: Object.freeze({}),
    sprintPlan: EMPTY_FORECAST_SPRINT_PLAN,
  });
}

export function createForecastConfiguration(
  params: Readonly<{
    pointsPerSprint: number | null;
    sprintLengthDays: number | null;
    startSprintOrdinal: number | null;
    startDate: string | null;
  }>,
): ForecastConfiguration {
  return Object.freeze({
    pointsPerSprint: params.pointsPerSprint,
    sprintLengthDays: params.sprintLengthDays,
    cadence: FORECAST_CADENCE,
    startSprintOrdinal: params.startSprintOrdinal,
    startDate: params.startDate,
  });
}

/**
 * The one canonical, immutable form of a plan's assignment map: each item's
 * person IDs de-duplicated and ordered case-insensitively. Every adapter that
 * hands a plan to analysis must produce this form, so browser and native
 * reads of the same stored facts are indistinguishable downstream (Story
 * 22.10, AC 22.10-1). Returns fresh frozen arrays; never aliases the input.
 */
export function canonicalizeForecastAssignments(
  assignments: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  // Null prototype: a stored `__proto__` key is a legitimate map entry for the
  // native `HashMap<String, Vec<String>>`, so it must round-trip as an own data
  // property instead of hitting the prototype setter (which would drop the key
  // and replace this object's prototype). See `parseAssignments`.
  const canonical: Record<string, readonly string[]> = Object.create(null);
  for (const [itemId, personIds] of Object.entries(assignments)) {
    canonical[itemId] = Object.freeze(
      [...new Set(personIds)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
  }
  return Object.freeze(canonical);
}

export function createForecastPlan(params: Readonly<{
  projectId: string;
  selectedFeatureIds?: readonly string[];
  parallelGroups?: readonly ForecastParallelGroup[];
  blockedFeatureIds?: readonly string[];
  configuration?: ForecastConfiguration;
  policyVersion?: ForecastPolicyVersion;
  planningLevel?: ForecastNodeLevel;
  roster?: readonly ForecastPerson[];
  assignments?: Readonly<Record<string, readonly string[]>>;
  sprintPlan?: ForecastSprintPlan;
}>): ForecastPlan {
  assertUuidV7(params.projectId, 'ForecastPlan.projectId must be a valid UUIDv7');
  const selectedFeatureIds = Object.freeze([...(params.selectedFeatureIds ?? [])]);
  const scopePosition = new Map(selectedFeatureIds.map((id, index) => [id, index]));
  // Group member order is not independently authored: it is always the
  // priority order of the selected scope. This gives every downstream
  // projection (including simultaneous completion ordering) one canonical
  // representation rather than letting equivalent groups hash differently.
  const parallelGroups = (params.parallelGroups ?? [])
    .map((group) =>
      Object.freeze({
        featureIds: Object.freeze(
          [...group.featureIds].sort(
            (a, b) => (scopePosition.get(a) ?? Number.MAX_SAFE_INTEGER) - (scopePosition.get(b) ?? Number.MAX_SAFE_INTEGER),
          ),
        ),
      }),
    )
    .sort((a, b) =>
      (scopePosition.get(a.featureIds[0]) ?? Number.MAX_SAFE_INTEGER) -
      (scopePosition.get(b.featureIds[0]) ?? Number.MAX_SAFE_INTEGER),
    );

  const roster = Object.freeze(
    (params.roster ?? []).map((p) =>
      Object.freeze({
        id: p.id,
        name: p.name,
        weightUnits: p.weightUnits,
      }),
    ),
  );


  return Object.freeze({
    projectId: params.projectId,
    selectedFeatureIds,
    parallelGroups: Object.freeze(parallelGroups),
    blockedFeatureIds: canonicalizeBlockedFeatureIds(params.blockedFeatureIds ?? [], selectedFeatureIds),
    configuration: params.configuration ?? createForecastConfiguration({
      pointsPerSprint: null,
      sprintLengthDays: null,
      startSprintOrdinal: null,
      startDate: null,
    }),
    policyVersion: params.policyVersion ?? FORECAST_POLICY_VERSION,
    planningLevel: params.planningLevel ?? DEFAULT_FORECAST_NODE_LEVEL,
    roster,
    assignments: canonicalizeForecastAssignments(params.assignments ?? {}),
    sprintPlan: createForecastSprintPlan(params.sprintPlan),
  });
}

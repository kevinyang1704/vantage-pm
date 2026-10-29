/**
 * Forecast change attribution (Story 20.2, AD-23, FR-14, FR-15, AR-24).
 *
 * `compareForecasts` derives *typed* causes from normalized before/after
 * inputs (and the two results, for the changed-outcome dimensions). Each
 * cause names its actual input: an estimate change is never a scope change,
 * a newly-selected Feature's points are `ScopeAdded` rather than an estimate
 * increase from zero, and an unchanged whole-set completion with changed
 * item timing is reported as "Same completion". No additive per-cause day
 * attribution is ever invented — causes carry before/after values only.
 *
 * This is not `AffectedReason` (that models date propagation with delta days
 * and acknowledgement behaviour). Titles and localized prose are computed by
 * the presentation layer, never here — these causes stay canonical.
 */

import type { ForecastInputs, ForecastResult } from './forecast-result';

/** The fixed architectural field order for "First differing input" (§6). */
export const FORECAST_CAUSE_FIELD_ORDER = [
  'policy',
  'scope',
  'estimate',
  'assignment',
  'roster',
  'order',
  'parallel',
  'capacity',
  'start',
  'cadence',
  'constraints',
] as const;

export type ForecastCauseField = (typeof FORECAST_CAUSE_FIELD_ORDER)[number];

export type ForecastChangeCause =
  | Readonly<{ kind: 'ScopeAdded'; field: 'scope'; featureIds: readonly string[] }>
  | Readonly<{ kind: 'ScopeRemoved'; field: 'scope'; featureIds: readonly string[] }>
  | Readonly<{
      kind: 'EstimateIncreased' | 'EstimateDecreased' | 'EstimateSet' | 'EstimateCleared';
      field: 'estimate';
      featureId: string;
      before: number | null;
      after: number | null;
    }>
  | Readonly<{ kind: 'OrderChanged'; field: 'order'; before: readonly string[]; after: readonly string[] }>
  | Readonly<{
      kind: 'ParallelChanged';
      field: 'parallel';
      before: readonly Readonly<{ featureIds: readonly string[] }>[];
      after: readonly Readonly<{ featureIds: readonly string[] }>[];
    }>
  | Readonly<{ kind: 'CapacityChanged'; field: 'capacity'; before: number | null; after: number | null }>
  | Readonly<{
      kind: 'StartChanged';
      field: 'start';
      before: Readonly<{ ordinal: number | null; date: string | null }>;
      after: Readonly<{ ordinal: number | null; date: string | null }>;
    }>
  | Readonly<{ kind: 'CadenceChanged'; field: 'cadence'; before: number | null; after: number | null }>
  | Readonly<{
      kind: 'BlockerChanged';
      field: 'constraints';
      added: readonly string[];
      removed: readonly string[];
    }>
  | Readonly<{
      kind: 'PolicyChanged';
      field: 'policy';
      before: import('./forecast-plan.entity').ForecastPolicyVersion;
      after: import('./forecast-plan.entity').ForecastPolicyVersion;
    }>
  | Readonly<{
      kind: 'AssignmentChanged';
      field: 'assignment';
      featureId: string;
      before: readonly string[];
      after: readonly string[];
    }>
  | Readonly<{
      kind: 'RosterChanged';
      field: 'roster';
      added: readonly string[];
      removed: readonly string[];
    }>
  | Readonly<{
      kind: 'PersonWeightChanged';
      field: 'roster';
      personId: string;
      personName: string;
      before: number;
      after: number;
    }>;

/** Which outcome dimensions moved between the two results (not a day delta). */
export type ForecastChangedDimensions = Readonly<{
  /** The whole-set completion sprint or date changed. */
  date: boolean;
  /** Per-Feature timing (allocation windows) changed. */
  sequence: boolean;
  /** Estimate coverage changed. */
  coverage: boolean;
  /** The result's validity class (ready / conditional / incomplete / …) changed. */
  validity: boolean;
}>;

export type ForecastComparison = Readonly<{
  /** Present when a prior baseline exists; empty array means "no material change". */
  causes: readonly ForecastChangeCause[];
  changedDimensions: ForecastChangedDimensions;
  /**
   * True when the whole-set completion is unchanged but at least one item
   * timing moved — the UI must say "Same completion", never "No change".
   */
  sameCompletion: boolean;
}>;

function lexical(ids: readonly string[]): readonly string[] {
  return [...ids].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function canonicalGroups(
  groups: readonly Readonly<{ featureIds: readonly string[] }>[],
  order: readonly string[],
): string {
  const pos = new Map(order.map((id, i) => [id, i]));
  return JSON.stringify(
    groups
      .map((g) => [...g.featureIds].sort((x, y) => (pos.get(x) ?? 0) - (pos.get(y) ?? 0)))
      .sort((x, y) => (pos.get(x[0]) ?? 0) - (pos.get(y[0]) ?? 0)),
  );
}

/**
 * Compare two acknowledged normalized forecasts. `beforeResult`/`afterResult`
 * are used only to decide which outcome dimensions moved — the causes
 * themselves come from the inputs. When `beforeInputs` is null (no retained
 * baseline — first run or post-restart), attribution is unavailable and the
 * caller must present "historical attribution unavailable" rather than
 * inventing causes (AC 20.2-6).
 */
export function compareForecasts(
  beforeInputs: ForecastInputs | null,
  afterInputs: ForecastInputs,
  beforeResult: ForecastResult | null,
  afterResult: ForecastResult,
  revisionChronology: readonly ForecastCauseField[] = [],
): ForecastComparison | null {
  if (!beforeInputs || !beforeResult) return null;

  const causes: ForecastChangeCause[] = [];

  const beforeSet = new Set(beforeInputs.selectedFeatureIds);
  const afterSet = new Set(afterInputs.selectedFeatureIds);
  const added = afterInputs.selectedFeatureIds.filter((id) => !beforeSet.has(id));
  const removed = beforeInputs.selectedFeatureIds.filter((id) => !afterSet.has(id));

  // 1. Scope (membership set) — before estimates so an added Feature's points
  //    are ScopeAdded, never "estimate increased from zero" (AC 20.2-2).
  if (added.length > 0) causes.push(Object.freeze({ kind: 'ScopeAdded', field: 'scope', featureIds: Object.freeze(lexical(added)) }));
  if (removed.length > 0) causes.push(Object.freeze({ kind: 'ScopeRemoved', field: 'scope', featureIds: Object.freeze(lexical(removed)) }));

  // 2. Estimate — only for Features present in BOTH sets (AC 20.2-1).
  for (const id of lexical([...afterInputs.selectedFeatureIds].filter((x) => beforeSet.has(x)))) {
    const before = beforeInputs.estimates[id] ?? null;
    const after = afterInputs.estimates[id] ?? null;
    if (before === after) continue;
    let kind: 'EstimateIncreased' | 'EstimateDecreased' | 'EstimateSet' | 'EstimateCleared';
    if (before === null) kind = 'EstimateSet';
    else if (after === null) kind = 'EstimateCleared';
    else kind = after > before ? 'EstimateIncreased' : 'EstimateDecreased';
    causes.push(Object.freeze({ kind, field: 'estimate', featureId: id, before, after }));
  }

  // 3. Order — same membership, different sequence.
  if (
    beforeSet.size === afterSet.size &&
    [...beforeSet].every((id) => afterSet.has(id)) &&
    !sameSequence(beforeInputs.selectedFeatureIds, afterInputs.selectedFeatureIds)
  ) {
    causes.push(Object.freeze({
      kind: 'OrderChanged',
      field: 'order',
      before: Object.freeze([...beforeInputs.selectedFeatureIds]),
      after: Object.freeze([...afterInputs.selectedFeatureIds]),
    }));
  }

  // 4. Parallel groups.
  if (
    canonicalGroups(beforeInputs.parallelGroups, beforeInputs.selectedFeatureIds) !==
    canonicalGroups(afterInputs.parallelGroups, afterInputs.selectedFeatureIds)
  ) {
    causes.push(Object.freeze({
      kind: 'ParallelChanged',
      field: 'parallel',
      before: Object.freeze(beforeInputs.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))),
      after: Object.freeze(afterInputs.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))),
    }));
  }

  // 5. Capacity.
  if (beforeInputs.pointsPerSprint !== afterInputs.pointsPerSprint) {
    causes.push(Object.freeze({
      kind: 'CapacityChanged',
      field: 'capacity',
      before: beforeInputs.pointsPerSprint,
      after: afterInputs.pointsPerSprint,
    }));
  }

  // 6. Start anchor (ordinal + date are one cause).
  if (
    beforeInputs.startSprintOrdinal !== afterInputs.startSprintOrdinal ||
    beforeInputs.startDate !== afterInputs.startDate
  ) {
    causes.push(Object.freeze({
      kind: 'StartChanged',
      field: 'start',
      before: Object.freeze({ ordinal: beforeInputs.startSprintOrdinal, date: beforeInputs.startDate }),
      after: Object.freeze({ ordinal: afterInputs.startSprintOrdinal, date: afterInputs.startDate }),
    }));
  }

  // 7. Cadence (sprint length in days).
  if (beforeInputs.sprintLengthDays !== afterInputs.sprintLengthDays) {
    causes.push(Object.freeze({
      kind: 'CadenceChanged',
      field: 'cadence',
      before: beforeInputs.sprintLengthDays,
      after: afterInputs.sprintLengthDays,
    }));
  }

  // 8. Blockers.
  const beforeBlocked = new Set(beforeInputs.blockedFeatureIds);
  const afterBlocked = new Set(afterInputs.blockedFeatureIds);
  const blockersAdded = afterInputs.blockedFeatureIds.filter((id) => !beforeBlocked.has(id));
  const blockersRemoved = beforeInputs.blockedFeatureIds.filter((id) => !afterBlocked.has(id));
  if (blockersAdded.length > 0 || blockersRemoved.length > 0) {
    causes.push(Object.freeze({
      kind: 'BlockerChanged',
      field: 'constraints',
      added: Object.freeze(lexical(blockersAdded)),
      removed: Object.freeze(lexical(blockersRemoved)),
    }));
  }

  // 9. Policy (mode).
  if (beforeInputs.policyVersion !== afterInputs.policyVersion) {
    causes.push(
      Object.freeze({
        kind: 'PolicyChanged',
        field: 'policy',
        before: beforeInputs.policyVersion,
        after: afterInputs.policyVersion,
      }),
    );
  }

  // 10. Assignments — only for Features present in BOTH scopes (AC 23.2-3, AC 23.2-5;
  //     added or removed Features are ScopeAdded / ScopeRemoved, not AssignmentChanged).
  const beforeAssign = beforeInputs.assignments ?? {};
  const afterAssign = afterInputs.assignments ?? {};
  const commonScope = new Set(afterInputs.selectedFeatureIds.filter((id) => beforeSet.has(id)));
  const allAssignFeatureIds = new Set([
    ...Object.keys(beforeAssign).filter((id) => commonScope.has(id)),
    ...Object.keys(afterAssign).filter((id) => commonScope.has(id)),
  ]);
  const personNameMap = new Map<string, string>();
  for (const p of [...(beforeInputs.roster ?? []), ...(afterInputs.roster ?? [])]) {
    personNameMap.set(p.id, p.name);
  }
  for (const id of lexical([...allAssignFeatureIds])) {
    const bList = [...(beforeAssign[id] ?? [])].sort();
    const aList = [...(afterAssign[id] ?? [])].sort();
    if (bList.length !== aList.length || bList.some((p, i) => p !== aList[i])) {
      const bNames = bList.map((pid) => personNameMap.get(pid) || pid);
      const aNames = aList.map((pid) => personNameMap.get(pid) || pid);
      causes.push(
        Object.freeze({
          kind: 'AssignmentChanged',
          field: 'assignment',
          featureId: id,
          before: Object.freeze(bNames),
          after: Object.freeze(aNames),
        }),
      );
    }
  }

  // 11. Roster & Person weights.
  const beforeRoster = beforeInputs.roster ?? [];
  const afterRoster = afterInputs.roster ?? [];
  const beforePersonMap = new Map(beforeRoster.map((p) => [p.id, p]));
  const afterPersonMap = new Map(afterRoster.map((p) => [p.id, p]));
  const rosterAdded = afterRoster.filter((p) => !beforePersonMap.has(p.id)).map((p) => p.name);
  const rosterRemoved = beforeRoster.filter((p) => !afterPersonMap.has(p.id)).map((p) => p.name);
  if (rosterAdded.length > 0 || rosterRemoved.length > 0) {
    causes.push(
      Object.freeze({
        kind: 'RosterChanged',
        field: 'roster',
        added: Object.freeze(rosterAdded),
        removed: Object.freeze(rosterRemoved),
      }),
    );
  }
  for (const [id, afterP] of afterPersonMap) {
    const beforeP = beforePersonMap.get(id);
    if (beforeP && beforeP.weightUnits !== afterP.weightUnits) {
      causes.push(
        Object.freeze({
          kind: 'PersonWeightChanged',
          field: 'roster',
          personId: id,
          personName: afterP.name,
          before: beforeP.weightUnits,
          after: afterP.weightUnits,
        }),
      );
    }
  }

  // Proven ChangeSet chronology wins; absent history uses stable §6 field order.
  causes.sort((a, b) => {
    const chronologyIndex = (field: ForecastCauseField) => {
      const index = revisionChronology.indexOf(field);
      return index < 0 ? revisionChronology.length + FORECAST_CAUSE_FIELD_ORDER.indexOf(field) : index;
    };
    const fa = chronologyIndex(a.field);
    const fb = chronologyIndex(b.field);
    if (fa !== fb) return fa - fb;
    const ida = 'featureId' in a ? a.featureId : 'featureIds' in a ? a.featureIds.join(',') : '';
    const idb = 'featureId' in b ? b.featureId : 'featureIds' in b ? b.featureIds.join(',') : '';
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });

  const beforeArith = beforeResult.arithmetic;
  const afterArith = afterResult.arithmetic;
  const dateChanged =
    (beforeArith?.completionSprint ?? null) !== (afterArith?.completionSprint ?? null) ||
    (beforeArith?.completionDate ?? null) !== (afterArith?.completionDate ?? null);
  const sequenceChanged =
    JSON.stringify(beforeResult.allocation?.timelines ?? null) !==
    JSON.stringify(afterResult.allocation?.timelines ?? null);
  const coverageChanged =
    JSON.stringify(beforeResult.coverage) !== JSON.stringify(afterResult.coverage);
  const validityChanged = beforeResult.state !== afterResult.state;

  return Object.freeze({
    causes: Object.freeze(causes),
    changedDimensions: Object.freeze({
      date: dateChanged,
      sequence: sequenceChanged,
      coverage: coverageChanged,
      validity: validityChanged,
    }),
    // "Same completion" — the whole-set date held while item timing moved
    // (AC 20.2-3, UX-DR14). Only meaningful when both results have a date.
    sameCompletion:
      !dateChanged && sequenceChanged && beforeArith !== null && afterArith !== null,
  });
}

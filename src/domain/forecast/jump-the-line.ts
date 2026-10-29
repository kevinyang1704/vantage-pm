/**
 * Jump-the-line what-if drafts (Epic 26, Story 26.7, FC-FR7, FC-FR8, FC-NFR1).
 *
 * Pure builders over the existing levers only: rank, assignments, parallel
 * groups and scope. No calculation change. Each strategy produces a scenario
 * patch against the captured baseline; evaluation happens in the worker as of
 * the injected today. `compareItemFinishes` reads each item's old and new
 * finish from the two acknowledged results so the view can show slips without
 * inventing dates.
 */

import type { ForecastScenarioPatch, ForecastScenarioBaseline } from './scenario';
import type { ForecastResult } from './forecast-result';
import type { ScenarioFeatureFact } from './scenario';

export type JumpStrategy = 'everyone-pauses' | 'chosen-people' | 'hold-the-date';

/** The urgent item, existing (a selected id) or new (a draft title + points). */
export type UrgentItem =
  | Readonly<{ kind: 'existing'; featureId: string }>
  | Readonly<{ kind: 'new'; draftId: string; title: string; effortPoints: number }>;

export type JumpDraftBuild = Readonly<{
  /** The scenario patch to evaluate for this strategy. */
  patch: ForecastScenarioPatch;
  /** A new draft item's captured fact, merged into the baseline when present. */
  addedFact?: Readonly<{ id: string; fact: ScenarioFeatureFact }>;
  /** Lowest-ranked feature IDs removed from scope by hold-the-date. */
  deferredFeatureIds: readonly string[];
  /** True when hold-the-date could not reach the live completion. */
  unreachable: boolean;
  /** Human-readable reason when a strategy is not offered. */
  unavailable?: string;
}>;

/**
 * Build the "everyone pauses" draft: the urgent item first, everything else
 * keeps its order and waits. Its people default to the people on the item it
 * displaces.
 */
export function buildEveryonePauses(
  baseline: ForecastScenarioBaseline,
  urgent: UrgentItem,
): JumpDraftBuild {
  const urgentId = urgent.kind === 'new' ? urgent.draftId : urgent.featureId;
  const ordered = [urgentId, ...baseline.orderedScope.filter((id) => id !== urgentId)];
  // AC 26.7-2: the urgent item's people default to the people on the item it
  // displaces (the first in the new order). Only in assigned-people mode.
  const assignmentOverrides: Record<string, readonly string[]> = {};
  if (baseline.policyVersion === 'staffed-capacity-v1') {
    assignmentOverrides[urgentId] = Object.freeze([
      ...(baseline.assignments?.[baseline.orderedScope[0] ?? ''] ?? []),
    ]);
  }
  const hasOverrides = Object.keys(assignmentOverrides).length > 0;
  return Object.freeze({
    patch: Object.freeze({
      orderedScope: Object.freeze(ordered),
      ...(hasOverrides ? { assignmentOverrides: Object.freeze(assignmentOverrides) } : {}),
    }),
    ...(urgent.kind === 'new'
      ? {
          addedFact: Object.freeze({
            id: urgent.draftId,
            fact: Object.freeze({
              effortPoints: urgent.effortPoints,
              nodeType: baseline.planningLevel,
              projectId: baseline.projectId,
              ancestorIds: Object.freeze([]),
            }),
          }),
        }
      : {}),
    deferredFeatureIds: Object.freeze([]),
    unreachable: false,
  });
}

/**
 * Build the "chosen people take it" draft: the urgent item and the following
 * items form one parallel group; those items' assignments exclude the chosen
 * people. The caller validates that no two group members share a person.
 */
export function buildChosenPeople(
  baseline: ForecastScenarioBaseline,
  urgent: UrgentItem,
  chosenPersonIds: readonly string[],
  groupSize: number,
): JumpDraftBuild {
  const urgentId = urgent.kind === 'new' ? urgent.draftId : urgent.featureId;
  const groupMembers = [urgentId, ...baseline.orderedScope.filter((id) => id !== urgentId)].slice(
    0,
    Math.max(groupSize, 2),
  );
  const assignmentOverrides: Record<string, readonly string[]> = {};
  const staffed = baseline.policyVersion === 'staffed-capacity-v1';
  if (staffed) {
    // The urgent item takes the chosen people (or defaults to the displaced
    // item's people); every group member excludes the chosen people.
    const chosen = chosenPersonIds.length > 0 ? chosenPersonIds : baseline.assignments?.[baseline.orderedScope[0] ?? ''] ?? [];
    assignmentOverrides[urgentId] = Object.freeze([...chosen]);
    for (const id of groupMembers) {
      if (id === urgentId) continue;
      const current = baseline.assignments?.[id] ?? [];
      assignmentOverrides[id] = Object.freeze(current.filter((p) => !chosen.includes(p)));
    }
  }
  const hasOverrides = Object.keys(assignmentOverrides).length > 0;
  return Object.freeze({
    patch: Object.freeze({
      orderedScope: Object.freeze([urgentId, ...baseline.orderedScope.filter((id) => id !== urgentId)]),
      parallelGroups: Object.freeze([Object.freeze({ featureIds: Object.freeze(groupMembers) })]),
      ...(hasOverrides ? { assignmentOverrides: Object.freeze(assignmentOverrides) } : {}),
    }),
    ...(urgent.kind === 'new'
      ? {
          addedFact: Object.freeze({
            id: urgent.draftId,
            fact: Object.freeze({
              effortPoints: urgent.effortPoints,
              nodeType: baseline.planningLevel,
              projectId: baseline.projectId,
              ancestorIds: Object.freeze([]),
            }),
          }),
        }
      : {}),
    deferredFeatureIds: Object.freeze([]),
    unreachable: false,
  });
}

/**
 * Build the "hold the date" draft: like everyone-pauses, then the lowest-ranked
 * items are removed from scope one at a time until completion is no later than
 * the live plan's. Returns the final build plus the deferred ids and whether
 * the target was reachable. `isNoLaterThanLive(scope)` evaluates a candidate.
 */
export function buildHoldTheDate(
  baseline: ForecastScenarioBaseline,
  urgent: UrgentItem,
  isNoLaterThanLive: (patch: ForecastScenarioPatch) => boolean,
): JumpDraftBuild {
  const base = buildEveryonePauses(baseline, urgent);
  const baseScope = [...(base.patch.orderedScope ?? baseline.orderedScope)];
  const deferred: string[] = [];
  let scope = baseScope;

  // Try with nothing deferred first.
  if (isNoLaterThanLive(Object.freeze({ ...base.patch, orderedScope: Object.freeze(scope) }))) {
    return Object.freeze({ ...base, deferredFeatureIds: Object.freeze([]), unreachable: false });
  }

  // Remove the lowest-ranked item, one at a time, until the target is reached.
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const candidate = scope[i];
    // Never defer the urgent item itself.
    const urgentId = urgent.kind === 'new' ? urgent.draftId : urgent.featureId;
    if (candidate === urgentId) continue;
    deferred.push(candidate);
    scope = scope.filter((id) => id !== candidate);
    if (isNoLaterThanLive(Object.freeze({ ...base.patch, orderedScope: Object.freeze(scope) }))) {
      return Object.freeze({
        ...base,
        patch: Object.freeze({ ...base.patch, orderedScope: Object.freeze(scope) }),
        deferredFeatureIds: Object.freeze(deferred),
        unreachable: false,
      });
    }
  }
  // Could not reach the live completion even by deferring everything else.
  return Object.freeze({
    ...base,
    patch: Object.freeze({ ...base.patch, orderedScope: Object.freeze(scope) }),
    deferredFeatureIds: Object.freeze(deferred),
    unreachable: true,
  });
}

export type ItemFinishDiff = Readonly<{
  featureId: string;
  oldFinish: string | null;
  newFinish: string | null;
  /** Signed whole-day slip (positive = later). Null when either side is absent. */
  slipDays: number | null;
  slipLabel: string;
  kind: 'first' | 'deferred' | 'moved' | 'same';
}>;

function daysBetweenIso(a: string, b: string): number | null {
  try {
    const toUtc = (s: string): number => {
      const [y, m, d] = s.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
  } catch {
    return null;
  }
}

/**
 * Plain stakeholder summary (AC 26.7-4, FC-UX5): names only the urgent item,
 * the affected items and their old/new dates, deferred items and the
 * completion change. No invented rationale.
 */
export function stakeholderSummary(params: {
  urgentTitle: string;
  diffs: readonly ItemFinishDiff[];
  names: (id: string) => string;
  liveCompletion: string | null;
  whatIfCompletion: string | null;
}): string {
  const parts: string[] = [];
  const moved = params.diffs.filter((d) => d.kind === 'moved');
  const deferred = params.diffs.filter((d) => d.kind === 'deferred');
  const first = params.diffs.find((d) => d.kind === 'first');

  if (first?.newFinish) {
    parts.push(`Taking on the ${params.urgentTitle} now ships it by ${first.newFinish}.`);
  } else {
    parts.push(`The ${params.urgentTitle} moves to the front of the plan.`);
  }
  for (const d of moved) {
    parts.push(
      `${params.names(d.featureId)} moves from ${d.oldFinish ?? 'unscheduled'} to ${d.newFinish ?? 'unscheduled'}.`,
    );
  }
  if (deferred.length > 0) {
    parts.push(
      `${deferred.map((d) => params.names(d.featureId)).join(', ')} ${
        deferred.length === 1 ? 'is' : 'are'
      } deferred out of this plan.`,
    );
  }
  if (params.liveCompletion && params.whatIfCompletion && params.liveCompletion !== params.whatIfCompletion) {
    parts.push(`The plan now completes ${params.whatIfCompletion} instead of ${params.liveCompletion}.`);
  } else if (params.whatIfCompletion) {
    parts.push(`The plan completes ${params.whatIfCompletion}.`);
  }
  return parts.join(' ');
}

export function compareItemFinishes(
  before: ForecastResult | null,
  after: ForecastResult | null,
  deferredIds: readonly string[] = [],
): readonly ItemFinishDiff[] {
  const finishOf = (result: ForecastResult | null, id: string): string | null =>
    result?.allocation?.timelines.find((t) => t.featureId === id)?.completionDate ?? null;
  const ids = new Set<string>([
    ...(before?.allocation?.timelines.map((t) => t.featureId) ?? []),
    ...(after?.allocation?.timelines.map((t) => t.featureId) ?? []),
  ]);
  const deferredSet = new Set(deferredIds);
  const diffs: ItemFinishDiff[] = [];
  for (const id of ids) {
    const oldFinish = finishOf(before, id);
    const deferred = deferredSet.has(id);
    const newFinish = deferred ? null : finishOf(after, id);
    let kind: ItemFinishDiff['kind'];
    let slipDays: number | null = null;
    let slipLabel: string;
    if (deferred) {
      kind = 'deferred';
      slipLabel = 'deferred';
    } else if (oldFinish === null && newFinish !== null) {
      kind = 'first';
      slipLabel = 'first';
    } else if (oldFinish !== null && newFinish !== null) {
      slipDays = daysBetweenIso(oldFinish, newFinish);
      if (slipDays === 0) {
        kind = 'same';
        slipLabel = 'no change';
      } else {
        kind = 'moved';
        slipLabel = slipDays! > 0 ? `+${slipDays} days` : `${Math.abs(slipDays!)} days sooner`;
      }
    } else if (oldFinish !== null && newFinish === null) {
      // The item is in the plan but its new timeline is withheld (the variant
      // is incomplete/invalid) — never presented as a deliberate deferral.
      kind = 'moved';
      slipLabel = 'not planned';
    } else {
      // Present only on the what-if side (an added item with no finish yet).
      kind = 'first';
      slipLabel = 'first';
    }
    diffs.push(Object.freeze({ featureId: id, oldFinish, newFinish, slipDays, slipLabel, kind }));
  }
  return Object.freeze(diffs);
}

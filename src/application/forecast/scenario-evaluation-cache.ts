/**
 * Saved-scenario evaluation cache (Story 25.1 AC 25.1-1).
 *
 * Extracted from the main.tsx effect so the no-re-hash / no-re-request
 * behaviour is directly testable.
 *
 * Why a content key, not object identity: every forecast refresh rebuilds the
 * scenario array from the worker read, so the same scenario arrives as a fresh
 * frozen object each time. Comparing object identity would never hit, leaving
 * the expensive `scenarioFingerprint` SHA-256 running on the main thread for
 * every scenario on every refresh — exactly what this story removes. The cache
 * therefore keys on a cheap structural signature ("content key") of the
 * persisted fields; the costly fingerprint is computed only when that key
 * changes.
 */

import type { PersistedForecastScenario } from '../../domain/forecast/scenario';
import type { ScenarioEvaluation } from '../../domain/forecast/scenario-evaluate';

export interface ScenarioCacheEntry {
  /** Cheap structural key of the persisted scenario that produced this entry. */
  readonly contentKey: string;
  readonly fingerprint: string;
  readonly evaluation: ScenarioEvaluation;
}

export type ScenarioEvaluationCache = Map<string, ScenarioCacheEntry>;

export interface ReconcileResult {
  readonly evaluations: ReadonlyMap<string, ScenarioEvaluation>;
  /** Scenarios that needed the expensive fingerprint recomputation. */
  readonly hashed: number;
  /** Scenarios that needed a worker request. */
  readonly requested: number;
}

/**
 * A cheap, stable signature of a persisted scenario's material content.
 *
 * Soundness rests on the id-immutability invariant: a scenario's `scenarioId`
 * is a fresh UUIDv7 assigned at create, and saved scenarios are immutable
 * records (remove then create mints a new id; there is no rename/update
 * command). So for a given id the captured `baseline` never changes, and its
 * stored `baselineFingerprint` is a sufficient proxy for the baseline's
 * material content. The key therefore covers the identity, the baseline
 * provenance, and a *canonicalised* patch — override maps are emitted in
 * sorted key order and assignment arrays in sorted order, mirroring
 * `scenarioFingerprint`, so a semantically identical patch always yields the
 * same key regardless of insertion order.
 */
export function scenarioContentKey(scenario: PersistedForecastScenario, today?: string | null): string {
  const patch = scenario.patch;
  const canonicalPatch = {
    orderedScope: patch.orderedScope ?? null,
    pointOverrides: sortedEntries(patch.pointOverrides),
    // Distinguish undefined ("use baseline") from null (an explicit override),
    // because the evaluator treats them differently.
    pointsPerSprint:
      patch.pointsPerSprint === undefined ? 'undefined' : patch.pointsPerSprint,
    weightOverrides: sortedEntries(patch.weightOverrides),
    assignmentOverrides:
      patch.assignmentOverrides === undefined
        ? null
        : Object.fromEntries(
            Object.keys(patch.assignmentOverrides)
              .sort()
              .map((id) => [id, [...(patch.assignmentOverrides?.[id] ?? [])].sort()]),
          ),
    // Story 26.4 levers.
    policyVersion: patch.policyVersion ?? null,
    parallelGroups: patch.parallelGroups ?? null,
  };
  return JSON.stringify([
    scenario.scenarioId,
    scenario.projectId,
    scenario.label,
    scenario.baselineRevision,
    scenario.baselineFingerprint,
    scenario.policyVersion,
    scenario.createdAtISO,
    // Story 26.6 AC 26.6-4: the injected date is part of the evaluation identity.
    today ?? null,
    canonicalPatch,
  ]);
}

function sortedEntries(
  map: Readonly<Record<string, number>> | undefined,
): readonly (readonly [string, number])[] | null {
  if (map === undefined) return null;
  return Object.keys(map)
    .sort()
    .map((k) => [k, map[k]] as const);
}

/**
 * Reconcile the cached evaluations against the current scenario set:
 *   - same content key → reuse with no hash and no request;
 *   - new key but same fingerprint → reuse with no request;
 *   - changed content → hash once and evaluate once.
 * Duplicate scenario ids are evaluated once (first wins). Stale entries are
 * dropped. The supplied `cache` is updated in place.
 */
export async function reconcileScenarioEvaluations(
  cache: ScenarioEvaluationCache,
  scenarios: readonly PersistedForecastScenario[],
  fingerprintOf: (scenario: PersistedForecastScenario) => Promise<string>,
  evaluate: (scenario: PersistedForecastScenario, fingerprint: string) => Promise<ScenarioEvaluation | undefined>,
  isStale: () => boolean = () => false,
  today: string | null = null,
): Promise<ReconcileResult> {
  const evaluations = new Map<string, ScenarioEvaluation>();
  const rebuilt: ScenarioEvaluationCache = new Map();
  const seenIds = new Set<string>();
  let hashed = 0;
  let requested = 0;

  for (const scenario of scenarios) {
    // A duplicated id (corrupt read) evaluates once; first occurrence wins.
    if (seenIds.has(scenario.scenarioId)) continue;
    seenIds.add(scenario.scenarioId);

    const cached = cache.get(scenario.scenarioId);
    const contentKey = scenarioContentKey(scenario, today);
    let evaluation: ScenarioEvaluation | undefined;
    let fingerprint: string;

    if (cached && cached.contentKey === contentKey) {
      evaluation = cached.evaluation;
      fingerprint = cached.fingerprint;
    } else {
      fingerprint = await fingerprintOf(scenario);
      hashed += 1;
      if (cached && cached.fingerprint === fingerprint) {
        evaluation = cached.evaluation;
      } else {
        evaluation = await evaluate(scenario, fingerprint);
        requested += 1;
      }
    }

    if (evaluation) {
      evaluations.set(scenario.scenarioId, evaluation);
      rebuilt.set(scenario.scenarioId, { contentKey, fingerprint, evaluation });
    }
  }

  // A newer reconcile pass may have started while this one awaited the worker;
  // abandon the write so an older pass cannot clobber the newer cache.
  if (isStale()) return Object.freeze({ evaluations, hashed, requested });

  cache.clear();
  for (const [id, entry] of rebuilt) cache.set(id, entry);
  return Object.freeze({ evaluations, hashed, requested });
}

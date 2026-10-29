/**
 * Captured scenario-draft context (Story 23.7, AC 23.7-1/-2/-3; review R2).
 *
 * A draft is prepared against ONE acknowledged revision. Opening a draft
 * captures, once, the complete historical baseline the save command will
 * store — ordered scope, configuration, groups, blockers, level, policy,
 * roster and assignments, plus a fact map over every item the draft may
 * add — together with the project ID, revision and material fingerprint the
 * save must expect. Nothing here reads a live result's arithmetic: the
 * configuration comes from the canonical plan inputs, so an incomplete or
 * invalid live forecast still captures its real configuration and never a
 * substituted default.
 *
 * Later live edits cannot reach a captured context. Saving sends the
 * captured expectations; a changed live plan is rejected as stale, and only
 * an explicit Refresh baseline captures a new context.
 */

import type { Node } from '../../domain/tree/node.entity';
import {
  createForecastPlan,
  STAFFED_FORECAST_POLICY_VERSION,
  type ForecastNodeLevel,
  type ForecastPlan,
  type ForecastPolicyVersion,
} from '../../domain/forecast/forecast-plan.entity';
import { normalizeForecastInputs } from '../../domain/forecast/forecast-normalization';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import type {
  ForecastScenarioBaseline,
  ForecastScenarioPatch,
  PersistedForecastScenario,
  ScenarioFeatureFact,
} from '../../domain/forecast/scenario';

/** One item the draft may include, with its title as captured (never a live lookup). */
export type ScenarioDraftItem = Readonly<{
  id: string;
  /** Title at capture time; empty when the captured node had none. */
  title: string;
  effortPoints: number | null;
  /** In the captured baseline scope. */
  included: boolean;
}>;

export type ScenarioDraftContext = Readonly<{
  /** Identity of this capture; also the worker request's scenario identity. */
  draftId: string;
  projectId: string;
  /** The acknowledged revision every captured fact came from. */
  baselineRevision: number;
  /** Material fingerprint of the captured plan inputs — the save's expectation. */
  materialFingerprint: string;
  policyVersion: ForecastPolicyVersion;
  planningLevel: ForecastNodeLevel;
  baseline: ForecastScenarioBaseline;
  /** Captured candidate items: baseline scope in order, then the rest of the level. */
  items: readonly ScenarioDraftItem[];
}>;

export type ScenarioDraftSnapshot = Readonly<{
  projectId: string;
  projectRevision: number;
  nodes: readonly Node[];
  forecastPlan?: ForecastPlan;
  forecastPlanError?: string;
}>;

/** Fact for one node, built exactly as the repository's scenario fact map. */
function factFor(id: string, byId: ReadonlyMap<string, Node>): ScenarioFeatureFact {
  const node = byId.get(id);
  const ancestors: string[] = [];
  const visited = new Set<string>([id]);
  let cur = node?.parentId ?? null;
  while (cur !== null && !visited.has(cur)) {
    visited.add(cur);
    ancestors.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return Object.freeze({
    effortPoints: node ? node.effortPoints ?? null : null,
    nodeType: node ? node.nodeType ?? '' : '',
    projectId: node ? node.projectId : '',
    ancestorIds: Object.freeze(ancestors),
  });
}

/**
 * Capture a complete, immutable draft context from one acknowledged
 * repository snapshot. Throws `FORECAST_PLAN_CORRUPT` when the stored plan
 * could not be read, rather than drafting from an empty plan.
 */
export function captureScenarioDraftContext(snapshot: ScenarioDraftSnapshot, draftId: string): ScenarioDraftContext {
  if (snapshot.forecastPlanError) throw new Error(snapshot.forecastPlanError);
  const plan = snapshot.forecastPlan ?? createForecastPlan({ projectId: snapshot.projectId });
  const staffed = plan.policyVersion === STAFFED_FORECAST_POLICY_VERSION;
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n] as const));

  const scope = plan.selectedFeatureIds;
  const scopeSet = new Set(scope);
  const levelIds = snapshot.nodes
    .filter((n) => n.projectId === snapshot.projectId && n.nodeType === plan.planningLevel && !scopeSet.has(n.id))
    .map((n) => n.id);
  const assignedIds = staffed ? Object.keys(plan.assignments ?? {}) : [];
  const factIds = [...new Set([...scope, ...levelIds, ...assignedIds])];
  const factMap: Record<string, ScenarioFeatureFact> = {};
  for (const id of factIds) factMap[id] = factFor(id, byId);

  const items: ScenarioDraftItem[] = [...scope, ...levelIds].map((id) =>
    Object.freeze({
      id,
      title: byId.get(id)?.title ?? '',
      effortPoints: byId.get(id)?.effortPoints ?? null,
      included: scopeSet.has(id),
    }),
  );

  const baseline: ForecastScenarioBaseline = Object.freeze({
    projectId: snapshot.projectId,
    baselineRevision: snapshot.projectRevision,
    policyVersion: plan.policyVersion,
    planningLevel: plan.planningLevel,
    orderedScope: Object.freeze([...scope]),
    configuration: plan.configuration,
    parallelGroups: Object.freeze(plan.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))),
    blockedFeatureIds: Object.freeze([...plan.blockedFeatureIds]),
    factMap: Object.freeze(factMap),
    ...(staffed
      ? {
          roster: Object.freeze((plan.roster ?? []).map((p) => Object.freeze({ id: p.id, name: p.name, weightUnits: p.weightUnits }))),
          assignments: Object.freeze({ ...(plan.assignments ?? {}) }),
        }
      : {}),
  });

  // The same material facts the repository recomputes at save time
  // (project-commands / handler.rs): equal only if nothing material moved.
  const normalized = normalizeForecastInputs(
    { projectId: snapshot.projectId, projectRevision: snapshot.projectRevision, nodes: snapshot.nodes },
    plan,
  );
  const materialFingerprint = computeForecastFingerprintSync(forecastMaterialFacts(normalized.inputs));

  return Object.freeze({
    draftId,
    projectId: snapshot.projectId,
    baselineRevision: snapshot.projectRevision,
    materialFingerprint,
    policyVersion: plan.policyVersion,
    planningLevel: plan.planningLevel,
    baseline,
    items: Object.freeze(items),
  });
}

/**
 * The draft as a scenario record for the analysis worker's existing
 * scenario-evaluation request: the captured baseline and the current patch.
 * Never persisted; the save command rebuilds its record in the repository.
 */
export function draftScenarioRecord(context: ScenarioDraftContext, patch: ForecastScenarioPatch): PersistedForecastScenario {
  const { projectId: _projectId, baselineRevision: _revision, policyVersion: _policy, ...baseline } = context.baseline;
  return Object.freeze({
    scenarioId: context.draftId,
    projectId: context.projectId,
    label: 'Draft',
    baselineRevision: context.baselineRevision,
    baselineFingerprint: context.materialFingerprint,
    policyVersion: context.policyVersion,
    createdAtISO: '1970-01-01T00:00:00.000Z',
    baseline: Object.freeze(baseline),
    patch,
  });
}

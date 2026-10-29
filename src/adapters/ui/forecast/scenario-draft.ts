/**
 * Scenario-draft editing state (Story 23.7, AC 23.7-1..3; Story 23.9).
 *
 * The draft editor keeps the user's raw field text separate from the
 * captured context it edits against. The patch is always built from the
 * captured context — never from live props — and a refreshed context
 * revalidates every preserved override against the new capture: a reference
 * that no longer resolves is a named, actionable error, never silently
 * dropped or saved.
 */

import { STAFFED_FORECAST_POLICY_VERSION } from '../../../domain/forecast/forecast-plan.entity';
import { formatStaffingWeightUnits } from '../../../domain/forecast/forecast-validators';
import type { ForecastScenarioPatch } from '../../../domain/forecast/scenario';
import type { ScenarioDraftContext } from '../../../application/forecast/scenario-draft-context';
import { parseWeightDraft } from './people-editor';

export type ScenarioDraftFields = Readonly<{
  label: string;
  capacity: string;
  /** The draft's ordered scope once the user edits it; null inherits the captured scope. */
  scope: readonly string[] | null;
  pointOverrides: Readonly<Record<string, string>>;
  weightOverrides: Readonly<Record<string, string>>;
  assignmentOverrides: Readonly<Record<string, readonly string[]>>;
  /** Pacing-mode override (Story 26.4); null inherits the captured policy. */
  policyVersion?: 'shared-capacity-v1' | 'staffed-capacity-v1' | null;
  /** "Run together" lever: full parallel-group override (Story 26.4); null inherits. */
  parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[] | null;
}>;

export const EMPTY_DRAFT_FIELDS: ScenarioDraftFields = Object.freeze({
  label: '',
  capacity: '',
  scope: null,
  pointOverrides: Object.freeze({}),
  weightOverrides: Object.freeze({}),
  assignmentOverrides: Object.freeze({}),
  policyVersion: null,
  parallelGroups: null,
});

/** True once the user has entered anything a close would lose. */
export function isDraftDirty(fields: ScenarioDraftFields): boolean {
  return (
    fields.label.trim() !== '' ||
    fields.capacity.trim() !== '' ||
    fields.scope !== null ||
    (fields.policyVersion !== null && fields.policyVersion !== undefined) ||
    (fields.parallelGroups !== null && fields.parallelGroups !== undefined) ||
    Object.values(fields.pointOverrides).some((v) => v.trim() !== '') ||
    Object.values(fields.weightOverrides).some((v) => v.trim() !== '') ||
    Object.keys(fields.assignmentOverrides).length > 0
  );
}

export function draftScope(fields: ScenarioDraftFields, context: ScenarioDraftContext): readonly string[] {
  return fields.scope ?? context.baseline.orderedScope;
}

/**
 * The parallel group a "run together" toggle would create: the first two
 * included items, in scope order (Story 26.4, FC-FR4).
 */
export function runTogetherGroup(
  fields: ScenarioDraftFields,
  context: ScenarioDraftContext,
): Readonly<{ featureIds: readonly string[] }> | null {
  const scope = draftScope(fields, context);
  if (scope.length < 2) return null;
  return Object.freeze({ featureIds: Object.freeze([scope[0], scope[1]]) });
}

/**
 * Whether "run together" is valid: in staffed mode the two items must not
 * share an assigned person (Story 26.4 AC 26.4-1). Shared mode is always valid
 * when there are two items.
 */
export function canRunTogether(
  fields: ScenarioDraftFields,
  context: ScenarioDraftContext,
): boolean {
  const group = runTogetherGroup(fields, context);
  if (!group) return false;
  if (context.policyVersion !== STAFFED_FORECAST_POLICY_VERSION) return true;
  const assignments = context.baseline.assignments ?? {};
  const [a, b] = group.featureIds;
  const peopleA = new Set(assignments[a] ?? []);
  return !(assignments[b] ?? []).some((p) => peopleA.has(p));
}

export type DraftFieldErrors = Readonly<{
  capacity: boolean;
  /** Item IDs whose point override is not a whole non-negative number. */
  points: readonly string[];
  /** Person IDs whose weight override the canonical parser rejects. */
  weights: readonly string[];
}>;

export function hasFieldErrors(errors: DraftFieldErrors): boolean {
  return errors.capacity || errors.points.length > 0 || errors.weights.length > 0;
}

const WHOLE = /^\d+$/;

/**
 * Build the patch from raw fields against the captured context. Invalid raw
 * values are reported, never rounded, substituted or silently omitted from
 * a save (the editor refuses to preview or save while any remain).
 */
export function buildDraftPatch(
  fields: ScenarioDraftFields,
  context: ScenarioDraftContext,
): Readonly<{ patch: ForecastScenarioPatch; errors: DraftFieldErrors }> {
  const scope = draftScope(fields, context);
  const inScope = new Set(scope);
  let patch: ForecastScenarioPatch = {};

  let capacityError = false;
  if (fields.capacity.trim() !== '') {
    const raw = fields.capacity.trim();
    const v = Number(raw);
    if (WHOLE.test(raw) && Number.isSafeInteger(v)) patch = { ...patch, pointsPerSprint: v };
    else capacityError = true;
  }

  if (fields.scope !== null && JSON.stringify(fields.scope) !== JSON.stringify(context.baseline.orderedScope)) {
    patch = { ...patch, orderedScope: Object.freeze([...fields.scope]) };
  }

  // Story 26.4 (FC-FR4): the pacing-mode lever.
  if (fields.policyVersion && fields.policyVersion !== context.policyVersion) {
    patch = { ...patch, policyVersion: fields.policyVersion };
  }

  // Story 26.4 (FC-FR4): the "run together" lever — a full parallel-group
  // override, only when it differs from the captured groups.
  if (
    fields.parallelGroups &&
    JSON.stringify(fields.parallelGroups) !== JSON.stringify(context.baseline.parallelGroups)
  ) {
    patch = {
      ...patch,
      parallelGroups: Object.freeze(
        fields.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
      ),
    };
  }

  const pointErrors: string[] = [];
  const points: Record<string, number> = {};
  for (const [id, raw] of Object.entries(fields.pointOverrides)) {
    if (raw.trim() === '' || !inScope.has(id)) continue;
    const v = Number(raw.trim());
    if (WHOLE.test(raw.trim()) && Number.isSafeInteger(v)) points[id] = v;
    else pointErrors.push(id);
  }
  if (Object.keys(points).length > 0) patch = { ...patch, pointOverrides: Object.freeze(points) };

  const weightErrors: string[] = [];
  if (context.policyVersion === STAFFED_FORECAST_POLICY_VERSION) {
    const weights: Record<string, number> = {};
    for (const [id, raw] of Object.entries(fields.weightOverrides)) {
      if (raw.trim() === '') continue;
      const units = parseWeightDraft(raw);
      if (units === null) weightErrors.push(id);
      else weights[id] = units;
    }
    if (Object.keys(weights).length > 0) patch = { ...patch, weightOverrides: Object.freeze(weights) };

    const assignments: Record<string, readonly string[]> = {};
    for (const [id, pids] of Object.entries(fields.assignmentOverrides)) {
      if (inScope.has(id)) assignments[id] = Object.freeze([...pids]);
    }
    if (Object.keys(assignments).length > 0) patch = { ...patch, assignmentOverrides: Object.freeze(assignments) };
  }

  return Object.freeze({
    patch: Object.freeze(patch),
    errors: Object.freeze({
      capacity: capacityError,
      points: Object.freeze(pointErrors),
      weights: Object.freeze(weightErrors),
    }),
  });
}

/** A preserved override whose captured reference did not survive a refresh (AC 23.7-3). */
export type DraftReferenceError = Readonly<{
  key: string;
  message: string;
  /** Removes exactly this override from the fields — an explicit user action. */
  resolve: (fields: ScenarioDraftFields) => ScenarioDraftFields;
}>;

function omitKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _omitted, ...rest } = record;
  return Object.freeze(rest);
}

/**
 * Revalidate preserved overrides against a (re)captured context. `labels`
 * resolves names from the context the override was entered against, so an
 * error can name a person or item that no longer exists in the new capture.
 */
export function revalidateDraft(
  fields: ScenarioDraftFields,
  context: ScenarioDraftContext,
  labels: Readonly<{ person: (id: string) => string; item: (id: string) => string }>,
): readonly DraftReferenceError[] {
  const errors: DraftReferenceError[] = [];
  const itemIds = new Set(context.items.map((i) => i.id));
  const staffed = context.policyVersion === STAFFED_FORECAST_POLICY_VERSION;
  const rosterIds = new Set((context.baseline.roster ?? []).map((p) => p.id));
  const at = `revision ${context.baselineRevision}`;

  if (fields.scope !== null) {
    for (const id of fields.scope) {
      if (!itemIds.has(id)) {
        errors.push({
          key: `scope:${id}`,
          message: `${labels.item(id)} is no longer a ${context.planningLevel} in this project at ${at}. Remove it from the scenario scope to continue.`,
          resolve: (f) => Object.freeze({ ...f, scope: Object.freeze((f.scope ?? []).filter((x) => x !== id)) }),
        });
      }
    }
  }
  for (const [id, raw] of Object.entries(fields.pointOverrides)) {
    if (raw.trim() !== '' && !itemIds.has(id)) {
      errors.push({
        key: `points:${id}`,
        message: `Point override for ${labels.item(id)}: the item is no longer a ${context.planningLevel} in this project at ${at}. Remove the override to continue.`,
        resolve: (f) => Object.freeze({ ...f, pointOverrides: omitKey(f.pointOverrides, id) }),
      });
    }
  }
  for (const [id, raw] of Object.entries(fields.weightOverrides)) {
    if (raw.trim() === '') continue;
    if (!staffed || !rosterIds.has(id)) {
      errors.push({
        key: `weight:${id}`,
        message: staffed
          ? `Weight override for ${labels.person(id)}: this person is no longer on the roster at ${at}. Remove the override to continue.`
          : `Weight override for ${labels.person(id)}: the plan no longer uses assigned people at ${at}. Remove the override to continue.`,
        resolve: (f) => Object.freeze({ ...f, weightOverrides: omitKey(f.weightOverrides, id) }),
      });
    }
  }
  for (const [itemId, pids] of Object.entries(fields.assignmentOverrides)) {
    const missingItem = !itemIds.has(itemId);
    const missingPeople = staffed ? pids.filter((pid) => !rosterIds.has(pid)) : [...pids];
    if (!staffed || missingItem || missingPeople.length > 0) {
      const why = !staffed
        ? 'the plan no longer uses assigned people'
        : missingItem
          ? `the item is no longer a ${context.planningLevel} in this project`
          : `${missingPeople.map(labels.person).join(', ')} ${missingPeople.length === 1 ? 'is' : 'are'} no longer on the roster`;
      errors.push({
        key: `assignment:${itemId}`,
        message: `Assignment override for ${labels.item(itemId)}: ${why} at ${at}. Remove the override to continue.`,
        resolve: (f) => Object.freeze({ ...f, assignmentOverrides: omitKey(f.assignmentOverrides, itemId) }),
      });
    }
  }
  return Object.freeze(errors);
}

/**
 * Plain-language list of the captured assumptions that differ between two
 * captures of the same project (AC 23.7-3 disclosure). Revision movement
 * alone is reported separately by the caller.
 */
export function describeBaselineChanges(before: ScenarioDraftContext, after: ScenarioDraftContext): readonly string[] {
  const changes: string[] = [];
  const b = before.baseline;
  const a = after.baseline;
  const title = (id: string) =>
    after.items.find((i) => i.id === id)?.title || before.items.find((i) => i.id === id)?.title || id;

  if (b.policyVersion !== a.policyVersion) {
    const label = (p: string) => (p === STAFFED_FORECAST_POLICY_VERSION ? 'Staffed Capacity' : 'Shared Capacity');
    changes.push(`Model: ${label(b.policyVersion)} → ${label(a.policyVersion)}`);
  }
  if (b.planningLevel !== a.planningLevel) changes.push(`Planning level: ${b.planningLevel} → ${a.planningLevel}`);
  if (JSON.stringify(b.orderedScope) !== JSON.stringify(a.orderedScope)) {
    const added = a.orderedScope.filter((id) => !b.orderedScope.includes(id));
    const removed = b.orderedScope.filter((id) => !a.orderedScope.includes(id));
    const parts: string[] = [];
    if (added.length > 0) parts.push(`added ${added.map(title).join(', ')}`);
    if (removed.length > 0) parts.push(`removed ${removed.map(title).join(', ')}`);
    changes.push(parts.length > 0 ? `Scope: ${parts.join('; ')}` : 'Scope order changed');
  }
  for (const id of a.orderedScope) {
    const pb = b.factMap[id]?.effortPoints;
    const pa = a.factMap[id]?.effortPoints;
    if (b.orderedScope.includes(id) && pb !== pa) {
      changes.push(`Estimate — ${title(id)}: ${pb ?? 'unknown'} → ${pa ?? 'unknown'} points`);
    }
  }
  const cb = b.configuration;
  const ca = a.configuration;
  if (cb.pointsPerSprint !== ca.pointsPerSprint) {
    changes.push(`Capacity: ${cb.pointsPerSprint ?? '—'} → ${ca.pointsPerSprint ?? '—'} points/sprint`);
  }
  if (cb.sprintLengthDays !== ca.sprintLengthDays) {
    changes.push(`Sprint length: ${cb.sprintLengthDays ?? '—'} → ${ca.sprintLengthDays ?? '—'} days`);
  }
  if (cb.startSprintOrdinal !== ca.startSprintOrdinal || cb.startDate !== ca.startDate) {
    changes.push(
      `Start: Sprint ${cb.startSprintOrdinal ?? '—'} (${cb.startDate ?? '—'}) → Sprint ${ca.startSprintOrdinal ?? '—'} (${ca.startDate ?? '—'})`,
    );
  }
  if (JSON.stringify(b.parallelGroups) !== JSON.stringify(a.parallelGroups)) changes.push('Parallel groups changed');
  if (JSON.stringify([...b.blockedFeatureIds].sort()) !== JSON.stringify([...a.blockedFeatureIds].sort())) {
    changes.push('Blockers changed');
  }

  const rb = new Map((b.roster ?? []).map((p) => [p.id, p]));
  const ra = new Map((a.roster ?? []).map((p) => [p.id, p]));
  for (const [id, p] of ra) {
    const prior = rb.get(id);
    if (!prior) changes.push(`Roster: added ${p.name} (${formatStaffingWeightUnits(p.weightUnits)})`);
    else if (prior.weightUnits !== p.weightUnits) {
      changes.push(`Weight — ${p.name}: ${formatStaffingWeightUnits(prior.weightUnits)} → ${formatStaffingWeightUnits(p.weightUnits)}`);
    }
  }
  for (const [id, p] of rb) if (!ra.has(id)) changes.push(`Roster: removed ${p.name}`);

  const name = (id: string) => ra.get(id)?.name ?? rb.get(id)?.name ?? id;
  const ab = b.assignments ?? {};
  const aa = a.assignments ?? {};
  for (const id of [...new Set([...Object.keys(ab), ...Object.keys(aa)])].sort()) {
    const before = [...(ab[id] ?? [])].sort();
    const after = [...(aa[id] ?? [])].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const list = (ids: readonly string[]) => (ids.length > 0 ? ids.map(name).join(', ') : 'unassigned');
      changes.push(`Assignment — ${title(id)}: ${list(before)} → ${list(after)}`);
    }
  }
  return Object.freeze(changes);
}

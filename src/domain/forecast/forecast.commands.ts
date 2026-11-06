/**
 * Forecast domain commands (Story 18.1, Task 3, AD-24).
 *
 * One atomic `ConfigureForecastPlan` command covers the complete
 * configuration group — capacity, sprint length, cadence, start ordinal, and
 * start date — so one UI save never splits into separate capacity and cadence
 * commits (AC 18.1-3, UX-DR9). `SetForecastMembership` includes/excludes
 * existing Feature nodes by reference only; inclusion appends by default
 * (AR-18).
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  validateCapacity,
  validateSprintLength,
  validateStartOrdinal,
  validateStartDate,
  isValidStaffingWeightUnits,
} from './forecast-validators';
import type { ForecastScenarioPatch, PersistedForecastScenario } from './scenario';
import type { ForecastNodeLevel, ForecastPerson, ForecastSprintPlan } from './forecast-plan.entity';
import { createForecastSprintPlan } from './forecast-plan.entity';

export type ConfigureForecastPlanCommand = Readonly<{
  type: 'ConfigureForecastPlan';
  commandId: string;
  projectId: string;
  baseRevision: number;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  startSprintOrdinal: number | null;
  startDate: string | null;
  /**
   * Planning level to apply with this configuration (Story 21.13, D5).
   * `null` preserves the plan's current level; a value applies it — used by
   * plan CREATION so the level chosen on the step card commits atomically
   * with the configuration (one command, one revision, one undo entry)
   * instead of a follow-up SetForecastPlanningLevel command.
   */
  planningLevel: ForecastNodeLevel | null;
}>;

export type SetForecastMembershipCommand = Readonly<{
  type: 'SetForecastMembership';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  included: boolean;
}>;

/**
 * Exact inverse of plan CREATION (Story 21.13, D5): deletes the forecast plan
 * row so a single Undo after creating a Theme-level plan returns to the
 * pre-creation state (the level step), not to a Feature-level plan with the
 * Theme configuration retained. Only ever dispatched through the undo engine;
 * Redo replays the forward ConfigureForecastPlan command.
 */
export type RemoveForecastPlanCommand = Readonly<{
  type: 'RemoveForecastPlan';
  commandId: string;
  projectId: string;
  baseRevision: number;
}>;

export function createConfigureForecastPlanCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  startSprintOrdinal: number | null;
  startDate: string | null;
  planningLevel?: ForecastNodeLevel | null;
}): ConfigureForecastPlanCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  const capacityIssue = validateCapacity(params.pointsPerSprint, 'pointsPerSprint');
  if (capacityIssue) throw new Error(capacityIssue.code);
  const lengthIssue = validateSprintLength(params.sprintLengthDays, 'sprintLengthDays');
  if (lengthIssue) throw new Error(lengthIssue.code);
  const ordinalIssue = validateStartOrdinal(params.startSprintOrdinal, 'startSprintOrdinal');
  if (ordinalIssue) throw new Error(ordinalIssue.code);
  const dateIssue = validateStartDate(params.startDate, 'startDate');
  if (dateIssue) throw new Error(dateIssue.code);
  if (
    params.planningLevel !== null &&
    params.planningLevel !== undefined &&
    !['Theme', 'Component', 'Feature'].includes(params.planningLevel)
  ) {
    throw new Error('INVALID_PLANNING_LEVEL');
  }

  return Object.freeze({
    type: 'ConfigureForecastPlan',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    pointsPerSprint: params.pointsPerSprint,
    sprintLengthDays: params.sprintLengthDays,
    startSprintOrdinal: params.startSprintOrdinal,
    startDate: params.startDate,
    planningLevel: params.planningLevel ?? null,
  });
}

export function createSetForecastMembershipCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  included: boolean;
}): SetForecastMembershipCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.featureId, 'featureId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.included !== 'boolean') {
    throw new Error('INVALID_INCLUDED');
  }
  return Object.freeze({
    type: 'SetForecastMembership',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureId: params.featureId,
    included: params.included,
  });
}

export function createRemoveForecastPlanCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
}): RemoveForecastPlanCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  return Object.freeze({
    type: 'RemoveForecastPlan',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
  });
}

// ── Epic 20 Commands (Story 20.1) ──────────────────────────────────────────

/**
 * Mark or clear a forecast-owned blocker on one included Feature (AR-12).
 * Granular and immutable: one command changes exactly one Feature's blocked
 * flag. It never forces order, never infers from unlock edges, and adds no
 * delay duration.
 */
export type SetForecastBlockerCommand = Readonly<{
  type: 'SetForecastBlocker';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  blocked: boolean;
}>;

export function createSetForecastBlockerCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  blocked: boolean;
}): SetForecastBlockerCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.featureId, 'featureId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.blocked !== 'boolean') {
    throw new Error('INVALID_BLOCKED');
  }
  return Object.freeze({
    type: 'SetForecastBlocker',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureId: params.featureId,
    blocked: params.blocked,
  });
}

// ── Epic 20 Scenario Commands (Story 20.4) ─────────────────────────────────

/**
 * Save a validated scenario preview as a durable workflow fact. The client
 * carries the label, the previewed baseline revision + material fingerprint,
 * and the single patch; the repository extracts the baseline scope/config/
 * groups/blocked set and the union fact map from its own snapshot at that
 * revision, all in one transaction (AD-22, AR-22).
 */
export type CreateForecastScenarioCommand = Readonly<{
  type: 'CreateForecastScenario';
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenarioId: string;
  label: string;
  baselineRevision: number;
  expectedMaterialFingerprint: string;
  /** Injected-clock ISO instant for the scenario's created-at provenance. */
  createdAtISO: string;
  patch: ForecastScenarioPatch;
}>;

export type RemoveForecastScenarioCommand = Readonly<{
  type: 'RemoveForecastScenario';
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenarioId: string;
}>;

/** Inverse of Remove — re-inserts the exact prior workflow fact. */
export type RestoreForecastScenarioCommand = Readonly<{
  type: 'RestoreForecastScenario';
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenario: PersistedForecastScenario;
}>;

function assertScenarioPatch(patch: ForecastScenarioPatch): ForecastScenarioPatch {
  if (patch.orderedScope !== undefined) {
    if (!Array.isArray(patch.orderedScope)) throw new Error('INVALID_SCENARIO_PATCH');
    for (const id of patch.orderedScope) assertUuidV7(id, 'orderedScope member must be a valid UUIDv7');
  }
  if (patch.pointOverrides !== undefined) {
    for (const [id, v] of Object.entries(patch.pointOverrides)) {
      assertUuidV7(id, 'pointOverride key must be a valid UUIDv7');
      if (!Number.isSafeInteger(v) || v < 0) throw new Error('INVALID_SCENARIO_PATCH');
    }
  }
  if (patch.pointsPerSprint !== undefined && (!Number.isSafeInteger(patch.pointsPerSprint) || patch.pointsPerSprint < 0)) {
    throw new Error('INVALID_SCENARIO_PATCH');
  }
  if (patch.weightOverrides !== undefined) {
    for (const [id, v] of Object.entries(patch.weightOverrides)) {
      assertUuidV7(id, 'weightOverride key must be a valid UUIDv7');
      if (!isValidStaffingWeightUnits(v)) throw new Error('INVALID_SCENARIO_PATCH');
    }
  }
  if (patch.assignmentOverrides !== undefined) {
    for (const [id, pids] of Object.entries(patch.assignmentOverrides)) {
      assertUuidV7(id, 'assignmentOverride key must be a valid UUIDv7');
      if (!Array.isArray(pids)) throw new Error('INVALID_SCENARIO_PATCH');
      for (const pid of pids) assertUuidV7(pid, 'assignmentOverride personId must be a valid UUIDv7');
    }
  }
  return Object.freeze({
    ...(patch.orderedScope !== undefined ? { orderedScope: Object.freeze([...patch.orderedScope]) } : {}),
    ...(patch.pointOverrides !== undefined ? { pointOverrides: Object.freeze({ ...patch.pointOverrides }) } : {}),
    ...(patch.pointsPerSprint !== undefined ? { pointsPerSprint: patch.pointsPerSprint } : {}),
    ...(patch.weightOverrides !== undefined ? { weightOverrides: Object.freeze({ ...patch.weightOverrides }) } : {}),
    ...(patch.assignmentOverrides !== undefined
      ? {
          assignmentOverrides: Object.freeze(
            Object.fromEntries(
              Object.entries(patch.assignmentOverrides).map(([k, v]) => [k, Object.freeze([...v])]),
            ),
          ),
        }
      : {}),
  });
}

export function createCreateForecastScenarioCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenarioId: string;
  label: string;
  baselineRevision: number;
  expectedMaterialFingerprint: string;
  createdAtISO: string;
  patch: ForecastScenarioPatch;
}): CreateForecastScenarioCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.scenarioId, 'scenarioId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  if (!Number.isSafeInteger(params.baselineRevision) || params.baselineRevision < 0) throw new Error('INVALID_BASELINE_REVISION');
  if (typeof params.label !== 'string' || params.label.trim().length === 0) throw new Error('INVALID_SCENARIO_LABEL');
  if (typeof params.createdAtISO !== 'string' || params.createdAtISO.length === 0) throw new Error('INVALID_SCENARIO_CREATED_AT');
  if (typeof params.expectedMaterialFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(params.expectedMaterialFingerprint)) {
    throw new Error('INVALID_SCENARIO_FINGERPRINT');
  }
  return Object.freeze({
    type: 'CreateForecastScenario',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    scenarioId: params.scenarioId,
    label: params.label.trim(),
    baselineRevision: params.baselineRevision,
    expectedMaterialFingerprint: params.expectedMaterialFingerprint,
    createdAtISO: params.createdAtISO,
    patch: assertScenarioPatch(params.patch),
  });
}

export function createRemoveForecastScenarioCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenarioId: string;
}): RemoveForecastScenarioCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.scenarioId, 'scenarioId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RemoveForecastScenario',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    scenarioId: params.scenarioId,
  });
}

export function createRestoreForecastScenarioCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  scenario: PersistedForecastScenario;
}): RestoreForecastScenarioCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.scenario.scenarioId, 'scenario.scenarioId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  return Object.freeze({
    type: 'RestoreForecastScenario',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    scenario: params.scenario,
  });
}

// ── Epic 19 Commands (Story 19.2) ──────────────────────────────────────────

export type ReorderForecastFeaturesCommand = Readonly<{
  type: 'ReorderForecastFeatures';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureIds: readonly string[];
}>;

/** Atomically changes delivery order and the group membership/order it implies. */
export type SetForecastSequenceCommand = Readonly<{
  type: 'SetForecastSequence';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}>;

export function createSetForecastSequenceCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}): SetForecastSequenceCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) throw new Error('INVALID_BASE_REVISION');
  for (const id of params.featureIds) assertUuidV7(id, 'featureId in featureIds must be a valid UUIDv7');
  const frozenGroups = params.parallelGroups.map((group) => Object.freeze({
    featureIds: Object.freeze(group.featureIds.map((id) => {
      assertUuidV7(id, 'featureId in parallel group must be a valid UUIDv7');
      return id;
    })),
  }));
  return Object.freeze({ type: 'SetForecastSequence', commandId: params.commandId, projectId: params.projectId,
    baseRevision: params.baseRevision, featureIds: Object.freeze([...params.featureIds]), parallelGroups: Object.freeze(frozenGroups) });
}

export function createReorderForecastFeaturesCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureIds: readonly string[];
}): ReorderForecastFeaturesCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!Array.isArray(params.featureIds)) {
    throw new Error('INVALID_FEATURE_IDS');
  }
  for (const id of params.featureIds) {
    assertUuidV7(id, 'featureId in featureIds must be a valid UUIDv7');
  }
  return Object.freeze({
    type: 'ReorderForecastFeatures',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureIds: Object.freeze([...params.featureIds]),
  });
}

export type SetForecastParallelGroupsCommand = Readonly<{
  type: 'SetForecastParallelGroups';
  commandId: string;
  projectId: string;
  baseRevision: number;
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}>;

export function createSetForecastParallelGroupsCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
}): SetForecastParallelGroupsCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!Array.isArray(params.parallelGroups)) {
    throw new Error('INVALID_PARALLEL_GROUPS');
  }
  const frozenGroups = params.parallelGroups.map((g) => {
    if (!Array.isArray(g.featureIds)) throw new Error('INVALID_PARALLEL_GROUP_FEATURE_IDS');
    for (const id of g.featureIds) {
      assertUuidV7(id, 'featureId in parallel group must be a valid UUIDv7');
    }
    return Object.freeze({ featureIds: Object.freeze([...g.featureIds]) });
  });
  return Object.freeze({
    type: 'SetForecastParallelGroups',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    parallelGroups: Object.freeze(frozenGroups),
  });
}

export type RestoreForecastScopeCommand = Readonly<{
  type: 'RestoreForecastScope';
  commandId: string;
  projectId: string;
  baseRevision: number;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  /** Blocked set to restore alongside scope/groups (Story 20.1). */
  blockedFeatureIds: readonly string[];
  /** Assignments to restore alongside scope/groups (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

export function createRestoreForecastScopeCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds?: readonly string[];
  assignments?: Readonly<Record<string, readonly string[]>>;
}): RestoreForecastScopeCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  for (const id of params.selectedFeatureIds) {
    assertUuidV7(id, 'featureId in selectedFeatureIds must be a valid UUIDv7');
  }
  const frozenGroups = params.parallelGroups.map((g) => {
    for (const id of g.featureIds) {
      assertUuidV7(id, 'featureId in parallel group must be a valid UUIDv7');
    }
    return Object.freeze({ featureIds: Object.freeze([...g.featureIds]) });
  });
  for (const id of params.blockedFeatureIds ?? []) {
    assertUuidV7(id, 'featureId in blockedFeatureIds must be a valid UUIDv7');
  }
  return Object.freeze({
    type: 'RestoreForecastScope',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    selectedFeatureIds: Object.freeze([...params.selectedFeatureIds]),
    parallelGroups: Object.freeze(frozenGroups),
    blockedFeatureIds: Object.freeze([...(params.blockedFeatureIds ?? [])]),
    assignments: params.assignments ? Object.freeze({ ...params.assignments }) : undefined,
  });
}

// ── Epic 21 Commands (Story 21.7, D4/D7) ───────────────────────────────────

/**
 * Switch the plan's planning level, atomically clearing scope, parallel
 * groups, and blockers in the same transaction (FR-13, D7). Shaped after
 * `SetForecastBlockerCommand`: no `planId` (one plan per project), no
 * `issuedAt`; `baseRevision` is mandatory for optimistic concurrency.
 */
export type SetForecastPlanningLevelCommand = Readonly<{
  type: 'SetForecastPlanningLevel';
  commandId: string;
  projectId: string;
  baseRevision: number;
  planningLevel: ForecastNodeLevel;
}>;

export function createSetForecastPlanningLevelCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  planningLevel: ForecastNodeLevel;
}): SetForecastPlanningLevelCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!['Theme', 'Component', 'Feature'].includes(params.planningLevel)) {
    throw new Error('INVALID_PLANNING_LEVEL');
  }
  return Object.freeze({
    type: 'SetForecastPlanningLevel',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    planningLevel: params.planningLevel,
  });
}

/**
 * Exact inverse of `SetForecastPlanningLevel` (FR-13): restores the prior
 * level, scope, parallel groups, and blockers simultaneously so a single
 * Undo step returns the plan to its pre-switch state.
 */
export type RestoreForecastPlanningLevelCommand = Readonly<{
  type: 'RestoreForecastPlanningLevel';
  commandId: string;
  projectId: string;
  baseRevision: number;
  planningLevel: ForecastNodeLevel;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds: readonly string[];
  /** Assignments to restore alongside scope/groups/level (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

export function createRestoreForecastPlanningLevelCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  planningLevel: ForecastNodeLevel;
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  blockedFeatureIds: readonly string[];
  assignments?: Readonly<Record<string, readonly string[]>>;
}): RestoreForecastPlanningLevelCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!['Theme', 'Component', 'Feature'].includes(params.planningLevel)) {
    throw new Error('INVALID_PLANNING_LEVEL');
  }
  for (const id of params.selectedFeatureIds) {
    assertUuidV7(id, 'featureId in selectedFeatureIds must be a valid UUIDv7');
  }
  const frozenGroups = params.parallelGroups.map((g) => {
    for (const id of g.featureIds) {
      assertUuidV7(id, 'featureId in parallel group must be a valid UUIDv7');
    }
    return Object.freeze({ featureIds: Object.freeze([...g.featureIds]) });
  });
  for (const id of params.blockedFeatureIds) {
    assertUuidV7(id, 'featureId in blockedFeatureIds must be a valid UUIDv7');
  }
  return Object.freeze({
    type: 'RestoreForecastPlanningLevel',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    planningLevel: params.planningLevel,
    selectedFeatureIds: Object.freeze([...params.selectedFeatureIds]),
    parallelGroups: Object.freeze(frozenGroups),
    blockedFeatureIds: Object.freeze([...params.blockedFeatureIds]),
    assignments: params.assignments ? Object.freeze({ ...params.assignments }) : undefined,
  });
}

// ── Epic 22 Commands (Story 22.3, SF-FR2, SF-FR3) ──────────────────────────

/**
 * Add a new person to the project forecast roster (SF-FR2).
 * Stable UUIDv7 identity, nonempty trimmed name, and positive weight units
 * defaulting to 100 (1.00 relative share).
 */
export type AddForecastPersonCommand = Readonly<{
  type: 'AddForecastPerson';
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
  name: string;
  weightUnits?: number;
}>;

export function createAddForecastPersonCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
  name: string;
  weightUnits?: number;
}): AddForecastPersonCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.personId, 'personId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.name !== 'string' || params.name.trim().length === 0) {
    throw new Error('INVALID_PERSON_NAME');
  }
  const weightUnits = params.weightUnits ?? 100;
  if (!isValidStaffingWeightUnits(weightUnits)) {
    throw new Error('INVALID_STAFFING_WEIGHT');
  }
  return Object.freeze({
    type: 'AddForecastPerson',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    personId: params.personId,
    name: params.name.trim(),
    weightUnits,
  });
}

/**
 * Update an existing person's name and/or weight units (SF-FR2).
 */
export type UpdateForecastPersonCommand = Readonly<{
  type: 'UpdateForecastPerson';
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
  name: string;
  weightUnits: number;
}>;

export function createUpdateForecastPersonCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
  name: string;
  weightUnits: number;
}): UpdateForecastPersonCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.personId, 'personId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.name !== 'string' || params.name.trim().length === 0) {
    throw new Error('INVALID_PERSON_NAME');
  }
  if (!isValidStaffingWeightUnits(params.weightUnits)) {
    throw new Error('INVALID_STAFFING_WEIGHT');
  }
  return Object.freeze({
    type: 'UpdateForecastPerson',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    personId: params.personId,
    name: params.name.trim(),
    weightUnits: params.weightUnits,
  });
}

/**
 * Remove an unassigned person from the project forecast roster (SF-FR2, AC 22.3-6).
 */
export type RemoveForecastPersonCommand = Readonly<{
  type: 'RemoveForecastPerson';
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
}>;

export function createRemoveForecastPersonCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  personId: string;
}): RemoveForecastPersonCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.personId, 'personId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  return Object.freeze({
    type: 'RemoveForecastPerson',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    personId: params.personId,
  });
}

/**
 * Restore a removed person (exact inverse of RemoveForecastPerson, AC 22.3-6).
 */
export type RestoreForecastPersonCommand = Readonly<{
  type: 'RestoreForecastPerson';
  commandId: string;
  projectId: string;
  baseRevision: number;
  person: ForecastPerson;
  /** Assignments to restore alongside person (Story 22.4). */
  assignments?: Readonly<Record<string, readonly string[]>>;
}>;

export function createRestoreForecastPersonCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  person: ForecastPerson;
  assignments?: Readonly<Record<string, readonly string[]>>;
}): RestoreForecastPersonCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!params.person) {
    throw new Error('INVALID_PERSON');
  }
  assertUuidV7(params.person.id, 'person.id must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.person.name !== 'string' || params.person.name.trim().length === 0) {
    throw new Error('INVALID_PERSON_NAME');
  }
  if (!isValidStaffingWeightUnits(params.person.weightUnits)) {
    throw new Error('INVALID_STAFFING_WEIGHT');
  }
  return Object.freeze({
    type: 'RestoreForecastPerson',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    person: Object.freeze({
      id: params.person.id,
      name: params.person.name.trim(),
      weightUnits: params.person.weightUnits,
    }),
    assignments: params.assignments ? Object.freeze({ ...params.assignments }) : undefined,
  });
}

// ── Epic 22 Commands (Story 22.4, SF-FR4, SF-FR5, SF-FR6, SF-FR11) ──────────

/**
 * Set the final assignment set of roster people for a forecast item (SF-FR4).
 * Commits the entire person ID set atomically.
 */
export type SetForecastAssignmentsCommand = Readonly<{
  type: 'SetForecastAssignments';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  personIds: readonly string[];
}>;

export function createSetForecastAssignmentsCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  personIds: readonly string[];
}): SetForecastAssignmentsCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.featureId, 'featureId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!Array.isArray(params.personIds)) {
    throw new Error('INVALID_PERSON_IDS');
  }
  for (const pid of params.personIds) {
    assertUuidV7(pid, 'personId in personIds must be a valid UUIDv7');
  }
  return Object.freeze({
    type: 'SetForecastAssignments',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureId: params.featureId,
    personIds: Object.freeze([...new Set(params.personIds)]),
  });
}

/**
 * Switch the active forecast policy / mode (Story 22.4, SF-FR11, SF-AR3).
 * Supports 'shared-capacity-v1' and 'staffed-capacity-v1'.
 */
export type SetForecastPolicyCommand = Readonly<{
  type: 'SetForecastPolicy';
  commandId: string;
  projectId: string;
  baseRevision: number;
  policyVersion: import('./forecast-plan.entity').ForecastPolicyVersion;
}>;

// ── Epic 27 single-move commands (Story 27.2, D8(c), R3) ─────────────────

/**
 * The optional group change a forecast feature move carries (Story 27.2).
 * A drag that leaves a parallel group, and a "run together" join, are still one
 * undoable gesture with the move:
 * - `unchanged` — group membership is left exactly as it was;
 * - `join` — the moved feature joins the group of `partnerId`;
 * - `leave` — the moved feature leaves whatever group it was in.
 */
export type ForecastGroupChange =
  | Readonly<{ kind: 'unchanged' }>
  | Readonly<{ kind: 'join'; partnerId: string }>
  | Readonly<{ kind: 'leave' }>;

/**
 * Move one scope member in the forecast priority order, carrying both intended
 * neighbours ("after Y, before Z", either may be null at an end) and the
 * intended index, plus an optional group change. Replaces the whole-list
 * `ReorderForecastFeatures` / `SetForecastSequence` for the shared path: the
 * command names only what changed, so a concurrent edit keeps its meaning
 * (D8(c), R3).
 */
export type MoveForecastFeatureCommand = Readonly<{
  type: 'MoveForecastFeature';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
  groupChange: ForecastGroupChange;
}>;

export function createMoveForecastFeatureCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  afterId: string | null;
  beforeId: string | null;
  intendedIndex: number;
  groupChange?: ForecastGroupChange;
}): MoveForecastFeatureCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.featureId, 'featureId must be a valid UUIDv7');
  if (params.afterId !== null) assertUuidV7(params.afterId, 'afterId must be a valid UUIDv7');
  if (params.beforeId !== null) assertUuidV7(params.beforeId, 'beforeId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (!Number.isSafeInteger(params.intendedIndex) || params.intendedIndex < 0) {
    throw new Error('INVALID_INTENDED_INDEX');
  }
  const groupChange = params.groupChange ?? Object.freeze({ kind: 'unchanged' as const });
  if (groupChange.kind === 'join') {
    assertUuidV7(groupChange.partnerId, 'groupChange.partnerId must be a valid UUIDv7');
    if (groupChange.partnerId === params.featureId) throw new Error('INVALID_GROUP_PARTNER');
  }
  return Object.freeze({
    type: 'MoveForecastFeature',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureId: params.featureId,
    afterId: params.afterId,
    beforeId: params.beforeId,
    intendedIndex: params.intendedIndex,
    groupChange,
  });
}

/**
 * Assign or unassign one person on one forecast item (Story 27.2, D8(d)).
 * Replaces the whole-list `SetForecastAssignments`: `personIds` is the final
 * single-person delta rather than the complete set — a named rejection
 * (`PersonMissing` / `TargetDeleted`) applies when the target is gone.
 */
export type SetForecastAssignmentCommand = Readonly<{
  type: 'SetForecastAssignment';
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  personId: string;
  assigned: boolean;
}>;

export function createSetForecastAssignmentCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  featureId: string;
  personId: string;
  assigned: boolean;
}): SetForecastAssignmentCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  assertUuidV7(params.featureId, 'featureId must be a valid UUIDv7');
  assertUuidV7(params.personId, 'personId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (typeof params.assigned !== 'boolean') {
    throw new Error('INVALID_ASSIGNED');
  }
  return Object.freeze({
    type: 'SetForecastAssignment',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    featureId: params.featureId,
    personId: params.personId,
    assigned: params.assigned,
  });
}

export function createSetForecastPolicyCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  policyVersion: import('./forecast-plan.entity').ForecastPolicyVersion;
}): SetForecastPolicyCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  if (
    params.policyVersion !== 'shared-capacity-v1' &&
    params.policyVersion !== 'staffed-capacity-v1'
  ) {
    throw new Error('INVALID_POLICY_VERSION');
  }
  return Object.freeze({
    type: 'SetForecastPolicy',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    policyVersion: params.policyVersion,
  });
}

// ── Delivery Board sprint plan ─────────────────────────────────────────────

/**
 * Replace the plan's hand-authored sprint plan (Delivery Board): which sprint
 * each hand-placed item starts in, and any per-sprint capacity override. The
 * whole value is set at once so undo is the same command carrying the prior
 * value. The repository stores it as given; placement rules (capacity,
 * dependencies, blockers) are checked by the board before it sends one.
 */
export type SetForecastSprintPlanCommand = Readonly<{
  type: 'SetForecastSprintPlan';
  commandId: string;
  projectId: string;
  baseRevision: number;
  sprintPlan: ForecastSprintPlan;
}>;

export function createSetForecastSprintPlanCommand(params: {
  commandId: string;
  projectId: string;
  baseRevision: number;
  sprintPlan: ForecastSprintPlan;
}): SetForecastSprintPlanCommand {
  assertUuidV7(params.commandId, 'commandId must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'projectId must be a valid UUIDv7');
  if (!Number.isSafeInteger(params.baseRevision) || params.baseRevision < 0) {
    throw new Error('INVALID_BASE_REVISION');
  }
  return Object.freeze({
    type: 'SetForecastSprintPlan',
    commandId: params.commandId,
    projectId: params.projectId,
    baseRevision: params.baseRevision,
    sprintPlan: createForecastSprintPlan(params.sprintPlan),
  });
}

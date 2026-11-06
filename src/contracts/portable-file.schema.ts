/**
 * Portable-file envelope contract and validator (Story 1.8 Task 1, Epic 13 Story 13.1, Epic 16 Story 16.1, AD-13).
 *
 * Schema version 4 (Epic 18): adds the optional `forecastPlan` record —
 * the project-owned forecast plan facts (ordered scope, parallel groups,
 * configuration, policy version). Computed results and receipts are absent
 * by contract (AR-14, AD-21).
 * Version 3 (Epic 16) added the `openQuestions` collection — ordered
 * node open questions & decisions — to the complete authored project graph.
 * Version 2 (Epic 13) carried project, phases, nodes, node custom fields,
 * type-template fields, unlock edges, finding dismissals, and affected reasons
 * as stored durable facts by stable identity. Session state (view preferences,
 * focus/selection, pending overlays, disposable geometry, derived projections,
 * command receipts, repository-local revisions) is permanently excluded (AD-4,
 * AD-5).
 *
 * Version 1 (project identity + name only) remains parseable and is upgraded
 * through an explicit compatibility adapter: a v1 file keeps its historical
 * project-only meaning, never silently reinterpreted as a complete graph.
 *
 * AD-13: "Portable files are versioned UTF-8 *.pmapp.json envelopes governed
 * by JSON Schema in contracts; import validates completely before one
 * transaction."
 */

import { assertUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import { isPersistedForecastScenario, normalizePersistedForecastScenario } from '../domain/forecast/scenario';
import { computeForecastFingerprintSync } from '../domain/forecast/forecast-canonical';
import { forecastMaterialFacts } from '../domain/forecast/whole-set.policy';
import { createForecastSprintPlan } from '../domain/forecast/forecast-plan.entity';

/**
 * Current portable-file schema version.
 *
 * Version 5 (Epic 20): adds `forecastPlan.blockedFeatureIds` (Story 20.1) and
 * the optional `forecastScenarios` collection — saved historical trade-off
 * scenarios, inputs only (Story 20.4). Additive; a v4 file upgrades to the v5
 * shape with an empty blocked set and no scenarios. Old readers reject a v5
 * envelope rather than stripping the new facts.
 *
 * Version 9 (Epic 26, Story 26.5): adds optional `nodes[].effortPointsDone`
 * (points done on an item). Additive; legacy v1-v8 files upgrade without the
 * field, read back as null ("not recorded"). Compatibility is backward only:
 * older builds reject a v9 file via the
 * `schemaVersion > PORTABLE_FILE_SCHEMA_VERSION` guard.
 *
 * Version 10 (Delivery Board): adds optional `forecastPlan.sprintPlan` (hand
 * placements and per-sprint capacities). Additive; v1-v9 files import with
 * the empty sprint plan, and older builds reject a v10 file.
 */
export const PORTABLE_FILE_SCHEMA_VERSION = 10;
/** The legacy project-only schema version (Story 1.8). */
export const LEGACY_PORTABLE_FILE_SCHEMA_VERSION = 1;

// ── Collection DTOs (stored durable facts, no derived projections) ─────────

export type PortableNodeType = 'Vision' | 'Theme' | 'Component' | 'Feature' | 'AcceptanceCriterion' | null;
export type PortableScheduleSourceMode = 'start_end' | 'start_duration' | 'end_duration' | 'none' | null;
export type PortableDeliveryStatus = 'not_started' | 'in_progress' | 'delivered';

export type PortableNode = Readonly<{
  id: string;
  parentId: string | null;
  title: string;
  bodyText: string | null;
  position: string; // decimal string (signed 64-bit gap position)
  nodeType: PortableNodeType;
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  scheduleSourceMode: PortableScheduleSourceMode;
  completed: boolean;
  effortPoints: number | null;
  /**
   * Story 26.5 (portable v9, FC-FR5/FC-NFR5): points already done on an item.
   * Optional — absent in files written before portable v9; read back as null
   * ("not recorded").
   */
  effortPointsDone?: number | null;
  strategicWeight: number | null;
  phaseId: string | null;
  /** Optional: absent in files written before outline status badging. */
  deliveryStatus?: PortableDeliveryStatus;
}>;

export type PortablePhase = Readonly<{
  id: string;
  name: string;
  position: string; // decimal string
}>;

export type PortableUnlockEdge = Readonly<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}>;

export type PortableNodeCustomField = Readonly<{
  nodeId: string;
  fieldKey: string;
  fieldValue: string | null;
}>;

export type PortableTypeTemplateField = Readonly<{
  nodeType: string;
  fieldKey: string;
  fieldLabel: string;
  position: number;
}>;

export type PortableFindingDismissal = Readonly<{
  findingId: string;
  findingKind: string;
  targetId: string;
  fingerprint: string;
  dismissedAt: string;
}>;

export type PortableAffectedReason = Readonly<{
  id: string;
  affectedNodeId: string;
  causalNodeId: string;
  causalNodeTitle: string;
  deltaDays: number;
  causalDateSummary: string;
  createdAt: string;
  acknowledgedAt: string | null;
}>;

export type PortableNodeOpenQuestion = Readonly<{
  id: string;
  nodeId: string;
  questionText: string;
  status: 'OPEN' | 'DECIDED';
  decisionText: string | null;
  position: string; // decimal string
  resolvedAtISO: string | null;
  createdAtISO: string;
}>;

/**
 * The project-owned forecast plan (Epic 18, Story 18.2). Optional: absent in
 * files written before forecasting. Computed results and receipts are absent
 * by contract (AR-14, AD-21). Configuration fields are explicitly nullable —
 * an incomplete configuration is valid plan state (AR-10).
 */
export type PortableForecastPlan = Readonly<{
  selectedFeatureIds: readonly string[];
  parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  /** Forecast-owned blocked Feature IDs (Epic 20, Story 20.1). Optional:
   * absent in v4 files. A subset of `selectedFeatureIds`. */
  blockedFeatureIds?: readonly string[];
  pointsPerSprint: number | null;
  sprintLengthDays: number | null;
  cadence: 'fixed-contiguous';
  startSprintOrdinal: number | null;
  startDate: string | null;
  policyVersion: string;
  /** The node hierarchy level this plan operates at (Epic 21, Story 21.8).
   * Optional: absent in v1-v5 files, normalized to 'Feature' on import. */
  planningLevel?: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
  /** Project forecast people and capacity weights (Epic 22, Story 22.8).
   * Optional: absent in v1-v6 files, defaults to empty array on import. */
  roster?: readonly import('../domain/forecast/forecast-plan.entity').ForecastPerson[];
  /** Work item to person ID assignments map (Epic 22, Story 22.8).
   * Optional: absent in v1-v6 files, defaults to empty object on import. */
  assignments?: Readonly<Record<string, readonly string[]>>;
  /** The Delivery Board's sprint plan. Optional: absent in v1-v9 files. */
  sprintPlan?: import('../domain/forecast/forecast-plan.entity').ForecastSprintPlan;
}>;

/**
 * A saved historical trade-off scenario (Epic 20, Story 20.4). Inputs only —
 * baseline scope/config/groups/blocked set, the immutable union fact map, and
 * one patch. Validated as self-contained facts; not required to resolve to
 * live nodes on import (§6, §8).
 */
export type PortableForecastScenario = Readonly<{
  scenarioId: string;
  label: string;
  baselineRevision: number;
  baselineFingerprint: string;
  policyVersion: string;
  createdAtISO: string;
  baseline: Readonly<{
    /** The node hierarchy level the baseline was captured at (Epic 21, Story 21.9). */
    planningLevel?: import('../domain/forecast/forecast-plan.entity').ForecastNodeLevel;
    orderedScope: readonly string[];
    configuration: Readonly<{
      pointsPerSprint: number | null;
      sprintLengthDays: number | null;
      cadence: 'fixed-contiguous';
      startSprintOrdinal: number | null;
      startDate: string | null;
    }>;
    parallelGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    blockedFeatureIds: readonly string[];
    factMap: Readonly<Record<string, Readonly<{
      effortPoints: number | null;
      /** The node's actual type at capture time (Epic 21, Story 21.9). */
      nodeType?: string;
      /** Legacy pre-Epic-21 boolean; normalized to nodeType on read. */
      isFeature?: boolean;
      projectId: string;
      ancestorIds: readonly string[];
    }>>>;
    /** Captured project roster for staffed forecasting (Story 23.5, SF-FR18). */
    roster?: readonly import('../domain/forecast/forecast-plan.entity').ForecastPerson[];
    /** Captured per-item assignments for staffed forecasting (Story 23.5, SF-FR18). */
    assignments?: Readonly<Record<string, readonly string[]>>;
  }>;
  patch: Readonly<{
    orderedScope?: readonly string[];
    pointOverrides?: Readonly<Record<string, number>>;
    pointsPerSprint?: number;
    /** Pacing-mode lever (Story 26.4, FC-FR4). */
    policyVersion?: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
    /** Full parallel-group lever (Story 26.4, FC-FR4). */
    parallelGroups?: readonly Readonly<{ featureIds: readonly string[] }>[];
    /** Per-person weight overrides by captured person ID (Story 23.5, SF-FR18). */
    weightOverrides?: Readonly<Record<string, number>>;
    /** Per-item assigned person IDs override by selected item ID (Story 23.5, SF-FR18). */
    assignmentOverrides?: Readonly<Record<string, readonly string[]>>;
  }>;
}>;

/** The complete-project portable envelope (schema version 10, Delivery Board). */
export type PortableFileEnvelopeV10 = Omit<PortableFileEnvelopeV9, 'schemaVersion'> & Readonly<{ schemaVersion: 10 }>;

/** The complete-project portable envelope (schema version 9, Epic 26). */
export type PortableFileEnvelopeV9 = Readonly<{
  schemaVersion: 9;
  exportedAt: string;
  project: Readonly<{ id: string; name: string }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in files written before Epic 20. */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 8, Epic 23). */
export type PortableFileEnvelopeV8 = Readonly<{
  schemaVersion: 8;
  exportedAt: string;
  project: Readonly<{ id: string; name: string }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in files written before Epic 20. */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 7, Epic 22). */
export type PortableFileEnvelopeV7 = Readonly<{
  schemaVersion: 7;
  exportedAt: string;
  project: Readonly<{ id: string; name: string }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in files written before Epic 20. */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 6, Epic 21). */
export type PortableFileEnvelopeV6 = Readonly<{
  schemaVersion: 6;
  exportedAt: string;
  project: Readonly<{ id: string; name: string }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in files written before Epic 20. */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 5). */
export type PortableFileEnvelopeV5 = Readonly<{
  schemaVersion: 5;
  exportedAt: string;
  project: Readonly<{ id: string; name: string }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in files written before Epic 20. */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 4). */
export type PortableFileEnvelopeV4 = Readonly<{
  schemaVersion: 4;
  exportedAt: string; // UTC ISO 8601 instant, injected clock port (AD-8)
  project: Readonly<{
    id: string; // UUIDv7 — the original project ID, preserved on import
    name: string;
  }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  /** Optional: absent in files written before forecasting (Epic 18). */
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in projects without saved scenarios (Epic 20, Story 20.4). */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

/** The complete-project portable envelope (schema version 3). */
export type PortableFileEnvelopeV3 = Readonly<{
  schemaVersion: 3;
  exportedAt: string; // UTC ISO 8601 instant, injected clock port (AD-8)
  project: Readonly<{
    id: string; // UUIDv7 — the original project ID, preserved on import
    name: string;
  }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
}>;

/** The complete-project portable envelope (schema version 2). */
export type PortableFileEnvelopeV2 = Readonly<{
  schemaVersion: 2;
  exportedAt: string; // UTC ISO 8601 instant, injected clock port (AD-8)
  project: Readonly<{
    id: string; // UUIDv7 — the original project ID, preserved on import
    name: string;
  }>;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
}>;

/** The legacy project-only envelope (schema version 1). */
export type PortableFileEnvelopeV1 = Readonly<{
  schemaVersion: 1;
  exportedAt: string;
  project: Readonly<{
    id: string;
    name: string;
  }>;
}>;

/** Any supported portable envelope version. */
export type PortableFileEnvelope =
  | PortableFileEnvelopeV10
  | PortableFileEnvelopeV9
  | PortableFileEnvelopeV8
  | PortableFileEnvelopeV7
  | PortableFileEnvelopeV6
  | PortableFileEnvelopeV5
  | PortableFileEnvelopeV4
  | PortableFileEnvelopeV3
  | PortableFileEnvelopeV2
  | PortableFileEnvelopeV1;

/**
 * Portable project snapshot (E13 Task 2): the raw authored/durable facts for
 * one project, assembled at the application/persistence boundary — never from
 * UI projections. Maps 1:1 onto the v4 envelope collections. Excludes
 * `view_state` and `product_command_receipt` by contract.
 */
export type PortableProjectSnapshot = Readonly<{
  projectId: string;
  projectName: string;
  projectRevision: number;
  phases: readonly PortablePhase[];
  nodes: readonly PortableNode[];
  nodeCustomFields: readonly PortableNodeCustomField[];
  typeTemplateFields: readonly PortableTypeTemplateField[];
  unlockEdges: readonly PortableUnlockEdge[];
  findingDismissals: readonly PortableFindingDismissal[];
  affectedReasons: readonly PortableAffectedReason[];
  openQuestions: readonly PortableNodeOpenQuestion[];
  /** Optional: absent in projects without a forecast plan (Epic 18). */
  forecastPlan?: PortableForecastPlan;
  /** Optional: absent in projects without saved scenarios (Epic 20). */
  forecastScenarios?: readonly PortableForecastScenario[];
}>;

// ── Typed rejections ───────────────────────────────────────────────────────

export type PortableFileRejection =
  | Readonly<{ type: 'MalformedJson'; cause: string }>
  | Readonly<{ type: 'UnsupportedNewerSchema'; found: number; supported: number }>
  | Readonly<{ type: 'UnknownFieldsAtCurrentVersion'; fields: readonly string[] }>
  | Readonly<{ type: 'MissingRequiredField'; field: string }>
  | Readonly<{ type: 'InvalidProjectId'; cause: string }>
  | Readonly<{ type: 'InvalidProjectName'; cause: string }>
  | Readonly<{ type: 'ActiveContentDetected'; field: string }>
  | Readonly<{ type: 'LimitExceeded'; cause: string }>
  | Readonly<{ type: 'DuplicateProjectId'; projectId: string }>
  | Readonly<{ type: 'InvalidRelation'; detail: string }>
  | Readonly<{ type: 'InvalidNodeId'; nodeId: string; cause: string }>
  | Readonly<{ type: 'InvalidPhaseId'; phaseId: string; cause: string }>
  | Readonly<{ type: 'InvalidEdgeId'; edgeId: string; cause: string }>
  | Readonly<{ type: 'CycleDetected'; nodeId: string }>
  | Readonly<{ type: 'DuplicateSiblingPosition'; nodeId: string; parentId: string | null; position: string }>
  | Readonly<{ type: 'InvalidBounds'; field: string; cause: string }>;

/** Maximum portable-file size in bytes (10 MB — conservative, see Completion Notes). */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
/** Maximum nodes per portable project (aligned with the 5,000-node supported scale headroom). */
export const MAX_PORTABLE_NODES = 5000;
/** Maximum phases, edges, and reasons per portable project. */
export const MAX_PORTABLE_PHASES = 200;
export const MAX_PORTABLE_EDGES = 2000;
export const MAX_PORTABLE_REASONS = 2000;

const KNOWN_TOP_LEVEL_FIELDS_V2 = Object.freeze([
  'schemaVersion',
  'exportedAt',
  'project',
  'phases',
  'nodes',
  'nodeCustomFields',
  'typeTemplateFields',
  'unlockEdges',
  'findingDismissals',
  'affectedReasons',
]);
const KNOWN_TOP_LEVEL_FIELDS_V3 = Object.freeze([
  'schemaVersion',
  'exportedAt',
  'project',
  'phases',
  'nodes',
  'nodeCustomFields',
  'typeTemplateFields',
  'unlockEdges',
  'findingDismissals',
  'affectedReasons',
  'openQuestions',
]);
const KNOWN_TOP_LEVEL_FIELDS_V4 = Object.freeze([
  'schemaVersion',
  'exportedAt',
  'project',
  'phases',
  'nodes',
  'nodeCustomFields',
  'typeTemplateFields',
  'unlockEdges',
  'findingDismissals',
  'affectedReasons',
  'openQuestions',
  'forecastPlan',
]);
const KNOWN_TOP_LEVEL_FIELDS_V5 = Object.freeze([...KNOWN_TOP_LEVEL_FIELDS_V4, 'forecastScenarios']);
const KNOWN_TOP_LEVEL_FIELDS_V1 = Object.freeze(['schemaVersion', 'exportedAt', 'project']);
const KNOWN_PROJECT_FIELDS = Object.freeze(['id', 'name']);
const KNOWN_FORECAST_PLAN_FIELDS = Object.freeze([
  'selectedFeatureIds',
  'parallelGroups',
  'blockedFeatureIds',
  'pointsPerSprint',
  'sprintLengthDays',
  'cadence',
  'startSprintOrdinal',
  'startDate',
  'policyVersion',
  'planningLevel',
  'roster',
  'assignments',
  'sprintPlan',
]);

// ── Active-content policy ──────────────────────────────────────────────────

function hasActiveContent(value: string): boolean {
  return /<[a-zA-Z]/.test(value) || /javascript\s*:/i.test(value);
}

function isSafeAuthorableText(value: string, field: string): boolean {
  if (hasActiveContent(value)) {
    return false;
  }
  return true;
}

function rejectActive(field: string): PortableFileRejection {
  return Object.freeze({ type: 'ActiveContentDetected', field });
}

// ── Validators ─────────────────────────────────────────────────────────────

function isUuidV7(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isDecimalPosition(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  try {
    BigInt(value.trim());
    return true;
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseV1Project(input: Record<string, unknown>): { ok: true; value: PortableFileEnvelopeV1 } | { ok: false; error: PortableFileRejection } {
  if (typeof input.project !== 'object' || input.project === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'project' }) };
  }
  const project = input.project as Record<string, unknown>;
  const extraProjectFields = Object.keys(project).filter((k) => !KNOWN_PROJECT_FIELDS.includes(k));
  if (extraProjectFields.length > 0) {
    return { ok: false, error: Object.freeze({ type: 'UnknownFieldsAtCurrentVersion', fields: Object.freeze([...extraProjectFields]) }) };
  }
  if (typeof project.id !== 'string' || !isUuidV7(project.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectId', cause: 'project.id must be a valid UUIDv7' }) };
  }
  if (typeof project.name !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name must be a string' }) };
  }
  const trimmedName = project.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name is empty' }) };
  }
  if (trimmedName.length > 200) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name exceeds 200 characters' }) };
  }
  if (!isSafeAuthorableText(trimmedName, 'project.name')) {
    return { ok: false, error: rejectActive('project.name') };
  }
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: LEGACY_PORTABLE_FILE_SCHEMA_VERSION as 1,
      exportedAt: String(input.exportedAt),
      project: Object.freeze({ id: project.id as string, name: trimmedName }),
    }),
  };
}

function readCollection(input: Record<string, unknown>, field: string): readonly unknown[] | null {
  const value = input[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return null; // caller converts to MissingRequiredField
  }
  return value;
}

function validateNode(raw: unknown, index: number): { ok: true; value: PortableNode } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodes[${index}]` }) };
  }
  const n = raw as Record<string, unknown>;
  const id = n.id;
  if (!isUuidV7(id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidNodeId', nodeId: String(id ?? ''), cause: 'id must be a valid UUIDv7' }) };
  }
  if (n.parentId !== null && n.parentId !== undefined && !isUuidV7(n.parentId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidNodeId', nodeId: String(n.parentId), cause: 'parentId must be null or a valid UUIDv7' }) };
  }
  if (n.phaseId !== null && n.phaseId !== undefined && !isUuidV7(n.phaseId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidPhaseId', phaseId: String(n.phaseId), cause: 'phaseId must be null or a valid UUIDv7' }) };
  }
  if (typeof n.title !== 'string' || !isSafeAuthorableText(n.title, `nodes[${index}].title`)) {
    return { ok: false, error: rejectActive(`nodes[${index}].title`) };
  }
  if (n.bodyText !== null && n.bodyText !== undefined && typeof n.bodyText !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodes[${index}].bodyText` }) };
  }
  if (n.bodyText !== null && n.bodyText !== undefined && hasActiveContent(n.bodyText)) {
    return { ok: false, error: rejectActive(`nodes[${index}].bodyText`) };
  }
  if (!isDecimalPosition(n.position)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].position`, cause: 'position must be a decimal string' }) };
  }
  if (n.nodeType !== null && n.nodeType !== undefined && !['Vision', 'Theme', 'Component', 'Feature', 'AcceptanceCriterion'].includes(String(n.nodeType))) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].nodeType`, cause: 'unknown node type' }) };
  }
  if (n.startDate !== null && n.startDate !== undefined && typeof n.startDate !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodes[${index}].startDate` }) };
  }
  if (n.endDate !== null && n.endDate !== undefined && typeof n.endDate !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodes[${index}].endDate` }) };
  }
  if (n.durationDays !== null && n.durationDays !== undefined && !isFiniteNumber(n.durationDays)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].durationDays`, cause: 'must be a finite number' }) };
  }
  if (n.scheduleSourceMode !== null && n.scheduleSourceMode !== undefined &&
      !['start_end', 'start_duration', 'end_duration', 'none'].includes(String(n.scheduleSourceMode))) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].scheduleSourceMode`, cause: 'unknown schedule source mode' }) };
  }
  if (typeof n.completed !== 'boolean') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodes[${index}].completed` }) };
  }
  if (n.effortPoints !== null && n.effortPoints !== undefined && !isFiniteNumber(n.effortPoints)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].effortPoints`, cause: 'must be a finite number' }) };
  }
  if (n.effortPointsDone !== null && n.effortPointsDone !== undefined && !isFiniteNumber(n.effortPointsDone)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].effortPointsDone`, cause: 'must be a finite number' }) };
  }
  if (n.strategicWeight !== null && n.strategicWeight !== undefined && !isFiniteNumber(n.strategicWeight)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].strategicWeight`, cause: 'must be a finite number' }) };
  }
  if (
    n.deliveryStatus !== null &&
    n.deliveryStatus !== undefined &&
    n.deliveryStatus !== 'not_started' &&
    n.deliveryStatus !== 'in_progress' &&
    n.deliveryStatus !== 'delivered'
  ) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `nodes[${index}].deliveryStatus`, cause: "must be 'not_started', 'in_progress', or 'delivered'" }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      id: id as string,
      parentId: n.parentId === null || n.parentId === undefined ? null : (n.parentId as string),
      title: n.title as string,
      bodyText: n.bodyText === null || n.bodyText === undefined ? null : (n.bodyText as string),
      position: String(n.position).trim(),
      nodeType: (n.nodeType ?? null) as PortableNodeType,
      startDate: n.startDate === null || n.startDate === undefined ? null : (n.startDate as string),
      endDate: n.endDate === null || n.endDate === undefined ? null : (n.endDate as string),
      durationDays: n.durationDays === null || n.durationDays === undefined ? null : Number(n.durationDays),
      scheduleSourceMode: (n.scheduleSourceMode ?? null) as PortableScheduleSourceMode,
      completed: n.completed as boolean,
      effortPoints: n.effortPoints === null || n.effortPoints === undefined ? null : Number(n.effortPoints),
      effortPointsDone:
        n.effortPointsDone === null || n.effortPointsDone === undefined ? null : Number(n.effortPointsDone),
      strategicWeight: n.strategicWeight === null || n.strategicWeight === undefined ? null : Number(n.strategicWeight),
      phaseId: n.phaseId === null || n.phaseId === undefined ? null : (n.phaseId as string),
      deliveryStatus:
        n.deliveryStatus === 'in_progress' || n.deliveryStatus === 'delivered'
          ? n.deliveryStatus
          : 'not_started',
    }),
  };
}

function validatePhase(raw: unknown, index: number): { ok: true; value: PortablePhase } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `phases[${index}]` }) };
  }
  const p = raw as Record<string, unknown>;
  if (!isUuidV7(p.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidPhaseId', phaseId: String(p.id ?? ''), cause: 'id must be a valid UUIDv7' }) };
  }
  if (typeof p.name !== 'string' || !isSafeAuthorableText(p.name, `phases[${index}].name`)) {
    return { ok: false, error: rejectActive(`phases[${index}].name`) };
  }
  if (!isDecimalPosition(p.position)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `phases[${index}].position`, cause: 'position must be a decimal string' }) };
  }
  return {
    ok: true,
    value: Object.freeze({ id: p.id as string, name: p.name as string, position: String(p.position).trim() }),
  };
}

function validateUnlockEdge(raw: unknown, index: number): { ok: true; value: PortableUnlockEdge } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `unlockEdges[${index}]` }) };
  }
  const e = raw as Record<string, unknown>;
  if (!isUuidV7(e.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidEdgeId', edgeId: String(e.id ?? ''), cause: 'id must be a valid UUIDv7' }) };
  }
  if (!isUuidV7(e.sourceNodeId) || !isUuidV7(e.targetNodeId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `unlockEdges[${index}]: sourceNodeId/targetNodeId must be valid UUIDv7` }) };
  }
  return {
    ok: true,
    value: Object.freeze({ id: e.id as string, sourceNodeId: e.sourceNodeId as string, targetNodeId: e.targetNodeId as string }),
  };
}

function validateNodeCustomField(raw: unknown, index: number): { ok: true; value: PortableNodeCustomField } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodeCustomFields[${index}]` }) };
  }
  const f = raw as Record<string, unknown>;
  if (!isUuidV7(f.nodeId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `nodeCustomFields[${index}]: nodeId must be a valid UUIDv7` }) };
  }
  if (typeof f.fieldKey !== 'string' || !isSafeAuthorableText(f.fieldKey, `nodeCustomFields[${index}].fieldKey`)) {
    return { ok: false, error: rejectActive(`nodeCustomFields[${index}].fieldKey`) };
  }
  if (f.fieldValue !== null && f.fieldValue !== undefined && typeof f.fieldValue !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `nodeCustomFields[${index}].fieldValue` }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      nodeId: f.nodeId as string,
      fieldKey: f.fieldKey as string,
      fieldValue: f.fieldValue === null || f.fieldValue === undefined ? null : (f.fieldValue as string),
    }),
  };
}

function validateTypeTemplateField(raw: unknown, index: number): { ok: true; value: PortableTypeTemplateField } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `typeTemplateFields[${index}]` }) };
  }
  const t = raw as Record<string, unknown>;
  if (!['Vision', 'Theme', 'Component', 'Feature', 'AcceptanceCriterion'].includes(String(t.nodeType))) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `typeTemplateFields[${index}].nodeType`, cause: 'unknown node type' }) };
  }
  if (typeof t.fieldKey !== 'string' || !isSafeAuthorableText(t.fieldKey, `typeTemplateFields[${index}].fieldKey`)) {
    return { ok: false, error: rejectActive(`typeTemplateFields[${index}].fieldKey`) };
  }
  if (typeof t.fieldLabel !== 'string' || !isSafeAuthorableText(t.fieldLabel, `typeTemplateFields[${index}].fieldLabel`)) {
    return { ok: false, error: rejectActive(`typeTemplateFields[${index}].fieldLabel`) };
  }
  if (!isFiniteNumber(t.position)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `typeTemplateFields[${index}].position`, cause: 'position must be a finite number' }) };
  }
  return {
    ok: true,
    value: Object.freeze({ nodeType: t.nodeType as string, fieldKey: t.fieldKey as string, fieldLabel: t.fieldLabel as string, position: Number(t.position) }),
  };
}

function validateFindingDismissal(raw: unknown, index: number): { ok: true; value: PortableFindingDismissal } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `findingDismissals[${index}]` }) };
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.findingId !== 'string' || typeof d.findingKind !== 'string' ||
      typeof d.targetId !== 'string' || typeof d.fingerprint !== 'string' || typeof d.dismissedAt !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `findingDismissals[${index}]` }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      findingId: d.findingId as string,
      findingKind: d.findingKind as string,
      targetId: d.targetId as string,
      fingerprint: d.fingerprint as string,
      dismissedAt: d.dismissedAt as string,
    }),
  };
}

function validateAffectedReason(raw: unknown, index: number): { ok: true; value: PortableAffectedReason } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `affectedReasons[${index}]` }) };
  }
  const r = raw as Record<string, unknown>;
  if (!isUuidV7(r.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `affectedReasons[${index}]: id must be a valid UUIDv7` }) };
  }
  if (!isUuidV7(r.affectedNodeId) || !isUuidV7(r.causalNodeId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `affectedReasons[${index}]: affectedNodeId/causalNodeId must be valid UUIDv7` }) };
  }
  if (typeof r.causalNodeTitle !== 'string' || typeof r.causalDateSummary !== 'string' || typeof r.createdAt !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `affectedReasons[${index}]` }) };
  }
  if (!isFiniteNumber(r.deltaDays)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `affectedReasons[${index}].deltaDays`, cause: 'must be a finite number' }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      id: r.id as string,
      affectedNodeId: r.affectedNodeId as string,
      causalNodeId: r.causalNodeId as string,
      causalNodeTitle: r.causalNodeTitle as string,
      deltaDays: Number(r.deltaDays),
      causalDateSummary: r.causalDateSummary as string,
      createdAt: r.createdAt as string,
      acknowledgedAt: r.acknowledgedAt === null || r.acknowledgedAt === undefined ? null : (r.acknowledgedAt as string),
    }),
  };
}

const FORECAST_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A finite non-negative safe integer, or null/undefined. */
function isNullableNonNegativeInt(value: unknown): boolean {
  return value === null || value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

/** A positive safe integer, or null/undefined. */
function isNullablePositiveInt(value: unknown): boolean {
  return value === null || value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

/** A real ISO YYYY-MM-DD calendar date, or null/undefined. */
function isNullableIsoCalendarDate(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string' || !FORECAST_ISO_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validate the optional forecast plan (Epic 18, Story 18.2, AR-25). Import
 * validates completely before any transaction: numeric domain, strict
 * calendar date, supported policy version, unique in-scope Feature
 * references, and disjoint / contiguous / >=2 parallel groups — the same
 * contract the live command boundary enforces.
 */
function validateForecastPlan(
  raw: unknown,
  featureNodeIds: ReadonlySet<string>,
  level: string = 'Feature',
  nodeEffortPoints?: ReadonlyMap<string, number | null>,
  schemaVersion: number = PORTABLE_FILE_SCHEMA_VERSION,
): { ok: true; value: PortableForecastPlan } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'forecastPlan' }) };
  }
  const p = raw as Record<string, unknown>;
  const extraFields = Object.keys(p).filter(
    (k) => !KNOWN_FORECAST_PLAN_FIELDS.includes(k) || (k === 'sprintPlan' && schemaVersion < 10),
  );
  if (extraFields.length > 0) {
    return { ok: false, error: Object.freeze({ type: 'UnknownFieldsAtCurrentVersion', fields: Object.freeze([...extraFields]) }) };
  }
  if (!Array.isArray(p.selectedFeatureIds) || p.selectedFeatureIds.some((id) => !isUuidV7(id))) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.selectedFeatureIds must be an array of UUIDv7' }) };
  }
  const selectedFeatureIds = p.selectedFeatureIds.map(String);
  // Unique, and each must resolve to a node of the plan's level in this
  // same envelope (Story 21.8 AC 6: the rejection names the expected level).
  const selectedSet = new Set<string>();
  for (const id of selectedFeatureIds) {
    if (selectedSet.has(id)) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.selectedFeatureIds contains a duplicate: ${id}` }) };
    }
    selectedSet.add(id);
    if (!featureNodeIds.has(id)) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.selectedFeatureIds references a node that is not a ${level} in this file: ${id}` }) };
    }
  }
  if (!Array.isArray(p.parallelGroups)) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'forecastPlan.parallelGroups' }) };
  }
  const parallelGroups: Readonly<{ featureIds: readonly string[] }>[] = [];
  const groupMemberSeen = new Set<string>();
  const positionOf = new Map(selectedFeatureIds.map((id, idx) => [id, idx] as const));
  for (let i = 0; i < p.parallelGroups.length; i += 1) {
    const g = p.parallelGroups[i] as Record<string, unknown>;
    if (typeof g !== 'object' || g === null || !Array.isArray(g.featureIds) || g.featureIds.some((id) => !isUuidV7(id))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.parallelGroups[${i}] must contain a featureIds array of UUIDv7` }) };
    }
    const ids = g.featureIds.map(String);
    if (ids.length < 2) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.parallelGroups[${i}] must have at least two members` }) };
    }
    const positions: number[] = [];
    for (const id of ids) {
      if (groupMemberSeen.has(id)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.parallelGroups: Feature ${id} appears in more than one group` }) };
      }
      groupMemberSeen.add(id);
      const pos = positionOf.get(id);
      if (pos === undefined) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.parallelGroups[${i}] member ${id} is not in selectedFeatureIds` }) };
      }
      positions.push(pos);
    }
    positions.sort((a, b) => a - b);
    for (let k = 1; k < positions.length; k += 1) {
      if (positions[k] !== positions[k - 1] + 1) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.parallelGroups[${i}] is not contiguous in priority order` }) };
      }
    }
    parallelGroups.push(Object.freeze({ featureIds: Object.freeze(ids) }));
  }
  if (!isNullableNonNegativeInt(p.pointsPerSprint)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.pointsPerSprint', cause: 'must be a non-negative safe integer or null' }) };
  }
  if (!isNullablePositiveInt(p.sprintLengthDays)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.sprintLengthDays', cause: 'must be a positive safe integer or null' }) };
  }
  if (p.cadence !== 'fixed-contiguous') {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.cadence', cause: "must be 'fixed-contiguous'" }) };
  }
  if (!isNullablePositiveInt(p.startSprintOrdinal)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.startSprintOrdinal', cause: 'must be a positive safe integer or null' }) };
  }
  if (!isNullableIsoCalendarDate(p.startDate)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.startDate', cause: 'must be a real ISO YYYY-MM-DD calendar date or null' }) };
  }
  if (p.policyVersion !== 'shared-capacity-v1' && p.policyVersion !== 'staffed-capacity-v1') {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.policyVersion', cause: "must be 'shared-capacity-v1' or 'staffed-capacity-v1'" }) };
  }
  // Story 21.8 AC 1: `planningLevel` is optional (absent in v1-v5 files) and
  // must be one of the three levels when present.
  if (p.planningLevel !== undefined && p.planningLevel !== null) {
    if (p.planningLevel !== 'Theme' && p.planningLevel !== 'Component' && p.planningLevel !== 'Feature') {
      return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: 'forecastPlan.planningLevel', cause: "must be 'Theme', 'Component', or 'Feature'" }) };
    }
  }
  let blockedFeatureIds: string[] | undefined;
  if (p.blockedFeatureIds !== undefined && p.blockedFeatureIds !== null) {
    if (!Array.isArray(p.blockedFeatureIds) || p.blockedFeatureIds.some((id) => !isUuidV7(id))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.blockedFeatureIds must be an array of UUIDv7' }) };
    }
    const blockedSeen = new Set<string>();
    for (const id of p.blockedFeatureIds.map(String)) {
      if (blockedSeen.has(id)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.blockedFeatureIds contains a duplicate: ${id}` }) };
      }
      blockedSeen.add(id);
      if (!selectedSet.has(id)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.blockedFeatureIds member ${id} is not in selectedFeatureIds` }) };
      }
    }
    blockedFeatureIds = p.blockedFeatureIds.map(String);
  }

  let roster: readonly import('../domain/forecast/forecast-plan.entity').ForecastPerson[] | undefined;
  const rosterPersonIds = new Set<string>();
  const rosterPersonNames = new Set<string>();
  if (p.roster !== undefined && p.roster !== null) {
    if (!Array.isArray(p.roster)) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.roster must be an array' }) };
    }
    const validatedRoster: import('../domain/forecast/forecast-plan.entity').ForecastPerson[] = [];
    for (let i = 0; i < p.roster.length; i += 1) {
      const item = p.roster[i] as Record<string, unknown>;
      if (typeof item !== 'object' || item === null) {
        return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastPlan.roster[${i}]` }) };
      }
      if (!isUuidV7(item.id)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.roster[${i}].id must be a valid UUIDv7` }) };
      }
      const personId = String(item.id);
      if (rosterPersonIds.has(personId)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.roster contains duplicate person id: ${personId}` }) };
      }
      rosterPersonIds.add(personId);

      if (typeof item.name !== 'string') {
        return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastPlan.roster[${i}].name` }) };
      }
      const trimmedName = item.name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 100) {
        return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `forecastPlan.roster[${i}].name`, cause: 'name must be 1 to 100 characters' }) };
      }
      if (!isSafeAuthorableText(trimmedName, `forecastPlan.roster[${i}].name`)) {
        return { ok: false, error: rejectActive(`forecastPlan.roster[${i}].name`) };
      }
      const lowerName = trimmedName.toLowerCase();
      if (rosterPersonNames.has(lowerName)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.roster contains duplicate person name: ${trimmedName}` }) };
      }
      rosterPersonNames.add(lowerName);

      if (!Number.isSafeInteger(item.weightUnits) || (item.weightUnits as number) < 1 || (item.weightUnits as number) > 1000) {
        return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `forecastPlan.roster[${i}].weightUnits`, cause: 'weightUnits must be an integer between 1 and 1000' }) };
      }

      validatedRoster.push(Object.freeze({
        id: personId,
        name: trimmedName,
        weightUnits: item.weightUnits as number,
      }));
    }
    roster = Object.freeze(validatedRoster);
  }

  let assignments: Readonly<Record<string, readonly string[]>> | undefined;
  if (p.assignments !== undefined && p.assignments !== null) {
    if (typeof p.assignments !== 'object' || Array.isArray(p.assignments)) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.assignments must be an object' }) };
    }
    const validatedAssignments: Record<string, readonly string[]> = {};
    for (const [key, value] of Object.entries(p.assignments as Record<string, unknown>)) {
      if (!isUuidV7(key)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments key ${key} must be a valid UUIDv7` }) };
      }
      if (!selectedSet.has(key)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments references item not in selectedFeatureIds: ${key}` }) };
      }
      if (!Array.isArray(value)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments[${key}] must be an array of person ids` }) };
      }
      const pids = value.map(String);
      if (pids.some((id) => !isUuidV7(id))) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments[${key}] contains invalid person id` }) };
      }

      if (pids.length > 0) {
        // Zero-work items cannot have assignments (AC 22.8-4)
        if (nodeEffortPoints && nodeEffortPoints.get(key) === 0) {
          return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments: zero-work item ${key} cannot have assigned people` }) };
        }

        const seenInItem = new Set<string>();
        for (const pid of pids) {
          if (seenInItem.has(pid)) {
            return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments[${key}]: person ${pid} is assigned more than once` }) };
          }
          seenInItem.add(pid);
          if (!rosterPersonIds.has(pid)) {
            return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastPlan.assignments[${key}]: person ${pid} is not in the project roster` }) };
          }
        }
      }
      validatedAssignments[key] = Object.freeze(pids);
    }
    assignments = Object.freeze(validatedAssignments);
  }

  let sprintPlan: import('../domain/forecast/forecast-plan.entity').ForecastSprintPlan | undefined;
  if (p.sprintPlan !== undefined && p.sprintPlan !== null) {
    try {
      sprintPlan = createForecastSprintPlan(p.sprintPlan);
    } catch {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.sprintPlan is malformed' }) };
    }
    const sprintPlanObject = p.sprintPlan as { placements?: unknown; capacities?: unknown };
    if (Object.keys(sprintPlanObject).some((key) => key !== 'placements' && key !== 'capacities')) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastPlan.sprintPlan has unknown fields' }) };
    }
    // A placement for an item that is not in the plan carries no meaning:
    // skip it rather than refuse the whole file.
    if (sprintPlan.placements.some((placement) => !selectedSet.has(placement.itemId))) {
      sprintPlan = Object.freeze({
        placements: Object.freeze(sprintPlan.placements.filter((placement) => selectedSet.has(placement.itemId))),
        capacities: sprintPlan.capacities,
      });
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      selectedFeatureIds: Object.freeze(selectedFeatureIds),
      parallelGroups: Object.freeze(parallelGroups),
      ...(blockedFeatureIds ? { blockedFeatureIds: Object.freeze(blockedFeatureIds) } : {}),
      pointsPerSprint: p.pointsPerSprint === null || p.pointsPerSprint === undefined ? null : Number(p.pointsPerSprint),
      sprintLengthDays: p.sprintLengthDays === null || p.sprintLengthDays === undefined ? null : Number(p.sprintLengthDays),
      cadence: 'fixed-contiguous',
      startSprintOrdinal: p.startSprintOrdinal === null || p.startSprintOrdinal === undefined ? null : Number(p.startSprintOrdinal),
      startDate: p.startDate === null || p.startDate === undefined ? null : (p.startDate as string),
      policyVersion: p.policyVersion,
      ...(p.planningLevel !== undefined && p.planningLevel !== null
        ? { planningLevel: p.planningLevel as 'Theme' | 'Component' | 'Feature' }
        : {}),
      ...(roster ? { roster } : {}),
      ...(assignments ? { assignments } : {}),
      ...(sprintPlan ? { sprintPlan } : {}),
    }),
  };
}

/**
 * Validate one saved forecast scenario (Epic 20, Story 20.4). Historical
 * facts are self-contained — the scenario is NOT required to resolve to live
 * nodes on import (§6, §8). Structural + identity + bounds only.
 */
function validateForecastScenario(
  raw: unknown,
  index: number,
  projectId: string,
  schemaVersion: number,
): { ok: true; value: PortableForecastScenario } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastScenarios[${index}]` }) };
  }
  const s = raw as Record<string, unknown>;
  if (!isUuidV7(s.scenarioId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios[${index}].scenarioId must be a valid UUIDv7` }) };
  }
  if (typeof s.label !== 'string' || s.label.trim().length === 0) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastScenarios[${index}].label` }) };
  }
  if (!Number.isSafeInteger(s.baselineRevision) || (s.baselineRevision as number) < 0) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `forecastScenarios[${index}].baselineRevision`, cause: 'must be a non-negative safe integer' }) };
  }
  if (typeof s.baselineFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(s.baselineFingerprint)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `forecastScenarios[${index}].baselineFingerprint`, cause: 'must be a lowercase hex SHA-256' }) };
  }
  if (s.policyVersion !== 'shared-capacity-v1' && s.policyVersion !== 'staffed-capacity-v1') {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `forecastScenarios[${index}].policyVersion`, cause: "must be 'shared-capacity-v1' or 'staffed-capacity-v1'" }) };
  }
  if (schemaVersion < 8) {
    if (s.policyVersion === 'staffed-capacity-v1') {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios[${index}]: staffed scenarios are not supported in schema version ${schemaVersion}` }) };
    }
    const b = (typeof s.baseline === 'object' && s.baseline !== null) ? (s.baseline as Record<string, unknown>) : {};
    const p = (typeof s.patch === 'object' && s.patch !== null) ? (s.patch as Record<string, unknown>) : {};
    if (b.roster !== undefined || b.assignments !== undefined || p.weightOverrides !== undefined || p.assignmentOverrides !== undefined) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios[${index}]: staffing scenario fields are not supported in schema version ${schemaVersion}` }) };
    }
  }
  if (typeof s.createdAtISO !== 'string' || s.createdAtISO.length === 0) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastScenarios[${index}].createdAtISO` }) };
  }
  if (typeof s.baseline !== 'object' || s.baseline === null || typeof s.patch !== 'object' || s.patch === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `forecastScenarios[${index}].baseline/patch` }) };
  }
  const persisted = { ...s, projectId };
  if (!isPersistedForecastScenario(persisted, projectId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios[${index}].baseline is malformed` }) };
  }
  const baseline = normalizePersistedForecastScenario(persisted).baseline;
  // Story 21.9 AC 3: the estimate filter accepts members whose captured type
  // equals the scenario's captured level (defaulting to 'Feature' for legacy
  // scenarios) — never a Feature-only boolean, which dropped every estimate
  // of a Theme- or Component-level scenario.
  const capturedLevel = (baseline as { planningLevel?: string }).planningLevel ?? 'Feature';
  const inputs = Object.freeze({
    projectId,
    projectRevision: persisted.baselineRevision,
    policyVersion: persisted.policyVersion,
    selectedFeatureIds: baseline.orderedScope,
    estimates: Object.freeze(Object.fromEntries(
      baseline.orderedScope.flatMap((id) => {
        const fact = baseline.factMap[id];
        return fact?.nodeType === capturedLevel ? [[id, fact.effortPoints]] : [];
      }),
    )),
    pointsPerSprint: baseline.configuration.pointsPerSprint,
    sprintLengthDays: baseline.configuration.sprintLengthDays,
    startSprintOrdinal: baseline.configuration.startSprintOrdinal,
    startDate: baseline.configuration.startDate,
    parallelGroups: baseline.parallelGroups,
    blockedFeatureIds: baseline.blockedFeatureIds,
    ...(persisted.policyVersion === 'staffed-capacity-v1' ? {
      roster: baseline.roster,
      assignments: baseline.assignments,
    } : {}),
  });
  if (computeForecastFingerprintSync(forecastMaterialFacts(inputs)) !== persisted.baselineFingerprint) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios[${index}].baselineFingerprint does not match its historical baseline` }) };
  }
  return { ok: true, value: Object.freeze({ ...s, baseline } as unknown as PortableForecastScenario) };
}

function validateNodeOpenQuestion(raw: unknown, index: number): { ok: true; value: PortableNodeOpenQuestion } | { ok: false; error: PortableFileRejection } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `openQuestions[${index}]` }) };
  }
  const q = raw as Record<string, unknown>;
  if (!isUuidV7(q.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `openQuestions[${index}]: id must be a valid UUIDv7` }) };
  }
  if (!isUuidV7(q.nodeId)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `openQuestions[${index}]: nodeId must be a valid UUIDv7` }) };
  }
  if (typeof q.questionText !== 'string' || q.questionText.trim().length === 0) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `openQuestions[${index}].questionText` }) };
  }
  if (q.status !== 'OPEN' && q.status !== 'DECIDED') {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `openQuestions[${index}].status`, cause: "status must be 'OPEN' or 'DECIDED'" }) };
  }
  if (q.decisionText !== null && q.decisionText !== undefined && typeof q.decisionText !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `openQuestions[${index}].decisionText` }) };
  }
  if (!isDecimalPosition(q.position)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidBounds', field: `openQuestions[${index}].position`, cause: 'position must be a decimal string' }) };
  }
  if (q.resolvedAtISO !== null && q.resolvedAtISO !== undefined && typeof q.resolvedAtISO !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `openQuestions[${index}].resolvedAtISO` }) };
  }
  if (typeof q.createdAtISO !== 'string' || q.createdAtISO.length === 0) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: `openQuestions[${index}].createdAtISO` }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      id: q.id as string,
      nodeId: q.nodeId as string,
      questionText: q.questionText as string,
      status: q.status as 'OPEN' | 'DECIDED',
      decisionText: q.decisionText === null || q.decisionText === undefined ? null : (q.decisionText as string),
      position: String(q.position).trim(),
      resolvedAtISO: q.resolvedAtISO === null || q.resolvedAtISO === undefined ? null : (q.resolvedAtISO as string),
      createdAtISO: q.createdAtISO as string,
    }),
  };
}

/**
 * Cross-collection referential validation: project scoping, parent/phase/edge/
 * affected-reason referential integrity, containment acyclicity, and
 * sibling-position uniqueness (E13 Task 1).
 */
function validateRelations(input: Record<string, unknown>, projectId: string): { ok: true } | { ok: false; error: PortableFileRejection } {
  const rawNodes = (input.nodes ?? []) as readonly unknown[];
  const rawPhases = (input.phases ?? []) as readonly unknown[];
  const rawEdges = (input.unlockEdges ?? []) as readonly unknown[];
  const rawCustomFields = (input.nodeCustomFields ?? []) as readonly unknown[];
  const rawReasons = (input.affectedReasons ?? []) as readonly unknown[];

  // Collect every node id first so parent references may resolve regardless
  // of collection order (parents can appear after children).
  const nodeIds = new Set<string>();
  for (const raw of rawNodes) {
    nodeIds.add(String((raw as Record<string, unknown>).id));
  }

  const phaseIds = new Set<string>();
  for (const raw of rawPhases) {
    phaseIds.add(String((raw as Record<string, unknown>).id));
  }

  for (const raw of rawNodes) {
    const r = raw as Record<string, unknown>;
    const parentId = r.parentId;
    if (parentId !== null && parentId !== undefined && !nodeIds.has(String(parentId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `node ${String(r.id)} references unknown parent ${String(parentId)}` }) };
    }
    const phaseId = r.phaseId;
    if (phaseId !== null && phaseId !== undefined && !phaseIds.has(String(phaseId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `node ${String(r.id)} references unknown phase ${String(phaseId)}` }) };
    }
  }

  // Containment acyclicity: walk parent pointers; a cycle means a node is its
  // own ancestor. The projection guarantees a tree, but portable files are
  // untrusted input.
  const parentOf = new Map<string, string | null>();
  for (const raw of rawNodes) {
    const r = raw as Record<string, unknown>;
    parentOf.set(String(r.id), r.parentId === null || r.parentId === undefined ? null : String(r.parentId));
  }
  for (const id of nodeIds) {
    const visited = new Set<string>();
    let current: string | null = id;
    while (current !== null) {
      if (visited.has(current)) {
        return { ok: false, error: Object.freeze({ type: 'CycleDetected', nodeId: id }) };
      }
      visited.add(current);
      current = parentOf.get(current) ?? null;
    }
  }

  // Sibling-position uniqueness per parent.
  const positionsByParent = new Map<string, Set<string>>();
  for (const raw of rawNodes) {
    const r = raw as Record<string, unknown>;
    const parentKey = r.parentId === null || r.parentId === undefined ? 'null' : String(r.parentId);
    const pos = String((r as Record<string, unknown>).position);
    let set = positionsByParent.get(parentKey);
    if (!set) {
      set = new Set();
      positionsByParent.set(parentKey, set);
    }
    if (set.has(pos)) {
      return {
        ok: false,
        error: Object.freeze({
          type: 'DuplicateSiblingPosition',
          nodeId: String(r.id),
          parentId: r.parentId === null || r.parentId === undefined ? null : String(r.parentId),
          position: pos,
        }),
      };
    }
    set.add(pos);
  }

  // Edge endpoints must exist.
  for (const raw of rawEdges) {
    const e = raw as Record<string, unknown>;
    if (!nodeIds.has(String(e.sourceNodeId)) || !nodeIds.has(String(e.targetNodeId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `edge ${String(e.id)} references a node outside the project` }) };
    }
  }

  // Custom field node references.
  for (const raw of rawCustomFields) {
    const f = raw as Record<string, unknown>;
    if (!nodeIds.has(String(f.nodeId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `custom field on ${String(f.nodeId)} references a node outside the project` }) };
    }
  }

  // Affected reason node references.
  for (const raw of rawReasons) {
    const r = raw as Record<string, unknown>;
    if (!nodeIds.has(String(r.affectedNodeId)) || !nodeIds.has(String(r.causalNodeId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `affected reason ${String(r.id)} references a node outside the project` }) };
    }
  }

  // Open question node references (Story 16.1 Task 3).
  const rawOpenQuestions = (input.openQuestions ?? []) as readonly unknown[];
  for (const raw of rawOpenQuestions) {
    const q = raw as Record<string, unknown>;
    if (!nodeIds.has(String(q.nodeId))) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `open question ${String(q.id)} references a node outside the project` }) };
    }
  }

  void projectId; // project scoping is implicit: every DTO is project-owned by construction
  return { ok: true };
}

/**
 * Validate a portable-file envelope (any supported version).
 * Returns a typed Result — never throws for expected validation failures.
 * Version-1 input is upgraded to the legacy project-only envelope.
 */
export function validatePortableFileEnvelope(
  input: unknown,
): { ok: true; value: PortableFileEnvelope } | { ok: false; error: PortableFileRejection } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: Object.freeze({ type: 'MalformedJson', cause: 'Input is not a JSON object' }) };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.schemaVersion !== 'number' || !Number.isInteger(obj.schemaVersion)) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'schemaVersion' }) };
  }
  if (obj.schemaVersion > PORTABLE_FILE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: Object.freeze({
        type: 'UnsupportedNewerSchema',
        found: obj.schemaVersion,
        supported: PORTABLE_FILE_SCHEMA_VERSION,
      }),
    };
  }

  if (typeof obj.exportedAt !== 'string' || obj.exportedAt.length === 0) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'exportedAt' }) };
  }

  // Legacy v1: project identity only.
  if (obj.schemaVersion === LEGACY_PORTABLE_FILE_SCHEMA_VERSION) {
    const extraTopFields = Object.keys(obj).filter((k) => !KNOWN_TOP_LEVEL_FIELDS_V1.includes(k));
    if (extraTopFields.length > 0) {
      return {
        ok: false,
        error: Object.freeze({ type: 'UnknownFieldsAtCurrentVersion', fields: Object.freeze([...extraTopFields]) }),
      };
    }
    return parseV1Project(obj);
  }

  // v2/v3/v4/v5/v6/v7/v8/v9: complete project graph. v3 adds openQuestions;
  // v4 adds forecastPlan; v5 adds blockedFeatureIds + forecastScenarios;
  // v6 adds forecastPlan.planningLevel; v7 adds forecastPlan.roster + assignments;
  // v8 adds forecastScenarios staffing fields; v9 adds nodes[].effortPointsDone.
  const isV10 = obj.schemaVersion === 10;
  const isV9 = obj.schemaVersion === 9;
  const isV8 = obj.schemaVersion === 8;
  const isV7 = obj.schemaVersion === 7;
  const isV6 = obj.schemaVersion === 6;
  const isV5 = obj.schemaVersion === 5;
  const isV4 = obj.schemaVersion === 4;
  const isV3 = obj.schemaVersion === 3;
  const knownTopFields = isV10 || isV9 || isV8 || isV7 || isV6 || isV5
    ? KNOWN_TOP_LEVEL_FIELDS_V5
    : isV4
      ? KNOWN_TOP_LEVEL_FIELDS_V4
      : isV3
        ? KNOWN_TOP_LEVEL_FIELDS_V3
        : KNOWN_TOP_LEVEL_FIELDS_V2;
  const extraTopFields = Object.keys(obj).filter((k) => !knownTopFields.includes(k));
  if (extraTopFields.length > 0) {
    return {
      ok: false,
      error: Object.freeze({ type: 'UnknownFieldsAtCurrentVersion', fields: Object.freeze([...extraTopFields]) }),
    };
  }

  if (typeof obj.project !== 'object' || obj.project === null) {
    return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field: 'project' }) };
  }
  const project = obj.project as Record<string, unknown>;
  const extraProjectFields = Object.keys(project).filter((k) => !KNOWN_PROJECT_FIELDS.includes(k));
  if (extraProjectFields.length > 0) {
    return { ok: false, error: Object.freeze({ type: 'UnknownFieldsAtCurrentVersion', fields: Object.freeze([...extraProjectFields]) }) };
  }
  if (!isUuidV7(project.id)) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectId', cause: 'project.id must be a valid UUIDv7' }) };
  }
  if (typeof project.name !== 'string') {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name must be a string' }) };
  }
  const trimmedName = project.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name is empty' }) };
  }
  if (trimmedName.length > 200) {
    return { ok: false, error: Object.freeze({ type: 'InvalidProjectName', cause: 'project.name exceeds 200 characters' }) };
  }
  if (!isSafeAuthorableText(trimmedName, 'project.name')) {
    return { ok: false, error: rejectActive('project.name') };
  }

  const rawNodes = readCollection(obj, 'nodes');
  const rawPhases = readCollection(obj, 'phases');
  const rawNodeCustomFields = readCollection(obj, 'nodeCustomFields');
  const rawTypeTemplateFields = readCollection(obj, 'typeTemplateFields');
  const rawUnlockEdges = readCollection(obj, 'unlockEdges');
  const rawFindingDismissals = readCollection(obj, 'findingDismissals');
  const rawAffectedReasons = readCollection(obj, 'affectedReasons');
  const rawOpenQuestions = readCollection(obj, 'openQuestions');
  for (const [field, value] of [
    ['nodes', rawNodes], ['phases', rawPhases], ['nodeCustomFields', rawNodeCustomFields],
    ['typeTemplateFields', rawTypeTemplateFields], ['unlockEdges', rawUnlockEdges],
    ['findingDismissals', rawFindingDismissals], ['affectedReasons', rawAffectedReasons],
    ['openQuestions', rawOpenQuestions],
  ] as const) {
    if (value === null) {
      return { ok: false, error: Object.freeze({ type: 'MissingRequiredField', field }) };
    }
  }

  if ((rawNodes as readonly unknown[]).length > MAX_PORTABLE_NODES) {
    return { ok: false, error: Object.freeze({ type: 'LimitExceeded', cause: `nodes exceed ${MAX_PORTABLE_NODES}` }) };
  }
  if ((rawPhases as readonly unknown[]).length > MAX_PORTABLE_PHASES) {
    return { ok: false, error: Object.freeze({ type: 'LimitExceeded', cause: `phases exceed ${MAX_PORTABLE_PHASES}` }) };
  }
  if ((rawUnlockEdges as readonly unknown[]).length > MAX_PORTABLE_EDGES) {
    return { ok: false, error: Object.freeze({ type: 'LimitExceeded', cause: `unlockEdges exceed ${MAX_PORTABLE_EDGES}` }) };
  }
  if ((rawAffectedReasons as readonly unknown[]).length > MAX_PORTABLE_REASONS) {
    return { ok: false, error: Object.freeze({ type: 'LimitExceeded', cause: `affectedReasons exceed ${MAX_PORTABLE_REASONS}` }) };
  }

  const nodes: PortableNode[] = [];
  for (let i = 0; i < (rawNodes as readonly unknown[]).length; i += 1) {
    const result = validateNode((rawNodes as readonly unknown[])[i], i);
    if (!result.ok) return result;
    nodes.push(result.value);
  }
  const phases: PortablePhase[] = [];
  for (let i = 0; i < (rawPhases as readonly unknown[]).length; i += 1) {
    const result = validatePhase((rawPhases as readonly unknown[])[i], i);
    if (!result.ok) return result;
    phases.push(result.value);
  }
  const unlockEdges: PortableUnlockEdge[] = [];
  for (let i = 0; i < (rawUnlockEdges as readonly unknown[]).length; i += 1) {
    const result = validateUnlockEdge((rawUnlockEdges as readonly unknown[])[i], i);
    if (!result.ok) return result;
    unlockEdges.push(result.value);
  }
  const nodeCustomFields: PortableNodeCustomField[] = [];
  for (let i = 0; i < (rawNodeCustomFields as readonly unknown[]).length; i += 1) {
    const result = validateNodeCustomField((rawNodeCustomFields as readonly unknown[])[i], i);
    if (!result.ok) return result;
    nodeCustomFields.push(result.value);
  }
  const typeTemplateFields: PortableTypeTemplateField[] = [];
  for (let i = 0; i < (rawTypeTemplateFields as readonly unknown[]).length; i += 1) {
    const result = validateTypeTemplateField((rawTypeTemplateFields as readonly unknown[])[i], i);
    if (!result.ok) return result;
    typeTemplateFields.push(result.value);
  }
  const findingDismissals: PortableFindingDismissal[] = [];
  for (let i = 0; i < (rawFindingDismissals as readonly unknown[]).length; i += 1) {
    const result = validateFindingDismissal((rawFindingDismissals as readonly unknown[])[i], i);
    if (!result.ok) return result;
    findingDismissals.push(result.value);
  }
  const affectedReasons: PortableAffectedReason[] = [];
  for (let i = 0; i < (rawAffectedReasons as readonly unknown[]).length; i += 1) {
    const result = validateAffectedReason((rawAffectedReasons as readonly unknown[])[i], i);
    if (!result.ok) return result;
    affectedReasons.push(result.value);
  }
  const openQuestions: PortableNodeOpenQuestion[] = [];
  for (let i = 0; i < (rawOpenQuestions as readonly unknown[]).length; i += 1) {
    const result = validateNodeOpenQuestion((rawOpenQuestions as readonly unknown[])[i], i);
    if (!result.ok) return result;
    openQuestions.push(result.value);
  }

  let forecastPlan: PortableForecastPlan | undefined;
  if (obj.forecastPlan !== undefined && obj.forecastPlan !== null) {
    // Story 21.8 AC 6: the membership set is built from the envelope's
    // `planningLevel` (defaulting to 'Feature' for v1-v5 files), not the
    // literal 'Feature' node type — a Theme- or Component-level v6 export
    // must round-trip on its first member. The local name is `scopeNodeIds`
    // (AR-8 rule 2): these are scope members at the plan's level.
    const rawPlan = obj.forecastPlan as Record<string, unknown>;
    const level = (rawPlan.planningLevel as 'Theme' | 'Component' | 'Feature' | undefined) ?? 'Feature';
    const scopeNodeIds = new Set(
      nodes.filter((n) => n.nodeType === level).map((n) => n.id),
    );
    const nodeEffortPoints = new Map(nodes.map((n) => [n.id, n.effortPoints] as const));
    const planResult = validateForecastPlan(obj.forecastPlan, scopeNodeIds, level, nodeEffortPoints, obj.schemaVersion as number);
    if (!planResult.ok) return planResult;
    forecastPlan = planResult.value;
  }

  let forecastScenarios: PortableForecastScenario[] | undefined;
  if (obj.forecastScenarios !== undefined && obj.forecastScenarios !== null) {
    if (!Array.isArray(obj.forecastScenarios)) {
      return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: 'forecastScenarios must be an array' }) };
    }
    const parsed: PortableForecastScenario[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < obj.forecastScenarios.length; i += 1) {
      const result = validateForecastScenario(obj.forecastScenarios[i], i, project.id as string, obj.schemaVersion as number);
      if (!result.ok) return result;
      if (seenIds.has(result.value.scenarioId)) {
        return { ok: false, error: Object.freeze({ type: 'InvalidRelation', detail: `forecastScenarios: duplicate scenarioId ${result.value.scenarioId}` }) };
      }
      seenIds.add(result.value.scenarioId);
      parsed.push(result.value);
    }
    forecastScenarios = parsed;
  }

  const relations = validateRelations(obj, project.id as string);
  if (!relations.ok) return relations;

  // Size limit check (approximate — stringified length).
  const jsonStr = JSON.stringify(input);
  if (jsonStr.length > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: Object.freeze({ type: 'LimitExceeded', cause: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes` }),
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: (isV10 ? 10 : isV9 ? 9 : isV8 ? 8 : isV7 ? 7 : isV6 ? 6 : isV5 ? 5 : isV4 ? 4 : isV3 ? 3 : 2) as 10 | 9 | 8 | 7 | 6 | 5 | 4 | 3 | 2,
      exportedAt: obj.exportedAt as string,
      project: Object.freeze({ id: project.id as string, name: trimmedName }),
      phases: Object.freeze(phases),
      nodes: Object.freeze(nodes),
      nodeCustomFields: Object.freeze(nodeCustomFields),
      typeTemplateFields: Object.freeze(typeTemplateFields),
      unlockEdges: Object.freeze(unlockEdges),
      findingDismissals: Object.freeze(findingDismissals),
      affectedReasons: Object.freeze(affectedReasons),
      openQuestions: Object.freeze(openQuestions),
      ...(forecastPlan ? { forecastPlan } : {}),
      ...(forecastScenarios ? { forecastScenarios: Object.freeze(forecastScenarios) } : {}),
    }),
  };
}

// ── Deterministic serialization ─────────────────────────────────────────────

/**
 * Recursively sorts object keys at every level (arrays preserve order) so the
 * serialized form is deterministic regardless of key insertion order
 * (E13-NFR4). `exportedAt` is excluded for the semantic digest but included
 * in the published file.
 */
function stableStringify(value: unknown, excludeExportedAt: boolean): string {
  const seen = new WeakSet<object>();
  const stringify = (v: unknown): string => {
    if (v === null || typeof v !== 'object') {
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) {
      return `[${v.map(stringify).join(',')}]`;
    }
    if (seen.has(v)) {
      throw new Error('CIRCULAR_REFERENCE');
    }
    seen.add(v);
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => !(excludeExportedAt && k === 'exportedAt'))
      .sort();
    const inner = keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(',');
    seen.delete(v);
    return `{${inner}}`;
  };
  return stringify(value);
}

/**
 * Serialize a PortableFileEnvelope to a deterministic, schema-owned-ordered
 * JSON string. Keys are sorted at every object level (E13-NFR4).
 */
export function serializePortableFileEnvelope(envelope: PortableFileEnvelope): string {
  return stableStringify(envelope, false);
}

/**
 * Semantic digest helpers (E13 Task 1): the canonical serialized form of every
 * authored/durable fact, ignoring `exportedAt`, hashed with SHA-256.
 * Identical authoritative snapshots yield identical digests (E13-NFR4).
 * Uses the Web Crypto API so the digest works in the browser, the worker,
 * and Node (no `node:crypto` in client bundles).
 */
export function canonicalPortableJson(envelope: PortableFileEnvelope): string {
  return stableStringify(envelope, true);
}

export async function computeSemanticDigest(envelope: PortableFileEnvelope): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPortableJson(envelope));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse and validate a portable file from raw bytes.
 */
export function parsePortableFile(
  raw: string,
): { ok: true; value: PortableFileEnvelope } | { ok: false; error: PortableFileRejection } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: Object.freeze({
        type: 'MalformedJson',
        cause: err instanceof Error ? err.message : 'Failed to parse JSON',
      }),
    };
  }
  return validatePortableFileEnvelope(parsed);
}

/**
 * Upgrades a validated legacy v1 envelope to the complete v4 shape with empty
 * collections (E13 AC 8, Story 16.1 Task 3, Epic 18). The v1 project-only
 * meaning is preserved.
 */
export function upgradeLegacyEnvelope(v1: PortableFileEnvelopeV1): PortableFileEnvelopeV5 {
  return Object.freeze({
    schemaVersion: 5 as const,
    exportedAt: v1.exportedAt,
    project: Object.freeze({ id: v1.project.id, name: v1.project.name }),
    phases: Object.freeze([]),
    nodes: Object.freeze([]),
    nodeCustomFields: Object.freeze([]),
    typeTemplateFields: Object.freeze([]),
    unlockEdges: Object.freeze([]),
    findingDismissals: Object.freeze([]),
    affectedReasons: Object.freeze([]),
    openQuestions: Object.freeze([]),
  });
}

/**
 * Upgrades a validated v2 envelope to the v4 shape with an empty
 * openQuestions collection and no forecast plan (Story 16.1 Task 3, Epic 18).
 * The v2 complete-graph meaning is preserved; the v2 file's authored facts
 * are carried through verbatim.
 */
export function upgradeV2Envelope(v2: PortableFileEnvelopeV2): PortableFileEnvelopeV5 {
  return Object.freeze({
    schemaVersion: 5 as const,
    exportedAt: v2.exportedAt,
    project: Object.freeze({ id: v2.project.id, name: v2.project.name }),
    phases: v2.phases,
    nodes: v2.nodes,
    nodeCustomFields: v2.nodeCustomFields,
    typeTemplateFields: v2.typeTemplateFields,
    unlockEdges: v2.unlockEdges,
    findingDismissals: v2.findingDismissals,
    affectedReasons: v2.affectedReasons,
    openQuestions: Object.freeze([]),
  });
}

/**
 * Upgrades a validated v3 envelope to the v4 shape with no forecast plan
 * (Epic 18). The v3 complete-graph meaning is preserved; the v3 file's
 * authored facts are carried through verbatim.
 */
export function upgradeV3Envelope(v3: PortableFileEnvelopeV3): PortableFileEnvelopeV5 {
  return Object.freeze({
    schemaVersion: 5 as const,
    exportedAt: v3.exportedAt,
    project: Object.freeze({ id: v3.project.id, name: v3.project.name }),
    phases: v3.phases,
    nodes: v3.nodes,
    nodeCustomFields: v3.nodeCustomFields,
    typeTemplateFields: v3.typeTemplateFields,
    unlockEdges: v3.unlockEdges,
    findingDismissals: v3.findingDismissals,
    affectedReasons: v3.affectedReasons,
    openQuestions: v3.openQuestions,
  });
}

/**
 * Upgrades a validated v6 envelope to the v7 shape (Epic 22, Story 22.8).
 */
export function upgradeV6Envelope(v6: PortableFileEnvelopeV6): PortableFileEnvelopeV7 {
  return Object.freeze({
    ...v6,
    schemaVersion: 7 as const,
  });
}


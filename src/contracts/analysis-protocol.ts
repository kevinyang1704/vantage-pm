/**
 * Analysis Worker & Coherence Protocol (Epic 4, Epic 7, Story 4.1, Story 7.6, FR-31, FR-50).
 *
 * Defines the revision-tagged wire protocol between the Main Thread and
 * the dedicated Analysis Web Worker.
 */

import type { Node } from '../domain/tree/node.entity';
import type { Phase } from '../domain/phase/phase.entity';
import type { UnlockEdge } from '../domain/edge/unlock-edge.entity';
import type { ChangeSet } from './change-set';
import type { ForecastPlan } from '../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../domain/forecast/forecast-result';

export type CoherenceFindingKind =
  | 'OrphanedFeature'
  | 'PhaseSequencingConflict'
  | 'DateSequencingConflict'
  | 'UnlockCycle'
  | 'StrategicImbalance'
  | 'ExplicitOverrideBoundaryViolation';

export interface BaseFinding {
  readonly id: string; // unique deterministic finding ID (e.g. SHA-256)
  readonly kind: CoherenceFindingKind;
  readonly projectId: string;
  readonly targetNodeId: string;
  readonly title: string;
  readonly narrative: string;
  readonly fingerprint: string; // SHA-256 material-input fingerprint
  readonly actionableEditPrompt?: string;
}

export interface OrphanedFeatureFinding extends BaseFinding {
  readonly kind: 'OrphanedFeature';
  readonly missingContainment: boolean;
  readonly missingUnlockEdges: boolean;
}

export interface PhaseSequencingConflictFinding extends BaseFinding {
  readonly kind: 'PhaseSequencingConflict';
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourcePhaseId: string;
  readonly sourcePhaseName: string;
  readonly targetPhaseId: string;
  readonly targetPhaseName: string;
}

export interface DateSequencingConflictFinding extends BaseFinding {
  readonly kind: 'DateSequencingConflict';
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourceEndDate: string;
  readonly targetStartDate: string;
  readonly overlapDays: number;
}

export interface UnlockCycleFinding extends BaseFinding {
  readonly kind: 'UnlockCycle';
  readonly cycleId: string;
  readonly pathNodeIds: readonly string[];
  readonly pathNodeTitles: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface StrategicImbalanceFinding extends BaseFinding {
  readonly kind: 'StrategicImbalance';
  readonly themeId: string;
  readonly themeName: string;
  readonly strategicWeightShare: number; // 0..100 %
  readonly effortShare: number; // 0..100 %
  readonly spanShare: number; // 0..100 %
  readonly divergencePercentage: number; // e.g. 25 (%)
  readonly coveragePercentage: number; // 0..100 %
  readonly missingDataNotes: readonly string[];
}

export type OverrideViolationBoundary = 'before_start' | 'after_end' | 'both';

export interface ExplicitOverrideBoundaryViolationFinding extends BaseFinding {
  readonly kind: 'ExplicitOverrideBoundaryViolation';
  readonly ancestorNodeId: string;
  readonly ancestorTitle: string;
  readonly ancestorStartDate: string;
  readonly ancestorEndDate: string;
  readonly descendantNodeId: string;
  readonly descendantTitle: string;
  readonly descendantStartDate: string;
  readonly descendantEndDate: string;
  readonly violatedBoundary: OverrideViolationBoundary;
}

export type CoherenceFinding =
  | OrphanedFeatureFinding
  | PhaseSequencingConflictFinding
  | DateSequencingConflictFinding
  | UnlockCycleFinding
  | StrategicImbalanceFinding
  | ExplicitOverrideBoundaryViolationFinding;

export interface FindingDismissal {
  readonly projectId: string;
  readonly findingId: string;
  readonly findingKind: CoherenceFindingKind;
  readonly targetId: string;
  readonly fingerprint: string;
  readonly dismissedAt: string;
}

export interface AffectedReason {
  readonly id: string;
  readonly projectId: string;
  readonly affectedNodeId: string;
  readonly causalNodeId: string;
  readonly causalNodeTitle: string;
  readonly deltaDays: number;
  readonly causalDateSummary: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
}

/** Full Snapshot request to initialize worker */
export interface AnalysisSnapshotRequest {
  readonly type: 'AnalysisSnapshot';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly nodes: readonly Node[];
  readonly phases: readonly Phase[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly dismissals: readonly FindingDismissal[];
  /** Optional project-owned forecast plan (Epic 18, Story 18.4). */
  readonly forecastPlan?: ForecastPlan;
  /**
   * Set when the persisted forecast plan could not be read (corrupt cell).
   * The plan is omitted rather than silently treated as empty (Story 18.2).
   */
  readonly forecastPlanError?: string;
  /**
   * Saved historical trade-off scenarios (Story 20.4 / 20.5). Carried with
   * the snapshot for the Compare experience; the analysis engine ignores
   * them — they are evaluated purely, never through the coherence pass.
   */
  readonly forecastScenarios?: readonly import('../domain/forecast/scenario').PersistedForecastScenario[];
}

/** Delta update request for sequential changes */
export interface AnalysisDeltaRequest {
  readonly type: 'AnalysisDelta';
  readonly projectId: string;
  readonly baseRevision: number;
  readonly targetRevision: number;
  readonly changeSet: ChangeSet;
}

/** Worker response containing computed findings */
export interface AnalysisResultResponse {
  readonly type: 'AnalysisResult';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly findings: readonly CoherenceFinding[];
  readonly themeImbalances: readonly StrategicImbalanceFinding[];
  readonly computedDurationMs: number;
}

/**
 * Forecast request (Epic 18, Story 18.4). Carries the request token and the
 * policy version so only the response matching the current project, revision,
 * policy, and token may become current (AC 18.4-2). The per-request token is a
 * fresh UUIDv7, so it alone orders responses; project + revision + policy are
 * matched as defence in depth.
 */
export interface ForecastRequest {
  readonly type: 'ForecastRequest';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly policyVersion: string;
  readonly requestToken: string;
  /** Expected material identity when the caller already has an acknowledged projection. */
  readonly materialFingerprint?: string;
  /** Event indexes whose member-completion detail is currently visible. */
  readonly visibleAllocationEventIndexes?: readonly number[];
  /**
   * Story 26.6 (FC-NFR2): the injected local date the forecast is evaluated as
   * of. Part of the evaluation identity — a new date re-evaluates. Absent
   * preserves the pre-26.6 fixed-start behaviour.
   */
  readonly today?: string | null;
}

/**
 * Forecast result response (Epic 18, Story 18.4). `result` is null when the
 * background computation could not produce an answer — `error` then carries a
 * recoverable "forecast unavailable" condition (AC 18.4-6): the authoring
 * thread is never blocked and the client surfaces a retryable state rather
 * than a stale or misleading forecast.
 */
export interface ForecastResultResponse {
  readonly type: 'ForecastResult';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly policyVersion: string;
  readonly requestToken: string;
  /** Copied from the computed result so acceptance need not trust nested DTO shape. */
  readonly materialFingerprint?: string;
  /** Story 26.6: the as-of date this result was evaluated for. */
  readonly today?: string | null;
  readonly result: ForecastResult | null;
  readonly error?: Readonly<{ code: string; message: string }>;
  /**
   * Typed change attribution against the previously-settled forecast in this
   * session (Story 20.2, AD-23). Absent when there is no retained baseline
   * (first computation, or after a worker restart) — the client then shows
   * "historical attribution unavailable" rather than inventing causes.
   * These are projection metadata, never part of the canonical `result` or
   * its fingerprint.
   */
  readonly comparison?: import('../domain/forecast/compare.policy').ForecastComparison;
  /** False when no retained baseline exists to attribute against (AC 20.2-6). */
  readonly historicalAttributionAvailable: boolean;
}

/**
 * Evaluate one saved scenario, or an open draft, from its captured baseline
 * and patch (Stories 20.5, 23.7). `scenarioId` is the saved scenario's ID or
 * the draft's capture identity. The worker echoes every identity field; the
 * client accepts a reply only when project, scenario/draft, captured
 * revision, policy, fingerprint and request token all match its latest
 * request for that identity (AC 23.7-5).
 */
export interface ScenarioEvaluationRequest {
  readonly type: 'ScenarioEvaluationRequest';
  readonly projectId: string;
  readonly scenarioId: string;
  readonly requestToken: string;
  readonly scenarioFingerprint: string;
  /** The captured baseline revision (= `scenario.baselineRevision`). */
  readonly baselineRevision: number;
  /** The captured policy (= `scenario.policyVersion`). */
  readonly policyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
  readonly scenario: import('../domain/forecast/scenario').PersistedForecastScenario;
  /**
   * Optional per-request override of the client's default evaluation timeout.
   * A legitimately long lab-scale evaluation (5,000 items / 10,000
   * assignments) can raise this without changing the default (Story 25.1
   * AC 25.1-3). Ignored by the worker; consumed by the client only.
   */
  readonly timeoutMs?: number;
  /** Story 26.6 (AC 26.6-5): the as-of date the scenario evaluates with. */
  readonly today?: string | null;
}

export interface ScenarioEvaluationResponse {
  readonly type: 'ScenarioEvaluationResult';
  readonly projectId: string;
  readonly scenarioId: string;
  readonly requestToken: string;
  readonly scenarioFingerprint: string;
  readonly baselineRevision: number;
  readonly policyVersion: import('../domain/forecast/forecast-plan.entity').ForecastPolicyVersion;
  /** Null only when evaluation failed; `error` then says why. */
  readonly evaluation: import('../domain/forecast/scenario-evaluate').ScenarioEvaluation | null;
  readonly error?: Readonly<{ code: string; message: string }>;
}

/** Worker resync required response on revision gaps */
export interface AnalysisResyncRequiredResponse {
  readonly type: 'AnalysisResyncRequired';
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly receivedRevision: number;
}

export type AnalysisWorkerRequest = AnalysisSnapshotRequest | AnalysisDeltaRequest | ForecastRequest | ScenarioEvaluationRequest;
export type AnalysisWorkerResponse = AnalysisResultResponse | ForecastResultResponse | ScenarioEvaluationResponse | AnalysisResyncRequiredResponse;

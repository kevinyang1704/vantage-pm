/**
 * In-Memory Analysis Engine (Epic 4, Story 4.1).
 *
 * Maintains revision-tracked in-memory model of nodes, phases, unlock edges,
 * and dismissals, computing pure coherence and strategic findings off the main thread.
 */

import type { Node } from '../../domain/tree/node.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type {
  AnalysisSnapshotRequest,
  AnalysisDeltaRequest,
  AnalysisResultResponse,
  AnalysisResyncRequiredResponse,
  FindingDismissal,
  CoherenceFinding,
  StrategicImbalanceFinding,
  ForecastRequest,
  ForecastResultResponse,
} from '../../contracts/analysis-protocol';
import { detectOrphanedFeatures } from '../../domain/analysis/orphan-policy';
import {
  detectPhaseSequencingConflicts,
  detectDateSequencingConflicts,
} from '../../domain/analysis/sequencing-conflict.policy';
import { detectUnlockCycles } from '../../domain/analysis/cycle-policy';
import { computeStrategicEffortBalance } from '../../domain/analysis/strategic-balance.policy';
import { detectOverrideBoundaryViolations } from '../../domain/analysis/override-boundary.policy';
import { filterActiveFindings } from '../../domain/analysis/dismissal-filter.policy';
import type { ForecastPlan } from '../../domain/forecast/forecast-plan.entity';
import { createForecastPlan, createForecastConfiguration } from '../../domain/forecast/forecast-plan.entity';
import { normalizeForecastInputs } from '../../domain/forecast/forecast-normalization';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import { compareForecasts } from '../../domain/forecast/compare.policy';
import type { ForecastInputs, ForecastResult } from '../../domain/forecast/forecast-result';

/**
 * Scope issues that require the node graph and so cannot be derived from the
 * immutable ForecastInputs alone — normalization computes them, the calculator
 * receives them (Story 18.1 AC3/AC4, AR-4).
 */
const GRAPH_SCOPE_ISSUE_CODES: ReadonlySet<string> = new Set([
  'FOREIGN_FEATURE',
  'NOT_A_FEATURE',
  'OVERLAPPING_SCOPE',
]);

export class AnalysisEngine {
  #projectId: string = '';
  #projectRevision: number = 0;
  #nodes: Map<string, Node> = new Map();
  #phases: Map<string, Phase> = new Map();
  #unlockEdges: Map<string, UnlockEdge> = new Map();
  #dismissals: Map<string, FindingDismissal> = new Map();
  #forecastPlan: ForecastPlan | null = null;
  /**
   * The last forecast this engine settled for the current project — the
   * baseline for change attribution (Story 20.2). Cleared on `initialize`
   * (a fresh snapshot is a fresh session with no retained history).
   */
  #lastForecast: { projectId: string; inputs: ForecastInputs; result: ForecastResult } | null = null;
  #forecastChangeChronology: import('../../domain/forecast/compare.policy').ForecastCauseField[] = [];

  get projectId(): string {
    return this.#projectId;
  }

  get projectRevision(): number {
    return this.#projectRevision;
  }

  initialize(snapshot: AnalysisSnapshotRequest): AnalysisResultResponse {
    const startTime = performance.now();
    // A re-bootstrap of the *same* project (the app re-snapshots on every
    // forecast refresh) must not wipe the change-attribution baseline —
    // otherwise "What changed" could never populate in the running app. Only
    // a genuine project switch, or a fresh engine after an app restart,
    // starts with no retained history (Story 20.2, AC 20.2-6).
    const sameProject = this.#lastForecast?.projectId === snapshot.projectId;
    this.#projectId = snapshot.projectId;
    this.#projectRevision = snapshot.projectRevision;

    this.#nodes.clear();
    for (const n of snapshot.nodes) this.#nodes.set(n.id, n);

    this.#phases.clear();
    for (const p of snapshot.phases) this.#phases.set(p.id, p);

    this.#unlockEdges.clear();
    for (const e of snapshot.unlockEdges) this.#unlockEdges.set(e.id, e);

    this.#dismissals.clear();
    for (const d of snapshot.dismissals) {
      this.#dismissals.set(`${d.findingKind}:${d.targetId}:${d.fingerprint}`, d);
    }

    this.#forecastPlan = snapshot.forecastPlan ?? null;
    if (!sameProject) this.#lastForecast = null;

    const results = this.#compute();
    const duration = performance.now() - startTime;

    return Object.freeze({
      type: 'AnalysisResult',
      projectId: this.#projectId,
      projectRevision: this.#projectRevision,
      findings: results.findings,
      themeImbalances: results.themeImbalances,
      computedDurationMs: Math.round(duration),
    });
  }

  /**
   * Compute the current forecast from the in-memory snapshot (Story 18.4).
   * Pure projection: never persisted, never written to authored fields.
   */
  async computeForecast(request: ForecastRequest): Promise<ForecastResultResponse> {
    const plan = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
    const normalized = normalizeForecastInputs(
      {
        projectId: this.#projectId,
        projectRevision: this.#projectRevision,
        nodes: Array.from(this.#nodes.values()),
      },
      plan,
      request.today ? { today: request.today, nodes: Array.from(this.#nodes.values()) } : null,
    );
    // Graph-level scope issues (foreign / non-Feature / overlap) cannot be
    // re-derived from the immutable inputs — hand them to the calculator so
    // the result envelope carries them instead of mislabelling a deleted or
    // retyped member as merely un-estimated (Story 18.1 AC3/AC4, AR-4).
    const graphIssues = normalized.issues.filter((i) => GRAPH_SCOPE_ISSUE_CODES.has(i.code));
    const result = await calculateForecast(normalized.inputs, graphIssues, {
      visibleEventIndexes: request.visibleAllocationEventIndexes,
    });

    // Change attribution against the previously-settled forecast (Story 20.2,
    // AD-23). Only when the baseline belongs to the same project.
    const baseline =
      this.#lastForecast && this.#lastForecast.projectId === this.#projectId ? this.#lastForecast : null;
    const comparison = baseline
      ? compareForecasts(baseline.inputs, normalized.inputs, baseline.result, result, this.#forecastChangeChronology)
      : null;
    this.#lastForecast = { projectId: this.#projectId, inputs: normalized.inputs, result };
    this.#forecastChangeChronology = [];

    return Object.freeze({
      type: 'ForecastResult',
      projectId: this.#projectId,
      projectRevision: this.#projectRevision,
      policyVersion: normalized.inputs.policyVersion,
      requestToken: request.requestToken,
      materialFingerprint: result.materialFingerprint,
      today: request.today ?? null,
      result,
      historicalAttributionAvailable: comparison !== null,
      ...(comparison ? { comparison } : {}),
    });
  }

  async evaluateScenario(request: import('../../contracts/analysis-protocol').ScenarioEvaluationRequest): Promise<import('../../contracts/analysis-protocol').ScenarioEvaluationResponse> {
    const [{ evaluateScenario }, { baselineFromPersisted }] = await Promise.all([
      import('../../domain/forecast/scenario-evaluate'),
      import('../../domain/forecast/scenario'),
    ]);
    const identity = {
      type: 'ScenarioEvaluationResult',
      projectId: request.projectId,
      scenarioId: request.scenarioId,
      requestToken: request.requestToken,
      scenarioFingerprint: request.scenarioFingerprint,
      baselineRevision: request.baselineRevision,
      policyVersion: request.policyVersion,
    } as const;
    try {
      return Object.freeze({
        ...identity,
        evaluation: await evaluateScenario(baselineFromPersisted(request.scenario), request.scenario.patch, request.today ?? null),
      });
    } catch (err) {
      // A failed evaluation is a reply, never silence: the editor keeps the
      // draft and offers a retry (AC 23.7-6).
      return Object.freeze({
        ...identity,
        evaluation: null,
        error: Object.freeze({
          code: 'SCENARIO_EVALUATION_FAILED',
          message: err instanceof Error ? err.message : 'Scenario evaluation failed.',
        }),
      });
    }
  }

  applyDelta(delta: AnalysisDeltaRequest): AnalysisResultResponse | AnalysisResyncRequiredResponse {
    if (delta.projectId !== this.#projectId || delta.baseRevision !== this.#projectRevision) {
      return Object.freeze({
        type: 'AnalysisResyncRequired',
        projectId: delta.projectId,
        expectedRevision: this.#projectRevision,
        receivedRevision: delta.baseRevision,
      });
    }

    const startTime = performance.now();
    this.#projectRevision = delta.targetRevision;

    const recordCause = (field: import('../../domain/forecast/compare.policy').ForecastCauseField): void => {
      if (!this.#forecastChangeChronology.includes(field)) this.#forecastChangeChronology.push(field);
    };
    for (const change of delta.changeSet.changes) {
      if (change.type === 'NodeEffortSet') recordCause('estimate');
      else if (change.type === 'ForecastScopeSet') recordCause('scope');
      else if (change.type === 'ForecastOrderSet') recordCause('order');
      else if (change.type === 'ForecastParallelGroupsSet') recordCause('parallel');
      else if (change.type === 'ForecastSequenceSet') { recordCause('order'); recordCause('parallel'); }
      else if (change.type === 'ForecastBlockerSet') recordCause('constraints');
      else if (change.type === 'ForecastConfigurationSet') { recordCause('capacity'); recordCause('start'); recordCause('cadence'); }
    }

    // Apply changeSet events in-memory
    for (const change of delta.changeSet.changes) {
      switch (change.type) {
        case 'NodeCreated': {
          this.#nodes.set(
            change.nodeId,
            Object.freeze({
              id: change.nodeId,
              projectId: this.#projectId,
              parentId: change.parentId,
              title: change.title,
              bodyText: null,
              position: BigInt(change.position),
              nodeType: null,
              startDate: null,
              endDate: null,
              durationDays: null,
              scheduleSourceMode: null,
              completed: false,
              effortPoints: null,
              effortPointsDone: null,
              strategicWeight: null,
              phaseId: null,
              deliveryStatus: 'not_started',
            }),
          );
          break;
        }
        case 'NodeTitleSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, title: change.title }));
          }
          break;
        }
        case 'NodeBodyTextSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, bodyText: change.bodyText }));
          }
          break;
        }
        case 'NodeMoved': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(
              change.nodeId,
              Object.freeze({
                ...existing,
                parentId: change.parentId,
                position: BigInt(change.position),
              }),
            );
          }
          break;
        }
        case 'NodeTypeSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, nodeType: change.nodeType }));
          }
          break;
        }
        case 'NodeScheduleSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(
              change.nodeId,
              Object.freeze({
                ...existing,
                startDate: change.startDate,
                endDate: change.endDate,
                durationDays: change.durationDays,
                scheduleSourceMode: change.sourceMode,
              }),
            );
          }
          break;
        }
        case 'NodeCompletedToggled': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, completed: change.completed }));
          }
          break;
        }
        case 'NodeEffortSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, effortPoints: change.effortPoints }));
          }
          break;
        }
        case 'ThemeWeightSet': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(
              change.nodeId,
              Object.freeze({ ...existing, strategicWeight: change.strategicWeight }),
            );
          }
          break;
        }
        case 'NodePhaseAssigned': {
          const existing = this.#nodes.get(change.nodeId);
          if (existing) {
            this.#nodes.set(change.nodeId, Object.freeze({ ...existing, phaseId: change.phaseId }));
          }
          break;
        }
        case 'PhaseCreated': {
          this.#phases.set(
            change.phaseId,
            Object.freeze({
              id: change.phaseId,
              projectId: this.#projectId,
              name: change.name,
              position: BigInt(change.position),
            }),
          );
          break;
        }
        case 'PhaseRenamed': {
          const existing = this.#phases.get(change.phaseId);
          if (existing) {
            this.#phases.set(change.phaseId, Object.freeze({ ...existing, name: change.name }));
          }
          break;
        }
        case 'PhasesReordered': {
          for (const p of change.phases) {
            const existing = this.#phases.get(p.phaseId);
            if (existing) {
              this.#phases.set(p.phaseId, Object.freeze({ ...existing, position: BigInt(p.position) }));
            }
          }
          break;
        }
        case 'PhaseDeleted': {
          this.#phases.delete(change.phaseId);
          for (const [nodeId, targetPhaseId] of Object.entries(change.reassignments)) {
            const existing = this.#nodes.get(nodeId);
            if (existing) {
              this.#nodes.set(nodeId, Object.freeze({ ...existing, phaseId: targetPhaseId }));
            }
          }
          break;
        }
        case 'UnlockEdgeCreated': {
          this.#unlockEdges.set(
            change.edgeId,
            Object.freeze({
              id: change.edgeId,
              projectId: this.#projectId,
              sourceNodeId: change.sourceNodeId,
              targetNodeId: change.targetNodeId,
            }),
          );
          break;
        }
        case 'UnlockEdgeDeleted': {
          this.#unlockEdges.delete(change.edgeId);
          break;
        }
        case 'SubtreeDeleted': {
          for (const deletedNode of change.nodes) {
            this.#nodes.delete(deletedNode.nodeId);
            // Delete edges attached to deleted nodes
            for (const [edgeId, edge] of this.#unlockEdges.entries()) {
              if (edge.sourceNodeId === deletedNode.nodeId || edge.targetNodeId === deletedNode.nodeId) {
                this.#unlockEdges.delete(edgeId);
              }
            }
          }
          break;
        }
        case 'FindingDismissed': {
          const dismissal: FindingDismissal = {
            projectId: this.#projectId,
            findingId: change.findingId,
            findingKind: change.findingKind,
            targetId: change.targetId,
            fingerprint: change.fingerprint,
            dismissedAt: change.dismissedAt,
          };
          this.#dismissals.set(
            `${change.findingKind}:${change.targetId}:${change.fingerprint}`,
            dismissal,
          );
          break;
        }
        case 'FindingUndismissed': {
          this.#dismissals.delete(
            `${change.findingKind}:${change.targetId}:${change.fingerprint}`,
          );
          break;
        }
        case 'ForecastPlanningLevelSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            planningLevel: change.planningLevel,
            selectedFeatureIds: change.selectedFeatureIds,
            parallelGroups: change.parallelGroups,
            blockedFeatureIds: change.blockedFeatureIds,
            ...(change.assignments ? { assignments: change.assignments } : {}),
          });
          break;
        }
        case 'ForecastPlanCreated': {
          this.#forecastPlan = createForecastPlan({ projectId: this.#projectId });
          break;
        }
        case 'ForecastPlanRemoved': {
          // Story 21.13 D5: undo of atomic plan creation deletes the row —
          // the in-memory plan must clear so the level step state is exact.
          this.#forecastPlan = null;
          break;
        }
        case 'ForecastConfigurationSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            configuration: createForecastConfiguration({
              pointsPerSprint: change.pointsPerSprint,
              sprintLengthDays: change.sprintLengthDays,
              startSprintOrdinal: change.startSprintOrdinal,
              startDate: change.startDate,
            }),
          });
          break;
        }
        case 'ForecastScopeSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            selectedFeatureIds: change.selectedFeatureIds,
            parallelGroups: change.parallelGroups,
            blockedFeatureIds: change.blockedFeatureIds,
            ...(change.assignments ? { assignments: change.assignments } : {}),
          });
          break;
        }
        case 'ForecastBlockerSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          const nextBlocked = change.blocked
            ? [...current.blockedFeatureIds, change.featureId]
            : current.blockedFeatureIds.filter((id) => id !== change.featureId);
          this.#forecastPlan = createForecastPlan({
            ...current,
            blockedFeatureIds: nextBlocked,
          });
          break;
        }
        case 'ForecastOrderSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            selectedFeatureIds: change.selectedFeatureIds,
          });
          break;
        }
        case 'ForecastSequenceSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            selectedFeatureIds: change.selectedFeatureIds,
            parallelGroups: change.parallelGroups,
          });
          break;
        }
        case 'ForecastParallelGroupsSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            parallelGroups: change.parallelGroups,
          });
          break;
        }
        case 'ForecastPersonAdded': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            roster: [...current.roster, change.person],
          });
          break;
        }
        case 'ForecastPersonUpdated': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            roster: current.roster.map((p) =>
              p.id === change.personId ? Object.freeze({ ...p, name: change.name, weightUnits: change.weightUnits }) : p,
            ),
          });
          break;
        }
        case 'ForecastPersonRemoved': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          const nextAssignments: Record<string, readonly string[]> = {};
          for (const [k, pids] of Object.entries(current.assignments)) {
            const filtered = pids.filter((id) => id !== change.person.id);
            if (filtered.length > 0) {
              nextAssignments[k] = filtered;
            }
          }
          this.#forecastPlan = createForecastPlan({
            ...current,
            roster: current.roster.filter((p) => p.id !== change.person.id),
            assignments: nextAssignments,
          });
          break;
        }
        case 'ForecastPersonRestored': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            roster: [...current.roster, change.person],
            assignments: change.assignments ?? current.assignments,
          });
          break;
        }
        case 'ForecastAssignmentsSet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          const nextAssignments = { ...current.assignments };
          if (change.personIds.length > 0) {
            nextAssignments[change.featureId] = change.personIds;
          } else {
            delete nextAssignments[change.featureId];
          }
          this.#forecastPlan = createForecastPlan({
            ...current,
            assignments: nextAssignments,
          });
          break;
        }
        case 'ForecastPolicySet': {
          const current = this.#forecastPlan ?? createForecastPlan({ projectId: this.#projectId });
          this.#forecastPlan = createForecastPlan({
            ...current,
            policyVersion: change.policyVersion,
          });
          break;
        }
      }
    }

    const results = this.#compute();
    const duration = performance.now() - startTime;

    return Object.freeze({
      type: 'AnalysisResult',
      projectId: this.#projectId,
      projectRevision: this.#projectRevision,
      findings: results.findings,
      themeImbalances: results.themeImbalances,
      computedDurationMs: Math.round(duration),
    });
  }

  #compute(): {
    findings: readonly CoherenceFinding[];
    themeImbalances: readonly StrategicImbalanceFinding[];
  } {
    const nodes = Array.from(this.#nodes.values());
    const phases = Array.from(this.#phases.values());
    const edges = Array.from(this.#unlockEdges.values());
    const dismissals = Array.from(this.#dismissals.values());

    const orphans = detectOrphanedFeatures(nodes, edges);
    const phaseConflicts = detectPhaseSequencingConflicts(nodes, phases, edges);
    const dateConflicts = detectDateSequencingConflicts(nodes, edges);
    const cycles = detectUnlockCycles(nodes, edges);
    const overrideViolations = detectOverrideBoundaryViolations(nodes);
    const imbalances = computeStrategicEffortBalance(nodes);

    const allTreeFindings: CoherenceFinding[] = [
      ...orphans,
      ...phaseConflicts,
      ...dateConflicts,
      ...cycles,
      ...overrideViolations,
    ];

    const activeTreeFindings = filterActiveFindings(allTreeFindings, dismissals);
    const activeImbalances = filterActiveFindings(imbalances, dismissals) as readonly StrategicImbalanceFinding[];

    return {
      findings: activeTreeFindings,
      themeImbalances: activeImbalances,
    };
  }
}

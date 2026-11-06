/**
 * UndoEngine (Story 2.6 Task 4, AD-4).
 *
 * Coordinates undo/redo stack transitions and dispatches durable inverse/forward
 * commands through CommandQueueOrchestrator.
 */

import { PROTOCOL_VERSION, createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ProductCommand, ProductCommandResult } from '../../contracts/repository-commands';
import type { ChangeSet } from '../../contracts/change-set';
import {
  createInitialUndoStackState,
  pushAppliedCommand,
  pushAppliedGroup,
  popUndoEntry,
  popRedoEntry,
  canUndoEntry,
  type UndoStackState,
  type UndoEntry,
} from '../../domain/undo/undo-stack.policy';
import type { CommandQueueOrchestrator } from '../command-queue/command-queue-orchestrator';
import type { InverseCommandDescriptor } from '../../domain/undo/inverse-command.policy';

export class UndoEngine {
  private stacksByProject = new Map<string, UndoStackState>();
  /** Open composite group buffer (Story 27.2); null when no group is open. */
  private openGroup: { projectId: string; entries: { command: ProductCommand; changeSet: ChangeSet }[] } | null = null;
  /** Confirmed commands from OTHER actors, keyed by project (Story 27.3, AC 27.3-6). */
  private otherActorChangesByProject = new Map<string, { actorId: string; targetIds: string[]; seq: number }[]>();
  /** Monotonic order shared by local entries and remote changes (R9 "since"). */
  #seq = 0;
  /** When each undo entry was recorded, keyed by its forward command id. */
  #entrySeq = new Map<string, number>();

  #markTop(projectId: string): void {
    const top = this.#stackFor(projectId).undoEntries.at(-1);
    if (top) this.#entrySeq.set(top.forwardCommand.commandId, ++this.#seq);
  }

  /**
   * Forget a project's undo/redo history and recorded teammate changes. Used
   * when an authoritative snapshot replaced local state, after which local
   * inverses are no longer safe to replay (R9).
   */
  clearProject(projectId: string): void {
    this.stacksByProject.delete(projectId);
    this.otherActorChangesByProject.delete(projectId);
    if (this.openGroup?.projectId === projectId) this.openGroup = null;
  }

  constructor(private readonly orchestrator: CommandQueueOrchestrator) {}

  #stackFor(projectId: string): UndoStackState {
    let stack = this.stacksByProject.get(projectId);
    if (!stack) {
      stack = createInitialUndoStackState();
      this.stacksByProject.set(projectId, stack);
    }
    return stack;
  }

  getState(projectId: string): UndoStackState {
    return this.#stackFor(projectId);
  }

  canUndo(projectId: string): boolean {
    return this.#stackFor(projectId).undoEntries.length > 0;
  }

  canRedo(projectId: string): boolean {
    return this.#stackFor(projectId).redoEntries.length > 0;
  }

  /**
   * Begin a composite gesture (Story 27.2, AC 27.2-3). Every command recorded
   * until `endGroup()` becomes ONE undoable entry. Nested/re-entrant calls keep
   * the first group open until the matching `endGroup()`.
   */
  beginGroup(projectId: string): void {
    if (this.openGroup) return;
    this.openGroup = { projectId, entries: [] };
  }

  /** Close the open group, pushing its steps as one undo entry. */
  endGroup(): void {
    const group = this.openGroup;
    this.openGroup = null;
    if (!group || group.entries.length === 0) return;
    const actorId = group.entries[group.entries.length - 1].command.actorId;
    this.stacksByProject.set(
      group.projectId,
      pushAppliedGroup(this.#stackFor(group.projectId), group.entries, actorId),
    );
    this.#markTop(group.projectId);
  }

  /**
   * Record a confirmed command from another actor (Story 27.3, AC 27.3-6). A
   * later undo of an overlapping target is refused with ChangedByOtherActor.
   */
  recordOtherActorChange(projectId: string, actorId: string, targetIds: readonly string[]): void {
    const list = this.otherActorChangesByProject.get(projectId) ?? [];
    list.push({ actorId, targetIds: [...targetIds], seq: ++this.#seq });
    // Bounded: older teammate changes than every remaining entry are irrelevant.
    if (list.length > 2000) list.splice(0, list.length - 2000);
    this.otherActorChangesByProject.set(projectId, list);
  }

  recordAppliedCommand(command: ProductCommand, changeSet: ChangeSet): void {
    const projectId = command.projectId;
    if (this.openGroup && this.openGroup.projectId === projectId) {
      this.openGroup.entries.push({ command, changeSet });
      return;
    }
    this.stacksByProject.set(
      projectId,
      pushAppliedCommand(this.#stackFor(projectId), command, changeSet, command.actorId),
    );
    this.#markTop(projectId);
  }

  async undo(projectId: string, currentRevision: number): Promise<ProductCommandResult | null> {
    const stack = this.#stackFor(projectId);
    const top = stack.undoEntries[stack.undoEntries.length - 1];
    if (!top) return null;

    // Story 27.3 AC 27.3-6: only the actor's own edits are eligible, and only
    // if no other actor changed the same target since. Check BEFORE popping so
    // a refused undo leaves the stack intact. A local project has no recorded
    // other-actor changes, so this always passes.
    // Only teammate changes confirmed AFTER this entry was recorded conflict;
    // an entry of unknown age is checked against all of them (conservative).
    const recordedAt = this.#entrySeq.get(top.forwardCommand.commandId) ?? 0;
    const eligibility = canUndoEntry(
      top,
      top.forwardCommand.actorId,
      (this.otherActorChangesByProject.get(projectId) ?? []).filter((change) => change.seq > recordedAt),
    );
    if (!eligibility.ok) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: top.forwardCommand.commandId,
        code: 'CHANGED_BY_OTHER_ACTOR',
        nodeId: eligibility.conflict.targetId,
      });
    }

    const { nextState, entry } = popUndoEntry(stack);
    if (!entry) return null;

    if (entry.forwardCommand.projectId !== projectId) {
      throw new Error(
        `UNDO_PROJECT_MISMATCH: undo entry for project ${entry.forwardCommand.projectId} popped while ${projectId} is active`,
      );
    }

    if (entry.steps.length > 1) {
      const commands = [...entry.steps].reverse().map((step, index) => this.#inverseFor(
        projectId, step.inverseDescriptor, currentRevision + index, step.actorId,
      ));
      const outcomes = await this.orchestrator.dispatchBatch(commands);
      const last = outcomes[outcomes.length - 1]?.result ?? null;
      if (outcomes.length === commands.length && outcomes.every(outcome => outcome.result.type === 'ProductCommandApplied')) {
        this.stacksByProject.set(projectId, nextState);
      }
      return last;
    }

    // Reverse every step, newest first; each inverse uses the current revision
    // and is attributed to the SAME actor as the forward step, so a shared
    // project's per-user undo stays own-actor (Story 27.3, R9).
    let revision = currentRevision;
    let last: ProductCommandResult | null = null;
    for (let i = entry.steps.length - 1; i >= 0; i -= 1) {
      const stepActor = entry.steps[i].actorId;
      const inverseCommand = this.#inverseFor(
        projectId,
        entry.steps[i].inverseDescriptor,
        revision,
        stepActor,
      );
      const outcome = await this.orchestrator.dispatchCommand(inverseCommand);
      last = outcome.type === 'CommandDispatched' ? outcome.result : null;
      if (!outcome || outcome.type !== 'CommandDispatched' || outcome.result.type !== 'ProductCommandApplied') {
        return last;
      }
      revision = outcome.result.targetRevision;
    }

    this.stacksByProject.set(projectId, nextState);
    return last;
  }

  async redo(projectId: string, currentRevision: number): Promise<ProductCommandResult | null> {
    const { nextState, entry } = popRedoEntry(this.#stackFor(projectId));
    if (!entry) return null;

    if (entry.forwardCommand.projectId !== projectId) {
      throw new Error(
        `REDO_PROJECT_MISMATCH: redo entry for project ${entry.forwardCommand.projectId} popped while ${projectId} is active`,
      );
    }

    if (entry.steps.length > 1) {
      const commands = entry.steps.map((step, index) => Object.freeze({
        ...step.forwardCommand, commandId: createUuidV7(),
        baseRevision: currentRevision + index, expectedRevision: currentRevision + index + 1,
      }) as ProductCommand);
      const outcomes = await this.orchestrator.dispatchBatch(commands);
      const last = outcomes[outcomes.length - 1]?.result ?? null;
      if (outcomes.length === commands.length && outcomes.every(outcome => outcome.result.type === 'ProductCommandApplied')) {
        this.stacksByProject.set(projectId, nextState);
      }
      return last;
    }

    let revision = currentRevision;
    let last: ProductCommandResult | null = null;
    for (const step of entry.steps) {
      const commandId = createUuidV7();
      const forwardReissue: ProductCommand = Object.freeze({
        ...step.forwardCommand,
        commandId,
        baseRevision: revision,
        expectedRevision: revision + 1,
      } as ProductCommand);
      const outcome = await this.orchestrator.dispatchCommand(forwardReissue);
      last = outcome.type === 'CommandDispatched' ? outcome.result : null;
      if (!outcome || outcome.type !== 'CommandDispatched' || outcome.result.type !== 'ProductCommandApplied') {
        return last;
      }
      revision = outcome.result.targetRevision;
    }

    this.stacksByProject.set(projectId, nextState);
    return last;
  }

  /** Build the inverse ProductCommand for one descriptor at a revision. */
  #inverseFor(
    projectId: string,
    inverseDesc: InverseCommandDescriptor,
    currentRevision: number,
    actorId?: string,
  ): ProductCommand {
    const commandId = createUuidV7();
    let inverseCommand: ProductCommand;

    switch (inverseDesc.type) {
      case 'DeleteSubtree':
        inverseCommand = Object.freeze({
          type: 'DeleteSubtree',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
        });
        break;

      case 'SetNodeTitle':
        inverseCommand = Object.freeze({
          type: 'SetNodeTitle',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          title: inverseDesc.title,
        });
        break;

      case 'SetNodeBodyText':
        inverseCommand = Object.freeze({
          type: 'SetNodeBodyText',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          bodyText: inverseDesc.bodyText,
        });
        break;

      case 'MoveNode':
        inverseCommand = Object.freeze({
          type: 'MoveNode',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          newParentId: inverseDesc.newParentId,
          newPosition: inverseDesc.newPosition,
        });
        break;

      case 'RestoreSubtree':
        inverseCommand = Object.freeze({
          type: 'RestoreSubtree',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          rootNodeId: inverseDesc.rootNodeId,
          nodes: inverseDesc.nodes,
          ...(inverseDesc.deletionBundle === undefined ? {} : { deletionBundle: inverseDesc.deletionBundle }),
        });
        break;

      case 'SetNodeType':
        inverseCommand = Object.freeze({
          type: 'SetNodeType',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          nodeType: inverseDesc.nodeType,
        });
        break;

      case 'SetNodeCustomField':
        inverseCommand = Object.freeze({
          type: 'SetNodeCustomField',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          fieldKey: inverseDesc.fieldKey,
          fieldValue: inverseDesc.fieldValue,
        });
        break;

      case 'SetNodeSchedule':
        inverseCommand = Object.freeze({
          type: 'SetNodeSchedule',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          startDate: inverseDesc.startDate,
          endDate: inverseDesc.endDate,
          durationDays: inverseDesc.durationDays,
          sourceMode: inverseDesc.sourceMode,
        });
        break;

      case 'ToggleNodeCompleted':
        inverseCommand = Object.freeze({
          type: 'ToggleNodeCompleted',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          completed: inverseDesc.completed,
        });
        break;

      case 'SetNodeEffort':
        inverseCommand = Object.freeze({
          type: 'SetNodeEffort',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          effortPoints: inverseDesc.effortPoints,
          ...(inverseDesc.restoredAssignments ? { restoredAssignments: inverseDesc.restoredAssignments } : {}),
        });
        break;

      case 'SetNodePointsDone':
        inverseCommand = Object.freeze({
          type: 'SetNodePointsDone',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          effortPointsDone: inverseDesc.effortPointsDone,
        });
        break;

      case 'SetNodeStatus':
        inverseCommand = Object.freeze({
          type: 'SetNodeStatus',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          deliveryStatus: inverseDesc.deliveryStatus,
        });
        break;

      case 'SetThemeWeight':
        inverseCommand = Object.freeze({
          type: 'SetThemeWeight',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          strategicWeight: inverseDesc.strategicWeight,
        });
        break;

      case 'DeletePhase':
        inverseCommand = Object.freeze({
          type: 'DeletePhase',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          phaseId: inverseDesc.phaseId,
          reassignments: inverseDesc.reassignments,
        });
        break;

      case 'RenamePhase':
        inverseCommand = Object.freeze({
          type: 'RenamePhase',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          phaseId: inverseDesc.phaseId,
          name: inverseDesc.name,
        });
        break;

      case 'ReorderPhases':
        inverseCommand = Object.freeze({
          type: 'ReorderPhases',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          phases: inverseDesc.phases,
        });
        break;

      case 'AssignNodePhase':
        inverseCommand = Object.freeze({
          type: 'AssignNodePhase',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          nodeId: inverseDesc.nodeId,
          phaseId: inverseDesc.phaseId,
        });
        break;

      case 'RestorePhase':
        inverseCommand = Object.freeze({
          type: 'RestorePhase',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          phaseId: inverseDesc.phaseId,
          name: inverseDesc.name,
          position: inverseDesc.position,
          priorAssignments: inverseDesc.priorAssignments,
        });
        break;

      case 'CreateUnlockEdge':
        inverseCommand = Object.freeze({
          type: 'CreateUnlockEdge',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          edgeId: inverseDesc.edgeId,
          sourceNodeId: inverseDesc.sourceNodeId,
          targetNodeId: inverseDesc.targetNodeId,
        });
        break;

      case 'DeleteUnlockEdge':
        inverseCommand = Object.freeze({
          type: 'DeleteUnlockEdge',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          edgeId: inverseDesc.edgeId,
          sourceNodeId: inverseDesc.sourceNodeId,
          targetNodeId: inverseDesc.targetNodeId,
        });
        break;

      case 'UndismissFinding':
        inverseCommand = Object.freeze({
          type: 'UndismissFinding',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          findingId: inverseDesc.findingId,
          findingKind: inverseDesc.findingKind,
          targetId: inverseDesc.targetId,
          fingerprint: inverseDesc.fingerprint,
        });
        break;

      case 'DismissFinding':
        inverseCommand = Object.freeze({
          type: 'DismissFinding',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          findingId: inverseDesc.findingId,
          findingKind: inverseDesc.findingKind,
          targetId: inverseDesc.targetId,
          fingerprint: inverseDesc.fingerprint,
          dismissedAt: inverseDesc.dismissedAt,
        });
        break;

      case 'ConfigureForecastPlan':
        inverseCommand = Object.freeze({
          type: 'ConfigureForecastPlan',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          pointsPerSprint: inverseDesc.pointsPerSprint,
          sprintLengthDays: inverseDesc.sprintLengthDays,
          startSprintOrdinal: inverseDesc.startSprintOrdinal,
          startDate: inverseDesc.startDate,
          // Edit-in-place configuration updates never touch the level — the
          // command only carries a level for plan CREATION (Story 21.13 D5).
          planningLevel: null,
        });
        break;

      case 'DeleteForecastPlan':
        inverseCommand = Object.freeze({
          type: 'RemoveForecastPlan',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
        });
        break;

      case 'SetForecastMembership':
        inverseCommand = Object.freeze({
          type: 'SetForecastMembership',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          featureId: inverseDesc.featureId,
          included: inverseDesc.included,
        });
        break;

      case 'ReorderForecastFeatures':
        inverseCommand = Object.freeze({
          type: 'ReorderForecastFeatures',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          featureIds: inverseDesc.featureIds,
        });
        break;

      case 'SetForecastSequence':
        inverseCommand = Object.freeze({
          type: 'SetForecastSequence', protocolVersion: PROTOCOL_VERSION, commandId, projectId,
          baseRevision: currentRevision, expectedRevision: currentRevision + 1,
          featureIds: inverseDesc.featureIds, parallelGroups: inverseDesc.parallelGroups,
        });
        break;

      case 'MoveForecastFeature':
        inverseCommand = Object.freeze({
          type: 'MoveForecastFeature',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          featureId: inverseDesc.featureId,
          afterId: inverseDesc.afterId,
          beforeId: inverseDesc.beforeId,
          intendedIndex: inverseDesc.intendedIndex,
          groupChange: inverseDesc.groupChange,
        });
        break;

      case 'SetForecastParallelGroups':
        inverseCommand = Object.freeze({
          type: 'SetForecastParallelGroups',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          parallelGroups: inverseDesc.parallelGroups,
        });
        break;

      case 'RestoreForecastScope':
        inverseCommand = Object.freeze({
          type: 'RestoreForecastScope',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          selectedFeatureIds: inverseDesc.selectedFeatureIds,
          parallelGroups: inverseDesc.parallelGroups,
          blockedFeatureIds: inverseDesc.blockedFeatureIds,
          ...(inverseDesc.assignments ? { assignments: inverseDesc.assignments } : {}),
        });
        break;

      case 'SetForecastBlocker':
        inverseCommand = Object.freeze({
          type: 'SetForecastBlocker',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          featureId: inverseDesc.featureId,
          blocked: inverseDesc.blocked,
        });
        break;

      case 'SetForecastSprintPlan':
        inverseCommand = Object.freeze({
          type: 'SetForecastSprintPlan',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          sprintPlan: inverseDesc.sprintPlan,
        });
        break;

      case 'RemoveForecastScenario':
        inverseCommand = Object.freeze({
          type: 'RemoveForecastScenario',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          scenarioId: inverseDesc.scenarioId,
        });
        break;

      case 'RestoreForecastScenario':
        inverseCommand = Object.freeze({
          type: 'RestoreForecastScenario',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          scenario: inverseDesc.scenario,
        });
        break;

      case 'RestoreForecastPlanningLevel':
        inverseCommand = Object.freeze({
          type: 'RestoreForecastPlanningLevel',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          planningLevel: inverseDesc.planningLevel,
          selectedFeatureIds: Object.freeze([...inverseDesc.selectedFeatureIds]),
          parallelGroups: Object.freeze(
            inverseDesc.parallelGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) })),
          ),
          blockedFeatureIds: Object.freeze([...inverseDesc.blockedFeatureIds]),
          ...(inverseDesc.assignments ? { assignments: inverseDesc.assignments } : {}),
        });
        break;

      case 'RemoveForecastPerson':
        inverseCommand = Object.freeze({
          type: 'RemoveForecastPerson',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          personId: inverseDesc.personId,
        });
        break;

      case 'UpdateForecastPerson':
        inverseCommand = Object.freeze({
          type: 'UpdateForecastPerson',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          personId: inverseDesc.personId,
          name: inverseDesc.name,
          weightUnits: inverseDesc.weightUnits,
        });
        break;

      case 'RestoreForecastPerson':
        inverseCommand = Object.freeze({
          type: 'RestoreForecastPerson',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          person: inverseDesc.person,
          ...(inverseDesc.assignments ? { assignments: inverseDesc.assignments } : {}),
        });
        break;

      case 'SetForecastAssignments':
        inverseCommand = Object.freeze({
          type: 'SetForecastAssignments',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          featureId: inverseDesc.featureId,
          personIds: Object.freeze([...inverseDesc.personIds]),
        });
        break;

      case 'SetForecastPolicy':
        inverseCommand = Object.freeze({
          type: 'SetForecastPolicy',
          protocolVersion: PROTOCOL_VERSION,
          commandId,
          projectId,
          baseRevision: currentRevision,
          expectedRevision: currentRevision + 1,
          policyVersion: inverseDesc.policyVersion,
        });
        break;
    }

    return actorId ? (Object.freeze({ ...inverseCommand, actorId }) as ProductCommand) : inverseCommand;
  }
}

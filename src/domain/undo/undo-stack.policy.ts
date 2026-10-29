/**
 * Pure undo/redo stack state transitions (Story 2.6 Task 2, AD-4; Story 27.2 group).
 *
 * Framework-free reducer over immutable entries.
 *
 * An entry holds one or more ordered *steps*. A single edit is one step; a
 * composite gesture (Story 27.2) records several steps under one entry so undo
 * reverses them together and redo re-applies them together — one undoable
 * change (AC 27.2-3). The `forwardCommand`/`changeSet`/`inverseDescriptor`
 * fields mirror the LAST step so existing single-step callers are unchanged.
 */

import type { ChangeSet } from '../../contracts/change-set';
import type { ProductCommand } from '../../contracts/repository-commands';
import { computeInverseDescriptor, type InverseCommandDescriptor } from './inverse-command.policy';

/** One forward mutation and its inverse within an undo entry. */
export interface UndoStep {
  readonly forwardCommand: ProductCommand;
  readonly changeSet: ChangeSet;
  readonly inverseDescriptor: InverseCommandDescriptor;
  /**
   * The actor that produced this step (Story 27.3, AC 27.3-6). Undo is
   * per-actor: only steps with the current actor are eligible. For a local
   * project every step carries the local actor, so this never changes behavior.
   */
  readonly actorId?: string;
  /**
   * The target ids this step touched (Story 27.3, AC 27.3-6). If a later
   * confirmed command from another actor overlaps one of these, undo is refused
   * with `ChangedByOtherActor`.
   */
  readonly footprints?: readonly string[];
}

export interface UndoEntry {
  /** Ordered forward steps (length >= 1). Undo reverses; redo re-applies. */
  readonly steps: readonly UndoStep[];
  /** The last forward command (single-step compatibility). */
  readonly forwardCommand: ProductCommand;
  /** The last step's ChangeSet (single-step compatibility). */
  readonly changeSet: ChangeSet;
  /** The last step's inverse descriptor (single-step compatibility). */
  readonly inverseDescriptor: InverseCommandDescriptor;
}

export interface UndoStackState {
  readonly undoEntries: readonly UndoEntry[];
  readonly redoEntries: readonly UndoEntry[];
}

export function createInitialUndoStackState(): UndoStackState {
  return Object.freeze({
    undoEntries: Object.freeze([]),
    redoEntries: Object.freeze([]),
  });
}

function entryFromSteps(steps: readonly UndoStep[]): UndoEntry {
  const last = steps[steps.length - 1];
  return Object.freeze({
    steps: Object.freeze([...steps]),
    forwardCommand: last.forwardCommand,
    changeSet: last.changeSet,
    inverseDescriptor: last.inverseDescriptor,
  });
}

/** Build a single-step entry from a command and its ChangeSet. */
export function makeUndoStep(
  forwardCommand: ProductCommand,
  changeSet: ChangeSet,
  actorId?: string,
): UndoStep | null {
  const inverseDescriptor = computeInverseDescriptor(changeSet);
  if (!inverseDescriptor) return null;
  return Object.freeze({ forwardCommand, changeSet, inverseDescriptor, actorId });
}

export function pushAppliedCommand(
  state: UndoStackState,
  forwardCommand: ProductCommand,
  changeSet: ChangeSet,
  actorId?: string,
): UndoStackState {
  const step = makeUndoStep(forwardCommand, changeSet, actorId);
  if (!step) return state;
  return Object.freeze({
    undoEntries: Object.freeze([...state.undoEntries, entryFromSteps([step])]),
    redoEntries: Object.freeze([]),
  });
}

/**
 * Push an ordered group of steps as ONE entry. Steps whose ChangeSet has no
 * inverse descriptor are skipped; if none remain, the state is unchanged.
 */
export function pushAppliedGroup(
  state: UndoStackState,
  commandsAndChangeSets: readonly Readonly<{ command: ProductCommand; changeSet: ChangeSet }>[],
  actorId?: string,
): UndoStackState {
  const steps: UndoStep[] = [];
  for (const { command, changeSet } of commandsAndChangeSets) {
    const step = makeUndoStep(command, changeSet, actorId);
    if (step) steps.push(step);
  }
  if (steps.length === 0) return state;
  return Object.freeze({
    undoEntries: Object.freeze([...state.undoEntries, entryFromSteps(steps)]),
    redoEntries: Object.freeze([]),
  });
}

export function popUndoEntry(
  state: UndoStackState,
): { nextState: UndoStackState; entry: UndoEntry | null } {
  if (state.undoEntries.length === 0) {
    return { nextState: state, entry: null };
  }

  const entry = state.undoEntries[state.undoEntries.length - 1];
  const nextUndo = state.undoEntries.slice(0, -1);
  const nextRedo = [...state.redoEntries, entry];

  return {
    nextState: Object.freeze({
      undoEntries: Object.freeze(nextUndo),
      redoEntries: Object.freeze(nextRedo),
    }),
    entry,
  };
}

export function popRedoEntry(
  state: UndoStackState,
): { nextState: UndoStackState; entry: UndoEntry | null } {
  if (state.redoEntries.length === 0) {
    return { nextState: state, entry: null };
  }

  const entry = state.redoEntries[state.redoEntries.length - 1];
  const nextRedo = state.redoEntries.slice(0, -1);
  const nextUndo = [...state.undoEntries, entry];

  return {
    nextState: Object.freeze({
      undoEntries: Object.freeze(nextUndo),
      redoEntries: Object.freeze(nextRedo),
    }),
    entry,
  };
}

/** The target ids a step's ChangeSet touched (Story 27.3, AC 27.3-6). */
export function stepFootprint(step: UndoStep): readonly string[] {
  if (step.footprints) return step.footprints;
  const ids: string[] = [];
  for (const change of step.changeSet.changes) {
    const c = change as Record<string, unknown>;
    for (const key of ['nodeId', 'rootNodeId', 'newRootId', 'phaseId', 'questionId', 'featureId', 'edgeId', 'scenarioId', 'personId', 'targetId']) {
      const value = c[key];
      if (typeof value === 'string') ids.push(value);
    }
  }
  return Object.freeze(ids);
}

/** A confirmed change from another actor that overlaps a step's footprint. */
export interface ActorConflict {
  readonly actorId: string;
  readonly targetId: string;
}

/**
 * Story 27.3 AC 27.3-6: whether an undo entry may be reversed by `currentActor`.
 * Only steps with `currentActor` are eligible; if `otherActorChanges` (confirmed
 * commands from other actors) overlap a step's footprint since it was recorded,
 * undo is refused with `ChangedByOtherActor`. A local project passes no
 * conflicts, so undo behaves exactly as today.
 */
export function canUndoEntry(
  entry: UndoEntry,
  currentActor: string | undefined,
  otherActorChanges: readonly Readonly<{ actorId: string; targetIds: readonly string[] }>[] = [],
): { ok: true } | { ok: false; reason: 'ChangedByOtherActor'; conflict: ActorConflict } {
  const conflicts: ActorConflict[] = [];
  for (const step of entry.steps) {
    if (currentActor !== undefined && step.actorId !== undefined && step.actorId !== currentActor) {
      // A step owned by a different actor is never undone by this actor.
      return {
        ok: false,
        reason: 'ChangedByOtherActor',
        conflict: { actorId: step.actorId, targetId: stepFootprint(step)[0] ?? '' },
      };
    }
    const footprint = new Set(stepFootprint(step));
    for (const other of otherActorChanges) {
      if (currentActor !== undefined && other.actorId === currentActor) continue;
      for (const target of other.targetIds) {
        if (footprint.has(target)) conflicts.push({ actorId: other.actorId, targetId: target });
      }
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, reason: 'ChangedByOtherActor', conflict: conflicts[0] };
  }
  return { ok: true };
}

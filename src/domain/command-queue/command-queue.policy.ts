/**
 * Command-queue pure state machine (Story 1.7 Task 1, AD-4).
 *
 * Encodes AD-4's exact queue rules as pure state transitions:
 * - Exactly one command in flight per project
 * - Later commands wait for the authoritative revision
 * - Success reconciles overlay, hands next command its revision
 * - Failure pauses queue, keeps dependent overlays, offers retry/discard
 * - Missing dependencies return DependencyRejected without silent loss
 *
 * Pure function — no I/O, no framework imports (AD-1).
 * Mirrors project.policy.ts, decideUpdate(), selectMigrationRecovery() convention.
 */

/** A queued command waiting to be dispatched. */
export type QueuedCommand = Readonly<{
  commandId: string;
  projectId: string;
  commandType: string;
  /** The overlay value the UI painted immediately (AD-5). */
  overlay: unknown;
}>;

/** The per-project queue state. */
export type QueueState = Readonly<{
  projectId: string;
  /** The command currently in flight, or null if idle. */
  inFlight: QueuedCommand | null;
  /** Commands waiting for the in-flight command to complete. */
  pending: readonly QueuedCommand[];
  /** Whether the queue is paused due to a failure. */
  paused: false | Readonly<{
    failed: QueuedCommand;
    cause: string;
  }>;
  /** Successful dispatch order for undo-stack insertion (Story 1.7 AC2). */
  dispatchOrder: readonly string[];
  /** The last known authoritative revision (updated on each success). */
  lastRevision: number;
}>;

/** Events that can be submitted to the queue state machine. */
export type QueueEvent =
  | Readonly<{ type: 'SubmitCommand'; command: QueuedCommand }>
  | Readonly<{ type: 'DispatchSucceeded'; commandId: string; newRevision: number }>
  | Readonly<{ type: 'DispatchFailed'; commandId: string; cause: string }>
  | Readonly<{ type: 'RetryCommand' }>
  | Readonly<{ type: 'DiscardCommand' }>;

/** Effects the state machine produces for the orchestrator to execute. */
export type QueueEffect =
  | Readonly<{ type: 'DispatchNow'; command: QueuedCommand; baseRevision: number }>
  | Readonly<{ type: 'ReconcileOverlay'; commandId: string; newRevision: number }>
  | Readonly<{ type: 'DependencyRejected'; commandId: string; blockedByCommandId: string; cause: string }>
  | Readonly<{ type: 'RemoveOverlay'; commandId: string }>;

/** Result of a state transition. */
export type QueueTransition = Readonly<{
  nextState: QueueState;
  effects: readonly QueueEffect[];
}>;

/** Create an initial (empty) queue state for a project. */
export function createInitialQueueState(projectId: string, initialRevision: number = 0): QueueState {
  return Object.freeze({
    projectId,
    inFlight: null,
    pending: Object.freeze([]),
    paused: false,
    dispatchOrder: Object.freeze([]),
    lastRevision: initialRevision,
  });
}

/**
 * Apply a queue event to the current state, producing the next state
 * and any side effects the orchestrator must execute.
 *
 * All state transitions are pure functions.
 */
export function transitionQueue(state: QueueState, event: QueueEvent): QueueTransition {
  switch (event.type) {
    case 'SubmitCommand':
      return handleSubmit(state, event.command);
    case 'DispatchSucceeded':
      return handleSuccess(state, event.commandId, event.newRevision);
    case 'DispatchFailed':
      return handleFailure(state, event.commandId, event.cause);
    case 'RetryCommand':
      return handleRetry(state);
    case 'DiscardCommand':
      return handleDiscard(state);
  }
}

function handleSubmit(state: QueueState, command: QueuedCommand): QueueTransition {
  // If nothing is in flight, dispatch immediately using lastRevision as baseRevision
  if (state.inFlight === null && state.paused === false) {
    const overlay = command.overlay as Readonly<{ baseRevision?: unknown }> | null | undefined;
    const cmdRev = overlay?.baseRevision;
    const baseRev = typeof cmdRev === 'number' && cmdRev > state.lastRevision ? cmdRev : state.lastRevision;
    return {
      nextState: Object.freeze({
        ...state,
        inFlight: command,
        lastRevision: baseRev,
      }),
      effects: Object.freeze([
        Object.freeze({ type: 'DispatchNow' as const, command, baseRevision: baseRev }),
      ]),
    };
  }

  // Something is in flight or queue is paused — hold in pending
  return {
    nextState: Object.freeze({
      ...state,
      pending: Object.freeze([...state.pending, command]),
    }),
    effects: Object.freeze([]),
  };
}

function handleSuccess(state: QueueState, commandId: string, newRevision: number): QueueTransition {
  if (state.inFlight === null || state.inFlight.commandId !== commandId) {
    // Idempotent: command already processed or not in flight
    return { nextState: state, effects: Object.freeze([]) };
  }

  const effects: QueueEffect[] = [
    Object.freeze({ type: 'ReconcileOverlay' as const, commandId, newRevision }),
  ];

  const dispatchOrder = Object.freeze([...state.dispatchOrder, commandId]);

  // Pop the next pending command
  if (state.pending.length > 0) {
    const [nextCommand, ...remaining] = state.pending;
    effects.push(
      Object.freeze({ type: 'DispatchNow' as const, command: nextCommand, baseRevision: newRevision }),
    );
    return {
      nextState: Object.freeze({
        ...state,
        inFlight: nextCommand,
        pending: Object.freeze(remaining),
        paused: false,
        dispatchOrder,
        lastRevision: newRevision,
      }),
      effects: Object.freeze(effects),
    };
  }

  // Queue is now idle
  return {
    nextState: Object.freeze({
      ...state,
      inFlight: null,
      paused: false,
      dispatchOrder,
      lastRevision: newRevision,
    }),
    effects: Object.freeze(effects),
  };
}

function handleFailure(state: QueueState, commandId: string, cause: string): QueueTransition {
  if (state.inFlight === null || state.inFlight.commandId !== commandId) {
    return { nextState: state, effects: Object.freeze([]) };
  }

  return {
    nextState: Object.freeze({
      ...state,
      inFlight: null,
      paused: Object.freeze({ failed: state.inFlight, cause }),
    }),
    effects: Object.freeze([]),
  };
}

function handleRetry(state: QueueState): QueueTransition {
  if (state.paused === false) {
    return { nextState: state, effects: Object.freeze([]) };
  }

  const { failed } = state.paused;
  return {
    nextState: Object.freeze({
      ...state,
      inFlight: failed,
      paused: false,
    }),
    effects: Object.freeze([
      Object.freeze({ type: 'DispatchNow' as const, command: failed, baseRevision: state.lastRevision }),
    ]),
  };
}

function handleDiscard(state: QueueState): QueueTransition {
  if (state.paused === false) {
    return { nextState: state, effects: Object.freeze([]) };
  }

  const { failed } = state.paused;
  const effects: QueueEffect[] = [
    Object.freeze({ type: 'RemoveOverlay' as const, commandId: failed.commandId }),
  ];

  // Revalidate remaining pending commands in order.
  // A pending command whose dependency no longer resolves gets DependencyRejected.
  const revalidated: QueueEffect[] = [];
  const surviving: QueuedCommand[] = [];

  for (const cmd of state.pending) {
    // If the failed command was a CreateProject and this pending command
    // targets the same projectId, it's a dependency rejection.
    if (failed.commandType === 'CreateProject' && cmd.projectId === failed.projectId) {
      revalidated.push(
        Object.freeze({
          type: 'DependencyRejected' as const,
          commandId: cmd.commandId,
          blockedByCommandId: failed.commandId,
          cause: `Dependency command ${failed.commandId} was discarded`,
        }),
      );
    } else {
      surviving.push(cmd);
    }
  }

  effects.push(...revalidated);

  // If there are surviving pending commands, dispatch the first one
  if (surviving.length > 0) {
    const [nextCommand, ...remaining] = surviving;
    effects.push(
      Object.freeze({ type: 'DispatchNow' as const, command: nextCommand, baseRevision: state.lastRevision }),
    );
    return {
      nextState: Object.freeze({
        ...state,
        inFlight: nextCommand,
        pending: Object.freeze(remaining),
        paused: false,
      }),
      effects: Object.freeze(effects),
    };
  }

  // Queue is now idle
  return {
    nextState: Object.freeze({
      ...state,
      inFlight: null,
      pending: Object.freeze([]),
      paused: false,
    }),
    effects: Object.freeze(effects),
  };
}

/**
 * Check if the queue is settled (empty and every result acknowledged).
 * AC4 predicate — used by export (Story 1.8), project switch (Story 5.4),
 * and delete (Story 1.10).
 */
export function isQueueSettled(state: QueueState): boolean {
  return state.inFlight === null && state.pending.length === 0 && state.paused === false;
}

/**
 * Get the blocking cause if the queue is not settled.
 */
export function queueBlockingCause(state: QueueState): string | null {
  if (state.paused !== false) {
    return `Command ${state.paused.failed.commandId} failed: ${state.paused.cause}`;
  }
  if (state.inFlight !== null) {
    return `Command ${state.inFlight.commandId} is in flight`;
  }
  if (state.pending.length > 0) {
    return `${state.pending.length} command(s) pending`;
  }
  return null;
}

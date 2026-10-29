/**
 * Command-queue orchestrator (Story 1.7 Task 2, AD-4).
 *
 * Wraps Story 1.6's dispatchCommand entry point with a per-project queue
 * driven by the pure state machine from src/domain/command-queue/command-queue.policy.ts.
 *
 * One QueueRuntime per projectId (Map<projectId, QueueRuntime>).
 * Each runtime:
 *   - Accepts SubmitCommand events
 *   - Drives the state machine
 *   - Executes effects (DispatchNow, ReconcileOverlay, DependencyRejected, RemoveOverlay)
 *   - Resolves/rejects the caller's Promise when the command completes
 *
 * AD-1: No I/O in domain logic — the orchestrator is the I/O boundary.
 * AD-4: All types are Readonly<> + Object.freeze().
 */

import {
  createInitialQueueState,
  transitionQueue,
  isQueueSettled,
  queueBlockingCause,
  type QueueState,
  type QueueEffect,
  type QueuedCommand,
} from '../../domain/command-queue/command-queue.policy';

import type {
  ProductCommand,
  ProductCommandResult,
  ProductCommandApplied,
} from '../../contracts/repository-commands';

// ── Dispatch port ───────────────────────────────────────────────────────────

/** The dispatch function signature — wraps Story 1.6's command application. */
export type CommandDispatcher = (
  command: ProductCommand,
) => Promise<ProductCommandResult>;

/** One repository transaction: all applied results, or one failed component. */
export type AtomicBatchDispatcher = (
  commands: readonly ProductCommand[],
) => Promise<readonly ProductCommandResult[]>;

// ── Outcome types ──────────────────────────────────────────────────────────

/** A command was successfully dispatched and applied. */
export type CommandDispatched = Readonly<{
  type: 'CommandDispatched';
  commandId: string;
  projectId: string;
  result: ProductCommandResult;
}>;

/** A command was rejected because its dependency was discarded. */
export type DependencyRejected = Readonly<{
  type: 'DependencyRejected';
  commandId: string;
  blockedByCommandId: string;
  cause: string;
}>;

/** Union of all possible outcomes from the command queue. */
export type CommandQueueOutcome = CommandDispatched | DependencyRejected;

// ── Queue runtime ──────────────────────────────────────────────────────────

/** Per-project queue runtime state. */
type QueueRuntime = Readonly<{
  state: QueueState;
  /** Pending promises keyed by commandId. */
  promises: Map<string, {
    resolve: (outcome: CommandQueueOutcome) => void;
    reject: (error: Error) => void;
  }>;
}>;

// ── Orchestrator ───────────────────────────────────────────────────────────

export class CommandQueueOrchestrator {
  private readonly runtimes = new Map<string, QueueRuntime>();
  private readonly lastResults = new Map<string, ProductCommandResult>();
  private readonly dispatch: CommandDispatcher;
  private readonly batchBarriers = new Map<string, Promise<void>>();
  private readonly uncertainBatchProjects = new Set<string>();

  constructor(dispatch: CommandDispatcher, private readonly dispatchAtomicBatch?: AtomicBatchDispatcher) {
    this.dispatch = dispatch;
  }

  /**
   * Check if the queue for a project is settled (empty and every result acknowledged).
   * AC4 predicate — used by export (Story 1.8), project switch (Story 5.4),
   * and delete (Story 1.10).
   */
  isQueueSettled(projectId: string): boolean {
    if (this.uncertainBatchProjects.has(projectId)) return false;
    if (this.batchBarriers.has(projectId)) return false;
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return true; // No queue = settled
    return isQueueSettled(runtime.state);
  }

  /**
   * Get the blocking cause if the queue is not settled.
   */
  queueBlockingCause(projectId: string): string | null {
    if (this.uncertainBatchProjects.has(projectId)) return 'Atomic edit needs repository reconciliation.';
    if (this.batchBarriers.has(projectId)) return 'Atomic edit in progress.';
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return null;
    return queueBlockingCause(runtime.state);
  }

  /**
   * Dispatch a command through the queue for its project.
   * Returns a Promise that resolves when the command completes
   * (success, failure, or dependency rejection).
   */
  async dispatchCommand(command: ProductCommand): Promise<CommandQueueOutcome> {
    const projectId = command.projectId;
    // Recheck after each barrier: another batch may have joined while this
    // command waited. Ordinary commands never interleave batch components.
    while (this.batchBarriers.has(projectId)) {
      await this.batchBarriers.get(projectId);
    }
    if (this.uncertainBatchProjects.has(projectId)) throw new Error('ATOMIC_BATCH_RECONCILIATION_REQUIRED');

    // Get or create the runtime for this project
    let runtime = this.runtimes.get(projectId);
    if (!runtime) {
      const baseRev = typeof command.baseRevision === 'number' ? command.baseRevision : 0;
      runtime = {
        state: createInitialQueueState(projectId, baseRev),
        promises: new Map(),
      };
      this.runtimes.set(projectId, runtime);
    }

    // Create a promise that will be resolved when the command completes
    return new Promise<CommandQueueOutcome>((resolve, reject) => {
      const queued: QueuedCommand = Object.freeze({
        commandId: command.commandId,
        projectId: command.projectId,
        commandType: command.type,
        overlay: command,
      });

      // Store the promise
      runtime!.promises.set(command.commandId, { resolve, reject });

      // Submit to the state machine
      const transition = transitionQueue(runtime!.state, {
        type: 'SubmitCommand',
        command: queued,
      });

      // Update runtime state
      this.runtimes.set(projectId, {
        state: transition.nextState,
        promises: runtime!.promises,
      });

      // Execute effects
      this.executeEffects(projectId, transition.effects);
    });
  }

  /** Fence ordinary edits while a reviewed snapshot is committed and adopt its revision. */
  async runAuthoritativeEdit<T extends Readonly<{ revision: number }>>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.isQueueSettled(projectId)) throw new Error('Finish or resolve pending edits before merging.');
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.batchBarriers.set(projectId, barrier);
    try {
      const result = await operation();
      const runtime = this.runtimes.get(projectId);
      if (!Number.isSafeInteger(result.revision) || result.revision < (runtime?.state.lastRevision ?? 0)) {
        throw new Error('Invalid merge revision. Reload the project before continuing.');
      }
      const state = runtime?.state ?? createInitialQueueState(projectId, result.revision);
      this.runtimes.set(projectId, {
        state: Object.freeze({ ...state, lastRevision: result.revision }),
        promises: runtime?.promises ?? new Map(),
      });
      return result;
    } catch (error) {
      // A missing IPC reply does not prove rollback. Caller must read storage.
      this.uncertainBatchProjects.add(projectId);
      throw error;
    } finally {
      if (this.batchBarriers.get(projectId) === barrier) this.batchBarriers.delete(projectId);
      release();
    }
  }

  async dispatchBatch(commands: readonly ProductCommand[]): Promise<readonly CommandDispatched[]> {
    if (commands.length === 0) return Object.freeze([]);
    if (!this.dispatchAtomicBatch) throw new Error('ATOMIC_BATCH_UNAVAILABLE');
    const projectId = commands[0].projectId;
    if (commands.some(command => command.projectId !== projectId)
      || new Set(commands.map(command => command.commandId)).size !== commands.length) {
      throw new Error('ATOMIC_BATCH_IDENTITY_INVALID');
    }
    const prior = this.batchBarriers.get(projectId);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    this.batchBarriers.set(projectId, barrier);
    let dispatched = false;
    try {
      if (prior) await prior;
      if (this.uncertainBatchProjects.has(projectId)) throw new Error('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
      const runtime = this.runtimes.get(projectId);
      if (runtime && !isQueueSettled(runtime.state)) throw new Error('ATOMIC_BATCH_QUEUE_UNSETTLED');
      const baseRevision = Math.max(commands[0].baseRevision, runtime?.state.lastRevision ?? 0);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0
        || !Number.isSafeInteger(baseRevision + commands.length)) throw new Error('ATOMIC_BATCH_REVISION_INVALID');
      const prepared = commands.map((command, index) => Object.freeze({
        ...command, baseRevision: baseRevision + index, expectedRevision: baseRevision + index + 1,
      }) as ProductCommand);
      dispatched = true;
      const results = await this.dispatchAtomicBatch(Object.freeze(prepared));
      const refusal = results.length === 1 && results[0].type === 'ProductCommandRejected' ? results[0] : null;
      if (refusal) {
        if (!prepared.some(command => command.commandId === refusal.commandId
          && command.protocolVersion === refusal.protocolVersion)) throw new Error('ATOMIC_BATCH_RESULT_INVALID');
        return Object.freeze([Object.freeze({ type: 'CommandDispatched', commandId: refusal.commandId, projectId, result: refusal })]);
      }
      if (results.length !== prepared.length || results.some((result, index) =>
        result.type !== 'ProductCommandApplied' || result.commandId !== prepared[index].commandId
        || result.protocolVersion !== prepared[index].protocolVersion || result.outcome !== 'VfsCommitAccepted'
        || !['NewCommit', 'StoredResultReturned'].includes(result.disposition)
        || result.projectId !== projectId || result.baseRevision !== prepared[index].baseRevision
        || result.targetRevision !== prepared[index].expectedRevision)) throw new Error('ATOMIC_BATCH_RESULT_INVALID');
      const state = runtime?.state ?? createInitialQueueState(projectId, baseRevision);
      this.runtimes.set(projectId, {
        state: Object.freeze({ ...state, lastRevision: baseRevision + prepared.length,
          dispatchOrder: Object.freeze([...state.dispatchOrder, ...prepared.map(command => command.commandId)]) }),
        promises: runtime?.promises ?? new Map(),
      });
      return Object.freeze(results.map(result => Object.freeze({
        type: 'CommandDispatched' as const, commandId: result.commandId, projectId, result,
      })));
    } catch (error) {
      // IPC can fail after COMMIT. Neither an exception nor a malformed reply
      // proves rollback; retain a gate until an authoritative repository read.
      if (dispatched) this.uncertainBatchProjects.add(projectId);
      throw error;
    } finally {
      if (this.batchBarriers.get(projectId) === barrier) this.batchBarriers.delete(projectId);
      release();
    }
  }

  /**
   * Shared projects (H08): an authoritative snapshot install may move the
   * repository revision BACKWARDS (restore, epoch change). Adopt it only while
   * the project's queue is settled and no batch is open; returns false
   * otherwise so the caller retries after the queue drains.
   */
  adoptAuthoritativeRevision(projectId: string, revision: number): boolean {
    const runtime = this.runtimes.get(projectId);
    if (!Number.isSafeInteger(revision) || revision < 0 || this.batchBarriers.has(projectId)
      || this.uncertainBatchProjects.has(projectId) || (runtime && !isQueueSettled(runtime.state))) return false;
    if (runtime) this.runtimes.set(projectId, { state: Object.freeze({ ...runtime.state, lastRevision: revision }), promises: runtime.promises });
    return true;
  }

  /** Caller must obtain this revision from the repository after an uncertain reply. */
  reconcileAtomicBatchRevision(projectId: string, revision: number): void {
    const runtime = this.runtimes.get(projectId);
    if (this.batchBarriers.has(projectId) || (runtime && !isQueueSettled(runtime.state))
      || !Number.isSafeInteger(revision) || revision < (runtime?.state.lastRevision ?? 0)) {
      throw new Error('ATOMIC_BATCH_RECONCILIATION_INVALID');
    }
    const state = runtime?.state ?? createInitialQueueState(projectId, revision);
    this.runtimes.set(projectId, { state: Object.freeze({ ...state, lastRevision: revision }), promises: runtime?.promises ?? new Map() });
    this.uncertainBatchProjects.delete(projectId);
  }

  /**
   * Retry the failed command at the head of the queue.
   */
  retryCommand(projectId: string): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;

    const transition = transitionQueue(runtime.state, { type: 'RetryCommand' });
    this.runtimes.set(projectId, { state: transition.nextState, promises: runtime.promises });
    this.executeEffects(projectId, transition.effects);
  }

  /**
   * Discard the failed command at the head of the queue.
   */
  discardCommand(projectId: string): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;

    const transition = transitionQueue(runtime.state, { type: 'DiscardCommand' });
    this.runtimes.set(projectId, { state: transition.nextState, promises: runtime.promises });
    this.executeEffects(projectId, transition.effects);
  }

  // ── Effect execution ─────────────────────────────────────────────────

  private executeEffects(projectId: string, effects: readonly QueueEffect[]): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'DispatchNow':
          this.handleDispatchNow(projectId, effect);
          break;
        case 'ReconcileOverlay':
          this.handleReconcileOverlay(projectId, effect);
          break;
        case 'DependencyRejected':
          this.handleDependencyRejected(projectId, effect);
          break;
        case 'RemoveOverlay':
          this.handleRemoveOverlay(projectId, effect);
          break;
      }
    }
  }

  private async handleDispatchNow(
    projectId: string,
    effect: Extract<QueueEffect, { type: 'DispatchNow' }>,
  ): Promise<void> {
    const runtime = this.runtimes.get(projectId);
    let command = effect.command.overlay as ProductCommand;
    if (command && typeof command.baseRevision === 'number') {
      const effectiveBaseRevision = Math.max(command.baseRevision, effect.baseRevision);
      command = {
        ...command,
        baseRevision: effectiveBaseRevision,
        expectedRevision: effectiveBaseRevision + 1,
      } as ProductCommand;
    }

    try {
      const result = await this.dispatch(command);
      this.lastResults.set(effect.command.commandId, result);

      const currentRuntime = this.runtimes.get(projectId);
      if (!currentRuntime) return;

      // Check if the result is a rejection
      if (result.type === 'ProductCommandRejected') {
        const pending = currentRuntime.promises.get(effect.command.commandId);
        if (pending) {
          pending.resolve(
            Object.freeze({
              type: 'CommandDispatched' as const,
              commandId: effect.command.commandId,
              projectId,
              result,
            }),
          );
          currentRuntime.promises.delete(effect.command.commandId);
        }

        // Feed failure back to the state machine
        const transition = transitionQueue(currentRuntime.state, {
          type: 'DispatchFailed',
          commandId: effect.command.commandId,
          cause: result.code,
        });
        this.runtimes.set(projectId, { state: transition.nextState, promises: currentRuntime.promises });
        this.executeEffects(projectId, transition.effects);
        return;
      }

      // Success
      const transition = transitionQueue(currentRuntime.state, {
        type: 'DispatchSucceeded',
        commandId: effect.command.commandId,
        newRevision: result.targetRevision,
      });
      this.runtimes.set(projectId, { state: transition.nextState, promises: currentRuntime.promises });
      this.executeEffects(projectId, transition.effects);
    } catch (error) {
      const currentRuntime = this.runtimes.get(projectId);
      if (!currentRuntime) return;

      const pending = currentRuntime.promises.get(effect.command.commandId);
      if (pending) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        currentRuntime.promises.delete(effect.command.commandId);
      }

      // Unexpected dispatch failure
      const transition = transitionQueue(currentRuntime.state, {
        type: 'DispatchFailed',
        commandId: effect.command.commandId,
        cause: error instanceof Error ? error.message : 'Unknown dispatch error',
      });
      this.runtimes.set(projectId, { state: transition.nextState, promises: currentRuntime.promises });
      this.executeEffects(projectId, transition.effects);
    }
  }

  private handleReconcileOverlay(
    projectId: string,
    effect: Extract<QueueEffect, { type: 'ReconcileOverlay' }>,
  ): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;

    const pending = runtime.promises.get(effect.commandId);
    if (pending) {
      const realResult = this.lastResults.get(effect.commandId);
      this.lastResults.delete(effect.commandId);

      const appliedResult: ProductCommandApplied =
        realResult && realResult.type === 'ProductCommandApplied'
          ? realResult
          : Object.freeze({
              type: 'ProductCommandApplied' as const,
              protocolVersion: '1.0.0' as const,
              commandId: effect.commandId,
              projectId,
              baseRevision: effect.newRevision - 1,
              targetRevision: effect.newRevision,
              outcome: 'VfsCommitAccepted' as const,
              disposition: 'NewCommit' as const,
            });

      pending.resolve(
        Object.freeze({
          type: 'CommandDispatched' as const,
          commandId: effect.commandId,
          projectId,
          result: appliedResult,
        }),
      );
      runtime.promises.delete(effect.commandId);
    }
  }

  private handleDependencyRejected(
    projectId: string,
    effect: Extract<QueueEffect, { type: 'DependencyRejected' }>,
  ): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;

    const pending = runtime.promises.get(effect.commandId);
    if (pending) {
      pending.resolve(Object.freeze({
        type: 'DependencyRejected' as const,
        commandId: effect.commandId,
        blockedByCommandId: effect.blockedByCommandId,
        cause: effect.cause,
      }));
      runtime.promises.delete(effect.commandId);
    }
  }

  private handleRemoveOverlay(
    projectId: string,
    effect: Extract<QueueEffect, { type: 'RemoveOverlay' }>,
  ): void {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;

    // The failed command's promise was never resolved — reject it now
    const pending = runtime.promises.get(effect.commandId);
    if (pending) {
      pending.reject(new Error(`Command ${effect.commandId} was discarded`));
      runtime.promises.delete(effect.commandId);
    }
  }
}

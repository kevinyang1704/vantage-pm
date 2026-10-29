/**
 * Product-level fault injection port.
 *
 * Provides a thin, injectable port for simulating command failures, network
 * denylist violations, and storage-health degradation at the application-command
 * level. Distinct from and not duplicating Story 1.1's low-level VFS interposer
 * (F1–F6 fault boundaries in `interposing-vfs.test-only.ts`).
 *
 * This port is designed to be injected into command handlers once Stories 1.6+
 * land commands to inject faults into. Until then, it serves as the established
 * pattern for product-level fault simulation.
 *
 * Usage:
 *   const hooks = createFaultHooks();
 *   hooks.injectCommandFailure('CreateProject', new Error('simulated'));
 *   // Next CreateProject command will fail with the injected error
 */

export type FaultHookId = string;

export type FaultInjection = Readonly<{
  /** Unique identifier for this injection. */
  id: FaultHookId;
  /** The command type to intercept. */
  commandType: string;
  /** The error to throw when the command is invoked. */
  error: Error;
  /** If set, only fire this injection `remaining` times before self-clearing. */
  remaining: number | null;
}>;

export type StorageDegradation = Readonly<{
  /** Unique identifier for this degradation. */
  id: FaultHookId;
  /** Simulated health status to report. */
  health: 'degraded' | 'readonly' | 'unavailable';
  /** If set, auto-clear after `remaining` health checks. */
  remaining: number | null;
}>;

export type FaultHooks = Readonly<{
  /**
   * Inject a command failure. The next invocation of `commandType` will throw
   * `error` instead of executing normally.
   */
  injectCommandFailure(commandType: string, error: Error): FaultHookId;

  /**
   * Inject a storage-health degradation. Storage health checks will report
   * the given status until cleared.
   */
  injectStorageDegradation(health: StorageDegradation['health']): FaultHookId;

  /**
   * Check whether a command should fail. Returns the injected error if one
   * exists and has remaining invocations, or null if the command should
   * proceed normally.
   */
  checkCommandFailure(commandType: string): Error | null;

  /**
   * Check current storage health. Returns the injected degradation status
   * if one is active, or null if storage is healthy.
   */
  checkStorageHealth(): StorageDegradation['health'] | null;

  /** Clear a specific injection by ID. */
  clear(id: FaultHookId): void;

  /** Clear all active injections. */
  clearAll(): void;
}>;

/**
 * Create a fault-hooks port for product-level fault injection.
 */
export function createFaultHooks(): FaultHooks {
  let nextId = 0;

  function generateId(): FaultHookId {
    nextId += 1;
    return `fault-${nextId.toString(16).padStart(4, '0')}`;
  }

  const commandFailures: FaultInjection[] = [];
  const storageDegradations: StorageDegradation[] = [];

  return Object.freeze({
    injectCommandFailure(commandType: string, error: Error): FaultHookId {
      const id = generateId();
      commandFailures.push(
        Object.freeze({
          id,
          commandType,
          error,
          remaining: null,
        }),
      );
      return id;
    },

    injectStorageDegradation(health: StorageDegradation['health']): FaultHookId {
      const id = generateId();
      storageDegradations.push(
        Object.freeze({
          id,
          health,
          remaining: null,
        }),
      );
      return id;
    },

    checkCommandFailure(commandType: string): Error | null {
      for (let i = commandFailures.length - 1; i >= 0; i -= 1) {
        const injection = commandFailures[i]!;
        if (injection.commandType === commandType) {
          if (injection.remaining !== null) {
            const newRemaining = injection.remaining - 1;
            const updated: FaultInjection = Object.freeze({
              ...injection,
              remaining: newRemaining,
            });
            if (newRemaining <= 0) {
              commandFailures.splice(i, 1);
            } else {
              commandFailures[i] = updated;
            }
          }
          return injection.error;
        }
      }
      return null;
    },

    checkStorageHealth(): StorageDegradation['health'] | null {
      for (let i = storageDegradations.length - 1; i >= 0; i -= 1) {
        const degradation = storageDegradations[i]!;
        if (degradation.remaining !== null) {
          const newRemaining = degradation.remaining - 1;
          const updated: StorageDegradation = Object.freeze({
            ...degradation,
            remaining: newRemaining,
          });
          if (newRemaining <= 0) {
            storageDegradations.splice(i, 1);
          } else {
            storageDegradations[i] = updated;
          }
        }
        return degradation.health;
      }
      return null;
    },

    clear(id: FaultHookId): void {
      const cmdIdx = commandFailures.findIndex((f) => f.id === id);
      if (cmdIdx !== -1) {
        commandFailures.splice(cmdIdx, 1);
        return;
      }
      const storIdx = storageDegradations.findIndex((f) => f.id === id);
      if (storIdx !== -1) {
        storageDegradations.splice(storIdx, 1);
      }
    },

    clearAll(): void {
      commandFailures.length = 0;
      storageDegradations.length = 0;
    },
  });
}

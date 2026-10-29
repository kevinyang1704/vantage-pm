import type { OwnershipEvent, OwnershipIdentity } from './ownership-protocol';

export type HandoffBlockedCause = 'QUEUE_UNRESOLVED' | 'DATABASE_CLOSE_FAILED' | 'VFS_PAUSE_FAILED';

export type HandoffPlan =
  | Readonly<{ type: 'HandoffPermitted'; lockReleased: false }>
  | Readonly<{ type: 'HandoffBlocked'; lockReleased: false; exactCause: HandoffBlockedCause }>;

export function planHandoff(state: Readonly<{
  queueResolved: boolean;
  databaseClosed: boolean;
  vfsPaused: boolean;
}>): HandoffPlan {
  if (!state.queueResolved) return { type: 'HandoffBlocked', lockReleased: false, exactCause: 'QUEUE_UNRESOLVED' };
  if (!state.databaseClosed) return { type: 'HandoffBlocked', lockReleased: false, exactCause: 'DATABASE_CLOSE_FAILED' };
  if (!state.vfsPaused) return { type: 'HandoffBlocked', lockReleased: false, exactCause: 'VFS_PAUSE_FAILED' };
  return { type: 'HandoffPermitted', lockReleased: false };
}

export type HandoffResult =
  | Readonly<{
      type: 'HandoffReleased';
      identity: OwnershipIdentity;
      lockReleased: true;
      writable: false;
      events: readonly OwnershipEvent[];
    }>
  | Readonly<{
      type: 'HandoffBlocked';
      identity: OwnershipIdentity;
      lockReleased: false;
      writable: false;
      exactCause: HandoffBlockedCause;
      events: readonly OwnershipEvent[];
      detail?: string;
    }>;

export async function executeCooperativeHandoff(input: Readonly<{
  identity: OwnershipIdentity;
  stopIntake: () => void;
  resumeIntake: () => void;
  resolveQueue: () => Promise<void>;
  closeStatements: () => Promise<void>;
  closeDatabase: () => Promise<void>;
  pauseVfs: () => Promise<void>;
  releaseWebLock: () => void;
  record?: (event: OwnershipEvent) => void;
}>): Promise<HandoffResult> {
  const events: OwnershipEvent[] = [];
  const record = (event: OwnershipEvent) => {
    events.push(event);
    input.record?.(event);
  };
  input.stopIntake();
  try {
    await input.resolveQueue();
    record('IntakeStopped');
    record('QueueResolved');
  } catch (error) {
    input.resumeIntake();
    return blocked('QUEUE_UNRESOLVED', error);
  }
  try {
    await input.closeStatements();
    record('StatementsClosed');
    await input.closeDatabase();
    record('SQLiteClosed');
  } catch (error) {
    input.resumeIntake();
    return blocked('DATABASE_CLOSE_FAILED', error);
  }
  try {
    await input.pauseVfs();
    record('VfsPaused');
  } catch (error) {
    input.resumeIntake();
    return blocked('VFS_PAUSE_FAILED', error);
  }
  input.releaseWebLock();
  record('WebLockReleased');
  record('FormerOwnerFenced');
  return {
    type: 'HandoffReleased',
    identity: input.identity,
    lockReleased: true,
    writable: false,
    events,
  };

  function blocked(exactCause: HandoffBlockedCause, error: unknown): HandoffResult {
    return {
      type: 'HandoffBlocked',
      identity: input.identity,
      lockReleased: false,
      writable: false,
      exactCause,
      events,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

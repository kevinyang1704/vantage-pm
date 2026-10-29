import { assertUuidV7 } from './command-receipt';

export const REPOSITORY_WRITE_LOCK = 'pmapp-repository-write' as const;

export type OwnershipEvent =
  | 'WebLockAcquired'
  | 'SAHAcquired'
  | 'SQLiteOpened'
  | 'IntegrityVerified'
  | 'ReceiptsReconciled'
  | 'RevisionReconciled'
  | 'OwnerReady'
  | 'IntakeStopped'
  | 'QueueResolved'
  | 'StatementsClosed'
  | 'SQLiteClosed'
  | 'VfsPaused'
  | 'WebLockReleased'
  | 'FormerOwnerFenced'
  | 'OwnershipFailed';

export type OwnershipIdentity = Readonly<{
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
}>;

export type OwnershipSnapshot = OwnershipIdentity & Readonly<{
  state: 'Acquiring' | 'Recovering' | 'OwnerReady' | 'Handoff' | 'Released' | 'Failed';
  writable: boolean;
  eventSequence: number;
  events: readonly OwnershipEvent[];
}>;

export type OwnershipResult =
  | ({ type: 'OwnerReady' } & OwnershipSnapshot)
  | Readonly<{
      type: 'StorageBusy';
      code: 'REPOSITORY_WRITER_BUSY';
      mode: 'read-only-frozen';
      events: readonly OwnershipEvent[];
    }>;

const READY_SEQUENCE: readonly OwnershipEvent[] = [
  'WebLockAcquired',
  'SAHAcquired',
  'SQLiteOpened',
  'IntegrityVerified',
  'ReceiptsReconciled',
  'RevisionReconciled',
] as const;

const HANDOFF_SEQUENCE: readonly OwnershipEvent[] = [
  'IntakeStopped',
  'QueueResolved',
  'StatementsClosed',
  'SQLiteClosed',
  'VfsPaused',
  'WebLockReleased',
  'FormerOwnerFenced',
] as const;

function assertWriterEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_WRITER_EPOCH');
}

export function assertOwnershipIdentity(identity: OwnershipIdentity): void {
  assertUuidV7(identity.contextId, 'contextId');
  assertUuidV7(identity.ownerSessionId, 'ownerSessionId');
  assertWriterEpoch(identity.writerEpoch);
}

function assertExactSequence(actual: readonly OwnershipEvent[], expected: readonly OwnershipEvent[], label: string): void {
  const observed = new Set<OwnershipEvent>();
  for (const event of actual) {
    if (observed.has(event)) throw new Error(`${label}_EVENT_REPEATED:${event}`);
    observed.add(event);
  }
  if (actual.length !== expected.length) throw new Error(`${label}_ORDER_LENGTH`);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label}_ORDER:${String(expected[index])}:${String(actual[index])}`);
    }
  }
}

export function reduceOwnershipEvents(
  events: readonly OwnershipEvent[],
  identity: OwnershipIdentity,
): OwnershipSnapshot {
  const normalized = events.at(-1) === 'OwnerReady' ? events.slice(0, -1) : events;
  assertExactSequence(normalized, READY_SEQUENCE, 'OWNERSHIP');
  return reduceOwnershipLifecycle([...normalized, 'OwnerReady'], identity);
}

export function reduceOwnershipLifecycle(
  events: readonly OwnershipEvent[],
  identity: OwnershipIdentity,
): OwnershipSnapshot {
  assertOwnershipIdentity(identity);
  if (events.length === 0) {
    return Object.freeze({ ...identity, state: 'Acquiring', writable: false, eventSequence: 0, events: [] });
  }
  const failureIndex = events.indexOf('OwnershipFailed');
  if (failureIndex >= 0) {
    if (failureIndex !== events.length - 1) throw new Error('OWNERSHIP_POST_FAILURE_EVENT');
    const prefix = events.slice(0, -1);
    assertLifecyclePrefix(prefix);
    return Object.freeze({ ...identity, state: 'Failed', writable: false, eventSequence: events.length, events: [...events] });
  }
  assertLifecyclePrefix(events);
  const last = events.at(-1)!;
  const state: OwnershipSnapshot['state'] = last === 'FormerOwnerFenced' || last === 'WebLockReleased'
    ? 'Released'
    : HANDOFF_SEQUENCE.includes(last)
      ? 'Handoff'
      : last === 'OwnerReady'
        ? 'OwnerReady'
        : ['IntegrityVerified', 'ReceiptsReconciled', 'RevisionReconciled'].includes(last)
          ? 'Recovering'
          : 'Acquiring';
  return Object.freeze({
    ...identity,
    state,
    writable: state === 'OwnerReady',
    eventSequence: events.length,
    events: Object.freeze([...events]),
  });
}

function assertLifecyclePrefix(events: readonly OwnershipEvent[]): void {
  const expected = [...READY_SEQUENCE, 'OwnerReady', ...HANDOFF_SEQUENCE] as const;
  const observed = new Set<OwnershipEvent>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (observed.has(event)) throw new Error(`OWNERSHIP_EVENT_REPEATED:${event}`);
    observed.add(event);
    if (event !== expected[index]) throw new Error(`OWNERSHIP_ORDER:${String(expected[index])}:${event}`);
  }
}

/** Compatibility entry point retained for the Story 1.1 protocol unit. */
export function evaluateOwnership(webLockAvailable: boolean, events: OwnershipEvent[]): OwnershipResult {
  if (!webLockAvailable) {
    return { type: 'StorageBusy', code: 'REPOSITORY_WRITER_BUSY', mode: 'read-only-frozen', events };
  }
  const required: OwnershipEvent[] = ['WebLockAcquired', 'SAHAcquired', 'SQLiteOpened'];
  if (required.some((event, index) => events[index] !== event)) throw new Error('OWNERSHIP_ORDER_VIOLATION');
  return {
    type: 'OwnerReady',
    contextId: '0198a000-0000-7000-8000-000000000010',
    ownerSessionId: '0198a000-0000-7000-8000-000000000011',
    writerEpoch: 1,
    state: 'OwnerReady',
    writable: true,
    eventSequence: events.length,
    events,
  };
}

export type OwnerCommandAuthorization =
  | Readonly<{ type: 'OwnershipAuthorized'; eventSequence: number }>
  | Readonly<{
      type: 'OwnershipRejected';
      code: 'NOT_CURRENT_REPOSITORY_OWNER';
      resultingState: 'read-only-frozen';
      mutated: false;
    }>;

export function authorizeOwnerCommand(input: Readonly<{
  state: OwnershipSnapshot['state'] | 'NonOwner';
  contextId?: string;
  ownerSessionId?: string;
  writerEpoch?: number;
  currentContextId?: string;
  currentOwnerSessionId?: string;
  currentWriterEpoch?: number;
  eventSequence?: number;
}>): OwnerCommandAuthorization {
  const authorized =
    input.state === 'OwnerReady' &&
    input.contextId !== undefined &&
    input.contextId === input.currentContextId &&
    input.ownerSessionId !== undefined &&
    input.ownerSessionId === input.currentOwnerSessionId &&
    input.writerEpoch !== undefined &&
    input.writerEpoch === input.currentWriterEpoch;
  if (authorized) return { type: 'OwnershipAuthorized', eventSequence: input.eventSequence ?? 0 };
  return {
    type: 'OwnershipRejected',
    code: 'NOT_CURRENT_REPOSITORY_OWNER',
    resultingState: 'read-only-frozen',
    mutated: false,
  };
}

export function verifyCooperativeHandoff(events: OwnershipEvent[]) {
  assertExactSequence(events, HANDOFF_SEQUENCE, 'HANDOFF');
  return { type: 'HandoffVerified' as const, events, formerOwnerWritable: false as const };
}

export const ownershipReadySequence = READY_SEQUENCE;
export const cooperativeHandoffSequence = HANDOFF_SEQUENCE;

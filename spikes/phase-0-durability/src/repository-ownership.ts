import { createUuidV7, assertUuidV7 } from './command-receipt';
import { executeCooperativeHandoff, type HandoffResult } from './cooperative-handoff';
import {
  authorizeOwnerCommand,
  reduceOwnershipEvents,
  REPOSITORY_WRITE_LOCK,
  type OwnershipEvent,
  type OwnershipIdentity,
  type OwnershipSnapshot,
} from './ownership-protocol';
import { SqliteOpfsAdapter, type AdapterInstrumentation, type EffectiveConfiguration } from './sqlite-opfs.adapter';

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export type OwnershipAcquisitionFailureCode =
  | 'WEB_LOCKS_UNAVAILABLE'
  | 'SAH_ACQUIRE_FAILED'
  | 'SQLITE_OPEN_FAILED'
  | 'INTEGRITY_CHECK_FAILED'
  | 'RECONCILIATION_FAILED';

export type StorageBusy = Readonly<{
  type: 'StorageBusy';
  code: 'REPOSITORY_WRITER_BUSY';
  mode: 'read-only-frozen';
  requestId: string;
  contextId: string;
  ownerSessionId: null;
  writerEpoch: null;
  sahOpenAttempts: 0;
  sqliteOpenAttempts: 0;
  writeAttemptsAccepted: 0;
  lifecycleEvents: readonly OwnershipEvent[];
}>;

export type StorageUnavailable = Readonly<{
  type: 'StorageUnavailable';
  code: OwnershipAcquisitionFailureCode;
  mode: 'read-only-frozen';
  requestId: string;
  contextId: string;
  ownerSessionId: string | null;
  writerEpoch: null;
  detail: string;
  lifecycleEvents: readonly OwnershipEvent[];
}>;

export type OwnerEnvelope = Readonly<{
  requestId: string;
  contextId: string;
  ownerSessionId: string;
  writerEpoch: number;
}>;

export class RepositoryOwnership {
  readonly identity: OwnershipIdentity;
  readonly snapshot: OwnershipSnapshot;
  readonly configuration: EffectiveConfiguration;
  readonly authoritativeRevision: number;
  readonly receiptCount: number;
  readonly resultCount: number;
  readonly lifecycleEvents: OwnershipEvent[];
  #accepting = true;
  #acceptedCommands = new Set<Promise<void>>();
  #handoffStarted = false;

  constructor(
    readonly adapter: SqliteOpfsAdapter,
    input: Readonly<{
      identity: OwnershipIdentity;
      snapshot: OwnershipSnapshot;
      configuration: EffectiveConfiguration;
      authoritativeRevision: number;
      receiptCount: number;
      resultCount: number;
      lifecycleEvents: OwnershipEvent[];
      releaseWebLock: () => void;
      record?: (event: OwnershipEvent, eventSequence: number) => void;
    }>,
  ) {
    this.identity = input.identity;
    this.snapshot = input.snapshot;
    this.configuration = input.configuration;
    this.authoritativeRevision = input.authoritativeRevision;
    this.receiptCount = input.receiptCount;
    this.resultCount = input.resultCount;
    this.lifecycleEvents = input.lifecycleEvents;
    this.#releaseWebLock = input.releaseWebLock;
    this.#record = input.record;
  }

  readonly #releaseWebLock: () => void;
  readonly #record?: (event: OwnershipEvent, eventSequence: number) => void;

  authorize(input: Partial<OwnerEnvelope>) {
    return authorizeOwnerCommand({
      state: this.#accepting && !this.#handoffStarted ? 'OwnerReady' : 'Handoff',
      contextId: input.contextId,
      ownerSessionId: input.ownerSessionId,
      writerEpoch: input.writerEpoch,
      currentContextId: this.identity.contextId,
      currentOwnerSessionId: this.identity.ownerSessionId,
      currentWriterEpoch: this.identity.writerEpoch,
      eventSequence: this.lifecycleEvents.length,
    });
  }

  beginCommand(input: Partial<OwnerEnvelope>): ReturnType<RepositoryOwnership['authorize']> & { completion?: () => void } {
    const result = this.authorize(input);
    if (result.type === 'OwnershipAuthorized') {
      let resolve!: () => void;
      const accepted = new Promise<void>((done) => { resolve = done; });
      this.#acceptedCommands.add(accepted);
      return {
        ...result,
        completion: () => {
          resolve();
          this.#acceptedCommands.delete(accepted);
        },
      };
    }
    return result;
  }

  acceptResult(input: Partial<OwnerEnvelope>) {
    return this.authorize(input);
  }

  async beginHandoff(input: Partial<OwnerEnvelope>): Promise<HandoffResult> {
    const authorization = this.authorize(input);
    if (authorization.type !== 'OwnershipAuthorized') {
      return {
        type: 'HandoffBlocked',
        identity: this.identity,
        lockReleased: false,
        writable: false,
        exactCause: 'QUEUE_UNRESOLVED',
        events: [],
        detail: authorization.code,
      };
    }
    if (this.#handoffStarted) return this.blockedHandoff('HANDOFF_ALREADY_STARTED');
    this.#handoffStarted = true;
    const result = await executeCooperativeHandoff({
      identity: this.identity,
      stopIntake: () => { this.#accepting = false; },
      resumeIntake: () => { this.#accepting = true; },
      resolveQueue: async () => {
        const accepted = [...this.#acceptedCommands];
        if (accepted.length) await Promise.all(accepted);
      },
      closeStatements: () => this.adapter.closeStatements(),
      closeDatabase: () => this.adapter.closeDatabase(),
      pauseVfs: () => this.adapter.pauseVfs(),
      releaseWebLock: this.#releaseWebLock,
      record: (event) => {
        this.lifecycleEvents.push(event);
        this.#record?.(event, this.lifecycleEvents.length);
      },
    });
    if (result.type === 'HandoffBlocked' && result.exactCause === 'QUEUE_UNRESOLVED') {
      this.#handoffStarted = false;
      this.#accepting = true;
    }
    return result;
  }

  private blockedHandoff(detail: string): HandoffResult {
    return { type: 'HandoffBlocked', identity: this.identity, lockReleased: false, writable: false,
      exactCause: 'QUEUE_UNRESOLVED', events: [], detail };
  }
}

export type OwnershipAcquisition =
  | Readonly<{ type: 'OwnerReady'; owner: RepositoryOwnership }>
  | StorageBusy
  | StorageUnavailable;

export function adjudicateContender(input: Readonly<{ webLock: Lock | null; events: readonly OwnershipEvent[] }>) {
  if (input.webLock) return null;
  return {
    type: 'StorageBusy',
    code: 'REPOSITORY_WRITER_BUSY',
    mode: 'read-only-frozen',
    sahOpenAttempts: 0,
    sqliteOpenAttempts: 0,
    writeAttemptsAccepted: 0,
  } as const;
}

export function validateOwnershipPolicy(input: Readonly<{ ifAvailable: boolean; mechanisms: readonly string[] }>) {
  const forbidden = new Set(['timeout', 'heartbeat', 'steal', 'lease-expiry', 'queued-lock']);
  if (!input.ifAvailable || input.mechanisms.some((mechanism) => forbidden.has(mechanism))) {
    return { status: 'FAIL' as const, code: 'FORCED_TAKEOVER_FORBIDDEN' as const };
  }
  return { status: 'PASS' as const };
}

export async function acquireRepositoryOwnership(input: Readonly<{
  locks: LockManager | undefined;
  requestId: string;
  contextId: string;
  namespace: string;
  fixture: { projectId: string; initialRevision: number; safeStateHash: string };
  instrumentation?: AdapterInstrumentation;
  adapterFactory?: () => SqliteOpfsAdapter;
  record?: (event: OwnershipEvent, eventSequence: number) => void;
}>): Promise<OwnershipAcquisition> {
  assertUuidV7(input.requestId, 'requestId');
  assertUuidV7(input.contextId, 'contextId');
  if (!input.locks) return unavailable('WEB_LOCKS_UNAVAILABLE', null, [], 'Web Locks API unavailable');
  const acquisition = deferredResult<OwnershipAcquisition>();
  const lifetime = deferred();
  const events: OwnershipEvent[] = [];
  let settled = false;
  const settle = (result: OwnershipAcquisition) => {
    if (!settled) {
      settled = true;
      acquisition.resolve(result);
    }
  };
  void input.locks.request(
    REPOSITORY_WRITE_LOCK,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        settle({
          type: 'StorageBusy', code: 'REPOSITORY_WRITER_BUSY', mode: 'read-only-frozen',
          requestId: input.requestId, contextId: input.contextId, ownerSessionId: null, writerEpoch: null,
          sahOpenAttempts: 0, sqliteOpenAttempts: 0, writeAttemptsAccepted: 0, lifecycleEvents: [],
        });
        return;
      }
      const ownerSessionId = createUuidV7();
      const record = (event: OwnershipEvent) => {
        events.push(event);
        input.record?.(event, events.length);
      };
      record('WebLockAcquired');
      const adapter = (input.adapterFactory ?? (() => new SqliteOpfsAdapter()))();
      try {
        const configuration = await adapter.open({
          namespace: input.namespace,
          ...input.fixture,
          ...(input.instrumentation ? { instrumentation: input.instrumentation } : {}),
          lifecycle: { sahAcquired: () => record('SAHAcquired'), sqliteOpened: () => record('SQLiteOpened') },
        });
        const recovery = adapter.recoverStartup(input.fixture.projectId);
        record('IntegrityVerified');
        record('ReceiptsReconciled');
        record('RevisionReconciled');
        const identity = { contextId: input.contextId, ownerSessionId, writerEpoch: recovery.writerEpoch };
        const snapshot = reduceOwnershipEvents(events, identity);
        record('OwnerReady');
        settle({
          type: 'OwnerReady',
          owner: new RepositoryOwnership(adapter, {
            identity,
            snapshot: { ...snapshot, eventSequence: events.length, events },
            configuration,
            authoritativeRevision: recovery.authoritativeRevision,
            receiptCount: recovery.receiptCount,
            resultCount: recovery.resultCount,
            lifecycleEvents: events,
            releaseWebLock: lifetime.resolve,
            record: input.record,
          }),
        });
        await lifetime.promise;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const code: OwnershipAcquisitionFailureCode = detail.startsWith('INTEGRITY_CHECK_FAILED')
          ? 'INTEGRITY_CHECK_FAILED'
          : detail.startsWith('RECONCILIATION_FAILED')
            ? 'RECONCILIATION_FAILED'
            : events.includes('SAHAcquired') ? 'SQLITE_OPEN_FAILED' : 'SAH_ACQUIRE_FAILED';
        try {
          await adapter.close();
          lifetime.resolve();
          settle(unavailable(code, ownerSessionId, events, detail));
        } catch (teardownError) {
          const teardownDetail = teardownError instanceof Error ? teardownError.message : String(teardownError);
          settle(unavailable(code, ownerSessionId, events, `${detail};TEARDOWN_FAILED:${teardownDetail}`));
          // Fail closed: retain the Web Lock until the worker is externally terminated.
          await lifetime.promise;
        }
      }
    },
  ).catch((error: unknown) => {
    settle(unavailable('WEB_LOCKS_UNAVAILABLE', null, events, error instanceof Error ? error.message : String(error)));
  });
  return acquisition.promise;

  function unavailable(
    code: OwnershipAcquisitionFailureCode,
    ownerSessionId: string | null,
    lifecycleEvents: readonly OwnershipEvent[],
    detail: string,
  ): StorageUnavailable {
    return {
      type: 'StorageUnavailable', code, mode: 'read-only-frozen', requestId: input.requestId,
      contextId: input.contextId, ownerSessionId, writerEpoch: null, detail, lifecycleEvents,
    };
  }
}

function deferredResult<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

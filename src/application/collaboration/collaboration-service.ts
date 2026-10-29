/**
 * Collaboration service (Story 27.6/27.7, D1/R4).
 *
 * Composes the pure sync-client core with a transport and a durable outbox into
 * one object the app can hold when the `collaboration` flag is on. The decision
 * logic stays pure; the transport stays an injected port.
 *
 * It is NOT composed for a local project: `createCollaborationService` is only
 * ever called behind `isCollaborationEnabled()`, and even then only after the
 * user explicitly shares a project (27.6).
 */

import type { RecoveryEnvelope, ConfirmedHistoryEntry } from '../../contracts/collaboration-recovery';
import { validateRecoveryEnvelope, validateConfirmedHistoryEntry, recoveryPayloadDigest } from '../../contracts/collaboration-recovery.validation';
import type { ProductCommand, ProductCommandResult } from '../../contracts/repository-commands';
import {
  applyStreamFrame,
  emptyOutbox,
  needsResync,
  queueEdit,
  rebasePending,
  reconnectDelayMs,
  type OutboxEntry,
  type OutboxState,
  type StreamFrame,
} from './sync-client';
import type { CollaborationTransport, WebSocketLike, AuthHeaders } from '../../adapters/platform/collaboration-transport';
import type { MergeState } from '../../domain/collaboration/rebase';

/** The minimal repository surface the sync client needs (AD-3/AD-4).
 *
 * Runtime-neutral: the browser and native adapters implement it. The two
 * operations that must be atomic are explicit, so the service never commits a
 * local edit and its outbox entry in separate transactions, and never applies a
 * rebase as individually-visible commits (R4/H04).
 */
export interface SyncRepository {
  readOutbox(projectId: string): Promise<OutboxState>;
  discardOutboxEntry(projectId: string, commandId: string): Promise<void>;
  /** Install confirmed state, rebase pending work, and persist cursor atomically. */
  installSnapshot: (projectId: string, snapshot: RecoveryEnvelope) => Promise<OutboxState>;
  /**
   * Commit a locally applied command AND its durable outbox entry in ONE
   * repository operation, before acknowledgement (R4/H04). Returns false when
   * the repository rejected the command (a rejection is not queued).
   */
  commitWithOutbox(
    projectId: string,
    command: ProductCommand,
    outboxEntry: OutboxEntry,
  ): Promise<{ applied: boolean; rejectedReason?: string; result: ProductCommandResult }>;

  /**
   * A composite gesture (Story 27.2): apply every member and write every
   * outbox entry (sharing one group id) in ONE repository operation. A refused
   * member commits nothing; `results` then holds that refusal alone.
   */
  commitGroupWithOutbox(
    projectId: string,
    commands: readonly ProductCommand[],
    entries: readonly OutboxEntry[],
  ): Promise<{ applied: boolean; rejectedReason?: string; results: readonly ProductCommandResult[] }>;

  /**
   * One recoverable rebase operation (R4/H04): remove rejected pending entries,
   * apply the confirmed remote command (unless own echo), and re-apply the
   * surviving pending commands, persisting their bumped outbox entries — all as
   * a single repository operation so readers never see a partial rebase.
   *
   * Returns `resyncRequired: true` when the confirmed remote command could not be
   * applied locally (the client diverged from the server log); the caller must
   * then request a fresh snapshot rather than trusting the advanced cursor.
   */
  applyRebase(
    projectId: string,
    remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch: number; historyEntry: ConfirmedHistoryEntry }>,
    toReapply: readonly OutboxEntry[],
    rejected: readonly Readonly<{ commandId: string; reason: string }>[],
  ): Promise<{ resyncRequired: boolean; state?: OutboxState }>;

  /** The current canonical merge state for the pure rebase. */
  mergeState(projectId: string): MergeState;
}

export interface CollaborationServiceDeps {
  projectId: string;
  deviceId: string;
  transport: CollaborationTransport;
  repository: SyncRepository;
  /**
   * Produces the authentication headers for a request: method + path + body
   * bytes in, headers out. Desktop returns a bearer; browser returns a
   * proof-of-possession (nonce/timestamp/signature) over the same bytes (H01).
   */
  authenticate: (input: {
    method: string;
    path: string;
    bodyBytes: Uint8Array;
  }) => Promise<AuthHeaders>;
  nowISO: () => string;
  /** Called when a rejected edit should appear in the panel (R8/TC-UX3). */
  onRejected?: (commandId: string, reason: string) => void;
  /** Called when a snapshot/gap requires replacing local state (R5). */
  onResync?: (snapshot: unknown) => void;
  /**
   * A teammate's confirmed command was applied locally (not an own echo), with
   * the ids it touched (command ids plus the server's authoritative effect
   * footprint when available). Feeds shared undo eligibility (R9).
   */
  onRemoteCommand?: (command: ProductCommand, actorId: string | null, targetIds: readonly string[]) => void;
  /** An authoritative snapshot replaced local state (undo history is stale). */
  onAuthoritativeReplace?: () => void;
  /** Called after any change to queue state, readiness or terminal status (H08). */
  onStateChange?: () => void;
  /** Timer hooks (injectable so reconnect is testable without real timers). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Why the service stopped for good, if it did. */
export type CollaborationTerminal = 'revoked' | 'update-required' | null;

export class CollaborationService {
  private currentState: OutboxState;
  private ready = false;
  private terminalStatus: CollaborationTerminal = null;

  private get state(): OutboxState { return this.currentState; }
  private set state(value: OutboxState) { this.currentState = value; this.deps.onStateChange?.(); }
  private get submissionReady(): boolean { return this.ready; }
  private set submissionReady(value: boolean) {
    if (this.ready === value) return;
    this.ready = value;
    this.deps.onStateChange?.();
  }
  private socket: WebSocketLike | null = null;
  /** Serializes stream processing so frames never interleave (R4). */
  private frameQueue: Promise<void> = Promise.resolve();
  /** Set when the caller has stopped reconnecting (leave/stop-sharing). */
  private stopped = false;
  private reconnectTimer: unknown = null;
  /** A pending-work resubmission scheduled after a failed send. */
  private submitRetryTimer: unknown = null;
  private submitRetryAttempt = 0;
  /** Monotonic token: only the current connection's callbacks may act. */
  private streamGeneration = 0;

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.reconnectTimer);
    else globalThis.clearTimeout(this.reconnectTimer as ReturnType<typeof globalThis.setTimeout>);
    this.reconnectTimer = null;
  }

  private constructor(private readonly deps: CollaborationServiceDeps, state: OutboxState) {
    this.currentState = state;
  }

  static async create(deps: CollaborationServiceDeps): Promise<CollaborationService> {
    return new CollaborationService(deps, await deps.repository.readOutbox(deps.projectId));
  }

  getState(): OutboxState {
    return this.state;
  }

  /** True once a validated ready cut admits submissions on the live stream. */
  isConnected(): boolean { return this.ready; }

  terminal(): CollaborationTerminal { return this.terminalStatus; }

  /**
   * Discard a rejected edit: remove it from memory and the durable queue (R8,
   * TC-UX3). Discarding dismisses rejected work, never confirmed state.
   */
  discardRejected(commandId: string): Promise<void> {
    const operation = this.frameQueue.then(() => this.discardEntry(commandId));
    this.frameQueue = operation.catch(() => undefined);
    return operation;
  }

  private async discardEntry(commandId: string): Promise<void> {
    await this.deps.repository.discardOutboxEntry(this.deps.projectId, commandId);
    // The durable journal is the truth for retained rejections and quarantine.
    this.state = await this.deps.repository.readOutbox(this.deps.projectId);
  }

  /**
   * Record a locally committed edit through the repository in ONE operation that
   * also writes the durable outbox entry (R4/H04), then submit. A domain
   * rejection is surfaced; a lost acknowledgement leaves the entry queued.
   */
  onLocalEdit(command: ProductCommand): Promise<void> {
    const operation = this.frameQueue.then(() => this.commitLocalEdit(command));
    this.frameQueue = operation.catch(() => undefined);
    return operation;
  }

  private async commitLocalEdit(command: ProductCommand): Promise<void> {
    const committed = await this.commitOnly(command);
    if (committed.applied) await this.submitPending(command);
  }

  /**
   * App dispatch path for a shared project (H08): commit the edit and its
   * durable outbox entry atomically, return the local result as soon as that
   * commit lands (the read model, undo and analysis track it like a local
   * edit), then submit in the same serialized queue. The UI never waits on the
   * network, and a lost acknowledgement leaves the entry queued.
   */
  applyLocalEdit(command: ProductCommand): Promise<ProductCommandResult> {
    const committed = this.frameQueue.then(() => this.commitOnly(command));
    this.frameQueue = committed
      .then((outcome) => (outcome.applied ? this.submitPending(command) : undefined))
      .catch(() => undefined);
    return committed.then((outcome) => outcome.result);
  }

  /**
   * A composite gesture on a shared project (Story 27.2): commit every member
   * and its outbox entry atomically (one group id), return the local results
   * once that commit lands, then submit the members to the service as ONE
   * all-or-nothing group. A refused member commits nothing locally.
   */
  applyLocalGroup(commands: readonly ProductCommand[]): Promise<readonly ProductCommandResult[]> {
    const committed = this.frameQueue.then(() => this.commitGroupOnly(commands));
    this.frameQueue = committed
      .then((outcome) => (outcome.applied ? this.submitGroup(outcome.entries) : undefined))
      .catch(() => undefined);
    return committed.then((outcome) => outcome.results);
  }

  private async commitGroupOnly(commands: readonly ProductCommand[]): Promise<{ applied: boolean; results: readonly ProductCommandResult[]; entries: readonly OutboxEntry[] }> {
    if (commands.length === 0) return { applied: true, results: Object.freeze([]), entries: Object.freeze([]) };
    // The first member's id is unique and stable: it names the group.
    const groupId = commands[0].commandId;
    const queuedAtISO = this.deps.nowISO();
    const entries: readonly OutboxEntry[] = Object.freeze(commands.map((command, groupIndex) => Object.freeze({
      commandId: command.commandId, command, commitAttemptId: 1, queuedAtISO, groupId, groupIndex,
    })));
    const committed = await this.deps.repository.commitGroupWithOutbox(this.deps.projectId, commands, entries);
    if (!committed.applied) return { applied: false, results: committed.results, entries };
    this.state = entries.reduce((state, entry) => queueEdit(state, entry), this.state);
    return { applied: true, results: committed.results, entries };
  }

  private async submitGroup(entries: readonly OutboxEntry[]): Promise<void> {
    const epoch = this.state.streamEpoch;
    if (entries.length === 0 || !this.submissionReady || this.state.recoveryRequired || epoch == null || this.stopped) return;
    const commands = entries.map((entry) => entry.command);
    try {
      const path = `/projects/${this.deps.projectId}/command-group`;
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ recoveryVersion: 1, streamEpoch: epoch, commands }));
      const auth = await this.deps.authenticate({ method: 'POST', path, bodyBytes });
      const outcome = await this.deps.transport.submitGroup(this.deps.projectId, commands, auth, epoch);
      if (outcome.recoveryReason) {
        this.requireManualRecovery(outcome.recoveryReason);
        return;
      }
      if (outcome.resyncRequired || (outcome.accepted && outcome.streamEpoch !== epoch)) {
        this.submissionReady = false;
        this.requestResync();
        return;
      }
      if (!outcome.accepted) {
        // An HTTP failure (e.g. a 5xx) that is not a resync: keep the work queued and retry.
        this.scheduleSubmitRetry();
        return;
      }
      if (outcome.accepted && !outcome.applied) {
        // The service refused the whole gesture and recorded a terminal
        // rejection for every member; the recovery snapshot retains them all
        // as rejected work and restores the authoritative graph (gate 5).
        this.deps.onRejected?.(commands[0].commandId, rejectionReason(outcome.result));
        this.submissionReady = false;
        this.requestResync();
      }
      this.submitRetryAttempt = 0;
    } catch {
      // Network/auth availability does not undo an acknowledged local commit;
      // the stream may stay open across a brief drop, so retry the queue.
      this.scheduleSubmitRetry();
    }
  }

  /**
   * Resubmit queued work after a failed send, with backoff. A transport error
   * on POST does not close the stream, so without this a queued edit would
   * wait for the next reconnect. Resubmitting is idempotent on the service.
   */
  private scheduleSubmitRetry(): void {
    if (this.stopped || this.submitRetryTimer !== null) return;
    const delay = reconnectDelayMs(this.submitRetryAttempt);
    this.submitRetryAttempt += 1;
    const generation = this.streamGeneration;
    const setTimer = this.deps.setTimer ?? globalThis.setTimeout;
    this.submitRetryTimer = setTimer(() => {
      this.submitRetryTimer = null;
      if (this.stopped || generation !== this.streamGeneration || !this.submissionReady) return;
      this.frameQueue = this.frameQueue.then(() => this.submitAllPending(generation)).catch(() => undefined);
    }, delay);
  }

  private clearSubmitRetry(): void {
    if (this.submitRetryTimer === null) return;
    if (this.deps.clearTimer) this.deps.clearTimer(this.submitRetryTimer);
    else globalThis.clearTimeout(this.submitRetryTimer as ReturnType<typeof globalThis.setTimeout>);
    this.submitRetryTimer = null;
  }

  /** Pending work in submission units: single edits, and each gesture once. */
  private async submitAllPending(generation: number): Promise<void> {
    const submittedGroups = new Set<string>();
    for (const entry of this.state.entries) {
      if (generation !== this.streamGeneration || this.stopped) break;
      if (entry.groupId === undefined) { await this.submitPending(entry.command); continue; }
      if (submittedGroups.has(entry.groupId)) continue;
      submittedGroups.add(entry.groupId);
      await this.submitGroup(this.state.entries.filter((member) => member.groupId === entry.groupId));
    }
  }

  private async commitOnly(command: ProductCommand): Promise<{ applied: boolean; result: ProductCommandResult }> {
    const entry: OutboxEntry = Object.freeze({
      commandId: command.commandId,
      command,
      commitAttemptId: 1,
      queuedAtISO: this.deps.nowISO(),
    });
    // Atomic local commit + outbox, via the repository port (R4/H04).
    const committed = await this.deps.repository.commitWithOutbox(this.deps.projectId, command, entry);
    if (!committed.applied) {
      this.deps.onRejected?.(command.commandId, committed.rejectedReason ?? 'The edit was not applied.');
      return { applied: false, result: committed.result };
    }
    this.state = queueEdit(this.state, entry);
    return { applied: true, result: committed.result };
  }

  private async submitPending(command: ProductCommand): Promise<void> {
    const epoch = this.state.streamEpoch;
    if (!this.submissionReady || this.state.recoveryRequired || epoch == null || this.stopped) return;
    try {
      const path = `/projects/${this.deps.projectId}/commands`;
      const bodyBytes = new TextEncoder().encode(JSON.stringify({ recoveryVersion: 1, streamEpoch: epoch, command }));
      const auth = await this.deps.authenticate({ method: 'POST', path, bodyBytes });
      const outcome = await this.deps.transport.submit(this.deps.projectId, command, auth, epoch);
      if (outcome.recoveryReason) {
        this.requireManualRecovery(outcome.recoveryReason);
        return;
      }
      if (outcome.resyncRequired || (outcome.accepted && outcome.streamEpoch !== epoch)) {
        this.submissionReady = false;
        this.requestResync();
        return;
      }
      if (!outcome.accepted) {
        // An HTTP failure (e.g. a 5xx) that is not a resync: keep the work queued and retry.
        this.scheduleSubmitRetry();
        return;
      }
      // Keep identity until ordered replay, including when a POST acknowledgement
      // precedes older remote frames. Transport failures retain durable work.
      if (outcome.accepted && !outcome.applied) {
        // A definitive server rejection never produces a stream frame, so the
        // optimistic edit would stay queued forever. The recovery snapshot
        // carries the server's terminal rejections; installing it atomically
        // retains this work as rejected, restores the authoritative graph and
        // replays the remaining pending edits (gate 5).
        this.deps.onRejected?.(command.commandId, rejectionReason(outcome.result));
        this.submissionReady = false;
        this.requestResync();
      }
      this.submitRetryAttempt = 0;
    } catch {
      // Network/auth availability does not undo an acknowledged local commit;
      // the stream may stay open across a brief drop, so retry the queue.
      this.scheduleSubmitRetry();
    }
  }

  /** Connect the ordered stream, resuming from the last acknowledged revision.
   * On drop, reconnects with exponential backoff unless explicitly stopped. */
  async connect(): Promise<void> {
    this.stopped = false;
    // If the durable queue holds a corrupt row (or a prior frame forced a
    // resync), resume with `since = 0` so the server sends a full snapshot
    // rather than a suffix that may be missing the unreadable work (H05).
    const since = needsResync(this.state) ? 0 : this.state.cursor;
    await this.openStream(0, since);
  }

  private async openStream(attempt: number, since: number): Promise<void> {
    if (this.stopped) return;
    // A generation token invalidates the callbacks of any superseded socket, so
    // a deliberate resync close cannot race a reconnect timer (H-review/r3).
    this.submissionReady = false;
    const generation = ++this.streamGeneration;
    // Authenticate per connection attempt: a browser nonce is single-use and a
    // timestamp is only fresh for a window, so a reused proof would fail on the
    // first reconnect (H01).
    const path = `/projects/${this.deps.projectId}/stream`;
    let auth;
    try {
      auth = await this.deps.authenticate({ method: 'GET', path, bodyBytes: new Uint8Array() });
    } catch {
      if (generation === this.streamGeneration) this.scheduleReconnect(attempt, since);
      return;
    }
    if (this.stopped || generation !== this.streamGeneration) return;
    this.socket = this.deps.transport.openStream(
      this.deps.projectId,
      since,
      auth,
      (frame) => {
        if (generation !== this.streamGeneration) return;
        // Serialize so two frames cannot both rebase against pre-await state;
        // a failure must not poison the chain for later frames.
        this.frameQueue = this.frameQueue
          .then(() => { if (generation === this.streamGeneration && !this.stopped) return this.onFrame(frame); })
          .catch(() => {
            this.state = Object.freeze({ ...this.state, resyncRequired: true });
            this.deps.onRejected?.(frame.command.commandId, 'Stream processing failed.');
            this.requestResync();
          });
      },
      () => {
        if (generation !== this.streamGeneration) return;
        this.socket = null;
        this.submissionReady = false;
        // Reconnect with backoff (R4/H05): a transient drop must not end sync
        // for the session. A new connection resumes from the current cursor
        // (or requests a resync when one is required).
        this.scheduleReconnect(attempt, this.state.cursor);
      },
      (snapshot) => {
        if (generation !== this.streamGeneration) return;
        this.submissionReady = false;
        if (snapshot === null || snapshot === undefined) {
          this.state = Object.freeze({ ...this.state, resyncRequired: true });
          this.requestResync();
          return;
        }
        this.frameQueue = this.frameQueue.then(async () => {
          if (generation !== this.streamGeneration) return;
          const envelope = await validateRecoveryEnvelope(snapshot, this.deps.projectId);
          if (generation !== this.streamGeneration) return;
          const installed = await this.deps.repository.installSnapshot(this.deps.projectId, envelope);
          if (generation !== this.streamGeneration || this.stopped) return;
          this.state = installed;
          this.deps.onAuthoritativeReplace?.();
          this.deps.onResync?.(snapshot);
        }).catch(() => {
          this.state = Object.freeze({ ...this.state, resyncRequired: true });
          this.disconnect();
          this.deps.onRejected?.('', 'The team snapshot could not be installed. Your pending edits are retained.');
        });
      },
      () => {
        if (generation !== this.streamGeneration) return;
        // Access was revoked (H06): stop for good; do not reconnect.
        this.terminalStatus = 'revoked';
        this.disconnect();
        this.deps.onRejected?.('', 'Your access to this project was removed.');
      },
      undefined,
      (needsResync(this.state) ? null : this.state.streamEpoch) ?? null,
      (ready) => {
        if (generation !== this.streamGeneration || this.stopped) return;
        this.frameQueue = this.frameQueue.then(async () => {
          if (generation !== this.streamGeneration || this.stopped) return;
          if (this.state.recoveryRequired || this.state.streamEpoch !== ready.streamEpoch
            || this.state.cursor !== ready.serverRevision || this.state.resyncRequired) {
            this.submissionReady = false;
            if (!this.state.recoveryRequired) this.requestResync();
            return;
          }
          this.submissionReady = true;
          await this.submitAllPending(generation);
        }).catch(() => undefined);
      },
      () => {
        if (generation !== this.streamGeneration) return;
        this.terminalStatus = 'update-required';
        this.disconnect();
        this.deps.onRejected?.('', 'Update required to recover this shared project. Your pending edits are retained.');
      },
      (reason) => { if (generation === this.streamGeneration) this.requireManualRecovery(reason); },
    );
  }

  private requireManualRecovery(reason: string): void {
    this.disconnect();
    this.state = Object.freeze({ ...this.state, recoveryRequired: true, recoveryReason: reason, resyncRequired: true });
    this.deps.onRejected?.('', reason);
  }

  /** Schedule one reconnect, clearing any pending timer first (H05). */
  private scheduleReconnect(attempt: number, since: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== null) {
      this.clearReconnectTimer();
    }
    const delay = reconnectDelayMs(attempt);
    const setTimer = this.deps.setTimer ?? globalThis.setTimeout;
    this.reconnectTimer = setTimer(() => {
        this.reconnectTimer = null;
        void this.openStream(attempt + 1, needsResync(this.state) ? 0 : this.state.cursor);
      }, delay);
  }

  /** Stop reconnecting and close the stream. */
  disconnect(): void {
    this.stopped = true;
    this.submissionReady = false;
    this.clearSubmitRetry();
    this.streamGeneration += 1;
    if (this.reconnectTimer !== null) {
      this.clearReconnectTimer();
    }
    this.socket?.close();
    this.socket = null;
  }

  private async onFrame(frame: StreamFrame): Promise<void> {
    // A frame for another project must never mutate this repository.
    if (frame.command.projectId !== this.deps.projectId) return;

    const history = await validateConfirmedHistoryEntry(frame.historyEntry, this.deps.projectId);
    if (history.serverRevision !== frame.serverRevision || history.command.commandId !== frame.command.commandId
      || await recoveryPayloadDigest(history.command) !== await recoveryPayloadDigest(frame.command)) {
      throw new Error('RECOVERY_FRAME_BINDING_INVALID');
    }
    const result = applyStreamFrame(this.state, frame);
    if (result.kind !== 'advance') {
      if (result.kind === 'resync') {
        this.state = result.state;
        this.deps.onResync?.(null);
        this.requestResync();
      }
      return;
    }

    const mergeState = this.deps.repository.mergeState(this.deps.projectId);
    const { toReapply, rejected } = rebasePending(result.state, [frame.command], mergeState);
    for (const r of rejected) {
      this.deps.onRejected?.(r.entry.commandId, r.reason);
    }

    // One recoverable rebase operation (R4/H04): rejected entries removed,
    // confirmed remote applied (unless own echo), survivors re-applied, all as a
    // single repository operation. Own-command identity is kept through the
    // authoritative ordered replay (own echo), so a toggle is never doubled.
    const rebase = await this.deps.repository.applyRebase(
      this.deps.projectId,
      { command: frame.command, ownEcho: result.ownEcho, serverRevision: frame.serverRevision, streamEpoch: frame.streamEpoch, historyEntry: history },
      toReapply,
      rejected.map((r) => ({ commandId: r.entry.commandId, reason: r.reason })),
    );
    if (rebase.resyncRequired) {
      // The confirmed remote command did not apply locally: we have diverged.
      // Flag a resync and reconnect from `since = 0` so a snapshot replaces the
      // divergent state (H-review/r3).
      this.state = Object.freeze({ ...this.state, resyncRequired: true });
      this.requestResync();
      return;
    }
    this.state = rebase.state ?? Object.freeze({
      ...result.state,
      entries: Object.freeze(toReapply),
    });
    if (!result.ownEcho) this.deps.onRemoteCommand?.(frame.command, history.actorId, remoteTargets(frame.command, history));
  }

  /**
   * Force a fresh snapshot: close the current stream and reconnect from
   * `since = 0`, so the server sends a full snapshot that replaces divergent
   * state (R5, H05).
   */
  private requestResync(): void {
    if (this.stopped) return;
    this.submissionReady = false;
    this.state = Object.freeze({ ...this.state, resyncRequired: true });
    const socket = this.socket;
    this.socket = null;
    this.streamGeneration += 1;
    socket?.close();
    if (this.reconnectTimer !== null) {
      this.clearReconnectTimer();
    }
    void this.openStream(0, 0);
  }
}

/** Ids a confirmed command touched: its own target ids plus known effects. */
export function remoteTargets(command: ProductCommand, history: ConfirmedHistoryEntry): readonly string[] {
  const ids = new Set<string>();
  const fields = command as unknown as Record<string, unknown>;
  for (const key of ['nodeId', 'featureId', 'phaseId', 'questionId', 'personId', 'edgeId', 'scenarioId', 'parentId', 'targetNodeId', 'sourceNodeId']) {
    const value = fields[key];
    if (typeof value === 'string') ids.add(value);
  }
  for (const footprint of [history.commandFootprint, history.effectFootprint]) {
    if (footprint.availability !== 'complete') continue;
    for (const target of footprint.knownTargets) {
      if (target.kind === 'order') ids.add(target.ownerId);
      else if (target.kind === 'reference') { ids.add(target.sourceId); ids.add(target.targetId); }
      else ids.add(target.id);
    }
  }
  return Object.freeze([...ids]);
}

function rejectionReason(result: unknown): string {
  const code = (result as { code?: string } | undefined)?.code;
  switch (code) {
    case 'FORECAST_ASSIGNMENT_CONFLICT':
      return 'A teammate changed this at the same time.';
    case 'FORECAST_SCOPE_INVALID':
      return 'This item is no longer in the forecast.';
    case 'REVISION_CONFLICT':
      return 'The project changed before this reached the team.';
    default:
      return 'A teammate changed this first.';
  }
}

/** Create the service with an explicit project + device (flag-on, shared only). */
export function createCollaborationService(deps: CollaborationServiceDeps): Promise<CollaborationService> {
  return CollaborationService.create(deps);
}

/** A local project uses the empty outbox and never composes the service (AD-20). */
export function localOutbox(): OutboxState {
  return emptyOutbox();
}

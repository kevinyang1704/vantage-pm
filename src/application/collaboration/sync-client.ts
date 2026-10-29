/**
 * Sync client core (Story 27.7, D1/R4/R5/R8, AD-3/AD-4/AD-18).
 *
 * The sync client sits in the TypeScript layer ABOVE the repository clients, so
 * the desktop and browser builds share it. Remote commands enter only through
 * the repository (AD-3). This module is the pure, deterministic core:
 *
 * - the durable **outbox**: local edits commit with a durable queue entry
 *   before acknowledgement (R4); a crash with a non-empty queue loses nothing;
 * - the **stream cursor**: the last acknowledged server revision; a gap yields
 *   `ResyncRequired`; verified duplicates are ignored;
 * - the **rebase** orchestration: when confirmed remote commands arrive while
 *   local commands are unconfirmed, roll back (via inverse ChangeSets), apply
 *   remote, re-apply local under the 27.3 pure `rebase`.
 *
 * I/O (SQLite, WebSocket, HTTP) is injected as ports so this stays testable and
 * framework-free (AD-1).
 */

import type { ConfirmedHistoryEntry } from '../../contracts/collaboration-recovery';
import type { ProductCommand } from '../../contracts/repository-commands';
import { rebase, type MergeState } from '../../domain/collaboration/rebase';

/** The largest offline queue the client warns at (D9); beyond it, warn, never drop. */
export const OFFLINE_QUEUE_WARN = 5000;
/** The offline window in milliseconds (D9: 30 days). */
export const OFFLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type OutboxEntry = Readonly<{
  /** Stable command id for the service (kept across a rollback/re-apply). */
  commandId: string;
  command: ProductCommand;
  /** Local commit attempt; bumped on a rollback/re-apply (R2/R4). */
  commitAttemptId: number;
  /** When the edit committed locally. */
  queuedAtISO: string;
  /**
   * Members of one composite gesture share a group id (Story 27.2): they are
   * submitted together, applied by the service all-or-nothing, and rejected
   * together on rebase. Absent for an ordinary single edit.
   */
  groupId?: string;
  /** Position within the composite gesture (0-based); set with `groupId`. */
  groupIndex?: number;
}>;

/** Reason shown for group members refused because another member was. */
export const GROUP_MEMBER_REJECTED_REASON = 'Part of a grouped edit that could not be applied.';

export type OutboxState = Readonly<{
  entries: readonly OutboxEntry[];
  /** Complete recoverable terminal work, outside the active queue. */
  rejected?: readonly Readonly<OutboxEntry & { reason: string }>[];
  /** The last acknowledged server revision (stream cursor). */
  cursor: number;
  streamEpoch: number | null;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  /** True when the client must resync (a gap or an expired window). */
  resyncRequired: boolean;
  /** Command ids quarantined because their stored JSON could not be read (H05). */
  corrupt?: readonly string[];
}>;

export function emptyOutbox(): OutboxState {
  return Object.freeze({ entries: Object.freeze([]), cursor: 0, streamEpoch: null, recoveryRequired: false, recoveryReason: null, resyncRequired: true, corrupt: Object.freeze([]) });
}

/** Queue a locally committed edit (durable, before acknowledgement). */
export function queueEdit(state: OutboxState, entry: OutboxEntry): OutboxState {
  return Object.freeze({
    ...state,
    entries: Object.freeze([...state.entries, entry]),
  });
}

export interface QueueHealth {
  /** Whether the queue is at/over the warning threshold (never drops). */
  readonly warn: boolean;
  readonly size: number;
  /** Whether the oldest unconfirmed edit is older than the offline window. */
  readonly expired: boolean;
}

export function queueHealth(state: OutboxState, nowISO: string): QueueHealth {
  const now = Date.parse(nowISO);
  const oldest = state.entries.reduce<number>((min, e) => {
    const t = Date.parse(e.queuedAtISO);
    return Number.isFinite(t) ? Math.min(min, t) : min;
  }, Number.POSITIVE_INFINITY);
  return Object.freeze({
    warn: state.entries.length >= OFFLINE_QUEUE_WARN,
    size: state.entries.length,
    expired: Number.isFinite(now) && Number.isFinite(oldest) && now - oldest > OFFLINE_WINDOW_MS,
  });
}

/** Confirm an edit: remove it from the outbox and advance the cursor. */
export function confirmEdit(state: OutboxState, commandId: string, serverRevision: number): OutboxState {
  return Object.freeze({
    ...state,
    entries: Object.freeze(state.entries.filter((e) => e.commandId !== commandId)),
    cursor: serverRevision,
  });
}

/**
 * A frame from the stream. A frame at `cursor + 1` advances; a frame at or
 * below the cursor is a verified duplicate (ignored); anything higher is a gap
 * requiring resync (mirrors the worker protocol).
 */
export type StreamFrame = Readonly<{
  serverRevision: number;
  streamEpoch: number;
  historyEntry: ConfirmedHistoryEntry;
  command: ProductCommand;
  /** The exact command ids the server applied, for own-echo detection. */
  appliedCommandIds: readonly string[];
}>;

export type StreamResult =
  | Readonly<{ kind: 'advance'; state: OutboxState; ownEcho: boolean }>
  | Readonly<{ kind: 'duplicate'; state: OutboxState }>
  | Readonly<{ kind: 'resync'; state: OutboxState }>;

export function applyStreamFrame(state: OutboxState, frame: StreamFrame): StreamResult {
  if (state.recoveryRequired || state.streamEpoch == null || frame.streamEpoch !== state.streamEpoch
    || !Number.isSafeInteger(frame.streamEpoch) || frame.streamEpoch <= 0) {
    return Object.freeze({ kind: 'resync', state: Object.freeze({ ...state, resyncRequired: true }) });
  }
  if (frame.serverRevision <= state.cursor) {
    return Object.freeze({ kind: 'duplicate', state });
  }
  if (frame.serverRevision !== state.cursor + 1) {
    // A gap → resync. Never apply out-of-order.
    return Object.freeze({ kind: 'resync', state: Object.freeze({ ...state, resyncRequired: true }) });
  }
  // Own echo: remove the pending entry without applying its effect twice; the
  // authoritative replay already happened on the server.
  const ownEcho = state.entries.some((e) => frame.appliedCommandIds.includes(e.commandId));
  let next = Object.freeze({ ...state, cursor: frame.serverRevision });
  for (const id of frame.appliedCommandIds) {
    next = confirmEdit(next, id, frame.serverRevision);
  }
  return Object.freeze({ kind: 'advance', state: next, ownEcho });
}

/**
 * Rebase local pending commands against a batch of confirmed remote commands.
 * Pure: returns the surviving pending commands (bumped commit attempt) and the
 * rejected ones with named reasons, using the 27.3 pure `rebase`.
 */export function rebasePending(
  state: OutboxState,
  confirmed: readonly ProductCommand[],
  mergeState: MergeState,
): Readonly<{
  toReapply: readonly OutboxEntry[];
  rejected: readonly Readonly<{ entry: OutboxEntry; reason: string; command: ProductCommand }>[];
}> {
  const decision = rebase(state.entries.map((e) => e.command), confirmed, mergeState);
  const byId = new Map(state.entries.map((e) => [e.commandId, e]));
  const rejectedIds = new Set(decision.rejected.map((r) => r.command.commandId));
  // A composite gesture is atomic: one refused member refuses the whole group.
  const rejectedGroups = new Set(state.entries
    .filter((e) => e.groupId !== undefined && rejectedIds.has(e.commandId))
    .map((e) => e.groupId));
  const groupRefused = (e: OutboxEntry): boolean => e.groupId !== undefined && rejectedGroups.has(e.groupId);

  const rejected = state.entries
    .filter((e) => rejectedIds.has(e.commandId) || groupRefused(e))
    .map((entry) => {
      const r = decision.rejected.find((x) => x.command.commandId === entry.commandId);
      return Object.freeze({ entry, reason: r?.reason ?? GROUP_MEMBER_REJECTED_REASON, command: entry.command });
    });

  const toReapply = decision.toReapply.filter((command) => !groupRefused(byId.get(command.commandId)!)).map((command) => {
    const entry = byId.get(command.commandId)!;
    // A rolled-back and re-applied command keeps its commandId for the service
    // but gets a NEW local commit attempt (R4), so local idempotency never
    // returns the pre-rollback result.
    return Object.freeze({ ...entry, commitAttemptId: entry.commitAttemptId + 1, command });
  });

  return Object.freeze({ toReapply: Object.freeze(toReapply), rejected: Object.freeze(rejected) });
}

// -- Reconnect policy (Story 27.7, R4/H05) -----------------------------------

/** Base reconnect delay and cap for exponential backoff. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * The delay before the next reconnect attempt: exponential backoff on the
 * attempt number, capped, with optional jitter (0..1) to avoid a thundering
 * herd across many devices. `attempt` is 0-based (first retry after a drop).
 */
export function reconnectDelayMs(attempt: number, jitter = 0): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  const jittered = base * (0.5 + 0.5 * Math.min(1, Math.max(0, jitter)));
  return Math.round(Math.min(RECONNECT_MAX_MS, jittered));
}

/** Whether a resync (fresh snapshot) is required rather than a suffix resume. */
export function needsResync(state: OutboxState): boolean {
  return state.streamEpoch == null || state.recoveryRequired === true || state.resyncRequired === true || (state.corrupt?.length ?? 0) > 0;
}

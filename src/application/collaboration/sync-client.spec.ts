import { historyFixture } from './recovery-fixtures.test-only';
import { describe, expect, it } from 'vitest';
import {
  OFFLINE_QUEUE_WARN,
  applyStreamFrame,
  confirmEdit,
  emptyOutbox,
  queueEdit,
  queueHealth,
  rebasePending,
  GROUP_MEMBER_REJECTED_REASON,
  needsResync,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  type OutboxEntry,
  type OutboxState,
} from './sync-client';
import type { ProductCommand } from '../../contracts/repository-commands';
import type { MergeState } from '../../domain/collaboration/rebase';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

function verifiedOutbox(): OutboxState { return Object.freeze({ ...emptyOutbox(), streamEpoch: 1, resyncRequired: false }); }

const P = '019ff100-0000-7000-8000-000000000001';
const A = '019ff100-0000-7000-8000-0000000000a0';
const B = '019ff100-0000-7000-8000-0000000000b0';

function entry(commandId: string, command: ProductCommand, at = '2026-09-30T00:00:00Z'): OutboxEntry {
  return { commandId, command, commitAttemptId: 1, queuedAtISO: at };
}

function title(nodeId: string, commandId: string): ProductCommand {
  return { type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId, projectId: P, baseRevision: 0, expectedRevision: 1, nodeId, title: 'X' } as ProductCommand;
}

function mergeState(): MergeState {
  return {
    projectId: P,
    nodes: new Map([[A, { parentId: null }], [B, { parentId: null }]]),
    order: new Map([['', [A, B]]]),
    forecastOrder: [],
    forecastGroups: [],
    assignments: {},
    rosterIds: new Set(),
    points: new Map(),
    pointsDone: new Map(),
  };
}

describe('sync-client outbox (Story 27.7, R4/R8)', () => {
  it('queues an edit durably and confirms it to advance the cursor', () => {
    let state = verifiedOutbox();
    state = queueEdit(state, entry('c1', title(A, 'c1')));
    expect(state.entries).toHaveLength(1);
    state = confirmEdit(state, 'c1', 1);
    expect(state.entries).toHaveLength(0);
    expect(state.cursor).toBe(1);
  });

  it('warns at the queue threshold and never drops', () => {
    let state = verifiedOutbox();
    for (let i = 0; i < OFFLINE_QUEUE_WARN; i += 1) state = queueEdit(state, entry(`c${i}`, title(A, `c${i}`)));
    const health = queueHealth(state, '2026-09-30T00:00:00Z');
    expect(health.warn).toBe(true);
    expect(health.size).toBe(OFFLINE_QUEUE_WARN);
    expect(state.entries).toHaveLength(OFFLINE_QUEUE_WARN);
  });

  it('flags an entry older than the 30-day offline window', () => {
    let state = queueEdit(verifiedOutbox(), entry('c1', title(A, 'c1'), '2026-05-01T00:00:00Z'));
    expect(queueHealth(state, '2026-09-30T00:00:00Z').expired).toBe(true);
    state = queueEdit(verifiedOutbox(), entry('c1', title(A, 'c1'), '2026-09-29T00:00:00Z'));
    expect(queueHealth(state, '2026-09-30T00:00:00Z').expired).toBe(false);
  });
});

describe('sync-client stream (Story 27.7, R4)', () => {
  it('advances on a contiguous frame and detects an own echo', () => {
    let state = queueEdit(verifiedOutbox(), entry('c1', title(A, 'c1')));
    const result = applyStreamFrame(state, { serverRevision: 1, streamEpoch: 1, historyEntry: historyFixture(title(A, 'c1')), command: title(A, 'c1'), appliedCommandIds: ['c1'] });
    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.ownEcho).toBe(true);
      // The own command is removed without applying twice.
      expect(result.state.entries).toHaveLength(0);
      expect(result.state.cursor).toBe(1);
    }
  });

  it('ignores a verified duplicate frame', () => {
    let state = confirmEdit(verifiedOutbox(), 'c1', 1);
    const result = applyStreamFrame(state, { serverRevision: 1, streamEpoch: 1, historyEntry: historyFixture(title(A, 'c1')), command: title(A, 'c1'), appliedCommandIds: ['c1'] });
    expect(result.kind).toBe('duplicate');
  });

  it('requires resync on a gap', () => {
    const state = verifiedOutbox();
    const result = applyStreamFrame(state, { serverRevision: 5, streamEpoch: 1, historyEntry: historyFixture(title(A, 'c5'),5), command: title(A, 'c5'), appliedCommandIds: ['c5'] });
    expect(result.kind).toBe('resync');
    if (result.kind === 'resync') expect(result.state.resyncRequired).toBe(true);
  });
});

describe('sync-client rebase (Story 27.7, R4)', () => {
  it('keeps a surviving pending command with a bumped commit attempt', () => {
    const state = queueEdit(verifiedOutbox(), entry('c1', title(A, 'c1')));
    const { toReapply, rejected } = rebasePending(state, [], mergeState());
    expect(rejected).toHaveLength(0);
    expect(toReapply).toHaveLength(1);
    // A rollback/re-apply bumps the local commit attempt (new result, not old).
    expect(toReapply[0].commitAttemptId).toBe(2);
    expect(toReapply[0].commandId).toBe('c1');
  });

  it('rejects a pending command whose target a remote delete removed', () => {
    const state = queueEdit(verifiedOutbox(), entry('c1', title(B, 'c1')));
    const remoteDelete: ProductCommand = { type: 'DeleteSubtree', protocolVersion: PROTOCOL_VERSION, commandId: 'd1', projectId: P, baseRevision: 0, expectedRevision: 1, nodeId: B } as ProductCommand;
    const { rejected } = rebasePending(state, [remoteDelete], mergeState());
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('TargetDeleted');
    // The rejected command keeps its full content for the UI to show/copy.
    expect(rejected[0].command).toMatchObject({ type: 'SetNodeTitle', nodeId: B });
  });

  it('refuses every member of a composite gesture when one member is refused', () => {
    let state = queueEdit(verifiedOutbox(), { ...entry('g1', title(A, 'g1')), groupId: 'grp' });
    state = queueEdit(state, { ...entry('g2', title(B, 'g2')), groupId: 'grp' });
    state = queueEdit(state, entry('solo', title(A, 'solo')));
    const remoteDelete: ProductCommand = { type: 'DeleteSubtree', protocolVersion: PROTOCOL_VERSION, commandId: 'd1', projectId: P, baseRevision: 0, expectedRevision: 1, nodeId: B } as ProductCommand;
    const { toReapply, rejected } = rebasePending(state, [remoteDelete], mergeState());
    expect(rejected.map((r) => [r.entry.commandId, r.reason])).toEqual([
      ['g1', GROUP_MEMBER_REJECTED_REASON],
      ['g2', 'TargetDeleted'],
    ]);
    // The unrelated single edit survives; no part of the group is re-applied.
    expect(toReapply.map((e) => e.commandId)).toEqual(['solo']);
  });

  it('keeps a whole group pending when every member survives', () => {
    let state = queueEdit(verifiedOutbox(), { ...entry('g1', title(A, 'g1')), groupId: 'grp' });
    state = queueEdit(state, { ...entry('g2', title(A, 'g2')), groupId: 'grp' });
    const { toReapply, rejected } = rebasePending(state, [], mergeState());
    expect(rejected).toHaveLength(0);
    expect(toReapply.map((e) => [e.commandId, e.groupId])).toEqual([['g1', 'grp'], ['g2', 'grp']]);
  });
});

describe('sync-client reconnect policy (Story 27.7)', () => {
  it('backs off exponentially and caps', () => {
    expect(RECONNECT_BASE_MS).toBe(1000);
    // Jitter 1.0 → full delay.
    expect(reconnectDelayMs(0, 1)).toBe(1000);
    expect(reconnectDelayMs(1, 1)).toBe(2000);
    expect(reconnectDelayMs(2, 1)).toBe(4000);
    // Capped at RECONNECT_MAX_MS.
    expect(reconnectDelayMs(20, 1)).toBe(RECONNECT_MAX_MS);
  });

  it('jitter 0 halves the delay', () => {
    expect(reconnectDelayMs(2, 0)).toBe(2000);
  });

  it('needsResync on a required resync or corrupt rows', () => {
    expect(needsResync(verifiedOutbox())).toBe(false);
    expect(needsResync({ ...verifiedOutbox(), resyncRequired: true })).toBe(true);
    expect(needsResync({ ...verifiedOutbox(), corrupt: ['x'] })).toBe(true);
  });
});

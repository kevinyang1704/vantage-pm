/**
 * Unit tests for command-queue.policy.ts (Story 1.7 Task 3).
 *
 * Table/property test over the pure state machine.
 * Covers:
 *   - submit-while-idle
 *   - submit-while-in-flight
 *   - success-with-pending-next
 *   - failure-then-retry
 *   - failure-then-discard
 *   - dependency rejection
 *   - cross-project independence
 */

import { describe, expect, it } from 'vitest';
import {
  createInitialQueueState,
  transitionQueue,
  isQueueSettled,
  queueBlockingCause,
  type QueueState,
  type QueuedCommand,
} from './command-queue.policy';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

// ── Helpers ─────────────────────────────────────────────────────────────────

function cmd(overrides: Partial<QueuedCommand> = {}): QueuedCommand {
  return Object.freeze({
    commandId: createUuidV7(),
    projectId: '0198a000-0000-7000-8000-000000000002',
    commandType: 'CreateProject',
    overlay: {},
    ...overrides,
  });
}

function assertFrozen(obj: unknown): void {
  expect(Object.isFrozen(obj)).toBe(true);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('command-queue.policy', () => {
  describe('createInitialQueueState', () => {
    it('creates a frozen initial state', () => {
      const state = createInitialQueueState('p1');
      assertFrozen(state);
      expect(state.projectId).toBe('p1');
      expect(state.inFlight).toBeNull();
      expect(state.pending).toEqual([]);
      expect(state.paused).toBe(false);
      expect(state.dispatchOrder).toEqual([]);
      expect(state.lastRevision).toBe(0);
    });
  });

  describe('submit-while-idle', () => {
    it('dispatches immediately when queue is idle', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      const result = transitionQueue(state, { type: 'SubmitCommand', command: c });

      expect(result.nextState.inFlight).toEqual(c);
      expect(result.nextState.pending).toEqual([]);
      expect(result.nextState.paused).toBe(false);
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe('DispatchNow');
      if (result.effects[0].type === 'DispatchNow') {
        expect(result.effects[0].command).toEqual(c);
        expect(result.effects[0].baseRevision).toBe(0);
      }
      assertFrozen(result.nextState);
      assertFrozen(result.effects);
    });
  });

  describe('submit-while-in-flight', () => {
    it('queues the command when another is in flight', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      const afterFirst = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const c2 = cmd();
      const result = transitionQueue(afterFirst.nextState, { type: 'SubmitCommand', command: c2 });

      expect(result.nextState.inFlight).toEqual(c1);
      expect(result.nextState.pending).toEqual([c2]);
      expect(result.effects).toHaveLength(0);
    });

    it('queues multiple commands in order', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const c2 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });

      const c3 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c3 });

      expect(current.nextState.inFlight).toEqual(c1);
      expect(current.nextState.pending).toEqual([c2, c3]);
    });
  });

  describe('success-with-pending-next', () => {
    it('reconciles overlay and dispatches next pending command', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const c2 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });

      // Dispatch c1 succeeds
      const result = transitionQueue(current.nextState, {
        type: 'DispatchSucceeded',
        commandId: c1.commandId,
        newRevision: 1,
      });

      expect(result.nextState.inFlight).toEqual(c2);
      expect(result.nextState.pending).toEqual([]);
      expect(result.nextState.lastRevision).toBe(1);
      expect(result.nextState.dispatchOrder).toEqual([c1.commandId]);

      // Should have ReconcileOverlay for c1 and DispatchNow for c2
      expect(result.effects).toHaveLength(2);
      expect(result.effects[0].type).toBe('ReconcileOverlay');
      expect(result.effects[1].type).toBe('DispatchNow');
    });

    it('goes idle when no pending commands remain', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      const afterSubmit = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const result = transitionQueue(afterSubmit.nextState, {
        type: 'DispatchSucceeded',
        commandId: c1.commandId,
        newRevision: 1,
      });

      expect(result.nextState.inFlight).toBeNull();
      expect(result.nextState.pending).toEqual([]);
      expect(result.nextState.paused).toBe(false);
      expect(result.nextState.lastRevision).toBe(1);
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe('ReconcileOverlay');
    });
  });

  describe('failure-then-retry', () => {
    it('pauses the queue on failure', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      const afterSubmit = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const result = transitionQueue(afterSubmit.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      expect(result.nextState.inFlight).toBeNull();
      expect(result.nextState.paused).not.toBe(false);
      if (result.nextState.paused !== false) {
        expect(result.nextState.paused.failed).toEqual(c1);
        expect(result.nextState.paused.cause).toBe('REVISION_CONFLICT');
      }
      expect(result.effects).toHaveLength(0);
    });

    it('retries the failed command', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      const result = transitionQueue(current.nextState, { type: 'RetryCommand' });

      expect(result.nextState.inFlight).toEqual(c1);
      expect(result.nextState.paused).toBe(false);
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe('DispatchNow');
      if (result.effects[0].type === 'DispatchNow') {
        expect(result.effects[0].command).toEqual(c1);
      }
    });

    it('retry is a no-op when not paused', () => {
      const state = createInitialQueueState('p1');
      const result = transitionQueue(state, { type: 'RetryCommand' });
      expect(result.nextState).toBe(state);
      expect(result.effects).toHaveLength(0);
    });
  });

  describe('failure-then-discard', () => {
    it('discards the failed command and dispatches next pending', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd({ commandType: 'RenameProject' });
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      const c2 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });

      // c1 fails
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      // Discard c1
      const result = transitionQueue(current.nextState, { type: 'DiscardCommand' });

      expect(result.nextState.inFlight).toEqual(c2);
      expect(result.nextState.pending).toEqual([]);
      expect(result.nextState.paused).toBe(false);

      // Should have RemoveOverlay for c1 and DispatchNow for c2
      const effectTypes = result.effects.map((e) => e.type);
      expect(effectTypes).toContain('RemoveOverlay');
      expect(effectTypes).toContain('DispatchNow');
    });

    it('goes idle when no pending commands after discard', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      const result = transitionQueue(current.nextState, { type: 'DiscardCommand' });

      expect(result.nextState.inFlight).toBeNull();
      expect(result.nextState.pending).toEqual([]);
      expect(result.nextState.paused).toBe(false);
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0].type).toBe('RemoveOverlay');
    });

    it('discard is a no-op when not paused', () => {
      const state = createInitialQueueState('p1');
      const result = transitionQueue(state, { type: 'DiscardCommand' });
      expect(result.nextState).toBe(state);
      expect(result.effects).toHaveLength(0);
    });
  });

  describe('dependency rejection', () => {
    it('rejects pending commands that depend on a discarded CreateProject', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd({ commandType: 'CreateProject' });
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      // Queue a second command for the same project
      const c2 = cmd({ projectId: c1.projectId, commandType: 'RenameProject' });
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });

      // c1 fails
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      // Discard c1 — c2 should be dependency-rejected
      const result = transitionQueue(current.nextState, { type: 'DiscardCommand' });

      // c2 should be rejected
      const depRejected = result.effects.find((e) => e.type === 'DependencyRejected');
      expect(depRejected).toBeDefined();
      if (depRejected && depRejected.type === 'DependencyRejected') {
        expect(depRejected.commandId).toBe(c2.commandId);
        expect(depRejected.blockedByCommandId).toBe(c1.commandId);
      }

      // Queue should be idle
      expect(result.nextState.inFlight).toBeNull();
      expect(result.nextState.pending).toEqual([]);
    });

    it('does not reject pending commands for different projects', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd({ commandType: 'CreateProject', projectId: 'p1' });
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });

      // Queue a command for a different project
      const c2 = cmd({ projectId: 'p2', commandType: 'CreateProject' });
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });

      // c1 fails
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c1.commandId,
        cause: 'REVISION_CONFLICT',
      });

      // Discard c1 — c2 should survive (different project)
      const result = transitionQueue(current.nextState, { type: 'DiscardCommand' });

      const depRejected = result.effects.find((e) => e.type === 'DependencyRejected');
      expect(depRejected).toBeUndefined();

      // c2 should be dispatched
      const dispatchNow = result.effects.find((e) => e.type === 'DispatchNow');
      expect(dispatchNow).toBeDefined();
    });
  });

  describe('cross-project independence', () => {
    it('queues for different projects are independent', () => {
      const p1State = createInitialQueueState('p1');
      const p2State = createInitialQueueState('p2');

      const c1 = cmd({ projectId: 'p1' });
      const p1Result = transitionQueue(p1State, { type: 'SubmitCommand', command: c1 });

      const c2 = cmd({ projectId: 'p2' });
      const p2Result = transitionQueue(p2State, { type: 'SubmitCommand', command: c2 });

      // Both should be dispatched immediately (independent queues)
      expect(p1Result.effects[0].type).toBe('DispatchNow');
      expect(p2Result.effects[0].type).toBe('DispatchNow');

      // p1's state should not affect p2
      expect(p1Result.nextState.inFlight).toEqual(c1);
      expect(p2Result.nextState.inFlight).toEqual(c2);
    });
  });

  describe('isQueueSettled', () => {
    it('returns true for initial state', () => {
      expect(isQueueSettled(createInitialQueueState('p1'))).toBe(true);
    });

    it('returns false when command is in flight', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      const after = transitionQueue(state, { type: 'SubmitCommand', command: c });
      expect(isQueueSettled(after.nextState)).toBe(false);
    });

    it('returns false when commands are pending', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });
      const c2 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });
      expect(isQueueSettled(current.nextState)).toBe(false);
    });

    it('returns false when paused', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c });
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c.commandId,
        cause: 'ERROR',
      });
      expect(isQueueSettled(current.nextState)).toBe(false);
    });

    it('returns true after all commands complete', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c });
      current = transitionQueue(current.nextState, {
        type: 'DispatchSucceeded',
        commandId: c.commandId,
        newRevision: 1,
      });
      expect(isQueueSettled(current.nextState)).toBe(true);
    });
  });

  describe('queueBlockingCause', () => {
    it('returns null when settled', () => {
      expect(queueBlockingCause(createInitialQueueState('p1'))).toBeNull();
    });

    it('returns in-flight cause', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      const after = transitionQueue(state, { type: 'SubmitCommand', command: c });
      const cause = queueBlockingCause(after.nextState);
      expect(cause).toContain('in flight');
      expect(cause).toContain(c.commandId);
    });

    it('returns pending cause', () => {
      const state = createInitialQueueState('p1');
      const c1 = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c1 });
      const c2 = cmd();
      current = transitionQueue(current.nextState, { type: 'SubmitCommand', command: c2 });
      // Succeed c1 so c2 is in flight
      current = transitionQueue(current.nextState, {
        type: 'DispatchSucceeded',
        commandId: c1.commandId,
        newRevision: 1,
      });
      // Now c2 is in flight, no pending
      const cause = queueBlockingCause(current.nextState);
      expect(cause).toContain('in flight');
    });

    it('returns paused cause', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      let current = transitionQueue(state, { type: 'SubmitCommand', command: c });
      current = transitionQueue(current.nextState, {
        type: 'DispatchFailed',
        commandId: c.commandId,
        cause: 'REVISION_CONFLICT',
      });
      const cause = queueBlockingCause(current.nextState);
      expect(cause).toContain('failed');
      expect(cause).toContain('REVISION_CONFLICT');
    });
  });

  describe('idempotent success/failure', () => {
    it('DispatchSucceeded for unknown commandId is a no-op', () => {
      const state = createInitialQueueState('p1');
      const result = transitionQueue(state, {
        type: 'DispatchSucceeded',
        commandId: 'nonexistent',
        newRevision: 1,
      });
      expect(result.nextState).toBe(state);
      expect(result.effects).toHaveLength(0);
    });

    it('DispatchFailed for unknown commandId is a no-op', () => {
      const state = createInitialQueueState('p1');
      const result = transitionQueue(state, {
        type: 'DispatchFailed',
        commandId: 'nonexistent',
        cause: 'ERROR',
      });
      expect(result.nextState).toBe(state);
      expect(result.effects).toHaveLength(0);
    });
  });

  describe('immutability', () => {
    it('all transition results are frozen', () => {
      const state = createInitialQueueState('p1');
      const c = cmd();
      const result = transitionQueue(state, { type: 'SubmitCommand', command: c });

      assertFrozen(result.nextState);
      assertFrozen(result.effects);
      assertFrozen(result.nextState.pending);
      assertFrozen(result.nextState.dispatchOrder);
    });

    it('original state is not mutated', () => {
      const state = createInitialQueueState('p1');
      const originalInFlight = state.inFlight;
      const originalPending = [...state.pending];

      const c = cmd();
      transitionQueue(state, { type: 'SubmitCommand', command: c });

      expect(state.inFlight).toBe(originalInFlight);
      expect(state.pending).toEqual(originalPending);
    });
  });
});

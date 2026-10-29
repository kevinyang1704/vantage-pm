import { describe, expect, it } from 'vitest';
import { decideExportEligibility } from './decide-export-eligibility';

/**
 * Integration-level test for the Story 8.1 Task 6 check-flush-recheck sequence
 * (AC4). Mirrors the flow in main.tsx's handleExportPreview: check the queue,
 * await a flush (which yields to the event loop), then re-check before
 * resolving scope. A queue that becomes unsettled between the two checks must
 * block the export and resolve no scope.
 */

interface FakeQueue {
  settled: boolean;
  cause: string | null;
}

async function runCheckFlushRecheck(
  queue: FakeQueue,
  onFlush?: () => void,
): Promise<
  | { kind: 'Blocked'; cause: string }
  | { kind: 'Proceed' }
> {
  const first = decideExportEligibility({ isQueueSettled: queue.settled, blockingCause: queue.cause });
  if (first.kind === 'Blocked') return first;

  // Simulate the coalescer.flush await yielding to the event loop, during which
  // a command can resolve or newly queue.
  await Promise.resolve();
  onFlush?.();

  const second = decideExportEligibility({ isQueueSettled: queue.settled, blockingCause: queue.cause });
  return second;
}

describe('export check-flush-recheck flow (Story 8.1 Task 6, AC4)', () => {
  it('proceeds when the queue stays settled across the flush', async () => {
    const queue: FakeQueue = { settled: true, cause: null };
    const result = await runCheckFlushRecheck(queue);
    expect(result).toEqual({ kind: 'Proceed' });
  });

  it('blocks on the first check when the queue is already unsettled', async () => {
    const queue: FakeQueue = { settled: false, cause: '3 commands in flight' };
    const result = await runCheckFlushRecheck(queue);
    expect(result).toEqual({ kind: 'Blocked', cause: '3 commands in flight' });
  });

  it('blocks on the re-check when the queue becomes unsettled during the flush', async () => {
    const queue: FakeQueue = { settled: true, cause: null };
    // A command queues during the flush await.
    const result = await runCheckFlushRecheck(queue, () => {
      queue.settled = false;
      queue.cause = '1 command queued during flush';
    });
    // The re-check sees the unsettled queue and blocks.
    expect(result).toEqual({ kind: 'Blocked', cause: '1 command queued during flush' });
  });
});

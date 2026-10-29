import { describe, expect, it, vi } from 'vitest';
import { CommandQueueOrchestrator } from './command-queue-orchestrator';
import type { ProductCommand, ProductCommandApplied, ProductCommandResult } from '../../contracts/repository-commands';
import { createUuidV7, PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const projectId = '0198a000-0000-7000-8000-000000000002';
function command(baseRevision = 4): ProductCommand {
  return Object.freeze({ type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId: createUuidV7(),
    projectId, baseRevision, expectedRevision: baseRevision + 1,
    nodeId: '0198a000-0000-7000-8000-000000000003', title: 'Synthetic title' });
}
function applied(cmd: ProductCommand): ProductCommandApplied {
  return Object.freeze({ type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION,
    commandId: cmd.commandId, projectId: cmd.projectId, baseRevision: cmd.baseRevision,
    targetRevision: cmd.expectedRevision, outcome: 'VfsCommitAccepted', disposition: 'NewCommit' });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('atomic application batch coordinator', () => {
  it('dispatches once with sequential revisions and advances subsequent ordinary edits', async () => {
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const batch = vi.fn(async (commands: readonly ProductCommand[]) => commands.map(applied));
    const queue = new CommandQueueOrchestrator(dispatch, batch);
    const outcomes = await queue.dispatchBatch([command(), command()]);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0].map(cmd => cmd.baseRevision)).toEqual([4, 5]);
    expect(outcomes).toHaveLength(2);
    await queue.dispatchCommand(command(0));
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(6);
  });

  it('blocks ordinary edits and project settlement while a batch is in flight', async () => {
    const block = gate();
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch, async commands => {
      await block.promise;
      return commands.map(applied);
    });
    const batch = queue.dispatchBatch([command(), command()]);
    const ordinary = queue.dispatchCommand(command(0));
    await Promise.resolve();
    expect(queue.isQueueSettled(projectId)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    block.release();
    await batch;
    await ordinary;
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(6);
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it('serializes concurrent batches before waiting ordinary work', async () => {
    const block = gate();
    const bases: number[] = [];
    const queue = new CommandQueueOrchestrator(async cmd => { bases.push(cmd.baseRevision); return applied(cmd); }, async commands => {
      bases.push(commands[0].baseRevision);
      if (bases.length === 1) await block.promise;
      return commands.map(applied);
    });
    const first = queue.dispatchBatch([command(), command()]);
    const ordinary = queue.dispatchCommand(command(0));
    const second = queue.dispatchBatch([command(0), command(0)]);
    block.release();
    await Promise.all([first, second, ordinary]);
    expect(bases).toEqual([4, 6, 8]);
  });

  it('returns only the failed component and does not advance the queue revision', async () => {
    const commands = [command(), command()];
    const rejection: ProductCommandResult = { type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION,
      commandId: commands[1].commandId, code: 'NODE_NOT_FOUND' };
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch, async () => [rejection]);
    expect(await queue.dispatchBatch(commands)).toEqual([{ type: 'CommandDispatched', projectId,
      commandId: commands[1].commandId, result: rejection }]);
    await queue.dispatchCommand(command(4));
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(4);
  });

  it('requires a repository read after a thrown port failure because its commit is uncertain', async () => {
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch, async () => { throw new Error('Synthetic storage refusal'); });
    await expect(queue.dispatchBatch([command()])).rejects.toThrow('Synthetic storage refusal');
    await expect(queue.dispatchCommand(command())).rejects.toThrow('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.isQueueSettled(projectId)).toBe(false);
    queue.reconcileAtomicBatchRevision(projectId, 4);
    await queue.dispatchCommand(command());
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it('blocks waiting ordinary work after a malformed committed result until authoritative reconciliation', async () => {
    const block = gate();
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    let repositoryRevision = 4;
    const queue = new CommandQueueOrchestrator(dispatch, async commands => {
      await block.promise;
      repositoryRevision += commands.length;
      return commands.map(cmd => ({ ...applied(cmd), commandId: createUuidV7() }));
    });
    const batch = queue.dispatchBatch([command(), command()]);
    const failedBatch = expect(batch).rejects.toThrow('ATOMIC_BATCH_RESULT_INVALID');
    const ordinary = queue.dispatchCommand(command(0));
    const blockedOrdinary = expect(ordinary).rejects.toThrow('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
    block.release();
    await Promise.all([failedBatch, blockedOrdinary]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.isQueueSettled(projectId)).toBe(false);
    queue.reconcileAtomicBatchRevision(projectId, repositoryRevision);
    await queue.dispatchCommand(command(0));
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(6);
  });

  it('refuses a batch while the ordinary queue is in flight without touching its port', async () => {
    const block = gate();
    const batchPort = vi.fn(async (commands: readonly ProductCommand[]) => commands.map(applied));
    const queue = new CommandQueueOrchestrator(async cmd => { await block.promise; return applied(cmd); }, batchPort);
    const ordinary = queue.dispatchCommand(command());
    await expect(queue.dispatchBatch([command()])).rejects.toThrow('ATOMIC_BATCH_QUEUE_UNSETTLED');
    expect(batchPort).not.toHaveBeenCalled();
    block.release();
    await ordinary;
  });

  it('fails explicitly without atomic support and rejects mixed projects before invoking the port', async () => {
    const batchPort = vi.fn(async (commands: readonly ProductCommand[]) => commands.map(applied));
    await expect(new CommandQueueOrchestrator(async cmd => applied(cmd)).dispatchBatch([command()]))
      .rejects.toThrow('ATOMIC_BATCH_UNAVAILABLE');
    const queue = new CommandQueueOrchestrator(async cmd => applied(cmd), batchPort);
    await expect(queue.dispatchBatch([command(), { ...command(), projectId: createUuidV7() }]))
      .rejects.toThrow('ATOMIC_BATCH_IDENTITY_INVALID');
    expect(batchPort).not.toHaveBeenCalled();
  });

  it('adopts a lower authoritative revision only while settled, so later edits use it', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn(async (cmd: ProductCommand) => { if (cmd.baseRevision === 9) await held; return applied(cmd); });
    const queue = new CommandQueueOrchestrator(dispatch);
    await queue.dispatchCommand(command(8));
    const inFlight = queue.dispatchCommand(command(9));
    // A replacement arrives while an edit is in flight: refused, nothing changes.
    expect(queue.adoptAuthoritativeRevision(projectId, 3)).toBe(false);
    release();
    await inFlight;
    expect(queue.adoptAuthoritativeRevision(projectId, 3)).toBe(true);
    await queue.dispatchCommand(command(3));
    expect(dispatch.mock.calls.at(-1)?.[0].baseRevision).toBe(3);
    expect(queue.adoptAuthoritativeRevision(projectId, -1)).toBe(false);
  });
});

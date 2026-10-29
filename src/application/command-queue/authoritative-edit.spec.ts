import { describe, expect, it, vi } from 'vitest';
import { CommandQueueOrchestrator } from './command-queue-orchestrator';
import type { ProductCommand, ProductCommandApplied } from '../../contracts/repository-commands';
import { createUuidV7, PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';

const projectId = '0198a000-0000-7000-8000-000000000002';
const otherProjectId = '0198a000-0000-7000-8000-000000000004';
function command(baseRevision = 4, project = projectId): ProductCommand {
  return Object.freeze({ type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId: createUuidV7(),
    projectId: project, baseRevision, expectedRevision: baseRevision + 1,
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

describe('authoritative local-file edit queue fence', () => {
  it('blocks ordinary edits until the authoritative revision is adopted', async () => {
    const block = gate();
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch);
    await queue.dispatchCommand(command());
    dispatch.mockClear();
    const edit = queue.runAuthoritativeEdit(projectId, async () => {
      await block.promise;
      return { revision: 12, operation: 'Synthetic merge' };
    });
    const ordinary = queue.dispatchCommand(command(0));
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.isQueueSettled(projectId)).toBe(false);
    expect(queue.queueBlockingCause(projectId)).toBe('Atomic edit in progress.');
    expect(queue.adoptAuthoritativeRevision(projectId, 99)).toBe(false);
    block.release();
    expect(await edit).toEqual({ revision: 12, operation: 'Synthetic merge' });
    await ordinary;
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(12);
    expect(dispatch.mock.calls[0][0].expectedRevision).toBe(13);
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it('does not block ordinary work on another project', async () => {
    const block = gate();
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch);
    const edit = queue.runAuthoritativeEdit(projectId, async () => { await block.promise; return { revision: 8 }; });
    await queue.dispatchCommand(command(2, otherProjectId));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].projectId).toBe(otherProjectId);
    expect(queue.isQueueSettled(otherProjectId)).toBe(true);
    block.release();
    await edit;
  });

  it('refuses an authoritative operation while an ordinary command is pending', async () => {
    const block = gate();
    const queue = new CommandQueueOrchestrator(async cmd => { await block.promise; return applied(cmd); });
    const ordinary = queue.dispatchCommand(command());
    const operation = vi.fn(async () => ({ revision: 10 }));
    await expect(queue.runAuthoritativeEdit(projectId, operation)).rejects.toThrow('Finish or resolve pending edits');
    expect(operation).not.toHaveBeenCalled();
    block.release();
    await ordinary;
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it('keeps ambiguous failures gated until storage supplies an authoritative revision', async () => {
    const block = gate();
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch);
    await queue.dispatchCommand(command());
    dispatch.mockClear();
    const edit = queue.runAuthoritativeEdit(projectId, async () => {
      await block.promise;
      throw new Error('Synthetic lost reply after commit');
    });
    const failedEdit = expect(edit).rejects.toThrow('Synthetic lost reply after commit');
    const ordinary = queue.dispatchCommand(command(0));
    const refusedOrdinary = expect(ordinary).rejects.toThrow('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
    block.release();
    await Promise.all([failedEdit, refusedOrdinary]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.isQueueSettled(projectId)).toBe(false);
    expect(queue.queueBlockingCause(projectId)).toContain('reconciliation');
    const retry = vi.fn(async () => ({ revision: 9 }));
    await expect(queue.runAuthoritativeEdit(projectId, retry)).rejects.toThrow('Finish or resolve pending edits');
    expect(retry).not.toHaveBeenCalled();
    expect(() => queue.reconcileAtomicBatchRevision(projectId, 4)).toThrow('ATOMIC_BATCH_RECONCILIATION_INVALID');
    queue.reconcileAtomicBatchRevision(projectId, 9);
    await queue.dispatchCommand(command(0));
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(9);
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it.each([NaN, Infinity, -1, 3.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid revision %s and gates subsequent commands', async revision => {
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch);
    await expect(queue.runAuthoritativeEdit(projectId, async () => ({ revision }))).rejects.toThrow('Invalid merge revision');
    await expect(queue.dispatchCommand(command())).rejects.toThrow('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
    expect(dispatch).not.toHaveBeenCalled();
    queue.reconcileAtomicBatchRevision(projectId, 4);
    expect(queue.isQueueSettled(projectId)).toBe(true);
  });

  it('refuses a backwards result instead of rebasing later edits onto an older plan', async () => {
    const dispatch = vi.fn(async (cmd: ProductCommand) => applied(cmd));
    const queue = new CommandQueueOrchestrator(dispatch);
    await queue.dispatchCommand(command(8));
    dispatch.mockClear();
    await expect(queue.runAuthoritativeEdit(projectId, async () => ({ revision: 8 }))).rejects.toThrow('Invalid merge revision');
    await expect(queue.dispatchCommand(command(0))).rejects.toThrow('ATOMIC_BATCH_RECONCILIATION_REQUIRED');
    queue.reconcileAtomicBatchRevision(projectId, 9);
    await queue.dispatchCommand(command(0));
    expect(dispatch.mock.calls[0][0].baseRevision).toBe(9);
  });

  it('runs only one concurrent authoritative callback for the same project', async () => {
    const block = gate();
    const queue = new CommandQueueOrchestrator(async cmd => applied(cmd));
    const firstOperation = vi.fn(async () => { await block.promise; return { revision: 8 }; });
    const secondOperation = vi.fn(async () => ({ revision: 9 }));
    const first = queue.runAuthoritativeEdit(projectId, firstOperation);
    await expect(queue.runAuthoritativeEdit(projectId, secondOperation)).rejects.toThrow('Finish or resolve pending edits');
    expect(firstOperation).toHaveBeenCalledOnce();
    expect(secondOperation).not.toHaveBeenCalled();
    expect(() => queue.reconcileAtomicBatchRevision(projectId, 7)).toThrow('ATOMIC_BATCH_RECONCILIATION_INVALID');
    block.release();
    await first;
    expect(queue.isQueueSettled(projectId)).toBe(true);
    await expect(queue.runAuthoritativeEdit(projectId, secondOperation)).resolves.toEqual({ revision: 9 });
    expect(secondOperation).toHaveBeenCalledOnce();
  });
});

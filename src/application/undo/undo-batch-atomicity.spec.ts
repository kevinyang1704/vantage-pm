import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from '../../adapters/persistence/repository.worker';
import { validateProductCommand, type ProductCommand } from '../../contracts/repository-commands';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { CommandQueueOrchestrator } from '../command-queue/command-queue-orchestrator';
import { UndoEngine } from './undo-engine';

async function fixture() {
  const handler = await initWorkerDatabase();
  const db = getDatabase()!;
  const projectId = createUuidV7();
  const nodeIds = [createUuidV7(), createUuidV7()];
  const make = (type: string, baseRevision: number, fields: Record<string, unknown>): ProductCommand => validateProductCommand({
    type, protocolVersion: '1.0.0', commandId: createUuidV7(), projectId,
    baseRevision, expectedRevision: baseRevision + 1, ...fields,
  });
  handler.apply(make('CreateProject', 0, { name: 'Synthetic atomic Undo' }));
  const queue = new CommandQueueOrchestrator(async command => handler.apply(command), async commands => handler.applyBatch(commands));
  const engine = new UndoEngine(queue);
  engine.beginGroup(projectId);
  for (const [index, nodeId] of nodeIds.entries()) {
    const command = make('CreateNode', index + 1, { nodeId, title: `Synthetic ${index}`, parentId: null, position: String((index + 1) * 4294967296) });
    const result = handler.apply(command);
    if (result.type !== 'ProductCommandApplied' || !result.changeSet) throw new Error('Fixture command was not applied');
    engine.recordAppliedCommand(command, result.changeSet);
  }
  engine.endGroup();
  const snapshot = () => ({
    nodes: db.exec({ sql: 'SELECT id,title FROM nodes WHERE project_id=? ORDER BY id', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }),
    revision: db.exec({ sql: 'SELECT revision FROM projects WHERE id=?', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }),
    receipts: db.exec({ sql: 'SELECT command_id,result_json FROM product_command_receipt WHERE project_id=? ORDER BY command_id', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }),
  });
  return { handler, engine, projectId, nodeIds, make, snapshot };
}

describe('grouped Undo against the actual SQLite batch handler', () => {
  it('a later inverse refusal rolls back the first inverse, its receipt and revision', async () => {
    const f = await fixture();
    expect(f.handler.apply(f.make('DeleteSubtree', 3, { nodeId: f.nodeIds[0] })).type).toBe('ProductCommandApplied');
    const before = f.snapshot();
    const stack = f.engine.getState(f.projectId);
    expect((await f.engine.undo(f.projectId, 4))?.type).toBe('ProductCommandRejected');
    expect(f.snapshot()).toEqual(before);
    expect(f.engine.getState(f.projectId)).toBe(stack);
  });

  it('a later Redo refusal rolls back the first recreation and keeps the Redo stack', async () => {
    const f = await fixture();
    expect((await f.engine.undo(f.projectId, 3))?.type).toBe('ProductCommandApplied');
    expect(f.handler.apply(f.make('CreateNode', 5, { nodeId: f.nodeIds[1], title: 'Synthetic competing recreation', parentId: null, position: '8589934592' })).type).toBe('ProductCommandApplied');
    const before = f.snapshot();
    const stack = f.engine.getState(f.projectId);
    await expect(f.engine.redo(f.projectId, 6)).rejects.toThrow('UNIQUE constraint failed');
    expect(f.snapshot()).toEqual(before);
    expect(f.engine.getState(f.projectId)).toBe(stack);
  });
});

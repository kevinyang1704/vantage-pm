import { describe, expect, it } from 'vitest';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { applyProductCommandBatch } from './repository-worker.client';
import { validateProductCommand } from '../../contracts/repository-commands';

describe('browser atomic batch port', () => {
  it('returns one rejection and rolls back a successful prefix through the runtime-neutral fallback', async () => {
    await initWorkerDatabase(); const db = getDatabase()!;
    const projectId = createUuidV7(); const nodeId = createUuidV7();
    db.exec({ sql: 'INSERT INTO projects(id,name,revision) VALUES(?,?,0)', bind: [projectId, 'Synthetic'] });
    db.exec({ sql: 'INSERT INTO nodes(id,project_id,parent_id,title,position) VALUES(?,?,NULL,?,1024)', bind: [nodeId, projectId, 'Before'] });
    const first = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', projectId, commandId: createUuidV7(), baseRevision: 0, expectedRevision: 1, nodeId, title: 'After' });
    const second = validateProductCommand({ ...first, commandId: createUuidV7(), baseRevision: 1, expectedRevision: 2, nodeId: createUuidV7() });
    expect(await applyProductCommandBatch([first, second])).toEqual([expect.objectContaining({ type: 'ProductCommandRejected', commandId: second.commandId, code: 'NODE_NOT_FOUND' })]);
    const rows = db.exec({ sql: 'SELECT title,revision FROM nodes JOIN projects ON projects.id=nodes.project_id WHERE nodes.id=?', bind: [nodeId], rowMode: 'object', returnValue: 'resultRows' });
    expect(rows).toEqual([{ title: 'Before', revision: 0 }]);
    await expect(applyProductCommandBatch([first, { ...second, projectId: createUuidV7() }])).rejects.toThrow('INVALID_PRODUCT_COMMAND_BATCH');
    await expect(applyProductCommandBatch([first, validateProductCommand({ ...second, baseRevision: 9, expectedRevision: 10 })])).rejects.toThrow('INVALID_PRODUCT_COMMAND_BATCH');
  });
});

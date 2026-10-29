import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { initializeCollaborationSchema, readCollaborationHistoryRows } from './collaboration-outbox';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

describe('browser confirmed history read (27.8 activity)', () => {
  it('reads the current epoch newest first, pages, skips malformed rows and refuses bad pages', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const project = createUuidV7();
    expect(readCollaborationHistoryRows(db, project, null, 10)).toEqual([]);
    db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch) VALUES(?,4,1)', bind: [project] });
    for (const [epoch, revision, json] of [[1, 1, '{"r":1}'], [1, 2, '{"r":2}'], [1, 3, '{"r":3}'], [2, 1, '{"r":"other epoch"}'], [1, 4, 'not json']] as const) {
      db.exec({ sql: 'INSERT INTO collaboration_authoritative_history(project_id,stream_epoch,server_revision,entry_json) VALUES(?,?,?,?)', bind: [project, epoch, revision, json] });
    }
    expect(readCollaborationHistoryRows(db, project, null, 200).map((r) => r.serverRevision)).toEqual([3, 2, 1]);
    expect(readCollaborationHistoryRows(db, project, 3, 200).map((r) => r.entry)).toEqual([{ r: 2 }, { r: 1 }]);
    expect(() => readCollaborationHistoryRows(db, project, null, 0)).toThrow('HISTORY_PAGE_INVALID');
    expect(() => readCollaborationHistoryRows(db, project, 0, 10)).toThrow('HISTORY_PAGE_INVALID');
  });
});

describe('forget collaboration after stop sharing', () => {
  it('drops sync state, keeps rejected work, and local composites work again', async () => {
    const { forgetCollaboration } = await import('./collaboration-outbox');
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const project = createUuidV7(); const node = createUuidV7();
    db.exec({ sql: 'INSERT INTO projects(id,name,revision) VALUES(?,?,1)', bind: [project, 'Synthetic'] });
    db.exec({ sql: 'INSERT INTO nodes(id,project_id,title,position) VALUES(?,?,?,0)', bind: [node, project, 'Before'] });
    db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch) VALUES(?,1,1)', bind: [project] });
    db.exec({ sql: "INSERT INTO collaboration_rejections(project_id,command_id,command_json,commit_attempt_id,queued_at_iso,reason) VALUES(?,'r1','{}',1,'2026-10-07T00:00:00Z','X')", bind: [project] });
    const { createSetNodeTitleWireCommand } = await import('../../contracts/repository-commands');
    const { createSetNodeTitleCommand } = await import('../../domain/tree/set-node-title.command');
    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: createUuidV7(), projectId: project, nodeId: node, title: 'After', baseRevision: 1 }));
    expect(handler.applyBatch([command])[0]).toMatchObject({ code: 'SHARED_ATOMIC_GROUP_UNAVAILABLE' });
    forgetCollaboration(db, project);
    const count = (table: string) => (db.exec({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, bind: [project], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { n: number }[])[0].n;
    expect(count('collaboration_cursor')).toBe(0);
    expect(count('collaboration_rejections')).toBe(1);
    expect(handler.applyBatch([command])[0].type).toBe('ProductCommandApplied');
  });
});

import { createLocalFileState, createShareBundle, parseLocalFileState } from '../../application/portable-file/local-merge';
import { describe, it, expect } from 'vitest';
import { initWorkerDatabase, getDatabase, queryPortableSnapshot, batchImportPortable } from './repository.worker';
import { applyLocalFileMergeDb, readLocalFileStateDb, readLocalFileRecoveryDb, restoreLocalFileMergeDb, writeLocalFileStateDb } from './local-file-store';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
async function fixture() { await initWorkerDatabase(); const db = getDatabase()!; const project = createUuidV7(), node = createUuidV7(); db.exec({ sql: 'INSERT INTO projects(id,name,revision) VALUES(?,?,1)', bind: [project, 'Synthetic local file',] }); db.exec({ sql: 'INSERT INTO nodes(id,project_id,title,position) VALUES(?,?,?,0)', bind: [node, project, 'Before'] }); return { db, project, node, snapshot: () => queryPortableSnapshot(project) }; }
describe('local file atomic storage', () => {
    it('commits graph, lineage and recovery together; retries exactly once and restores after later edits', async () => {
        const f = await fixture();
        const stateBefore = JSON.stringify(createLocalFileState(f.snapshot()));
        writeLocalFileStateDb(f.db, f.project, 1, stateBefore, f.snapshot);
        const snapshot = f.snapshot();
        const input = { operationId: createUuidV7(), projectId: f.project, expectedRevision: 1, snapshot: { ...snapshot, nodes: snapshot.nodes.map(n => ({ ...n, title: 'Incoming' })) }, stateJson: JSON.stringify(createLocalFileState(f.snapshot())) };
        expect(applyLocalFileMergeDb(f.db, input, f.snapshot)).toEqual({ revision: 2 });
        expect(f.snapshot().nodes[0].title).toBe('Incoming');
        expect(readLocalFileStateDb(f.db, f.project)).toBe(input.stateJson);
        expect(readLocalFileRecoveryDb(f.db, f.project)?.snapshot.nodes[0].title).toBe('Before');
        expect(applyLocalFileMergeDb(f.db, input, f.snapshot)).toEqual({ revision: 2 });
        f.db.exec({ sql: 'UPDATE projects SET revision=3 WHERE id=?', bind: [f.project] });
        const operation = createUuidV7();
        expect(restoreLocalFileMergeDb(f.db, f.project, 3, operation, f.snapshot)).toEqual({ revision: 4 });
        expect(f.snapshot().nodes[0].title).toBe('Before');
        expect(readLocalFileStateDb(f.db, f.project)).toBe(stateBefore);
        expect(readLocalFileRecoveryDb(f.db, f.project)?.snapshot.nodes[0].title).toBe('Incoming');
        expect(restoreLocalFileMergeDb(f.db, f.project, 3, operation, f.snapshot)).toEqual({ revision: 4 });
    });
    it('rolls back recovery/state when a SQL failure interrupts graph installation', async () => {
        const f = await fixture();
        const initial = JSON.stringify(createLocalFileState(f.snapshot()));
        writeLocalFileStateDb(f.db, f.project, 1, initial, f.snapshot);
        const snapshot = f.snapshot();
        f.db.exec(`CREATE TEMP TRIGGER reject_local_file BEFORE INSERT ON nodes WHEN NEW.title='RejectSynthetic' BEGIN SELECT RAISE(ABORT,'injected'); END`);
        expect(() => applyLocalFileMergeDb(f.db, { operationId: createUuidV7(), projectId: f.project, expectedRevision: 1, snapshot: { ...snapshot, nodes: snapshot.nodes.map(n => ({ ...n, title: 'RejectSynthetic' })) }, stateJson: JSON.stringify(createLocalFileState(f.snapshot())) }, f.snapshot)).toThrow();
        f.db.exec('DROP TRIGGER reject_local_file');
        expect(f.snapshot().nodes[0].title).toBe('Before');
        expect(readLocalFileStateDb(f.db, f.project)).toBe(initial);
        expect(readLocalFileRecoveryDb(f.db, f.project)).toBeNull();
    });
    it('rejects stale previews and operation ID reuse with different payloads', async () => {
        const f = await fixture();
        const input = { operationId: createUuidV7(), projectId: f.project, expectedRevision: 0, snapshot: f.snapshot(), stateJson: JSON.stringify(createLocalFileState(f.snapshot())) };
        expect(() => applyLocalFileMergeDb(f.db, input, f.snapshot)).toThrow('STALE');
        const good = { ...input, expectedRevision: 1 };
        applyLocalFileMergeDb(f.db, good, f.snapshot);
        expect(() => applyLocalFileMergeDb(f.db, { ...good, stateJson: JSON.stringify(createLocalFileState(f.snapshot())) }, f.snapshot)).toThrow('CONFLICT');
    });
    it('imports a shared project and metadata atomically', async () => { const f = await fixture(); const snapshot = { ...f.snapshot(), projectId: createUuidV7(), nodes: [] }; const initial = JSON.stringify(createLocalFileState(snapshot)); expect(batchImportPortable(snapshot, initial).ok).toBe(true); expect(readLocalFileStateDb(f.db, snapshot.projectId)).toBe(initial); const bad = { ...snapshot, projectId: createUuidV7() }; expect(() => batchImportPortable(bad, '[]')).toThrow(); expect(readLocalFileStateDb(f.db, bad.projectId)).toBeNull(); });
    it('refuses invalid hierarchy, self unlocks and malformed lineage before any project mutation', async () => {
        const f = await fixture();
        const snapshot = f.snapshot();
        const initial = JSON.stringify(createLocalFileState(snapshot));
        const input = { operationId: createUuidV7(), projectId: f.project, expectedRevision: 1, snapshot, stateJson: initial };
        const child = { ...snapshot.nodes[0], id: createUuidV7(), parentId: f.node, nodeType: 'Theme' as const };
        expect(() => applyLocalFileMergeDb(f.db, { ...input, snapshot: { ...snapshot, nodes: [{ ...snapshot.nodes[0], nodeType: 'Feature' }, child] } }, f.snapshot)).toThrow('hierarchy');
        expect(() => applyLocalFileMergeDb(f.db, { ...input, snapshot: { ...snapshot, unlockEdges: [{ id: createUuidV7(), sourceNodeId: f.node, targetNodeId: f.node }] } }, f.snapshot)).toThrow();
        expect(() => writeLocalFileStateDb(f.db, f.project, 1, '{"version":2}', f.snapshot)).toThrow();
        expect(f.snapshot().nodes[0].title).toBe('Before');
        expect(readLocalFileRecoveryDb(f.db, f.project)).toBeNull();
    });
    it('keeps the sending sequence monotonic across recovery and recovery toggles', async () => {
        const f = await fixture();
        const before = { ...createLocalFileState(f.snapshot()), exportSequence: 5 };
        writeLocalFileStateDb(f.db, f.project, 1, JSON.stringify(before), f.snapshot);
        applyLocalFileMergeDb(f.db, {
            operationId: createUuidV7(), projectId: f.project, expectedRevision: 1,
            snapshot: { ...f.snapshot(), nodes: f.snapshot().nodes.map(n => ({ ...n, title: 'Incoming' })) },
            stateJson: JSON.stringify({ ...before, exportSequence: 6 }),
        }, f.snapshot);
        writeLocalFileStateDb(f.db, f.project, 2, JSON.stringify({ ...before, exportSequence: 7 }), f.snapshot);
        restoreLocalFileMergeDb(f.db, f.project, 2, createUuidV7(), f.snapshot);
        const restored = parseLocalFileState(readLocalFileStateDb(f.db, f.project)!, f.snapshot());
        expect(restored.replicaId).toBe(before.replicaId);
        expect(restored.exportSequence).toBe(7);
        expect(createShareBundle(f.snapshot(), restored).state.exportSequence).toBe(8);
        expect(f.snapshot().nodes[0].title).toBe('Before');
        restoreLocalFileMergeDb(f.db, f.project, 3, createUuidV7(), f.snapshot);
        expect(parseLocalFileState(readLocalFileStateDb(f.db, f.project)!, f.snapshot()).exportSequence).toBe(7);
        expect(f.snapshot().nodes[0].title).toBe('Incoming');
    });
    it('preserves null lineage when recovering a project that had never been shared', async () => {
        const f = await fixture();
        const snapshot = f.snapshot();
        applyLocalFileMergeDb(f.db, { operationId: createUuidV7(), projectId: f.project, expectedRevision: 1, snapshot, stateJson: JSON.stringify({ ...createLocalFileState(snapshot), exportSequence: 7 }) }, f.snapshot);
        restoreLocalFileMergeDb(f.db, f.project, 2, createUuidV7(), f.snapshot);
        expect(readLocalFileStateDb(f.db, f.project)).toBeNull();
    });
    it('preserves signed 64-bit positions beyond JavaScript number precision during merge and import', async () => {
        const f = await fixture();
        const precise = '9007199254740993';
        const snapshot = { ...f.snapshot(), nodes: f.snapshot().nodes.map(node => ({ ...node, position: precise })) };
        applyLocalFileMergeDb(f.db, { operationId: createUuidV7(), projectId: f.project, expectedRevision: 1, snapshot, stateJson: JSON.stringify(createLocalFileState(snapshot)) }, f.snapshot);
        expect(f.snapshot().nodes[0].position).toBe(precise);
        const imported = { ...snapshot, projectId: createUuidV7(), nodes: snapshot.nodes.map(node => ({ ...node, id: createUuidV7() })) };
        expect(batchImportPortable(imported).ok).toBe(true);
        expect(queryPortableSnapshot(imported.projectId).nodes[0].position).toBe(precise);
    });
});

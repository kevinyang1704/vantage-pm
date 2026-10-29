import { detectUnlockCycles } from '../../domain/analysis/cycle-policy';
import type { Node } from '../../domain/tree/node.entity';
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import fixtureSql from '../../../crates/pmapp-core/src/db/deletion-fixture.sql?raw';
import { prepareProductDatabase } from './repository.worker';
import { captureDeletionBundle, deletionBasicNodes } from './deletion-bundle.persistence';
import { createRestoreSubtreeWireCommand, type DeleteSubtreeWireCommand, type RestoreSubtreeWireCommand, type ProductCommand } from '../../contracts/repository-commands';
import { deletionReceiptCompleteness, validateDeletionBundle } from '../../contracts/deletion-bundle';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';
import { UndoEngine } from '../../application/undo/undo-engine';
import { CommandQueueOrchestrator } from '../../application/command-queue/command-queue-orchestrator';
let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => { sqlite = await sqlite3InitModule(); });
const id = (n: number) => `019ffe00-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const P = id(1), N = id(2);
function rows(db: Database, sql: string): Record<string, unknown>[] { return db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Record<string, unknown>[]; }
const tables = ['nodes', 'node_custom_fields', 'node_open_questions', 'unlock_edges', 'affected_reasons', 'phases', 'type_template_fields'];
function graph(db: Database) { return Object.fromEntries(tables.map(t => [t, rows(db, `SELECT * FROM ${t} ORDER BY rowid`)])); }
function fixture() {
    const db = new sqlite.oo1.DB(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    const handler = prepareProductDatabase(db);
    db.exec(fixtureSql);
    const command: DeleteSubtreeWireCommand = { type: 'DeleteSubtree', protocolVersion: '1.0.0', commandId: id(100), projectId: P, baseRevision: 1, expectedRevision: 2, nodeId: N };
    const before = captureDeletionBundle(db, P, N);
    const restore = (): RestoreSubtreeWireCommand => createRestoreSubtreeWireCommand({ commandId: id(101), projectId: P, baseRevision: 2, rootNodeId: N, nodes: deletionBasicNodes(before), deletionBundle: before });
    return { db, handler, command, before, restore };
}
describe('complete version1 deletion receipts', () => {
    it('clones and freezes every bundle fact before factories and UndoEngine retain it', async () => {
        const { db, handler, command, before } = fixture();
        try {
            const caller = { ...before, nodes: before.nodes.map(row => ({ ...row })), customFields: before.customFields.map(row => ({ ...row })), openQuestions: before.openQuestions.map(row => ({ ...row })), unlockEdges: before.unlockEdges.map(row => ({ ...row })), affectedReasons: before.affectedReasons.map(row => ({ ...row })) };
            const basic = deletionBasicNodes(before).map(row => ({ ...row }));
            const normalized = validateDeletionBundle(caller, P, N, basic);
            const wire = createRestoreSubtreeWireCommand({ commandId: id(101), projectId: P, baseRevision: 2, rootNodeId: N, nodes: basic, deletionBundle: caller });
            const applied = handler.apply(command);
            if (applied.type !== 'ProductCommandApplied')
                throw Error('expected applied');
            const deleted = applied.changeSet!.changes[0];
            if (deleted.type !== 'SubtreeDeleted')
                throw Error('expected deletion');
            const callerChangeSet = { ...applied.changeSet!, changes: [{ ...deleted, nodes: basic, deletionBundle: caller }] };
            const descriptor = computeInverseDescriptor(callerChangeSet);
            const engine = new UndoEngine(new CommandQueueOrchestrator(async (c) => handler.apply(c)));
            engine.recordAppliedCommand(command, callerChangeSet);
            caller.nodes[0].title = 'Mutated';
            caller.nodes.pop();
            basic[0].title = 'Mutated basic';
            caller.customFields[0].fieldValue = 'Mutated';
            caller.customFields.pop();
            caller.openQuestions[0].questionText = 'Mutated';
            caller.openQuestions.pop();
            caller.unlockEdges[0].sourceNodeId = id(999);
            caller.unlockEdges.pop();
            caller.affectedReasons[0].causalNodeTitle = 'Mutated';
            caller.affectedReasons.pop();
            expect(normalized).toEqual(before);
            expect(wire.deletionBundle).toEqual(before);
            expect(descriptor).toMatchObject({ deletionBundle: before, nodes: deletionBasicNodes(before) });
            for (const retained of [before, normalized, wire.deletionBundle!]) {
                expect(Object.isFrozen(retained)).toBe(true);
                for (const collection of [retained.nodes, retained.customFields, retained.openQuestions, retained.unlockEdges, retained.affectedReasons]) {
                    expect(Object.isFrozen(collection)).toBe(true);
                    for (const row of collection)
                        expect(Object.isFrozen(row)).toBe(true);
                }
            }
            expect((await engine.undo(P, 2))?.type).toBe('ProductCommandApplied');
            expect(captureDeletionBundle(db, P, N)).toEqual(before);
        }
        finally {
            db.close();
        }
    });
    it('preserves advisory unlock cycles after external edits rather than introducing a new prohibition', () => {
        const { db, handler, command } = fixture();
        try {
            db.exec('DELETE FROM unlock_edges');
            db.exec(`INSERT INTO unlock_edges VALUES('${id(50)}','${P}','${id(5)}','${N}'),('${id(51)}','${P}','${N}','${id(4)}')`);
            const applied = handler.apply(command);
            if (applied.type !== 'ProductCommandApplied')
                throw Error('expected applied');
            const change = applied.changeSet!.changes[0];
            if (change.type !== 'SubtreeDeleted')
                throw Error('expected deletion');
            db.exec(`INSERT INTO unlock_edges VALUES('${id(52)}','${P}','${id(4)}','${id(5)}')`);
            const restore = createRestoreSubtreeWireCommand({ commandId: id(101), projectId: P, baseRevision: 2, rootNodeId: N, nodes: change.nodes, deletionBundle: change.deletionBundle });
            expect(handler.apply(restore).type).toBe('ProductCommandApplied');
            const nodes: Node[] = [N, id(4), id(5)].map(nodeId => ({ id: nodeId, projectId: P, parentId: null, title: 'Synthetic', bodyText: null, position: 1000n, nodeType: null, startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: null, effortPointsDone: null, strategicWeight: null, phaseId: null, deliveryStatus: 'not_started' }));
            const edges = rows(db, 'SELECT * FROM unlock_edges').map(row => ({ id: String(row.id), projectId: P, sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id) }));
            expect(edges).toHaveLength(3);
            expect(detectUnlockCycles(nodes, edges)[0].pathNodeIds).toEqual([N, id(4), id(5), N]);
        }
        finally {
            db.close();
        }
    });
    it('roundtrips every persisted fact and precisely incident dependencies, including legacy vocabulary and nullable zero values', () => {
        const { db, handler, command, before, restore } = fixture();
        try {
            const untouched = Object.fromEntries(tables.map(t => [t, rows(db, `SELECT * FROM ${t} WHERE project_id='${id(7)}'`)]));
            const result = handler.apply(command);
            expect(result.type).toBe('ProductCommandApplied');
            if (result.type !== 'ProductCommandApplied')
                throw Error('expected applied');
            const change = result.changeSet!.changes[0];
            expect(change.type).toBe('SubtreeDeleted');
            if (change.type !== 'SubtreeDeleted')
                throw Error('expected deleted');
            expect(change.deletionBundle).toEqual(before);
            expect(deletionReceiptCompleteness(change)).toBe('complete');
            expect(before.unlockEdges).toHaveLength(2);
            expect(before.affectedReasons).toHaveLength(2);
            expect(rows(db, 'SELECT * FROM unlock_edges')).toHaveLength(1);
            expect(handler.apply(restore()).type).toBe('ProductCommandApplied');
            expect(captureDeletionBundle(db, P, N)).toEqual(before);
            expect(Object.fromEntries(tables.map(t => [t, rows(db, `SELECT * FROM ${t} WHERE project_id='${id(7)}'`)]))).toEqual(untouched);
            expect(rows(db, 'SELECT * FROM type_template_fields')).toHaveLength(1);
            expect(rows(db, 'SELECT * FROM unlock_edges')).toHaveLength(3);
            expect(rows(db, 'SELECT * FROM affected_reasons')).toHaveLength(3);
        }
        finally {
            db.close();
        }
    });
    it('carries the complete bundle through inverse descriptor, factory and UndoEngine', async () => {
        const { db, handler, command, before } = fixture();
        try {
            const result = handler.apply(command);
            if (result.type !== 'ProductCommandApplied')
                throw Error('expected applied');
            expect(computeInverseDescriptor(result.changeSet!)).toMatchObject({ type: 'RestoreSubtree', deletionBundle: before });
            const commands: ProductCommand[] = [];
            const engine = new UndoEngine(new CommandQueueOrchestrator(async (c) => { commands.push(c); return handler.apply(c); }));
            engine.recordAppliedCommand(command, result.changeSet!);
            await engine.undo(P, 2);
            expect(commands[0]).toMatchObject({ type: 'RestoreSubtree', deletionBundle: before });
            expect(captureDeletionBundle(db, P, N)).toEqual(before);
        }
        finally {
            db.close();
        }
    });
    it.each(['external', 'phase', 'parent', 'position', 'identity', 'hierarchy'] as const)('refuses %s conflicts without changing the deleted graph or receipt', kind => {
        const { db, handler, command, restore } = fixture();
        try {
            handler.apply(command);
            if (kind === 'external')
                db.exec(`DELETE FROM nodes WHERE id='${id(4)}'`);
            if (kind === 'phase')
                db.exec(`UPDATE phases SET project_id='${id(7)}' WHERE id='${id(6)}'`);
            if (kind === 'parent')
                db.exec(`DELETE FROM nodes WHERE id='${id(5)}'`);
            if (kind === 'position')
                db.exec(`INSERT INTO nodes(id,project_id,parent_id,title,position) VALUES('${id(80)}','${P}','${id(5)}','Occupied',1000)`);
            if (kind === 'identity')
                db.exec(`INSERT INTO node_open_questions VALUES('${id(20)}','${P}','${id(4)}','Occupied','OPEN',NULL,2000,NULL,'2026-10-01')`);
            if (kind === 'hierarchy')
                db.exec(`UPDATE nodes SET node_type='AcceptanceCriterion' WHERE id='${id(5)}'`);
            const unchanged = graph(db);
            const receipts = rows(db, 'SELECT * FROM product_command_receipt');
            const result = handler.apply(restore());
            expect(result.type).toBe('ProductCommandRejected');
            expect(graph(db)).toEqual(unchanged);
            expect(rows(db, 'SELECT * FROM product_command_receipt')).toEqual(receipts);
            expect(rows(db, `SELECT revision FROM projects WHERE id='${P}'`)[0].revision).toBe(2);
        }
        finally {
            db.close();
        }
    });
    it.each(['delete', 'receipt', 'secondDependency'] as const)('rolls back %s storage failure and permits identical retry', fault => {
        const { db, handler, command, restore } = fixture();
        try {
            if (fault === 'secondDependency')
                handler.apply(command);
            const unchanged = graph(db);
            const receipts = rows(db, 'SELECT * FROM product_command_receipt');
            const trigger = fault === 'delete' ? `CREATE TRIGGER injected BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT,'synthetic'); END` : fault === 'receipt' ? `CREATE TRIGGER injected BEFORE INSERT ON product_command_receipt BEGIN SELECT RAISE(ABORT,'synthetic'); END` : `CREATE TRIGGER injected BEFORE INSERT ON node_custom_fields WHEN NEW.field_key='nullable' BEGIN SELECT RAISE(ABORT,'synthetic'); END`;
            db.exec(trigger);
            const c = fault === 'secondDependency' ? restore() : command;
            const entry = { commandId: c.commandId, commandJson: JSON.stringify(c), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' };
            expect(() => handler.applyWithOutbox(c, entry, P)).toThrow();
            expect(graph(db)).toEqual(unchanged);
            expect(rows(db, 'SELECT * FROM product_command_receipt')).toEqual(receipts);
            expect(rows(db, 'SELECT * FROM collaboration_attempt_receipt')).toHaveLength(0);
            db.exec('DROP TRIGGER injected');
            expect(handler.applyWithOutbox(c, entry, P).type).toBe('ProductCommandApplied');
        }
        finally {
            db.close();
        }
    });
    it('rejects malformed bundles and unrelated injected dependencies, while preserving absent legacy wire shape', () => {
        const { db, before } = fixture();
        try {
            const basic = deletionBasicNodes(before);
            expect(() => validateDeletionBundle({ ...before, nodes: before.nodes.map(n => ({ ...n, projectId: id(7) })) }, P, N, basic)).toThrow();
            expect(() => validateDeletionBundle({ ...before, unlockEdges: [{ id: id(90), sourceNodeId: id(4), targetNodeId: id(5) }] }, P, N, basic)).toThrow();
            const legacy = createRestoreSubtreeWireCommand({ commandId: id(101), projectId: P, baseRevision: 2, rootNodeId: N, nodes: basic });
            expect(Object.hasOwn(legacy, 'deletionBundle')).toBe(false);
            expect(deletionReceiptCompleteness(legacy)).toBe('legacy-incomplete');
            expect(deletionReceiptCompleteness({ ...legacy, deletionBundle: { ...before, customFields: [], openQuestions: [], unlockEdges: [], affectedReasons: [] } })).toBe('complete');
        }
        finally {
            db.close();
        }
    });
});

import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { PortableProjectSnapshot } from '../../contracts/portable-file.schema';
import { validateLocalSnapshot as validateAuthoredSnapshot, parseLocalFileState } from '../../application/portable-file/local-merge';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import { RECOVERY_GRAPH_TABLES } from '../../contracts/collaboration-recovery';
import { assertWritableSchema } from './schema';
export type LocalFileMergeInput = Readonly<{
    operationId: string;
    projectId: string;
    expectedRevision: number;
    snapshot: PortableProjectSnapshot;
    stateJson: string;
}>;
export type LocalFileRecovery = Readonly<{
    snapshot: PortableProjectSnapshot;
    stateJson: string | null;
    appliedRevision: number;
}>;
export const LOCAL_FILE_DDL = `CREATE TABLE IF NOT EXISTS local_file_state(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_file_recovery(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,snapshot_json TEXT NOT NULL,state_json TEXT,applied_revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_file_receipt(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(project_id,operation_id));`;
export function initializeLocalFileSchema(db: Database): void { db.exec(LOCAL_FILE_DDL); }
type Row = Record<string, SqlValue>;
function rows(db: Database, sql: string, bind: SqlValue[] = []): Row[] { return db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Row[]; }
function state(value: string, snapshot: PortableProjectSnapshot): void { parseLocalFileState(value, snapshot); }
export function validateLocalSnapshot(snapshot: PortableProjectSnapshot): void { validateAuthoredSnapshot(snapshot); }
function revision(db: Database, projectId: string, expected: number): void {
    assertWritableSchema(db);
    const found = rows(db, 'SELECT revision FROM projects WHERE id=?', [projectId])[0];
    if (!found)
        throw new Error('PROJECT_NOT_FOUND');
    if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER || Number(found.revision) !== expected)
        throw new Error('STALE_MERGE_REVIEW');
    if (rows(db, 'SELECT project_id FROM collaboration_cursor WHERE project_id=?', [projectId]).length)
        throw new Error('ONLINE_PROJECT_NOT_SUPPORTED');
}
export function readLocalFileStateDb(db: Database, projectId: string): string | null { const row = rows(db, 'SELECT state_json FROM local_file_state WHERE project_id=?', [projectId])[0]; return row ? String(row.state_json) : null; }
export function writeLocalFileStateDb(db: Database, projectId: string, expected: number, value: string, capture: () => PortableProjectSnapshot): void {
    state(value, capture());
    db.exec('BEGIN IMMEDIATE');
    try {
        revision(db, projectId, expected);
        setState(db, projectId, value);
        db.exec('COMMIT');
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* original error */ }
        throw error;
    }
}
function setState(db: Database, projectId: string, value: string | null): void {
    if (value === null)
        db.exec({ sql: 'DELETE FROM local_file_state WHERE project_id=?', bind: [projectId] });
    else
        db.exec({ sql: 'INSERT INTO local_file_state(project_id,state_json) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET state_json=excluded.state_json', bind: [projectId, value] });
}
export function readLocalFileRecoveryDb(db: Database, projectId: string): LocalFileRecovery | null {
    const row = rows(db, 'SELECT snapshot_json,state_json,applied_revision FROM local_file_recovery WHERE project_id=?', [projectId])[0];
    return row ? Object.freeze({ snapshot: JSON.parse(String(row.snapshot_json)) as PortableProjectSnapshot, stateJson: row.state_json === null ? null : String(row.state_json), appliedRevision: Number(row.applied_revision) }) : null;
}
/** Caller owns the only transaction. No project deletion: workspace placement survives. */
function replace(db: Database, snapshot: PortableProjectSnapshot, nextRevision: number): void {
    db.exec('PRAGMA defer_foreign_keys=ON');
    const mapped: Record<string, readonly unknown[]> = { phases: snapshot.phases, nodes: snapshot.nodes, customFields: snapshot.nodeCustomFields, typeTemplateFields: snapshot.typeTemplateFields, unlockEdges: snapshot.unlockEdges, dismissals: snapshot.findingDismissals, affectedReasons: snapshot.affectedReasons, openQuestions: snapshot.openQuestions, forecastPlans: snapshot.forecastPlan ? [snapshot.forecastPlan] : [], forecastScenarios: snapshot.forecastScenarios ?? [] };
    for (const [, table] of [...RECOVERY_GRAPH_TABLES].reverse())
        if (table !== 'projects')
            db.exec({ sql: `DELETE FROM ${table} WHERE project_id=?`, bind: [snapshot.projectId] });
    for (const [key, table, fields] of RECOVERY_GRAPH_TABLES) {
        if (key === 'project') {
            db.exec({ sql: 'UPDATE projects SET name=?,revision=? WHERE id=?', bind: [snapshot.projectName, nextRevision, snapshot.projectId] });
            continue;
        }
        for (const entry of mapped[key] ?? []) {
            const record = entry as Record<string, unknown>;
            const bind = fields.map(([field]) => {
                if (field === 'projectId')
                    return snapshot.projectId;
                if (field === 'createdAtIso')
                    return (record.createdAtISO ?? null) as SqlValue;
                if (field === 'resolvedAtIso')
                    return (record.resolvedAtISO ?? null) as SqlValue;
                if (field === 'baselineJson')
                    return JSON.stringify(record.baseline);
                if (field === 'patchJson')
                    return JSON.stringify(record.patch);
                let value = record[field];
                if (field === 'position')
                    value = String(value);
                if (table === 'forecast_plans' && ['selectedFeatureIds', 'parallelGroups', 'blockedFeatureIds', 'roster', 'assignments'].includes(field))
                    return JSON.stringify(value ?? (field === 'assignments' ? {} : []));
                if (field === 'deliveryStatus')
                    value ??= 'not_started';
                if (field === 'planningLevel')
                    value ??= 'Feature';
                if (typeof value === 'boolean')
                    return Number(value);
                return (value ?? null) as SqlValue;
            });
            db.exec({ sql: `INSERT INTO ${table}(${fields.map(([, column]) => column).join(',')}) VALUES(${fields.map(() => '?').join(',')})`, bind });
        }
    }
    // Undo receipts before the replacement refer to a different graph cut.
    db.exec({ sql: 'DELETE FROM product_command_receipt WHERE project_id=?', bind: [snapshot.projectId] });
}
export function applyLocalFileMergeDb(db: Database, input: LocalFileMergeInput, capture: () => PortableProjectSnapshot): {
    revision: number;
} {
    validateLocalSnapshot(input.snapshot);
    state(input.stateJson, input.snapshot);
    if (input.snapshot.projectId !== input.projectId || !input.operationId || input.operationId.length > 200)
        throw new Error('INVALID_MERGE_REQUEST');
    const payload = computeForecastFingerprintSync(input);
    assertWritableSchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
        const old = rows(db, 'SELECT revision,payload_hash FROM local_file_receipt WHERE project_id=? AND operation_id=?', [input.projectId, input.operationId])[0];
        if (old) {
            if (old.payload_hash !== payload)
                throw new Error('MERGE_OPERATION_ID_CONFLICT');
            db.exec('COMMIT');
            return { revision: Number(old.revision) };
        }
        revision(db, input.projectId, input.expectedRevision);
        const before = capture();
        const previousState = readLocalFileStateDb(db, input.projectId);
        const next = input.expectedRevision + 1;
        db.exec({ sql: 'INSERT INTO local_file_recovery(project_id,snapshot_json,state_json,applied_revision) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,state_json=excluded.state_json,applied_revision=excluded.applied_revision', bind: [input.projectId, JSON.stringify(before), previousState, next] });
        replace(db, input.snapshot, next);
        setState(db, input.projectId, input.stateJson);
        db.exec({ sql: 'INSERT INTO local_file_receipt(project_id,operation_id,payload_hash,revision) VALUES(?,?,?,?)', bind: [input.projectId, input.operationId, payload, next] });
        db.exec('COMMIT');
        return { revision: next };
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* original error */ }
        throw error;
    }
}
export function restoreLocalFileMergeDb(db: Database, projectId: string, expected: number, operationId: string, capture: () => PortableProjectSnapshot): {
    revision: number;
} {
    assertWritableSchema(db);
    db.exec('BEGIN IMMEDIATE');
    try {
        const payload = computeForecastFingerprintSync({ restore: true, projectId, expected, operationId });
        const old = rows(db, 'SELECT revision,payload_hash FROM local_file_receipt WHERE project_id=? AND operation_id=?', [projectId, operationId])[0];
        if (old) {
            if (old.payload_hash !== payload)
                throw new Error('MERGE_OPERATION_ID_CONFLICT');
            db.exec('COMMIT');
            return { revision: Number(old.revision) };
        }
        revision(db, projectId, expected);
        const recovery = readLocalFileRecoveryDb(db, projectId);
        if (!recovery)
            throw new Error('RECOVERY_NOT_FOUND');
        const current = capture();
        const currentState = readLocalFileStateDb(db, projectId);
        validateLocalSnapshot(recovery.snapshot);
        let restoredStateJson = recovery.stateJson;
        if (restoredStateJson !== null) {
            const restored = parseLocalFileState(restoredStateJson, recovery.snapshot);
            if (currentState !== null) {
                const active = parseLocalFileState(currentState, current);
                // Files already exported remain in circulation after recovery. Never
                // reuse an older sequence for the same local replica.
                if (restored.replicaId === active.replicaId && (active.exportSequence ?? 0) > (restored.exportSequence ?? 0)) {
                    restoredStateJson = JSON.stringify({ ...restored, exportSequence: active.exportSequence });
                }
            }
        }
        replace(db, recovery.snapshot, expected + 1);
        setState(db, projectId, restoredStateJson);
        db.exec({ sql: 'DELETE FROM local_file_receipt WHERE project_id=?', bind: [projectId] });
        db.exec({ sql: 'UPDATE local_file_recovery SET snapshot_json=?,state_json=?,applied_revision=? WHERE project_id=?', bind: [JSON.stringify(current), currentState, expected + 1, projectId] });
        db.exec({ sql: 'INSERT INTO local_file_receipt(project_id,operation_id,payload_hash,revision) VALUES(?,?,?,?)', bind: [projectId, operationId, payload, expected + 1] });
        db.exec('COMMIT');
        return { revision: expected + 1 };
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* original error */ }
        throw error;
    }
}

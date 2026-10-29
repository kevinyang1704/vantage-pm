/** Transaction-scoped lossless subtree capture and restoration. */
import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { NodeSnapshot } from '../../contracts/change-set';
import { cloneFrozenDeletionBundle, validateDeletionBundle, type DeletionBundle } from '../../contracts/deletion-bundle';
import { HIERARCHY_RANKS } from '../../domain/tree/node-hierarchy.policy';
import type { ProductCommandRejected } from '../../contracts/repository-commands';
function rows(db: Database, sql: string, bind: readonly SqlValue[] = []): Record<string, SqlValue>[] {
    return db.exec({ sql, bind: [...bind], rowMode: 'object', returnValue: 'resultRows' }) as Record<string, SqlValue>[];
}
function persistedBoolean(value: SqlValue | undefined): boolean {
    if (value !== 0 && value !== 1)
        throw new Error('INVALID_DELETION_BUNDLE');
    return value === 1;
}
const nullable = (v: SqlValue | undefined): string | null => v === null || v === undefined ? null : String(v);
const numberOrNull = (v: SqlValue | undefined): number | null => v === null || v === undefined ? null : Number(v);
export function captureDeletionBundle(db: Database, projectId: string, rootNodeId: string): DeletionBundle {
    const nodes = rows(db, `WITH RECURSIVE s(id,depth) AS (
    SELECT id,0 FROM nodes WHERE id=? AND project_id=? UNION ALL
    SELECT n.id,s.depth+1 FROM nodes n JOIN s ON n.parent_id=s.id WHERE n.project_id=?
  ) SELECT n.*,s.depth FROM nodes n JOIN s ON n.id=s.id ORDER BY s.depth,n.position`, [rootNodeId, projectId, projectId]).map(r => ({
        nodeId: String(r.id), projectId: String(r.project_id), parentId: nullable(r.parent_id), title: String(r.title),
        bodyText: nullable(r.body_text), position: String(r.position), depth: Number(r.depth), nodeType: nullable(r.node_type),
        startDate: nullable(r.start_date), endDate: nullable(r.end_date), durationDays: numberOrNull(r.duration_days),
        scheduleSourceMode: nullable(r.schedule_source_mode), completed: persistedBoolean(r.completed),
        effortPoints: numberOrNull(r.effort_points), effortPointsDone: numberOrNull(r.effort_points_done),
        strategicWeight: numberOrNull(r.strategic_weight), phaseId: nullable(r.phase_id), deliveryStatus: nullable(r.delivery_status),
    }));
    const ids = nodes.map(n => n.nodeId);
    const select = (table: string, columns: string[]) => ids.length === 0 ? [] : rows(db, `SELECT * FROM ${table} WHERE project_id=? AND (${columns.map(c => `${c} IN (${ids.map(() => '?').join(',')})`).join(' OR ')}) ORDER BY rowid`, [projectId, ...columns.flatMap(() => ids)]);
    return cloneFrozenDeletionBundle({ version: 1, projectId, rootNodeId, nodes,
        customFields: select('node_custom_fields', ['node_id']).map(r => ({ nodeId: String(r.node_id), fieldKey: String(r.field_key), fieldValue: nullable(r.field_value) })),
        openQuestions: select('node_open_questions', ['node_id']).map(r => ({ id: String(r.id), nodeId: String(r.node_id), questionText: String(r.question_text), status: r.status as 'OPEN' | 'DECIDED', decisionText: nullable(r.decision_text), position: String(r.position), resolvedAtISO: nullable(r.resolved_at_iso), createdAtISO: String(r.created_at_iso) })),
        unlockEdges: select('unlock_edges', ['source_node_id', 'target_node_id']).map(r => ({ id: String(r.id), sourceNodeId: String(r.source_node_id), targetNodeId: String(r.target_node_id) })),
        affectedReasons: select('affected_reasons', ['affected_node_id', 'causal_node_id']).map(r => ({ id: String(r.id), affectedNodeId: String(r.affected_node_id), causalNodeId: String(r.causal_node_id), causalNodeTitle: String(r.causal_node_title), deltaDays: Number(r.delta_days), causalDateSummary: String(r.causal_date_summary), createdAt: String(r.created_at), acknowledgedAt: nullable(r.acknowledged_at) })),
    });
}
export function deletionBasicNodes(bundle: DeletionBundle): readonly NodeSnapshot[] {
    return Object.freeze(bundle.nodes.map(n => Object.freeze({ nodeId: n.nodeId, parentId: n.parentId, title: n.title, bodyText: n.bodyText, position: n.position, depth: n.depth })));
}
export function restoreDeletionBundle(db: Database, input: DeletionBundle, projectId: string, rootNodeId: string, basic: readonly NodeSnapshot[]): ProductCommandRejected['code'] | null {
    let bundle: DeletionBundle;
    try {
        bundle = validateDeletionBundle(input, projectId, rootNodeId, basic);
    }
    catch {
        return 'INVALID_DELETION_BUNDLE';
    }
    const byId = new Map(bundle.nodes.map(n => [n.nodeId, n]));
    const exists = (table: string, id: string) => rows(db, `SELECT id FROM ${table} WHERE id=?`, [id]).length > 0;
    const endpointExists = (id: string) => byId.has(id) || rows(db, 'SELECT id FROM nodes WHERE id=? AND project_id=?', [id, projectId]).length > 0;
    const positions = new Set<string>();
    const rank = (type: string | null): number | undefined => type === null ? undefined : Object.entries(HIERARCHY_RANKS).find(([key]) => key === type)?.[1];
    for (const n of bundle.nodes) {
        if (exists('nodes', n.nodeId))
            return 'RESTORE_IDENTITY_CONFLICT';
        if (n.phaseId !== null && rows(db, 'SELECT id FROM phases WHERE id=? AND project_id=?', [n.phaseId, projectId]).length === 0)
            return 'RESTORE_DEPENDENCY_MISSING';
        let parentType: string | null = null;
        if (n.parentId !== null) {
            const parent = byId.get(n.parentId);
            if (parent)
                parentType = parent.nodeType;
            else {
                const stored = rows(db, 'SELECT node_type FROM nodes WHERE id=? AND project_id=?', [n.parentId, projectId])[0];
                if (!stored)
                    return 'RESTORE_DEPENDENCY_MISSING';
                parentType = nullable(stored.node_type);
            }
        }
        const pr = rank(parentType), nr = rank(n.nodeType);
        if (pr !== undefined && nr !== undefined && pr > nr)
            return 'HIERARCHY_CONFLICT';
        const key = JSON.stringify([n.parentId, Number(n.position)]);
        if (positions.has(key) || rows(db, 'SELECT id FROM nodes WHERE project_id=? AND parent_id IS ? AND position=?', [projectId, n.parentId, Number(n.position)]).length > 0)
            return 'RESTORE_POSITION_CONFLICT';
        positions.add(key);
    }
    for (const q of bundle.openQuestions)
        if (exists('node_open_questions', q.id))
            return 'RESTORE_IDENTITY_CONFLICT';
    for (const e of bundle.unlockEdges) {
        if (!endpointExists(e.sourceNodeId) || !endpointExists(e.targetNodeId))
            return 'RESTORE_DEPENDENCY_MISSING';
        if (exists('unlock_edges', e.id) || rows(db, 'SELECT id FROM unlock_edges WHERE project_id=? AND source_node_id=? AND target_node_id=?', [projectId, e.sourceNodeId, e.targetNodeId]).length > 0)
            return 'RESTORE_IDENTITY_CONFLICT';
    }
    for (const r of bundle.affectedReasons) {
        if (!endpointExists(r.affectedNodeId) || !endpointExists(r.causalNodeId))
            return 'RESTORE_DEPENDENCY_MISSING';
        if (exists('affected_reasons', r.id))
            return 'RESTORE_IDENTITY_CONFLICT';
    }
    for (const n of [...bundle.nodes].sort((a, b) => a.depth - b.depth))
        db.exec({ sql: `INSERT INTO nodes(id,project_id,parent_id,title,body_text,position,node_type,start_date,end_date,duration_days,schedule_source_mode,completed,effort_points,effort_points_done,strategic_weight,phase_id,delivery_status) VALUES(${Array(17).fill('?').join(',')})`, bind: [n.nodeId, projectId, n.parentId, n.title, n.bodyText, Number(n.position), n.nodeType, n.startDate, n.endDate, n.durationDays, n.scheduleSourceMode, n.completed ? 1 : 0, n.effortPoints, n.effortPointsDone, n.strategicWeight, n.phaseId, n.deliveryStatus] });
    for (const f of bundle.customFields)
        db.exec({ sql: 'INSERT INTO node_custom_fields(project_id,node_id,field_key,field_value) VALUES(?,?,?,?)', bind: [projectId, f.nodeId, f.fieldKey, f.fieldValue] });
    for (const q of bundle.openQuestions)
        db.exec({ sql: 'INSERT INTO node_open_questions(id,project_id,node_id,question_text,status,decision_text,position,resolved_at_iso,created_at_iso) VALUES(?,?,?,?,?,?,?,?,?)', bind: [q.id, projectId, q.nodeId, q.questionText, q.status, q.decisionText, Number(q.position), q.resolvedAtISO, q.createdAtISO] });
    for (const e of bundle.unlockEdges)
        db.exec({ sql: 'INSERT INTO unlock_edges(id,project_id,source_node_id,target_node_id) VALUES(?,?,?,?)', bind: [e.id, projectId, e.sourceNodeId, e.targetNodeId] });
    for (const r of bundle.affectedReasons)
        db.exec({ sql: 'INSERT INTO affected_reasons(id,project_id,affected_node_id,causal_node_id,causal_node_title,delta_days,causal_date_summary,created_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?)', bind: [r.id, projectId, r.affectedNodeId, r.causalNodeId, r.causalNodeTitle, r.deltaDays, r.causalDateSummary, r.createdAt, r.acknowledgedAt] });
    return null;
}

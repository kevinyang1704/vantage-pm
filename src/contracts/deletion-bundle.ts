/** Versioned, lossless facts actually removed by a subtree deletion. */
import { assertUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import type { NodeSnapshot } from './change-set';
export type CompleteDeletedNode = Readonly<{
    nodeId: string;
    projectId: string;
    parentId: string | null;
    title: string;
    bodyText: string | null;
    position: string;
    depth: number;
    nodeType: string | null;
    startDate: string | null;
    endDate: string | null;
    durationDays: number | null;
    scheduleSourceMode: string | null;
    completed: boolean;
    effortPoints: number | null;
    effortPointsDone: number | null;
    strategicWeight: number | null;
    phaseId: string | null;
    deliveryStatus: string | null;
}>;
export type DeletedCustomField = Readonly<{
    nodeId: string;
    fieldKey: string;
    fieldValue: string | null;
}>;
export type DeletedQuestion = Readonly<{
    id: string;
    nodeId: string;
    questionText: string;
    status: 'OPEN' | 'DECIDED';
    decisionText: string | null;
    position: string;
    resolvedAtISO: string | null;
    createdAtISO: string;
}>;
export type DeletedEdge = Readonly<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
}>;
export type DeletedAffectedReason = Readonly<{
    id: string;
    affectedNodeId: string;
    causalNodeId: string;
    causalNodeTitle: string;
    deltaDays: number;
    causalDateSummary: string;
    createdAt: string;
    acknowledgedAt: string | null;
}>;
export type DeletionBundle = Readonly<{
    version: 1;
    projectId: string;
    rootNodeId: string;
    nodes: readonly CompleteDeletedNode[];
    customFields: readonly DeletedCustomField[];
    openQuestions: readonly DeletedQuestion[];
    unlockEdges: readonly DeletedEdge[];
    affectedReasons: readonly DeletedAffectedReason[];
}>;
/** Copy every retained fact; callers keep ownership of their mutable input. */
export function cloneFrozenDeletionBundle(bundle: DeletionBundle): DeletionBundle {
    return Object.freeze({
        ...bundle,
        nodes: Object.freeze(bundle.nodes.map(row => Object.freeze({ ...row }))),
        customFields: Object.freeze(bundle.customFields.map(row => Object.freeze({ ...row }))),
        openQuestions: Object.freeze(bundle.openQuestions.map(row => Object.freeze({ ...row }))),
        unlockEdges: Object.freeze(bundle.unlockEdges.map(row => Object.freeze({ ...row }))),
        affectedReasons: Object.freeze(bundle.affectedReasons.map(row => Object.freeze({ ...row }))),
    });
}
export function deletionReceiptCompleteness(value: Readonly<{
    deletionBundle?: DeletionBundle;
}>): 'complete' | 'legacy-incomplete' {
    return value.deletionBundle === undefined ? 'legacy-incomplete' : 'complete';
}
function invalid(): never { throw new Error('INVALID_DELETION_BUNDLE'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
        return invalid();
    return row;
}
function text(value: unknown): asserts value is string {
    if (typeof value !== 'string')
        invalid();
}
function nullableText(value: unknown): void {
    if (value !== null)
        text(value);
}
function integer(value: unknown): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        invalid();
}
function position(value: unknown): void {
    text(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        invalid();
}
function uuid(value: unknown): void { text(value); assertUuidV7(value, 'deletionBundle.id'); }
function unique(rows: readonly Record<string, unknown>[], identity: (row: Record<string, unknown>) => string): void {
    const ids = rows.map(identity);
    if (new Set(ids).size !== ids.length)
        invalid();
}
export function validateDeletionBundle(input: unknown, projectId: string, rootNodeId: string, legacyNodes: readonly NodeSnapshot[]): DeletionBundle {
    const bundle = record(input, ['version', 'projectId', 'rootNodeId', 'nodes', 'customFields', 'openQuestions', 'unlockEdges', 'affectedReasons']);
    if (bundle.version !== 1 || bundle.projectId !== projectId || bundle.rootNodeId !== rootNodeId)
        invalid();
    uuid(bundle.projectId);
    uuid(bundle.rootNodeId);
    for (const collection of ['nodes', 'customFields', 'openQuestions', 'unlockEdges', 'affectedReasons'])
        if (!Array.isArray(bundle[collection]))
            invalid();
    const nodes = (bundle.nodes as unknown[]).map((value) => {
        const row = record(value, ['nodeId', 'projectId', 'parentId', 'title', 'bodyText', 'position', 'depth', 'nodeType', 'startDate', 'endDate', 'durationDays', 'scheduleSourceMode', 'completed', 'effortPoints', 'effortPointsDone', 'strategicWeight', 'phaseId', 'deliveryStatus']);
        uuid(row.nodeId);
        if (row.projectId !== projectId)
            invalid();
        for (const field of ['parentId', 'phaseId'])
            if (row[field] !== null)
                uuid(row[field]);
        text(row.title);
        position(row.position);
        integer(row.depth);
        if (row.depth < 0 || typeof row.completed !== 'boolean')
            invalid();
        for (const field of ['bodyText', 'nodeType', 'startDate', 'endDate', 'scheduleSourceMode', 'deliveryStatus'])
            nullableText(row[field]);
        for (const field of ['durationDays', 'effortPoints', 'effortPointsDone', 'strategicWeight'])
            if (row[field] !== null)
                integer(row[field]);
        return row;
    });
    unique(nodes, (row) => String(row.nodeId));
    const byId = new Map(nodes.map((row) => [String(row.nodeId), row]));
    if (!nodes.length || legacyNodes.length !== nodes.length || new Set(legacyNodes.map((n) => n.nodeId)).size !== nodes.length)
        invalid();
    for (const node of nodes) {
        const isRoot = node.nodeId === rootNodeId;
        if (isRoot ? node.depth !== 0 || (node.parentId !== null && byId.has(String(node.parentId))) : node.depth === 0 || !byId.has(String(node.parentId)) || Number(byId.get(String(node.parentId))?.depth) + 1 !== node.depth)
            invalid();
        const legacy = legacyNodes.find((n) => n.nodeId === node.nodeId);
        if (!legacy || ['parentId', 'title', 'bodyText', 'position', 'depth'].some((field) => (legacy as unknown as Record<string, unknown>)[field] !== node[field]))
            invalid();
    }
    if (!byId.has(rootNodeId))
        invalid();
    const owned = (id: unknown) => {
        uuid(id);
        if (!byId.has(String(id)))
            invalid();
    };
    const fields = (bundle.customFields as unknown[]).map((value) => { const row = record(value, ['nodeId', 'fieldKey', 'fieldValue']); owned(row.nodeId); text(row.fieldKey); nullableText(row.fieldValue); return row; });
    unique(fields, (row) => JSON.stringify([row.nodeId, row.fieldKey]));
    const questions = (bundle.openQuestions as unknown[]).map((value) => {
        const row = record(value, ['id', 'nodeId', 'questionText', 'status', 'decisionText', 'position', 'resolvedAtISO', 'createdAtISO']);
        uuid(row.id);
        owned(row.nodeId);
        text(row.questionText);
        if (row.status !== 'OPEN' && row.status !== 'DECIDED')
            invalid();
        nullableText(row.decisionText);
        position(row.position);
        nullableText(row.resolvedAtISO);
        text(row.createdAtISO);
        return row;
    });
    unique(questions, (row) => String(row.id));
    const edges = (bundle.unlockEdges as unknown[]).map((value) => {
        const row = record(value, ['id', 'sourceNodeId', 'targetNodeId']);
        uuid(row.id);
        uuid(row.sourceNodeId);
        uuid(row.targetNodeId);
        if (!byId.has(String(row.sourceNodeId)) && !byId.has(String(row.targetNodeId)))
            invalid();
        return row;
    });
    unique(edges, (row) => String(row.id));
    unique(edges, (row) => JSON.stringify([row.sourceNodeId, row.targetNodeId]));
    const reasons = (bundle.affectedReasons as unknown[]).map((value) => {
        const row = record(value, ['id', 'affectedNodeId', 'causalNodeId', 'causalNodeTitle', 'deltaDays', 'causalDateSummary', 'createdAt', 'acknowledgedAt']);
        uuid(row.id);
        uuid(row.affectedNodeId);
        uuid(row.causalNodeId);
        integer(row.deltaDays);
        text(row.causalNodeTitle);
        text(row.causalDateSummary);
        text(row.createdAt);
        nullableText(row.acknowledgedAt);
        if (!byId.has(String(row.affectedNodeId)) && !byId.has(String(row.causalNodeId)))
            invalid();
        return row;
    });
    unique(reasons, (row) => String(row.id));
    return cloneFrozenDeletionBundle(input as DeletionBundle);
}

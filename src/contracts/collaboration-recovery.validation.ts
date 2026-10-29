import { assertUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import { canonicalizeJcs } from '../../spikes/phase-0-durability/src/attestation';
import { validateProductCommand } from './repository-commands';
import { validateDeletionBundle } from './deletion-bundle';
import { RECOVERY_GRAPH_TABLES, type RecoveryEnvelope, type RecoveryGraph } from './collaboration-recovery';
import { RECOVERY_EFFECT_FIELDS, RECOVERY_EFFECT_SCHEMAS, type RecoveryEffectSchema } from './recovery-effect-fields';
import { canParentNodeType } from '../domain/tree/node-hierarchy.policy';
import { isValidNodeType } from '../domain/tree/node-type.policy';
import type { NodeType } from '../domain/tree/node.entity';
import { validatePersistedForecastScenario } from '../domain/forecast/scenario';
import { validateRoster, validateForecastGroups, validateCapacity, validateSprintLength, validateStartOrdinal, validateStartDate, validatePolicyVersion } from '../domain/forecast/forecast-validators';

const invalid = (): never => { throw new Error('INVALID_RECOVERY_ENVELOPE'); };
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (keys && (Object.keys(result).length !== keys.length || keys.some(k => !Object.hasOwn(result, k)))) invalid();
  return result;
}
function integer(value: unknown, nonnegative = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (nonnegative && value < 0)) invalid();
}
function date(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(String(value));
  if (!match) invalid();
  const year = Number(match![1]); const month = Number(match![2]); const day = Number(match![3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(match![4]) > 23 || Number(match![5]) > 59 || Number(match![6]) > 59) invalid();
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : invalid(); }
function effectValue(value: unknown, schema: RecoveryEffectSchema, projectId: string, field = ''): void {
  if (schema === 'string') {
    if (typeof value !== 'string') invalid();
    if (/^(?:id|nodeId|parentId|priorParentId|rootNodeId|sourceRootId|newRootId|phaseId|priorPhaseId|edgeId|sourceNodeId|targetNodeId|affectedNodeId|causalNodeId|reasonId|questionId|projectId|featureId|afterId|beforeId|personId|scenarioId)$/.test(field)) assertUuidV7(value as string, field);
    if (field === 'projectId' && value !== projectId) invalid();
    if (/Position$|^position$/.test(field)) {
      if (!/^-?\d+$/.test(value as string)) invalid();
      const position = BigInt(value as string); if (position < -9223372036854775808n || position > 9223372036854775807n) invalid();
    }
    if (/At(?:ISO)?$/.test(field)) date(value);
    return;
  }
  if (schema === 'integer') { integer(value); return; }
  if (schema === 'boolean') { if (typeof value !== 'boolean') invalid(); return; }
  if ('literal' in schema) { if (value !== schema.literal) invalid(); return; }
  if ('union' in schema) { for (const alternative of schema.union) { try { effectValue(value, alternative, projectId, field); return; } catch { /* Try the next declared variant. */ } } return invalid(); }
  if ('array' in schema) { for (const child of array(value)) effectValue(child, schema.array, projectId, field.endsWith('Ids') || field === 'clearedAssignments' ? 'id' : ''); return; }
  if ('dictionary' in schema) { for (const [key, child] of Object.entries(record(value))) { assertUuidV7(key, 'effect dictionary key'); effectValue(child, schema.dictionary, projectId, field === 'assignments' || field === 'priorAssignments' ? 'personIds' : 'phaseId'); } return; }
  if ('object' in schema) {
    const object = record(value); if (Object.keys(object).some(key => !Object.hasOwn(schema.object, key))) invalid();
    for (const [key, child] of Object.entries(schema.object)) { if (!Object.hasOwn(object, key) && child.optional) continue; effectValue(object[key], child.schema, projectId, key); }
    return;
  }
  switch (schema.custom) {
    case 'NodeType': if (!isValidNodeType(value)) invalid(); return;
    case 'ScheduleSourceMode': if (!['start_end', 'start_duration', 'end_duration', 'none'].includes(String(value))) invalid(); return;
    case 'DeliveryStatus': if (!['not_started', 'in_progress', 'delivered'].includes(String(value))) invalid(); return;
    case 'ForecastNodeLevel': if (!['Theme', 'Component', 'Feature'].includes(String(value))) invalid(); return;
    case 'ForecastPolicyVersion': if (validatePolicyVersion(value)) invalid(); return;
    case 'ForecastPerson': record(value, ['id', 'name', 'weightUnits']); if (validateRoster([value]).length) invalid(); return;
    case 'PersistedForecastScenario': if (validatePersistedForecastScenario(value, projectId).length) invalid(); return;
    case 'ForecastGroupChange': {
      const group = record(value); if (group.kind === 'unchanged' || group.kind === 'leave') { record(group, ['kind']); return; }
      if (group.kind === 'join') { record(group, ['kind', 'partnerId']); assertUuidV7(group.partnerId as string, 'partnerId'); return; }
      return invalid();
    }
    case 'DeletionBundle': return; // Validated with exact subtree binding below.
    default: return invalid();
  }
}
export async function recoveryPayloadDigest(command: unknown): Promise<string> {
  const { commandId: _id, ...body } = record(command);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeJcs(body)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateRecoveryGraph(value: unknown, projectId: string): asserts value is RecoveryGraph {
  const graph = record(value, RECOVERY_GRAPH_TABLES.map(([key]) => key));
  for (const [key, , fields] of RECOVERY_GRAPH_TABLES) {
    const list: unknown[] = key === 'project' ? [graph[key]] : Array.isArray(graph[key]) ? graph[key] as unknown[] : invalid();
    const identities = new Set<string>();
    for (const raw of list) {
      const row = record(raw, fields.map(([name]) => name));
      for (const [name, , kind] of fields) {
        const cell = row[name];
        if (kind.endsWith('?') && cell === null) continue;
        if (kind.startsWith('s')) { if (typeof cell !== 'string') invalid(); }
        else if (kind.startsWith('i')) integer(cell);
        else if (typeof cell !== 'boolean') invalid();
      }
      if (row.projectId !== undefined && row.projectId !== projectId) invalid();
      for (const name of ['id', 'nodeId', 'parentId', 'phaseId', 'sourceNodeId', 'targetNodeId', 'affectedNodeId', 'causalNodeId', 'scenarioId']) {
        if (row[name] != null) assertUuidV7(String(row[name]), name);
      }
      const identity = row.id ?? row.scenarioId ?? (key === 'customFields' ? JSON.stringify([row.nodeId, row.fieldKey]) : key === 'typeTemplateFields' ? JSON.stringify([row.nodeType, row.fieldKey]) : key === 'dismissals' ? JSON.stringify([row.findingKind, row.targetId, row.fingerprint]) : row.projectId);
      if (identities.has(String(identity))) invalid(); identities.add(String(identity));
      for (const name of ['createdAtIso', 'resolvedAtIso', 'createdAt', 'acknowledgedAt', 'dismissedAt']) if (row[name] != null) date(row[name]);
    }
  }
  const typed = value as RecoveryGraph;
  if (typed.project.id !== projectId || typed.forecastPlans.length > 1) invalid();
  integer(typed.project.revision, true);
  const nodes = new Map(typed.nodes.map(node => [node.id, node]));
  const phases = new Set(typed.phases.map(phase => phase.id));
  const positions = new Set<string>();
  for (const node of typed.nodes) {
    // Persisted vocabulary is open. Only known typed edges carry rank rules;
    // unknown historical labels must survive recovery without coercion.
    const parentType = node.parentId === null ? null : nodes.get(node.parentId)?.nodeType;
    if (isValidNodeType(parentType) && isValidNodeType(node.nodeType) && !canParentNodeType(parentType as NodeType, node.nodeType as NodeType)) invalid();
    if (node.scheduleSourceMode !== null && !['start_end', 'start_duration', 'end_duration', 'none'].includes(node.scheduleSourceMode)) invalid();
    if (node.deliveryStatus !== null && !['not_started', 'in_progress', 'delivered'].includes(node.deliveryStatus)) invalid();
    const positionKey = JSON.stringify([node.parentId, node.position]); if (positions.has(positionKey)) invalid(); positions.add(positionKey);
    if (node.phaseId !== null && !phases.has(node.phaseId)) invalid();
    const visited = new Set<string>([node.id]); let parent = node.parentId;
    while (parent !== null) { if (visited.has(parent) || !nodes.has(parent)) invalid(); visited.add(parent); parent = nodes.get(parent)!.parentId; }
    if (node.effortPointsDone !== null && (node.effortPointsDone < 0 || node.effortPoints === null || node.effortPointsDone > node.effortPoints)) invalid();
  }
  for (const row of [...typed.customFields, ...typed.openQuestions]) if (!nodes.has(row.nodeId)) invalid();
  for (const row of typed.openQuestions) if (!['OPEN', 'DECIDED'].includes(row.status)) invalid();
  const edgePairs = new Set<string>();
  for (const row of typed.unlockEdges) { const pair = JSON.stringify([row.sourceNodeId, row.targetNodeId]); if (!nodes.has(row.sourceNodeId) || !nodes.has(row.targetNodeId) || row.sourceNodeId === row.targetNodeId || edgePairs.has(pair)) invalid(); edgePairs.add(pair); }
  for (const row of typed.affectedReasons) if (!nodes.has(row.affectedNodeId) || !nodes.has(row.causalNodeId)) invalid();
  for (const plan of typed.forecastPlans) {
    const selected: unknown = JSON.parse(plan.selectedFeatureIds); const groups: unknown = JSON.parse(plan.parallelGroups);
    const blocked: unknown = JSON.parse(plan.blockedFeatureIds); const roster: unknown = JSON.parse(plan.roster); const assignments = record(JSON.parse(plan.assignments));
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length || !Array.isArray(groups) || !Array.isArray(blocked) || !Array.isArray(roster)) invalid();
    for (const id of [...array(selected), ...array(blocked)]) assertUuidV7(id as string, 'forecast node ID');
    if (new Set(array(blocked)).size !== array(blocked).length || validateRoster(roster).length || validatePolicyVersion(plan.policyVersion) || !['Theme', 'Component', 'Feature'].includes(plan.planningLevel) || plan.cadence !== 'fixed-contiguous') invalid();
    if (validateCapacity(plan.pointsPerSprint, 'pointsPerSprint') || validateSprintLength(plan.sprintLengthDays, 'sprintLengthDays') || validateStartOrdinal(plan.startSprintOrdinal, 'startSprintOrdinal') || validateStartDate(plan.startDate, 'startDate')) invalid();
    for (const person of array(roster)) record(person, ['id', 'name', 'weightUnits']);
    const selectedIds = new Set(array(selected)); const people = new Set(array(roster).map(person => record(person).id));
    for (const group of array(groups)) { const ids = record(group, ['featureIds']).featureIds; if (!Array.isArray(ids) || ids.length < 2 || ids.some(id => !selectedIds.has(id))) invalid(); }
    if (validateForecastGroups(selected as string[], groups as {featureIds: string[]}[]).length) invalid();
    if (array(blocked).some(id => !selectedIds.has(id))) invalid();
    for (const [feature, assigned] of Object.entries(assignments)) { assertUuidV7(feature, 'assignment node ID'); if (!Array.isArray(assigned) || new Set(assigned).size !== assigned.length || assigned.some(id => !people.has(id))) invalid(); }
  }
  for (const scenario of typed.forecastScenarios) {
    const { baselineJson, patchJson, createdAtIso, ...rest } = scenario;
    if (validatePersistedForecastScenario({ ...rest, createdAtISO: createdAtIso, baseline: JSON.parse(baselineJson), patch: JSON.parse(patchJson) }, projectId).length) invalid();
  }
}
function footprints(value: unknown): void {
  const fp = record(value, ['availability', 'knownTargets', 'reason']);
  if (!['complete', 'unavailable'].includes(String(fp.availability)) || !Array.isArray(fp.knownTargets) || (fp.availability === 'complete' ? fp.reason !== null : typeof fp.reason !== 'string' || fp.reason.length === 0)) invalid();
  const identities = new Set<string>();
  for (const raw of array(fp.knownTargets)) {
    const target = record(raw); const keys = target.kind === 'entity' ? ['kind', 'entityType', 'id'] : target.kind === 'field' ? ['kind', 'entityType', 'id', 'field'] : target.kind === 'order' ? ['kind', 'collectionType', 'ownerId'] : target.kind === 'reference' ? ['kind', 'relation', 'sourceId', 'targetId'] : invalid();
    record(target, keys); if (Object.values(target).some(cell => typeof cell !== 'string' || cell.length === 0)) invalid();
    const identity = canonicalizeJcs(target); if (identities.has(identity)) invalid(); identities.add(identity);
  }
}
export async function validateRecoveryEnvelope(value: unknown, projectId: string): Promise<RecoveryEnvelope> {
  assertUuidV7(projectId, 'projectId');
  const envelope = record(value, ['version', 'protocolVersion', 'projectId', 'streamEpoch', 'serverRevision', 'historyFloor', 'dedupCoverage', 'graph', 'confirmedHistory', 'terminalRejections']);
  if (envelope.version !== 1 || envelope.protocolVersion !== '1.0.0' || envelope.projectId !== projectId || !['complete', 'unavailable'].includes(String(envelope.dedupCoverage))) invalid();
  integer(envelope.streamEpoch, true); integer(envelope.serverRevision, true); integer(envelope.historyFloor, true);
  if (envelope.streamEpoch === 0 || envelope.historyFloor > envelope.serverRevision) invalid();
  validateRecoveryGraph(envelope.graph, projectId);
  if (envelope.graph.project.revision !== envelope.serverRevision || !Array.isArray(envelope.confirmedHistory) || !Array.isArray(envelope.terminalRejections)) invalid();
  const ids = new Set<string>(); let revision = envelope.historyFloor;
  for (const raw of [...array(envelope.confirmedHistory), ...array(envelope.terminalRejections)]) {
    const applied = array(envelope.confirmedHistory).includes(raw);
    const entry = record(raw, applied ? ['command', 'result', 'payloadDigest', 'actorId', 'wireIdentityAvailability', 'protocolVersion', 'serverRevision', 'receiptRevisionAvailability', 'recordedAtIso', 'label', 'commandFootprint', 'effectFootprint', 'deletionMetadata'] : ['command', 'result', 'payloadDigest', 'actorId', 'wireIdentityAvailability', 'protocolVersion']);
    const command = validateProductCommand(entry.command); const result = record(entry.result);
    if (entry.actorId !== null) assertUuidV7(entry.actorId as string, 'actorId');
    if (!['original', 'legacy-admitted-wire'].includes(String(entry.wireIdentityAvailability)) || command.projectId !== projectId || ids.has(command.commandId) || entry.protocolVersion !== command.protocolVersion || (command.actorId != null && entry.actorId !== command.actorId) || entry.payloadDigest !== await recoveryPayloadDigest(entry.command) || result.commandId !== command.commandId || result.protocolVersion !== envelope.protocolVersion) invalid();
    ids.add(command.commandId);
    if (!applied) {
      const required = ['type', 'protocolVersion', 'commandId', 'code'];
      const optional = ['expectedRevision', 'projectId', 'nodeId', 'personId', 'conflictingFeatureIds', 'featureId', 'column', 'priorPointsDone'];
      if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => ![...required, ...optional].includes(key)) || result.type !== 'ProductCommandRejected' || typeof result.code !== 'string' || result.code.length === 0 || ['INTERNAL', 'STORAGE_FULL'].includes(result.code) || (result.projectId != null && result.projectId !== projectId)) invalid();
      for (const key of ['expectedRevision', 'priorPointsDone']) if (Object.hasOwn(result, key)) integer(result[key], true);
      for (const key of ['projectId', 'nodeId', 'personId', 'featureId']) if (Object.hasOwn(result, key)) assertUuidV7(result[key] as string, key);
      if (Object.hasOwn(result, 'column') && typeof result.column !== 'string') invalid();
      if (Object.hasOwn(result, 'conflictingFeatureIds')) for (const id of array(result.conflictingFeatureIds)) assertUuidV7(id as string, 'conflictingFeatureIds');
      continue;
    }
    revision += 1; if (entry.serverRevision !== revision || result.type !== 'ProductCommandApplied' || result.projectId !== projectId) invalid();
    const appliedKeys = ['type', 'protocolVersion', 'commandId', 'projectId', 'baseRevision', 'targetRevision', 'outcome', 'disposition'];
    if (appliedKeys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => ![...appliedKeys, 'changeSet'].includes(key)) || result.outcome !== 'VfsCommitAccepted' || !['NewCommit', 'StoredResultReturned'].includes(String(result.disposition))) invalid();
    footprints(entry.commandFootprint); footprints(entry.effectFootprint);
    const authoritative = entry.receiptRevisionAvailability === 'authoritative' && result.baseRevision === revision - 1 && result.targetRevision === revision;
    const legacy = entry.receiptRevisionAvailability === 'legacy-client-revision' && record(entry.commandFootprint).availability === 'unavailable' && record(entry.effectFootprint).availability === 'unavailable' && result.baseRevision === command.baseRevision && result.targetRevision === command.expectedRevision && command.expectedRevision < revision;
    if (!authoritative && !legacy) invalid();
    if (entry.recordedAtIso !== null) date(entry.recordedAtIso); if (entry.label !== null && typeof entry.label !== 'string') invalid();
    let deletion: string = 'not-applicable';
    if (result.changeSet != null) {
      const changes = record(result.changeSet, ['protocolVersion', 'projectId', 'baseRevision', 'targetRevision', 'changes']);
      if (changes.projectId !== projectId || changes.protocolVersion !== envelope.protocolVersion || changes.baseRevision !== result.baseRevision || changes.targetRevision !== result.targetRevision || !Array.isArray(changes.changes)) invalid();
      for (const rawChange of array(changes.changes)) {
        const change = record(rawChange);
        const shape = RECOVERY_EFFECT_FIELDS[change.type as keyof typeof RECOVERY_EFFECT_FIELDS];
        if (!shape || shape.required.some(key => !Object.hasOwn(change, key)) || Object.keys(change).some(key => ![...shape.required, ...shape.optional].includes(key as never))) invalid();
        effectValue(change, RECOVERY_EFFECT_SCHEMAS[change.type as keyof typeof RECOVERY_EFFECT_SCHEMAS], projectId);
        if (change.type === 'SubtreeRestored' && change.deletionBundle !== undefined) validateDeletionBundle(change.deletionBundle, projectId, String(change.rootNodeId), array(change.nodes) as import('./change-set').NodeSnapshot[]);
        if (change.type === 'SubtreeDeleted') { if (deletion !== 'legacy-incomplete') deletion = change.deletionBundle === undefined ? 'legacy-incomplete' : 'complete'; if (change.deletionBundle !== undefined) validateDeletionBundle(change.deletionBundle, projectId, String(change.rootNodeId), array(change.nodes) as import('./change-set').NodeSnapshot[]); }
      }
    }
    if (entry.deletionMetadata !== deletion) invalid();
  }
  if (revision !== envelope.serverRevision) invalid();
  return structuredClone(value) as RecoveryEnvelope;
}

/** A stream entry uses the identical terminal validation as snapshot history. */
export async function validateConfirmedHistoryEntry(value: unknown, projectId: string): Promise<import('./collaboration-recovery').ConfirmedHistoryEntry> {
  const row = record(value); integer(row.serverRevision, true);
  if (row.serverRevision < 1) invalid();
  const envelope = await validateRecoveryEnvelope({
    version: 1, protocolVersion: '1.0.0', projectId, streamEpoch: 1,
    serverRevision: row.serverRevision, historyFloor: row.serverRevision - 1, dedupCoverage: 'unavailable',
    graph: { project: { id: projectId, name: '', revision: row.serverRevision }, phases: [], nodes: [], customFields: [], typeTemplateFields: [], unlockEdges: [], dismissals: [], affectedReasons: [], openQuestions: [], forecastPlans: [], forecastScenarios: [] },
    confirmedHistory: [value], terminalRejections: [],
  }, projectId);
  return envelope.confirmedHistory[0];
}


import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { initializeCollaborationSchema, readOutbox } from './collaboration-outbox';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { recoveryPayloadDigest, validateRecoveryEnvelope, type RecoveryEnvelope, type RecoveryNodesRow } from '../../contracts/collaboration-recovery';
import { validateProductCommand, createDeleteSubtreeWireCommand, type ProductCommandApplied } from '../../contracts/repository-commands';
import { createDeleteSubtreeCommand } from '../../domain/tree/delete-subtree.command';
import { boundHistoryFixture } from '../../application/collaboration/recovery-fixtures.test-only';

async function fixture() {
  const handler = await initWorkerDatabase(); const db = getDatabase()!;
  initializeCollaborationSchema(db); const project = createUuidV7(); const node = createUuidV7();
  db.exec({ sql: 'INSERT INTO projects(id,name,revision) VALUES(?,?,0)', bind: [project, 'Synthetic'] });
  db.exec({ sql: 'INSERT INTO nodes(id,project_id,title,position) VALUES(?,?,?,0)', bind: [node, project, 'Original'] });
  const nodeRow: RecoveryNodesRow = { id: node, projectId: project, parentId: null, title: 'Authoritative', bodyText: null, position: 0, nodeType: null, startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: null, effortPointsDone: null, strategicWeight: null, phaseId: null, deliveryStatus: null };
  const envelope: RecoveryEnvelope = { version: 1, protocolVersion: '1.0.0', projectId: project, streamEpoch: 1, serverRevision: 0, historyFloor: 0, dedupCoverage: 'complete', graph: { project: { id: project, name: 'Authoritative', revision: 0 }, nodes: [nodeRow], phases: [], customFields: [], typeTemplateFields: [], unlockEdges: [], dismissals: [], affectedReasons: [], openQuestions: [], forecastPlans: [], forecastScenarios: [] }, confirmedHistory: [], terminalRejections: [] };
  const title = () => (db.exec({ sql: 'SELECT title FROM nodes WHERE id = ?', bind: [node], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { title: string }[])[0].title;
  return { handler, db, project, node, envelope, title };
}
describe('atomic browser snapshot recovery', () => {
  it('rejects missing/unknown fields, cross-project rows and containment cycles before mutation', async () => {
    const f = await fixture();
    await expect(validateRecoveryEnvelope({ ...f.envelope, surprise: true }, f.project)).rejects.toThrow();
    await expect(validateRecoveryEnvelope({ ...f.envelope, graph: { ...f.envelope.graph, nodes: [{ ...f.envelope.graph.nodes[0], projectId: createUuidV7() }] } }, f.project)).rejects.toThrow();
    await expect(f.handler.installSnapshotAtomic(f.project, { ...f.envelope, graph: { ...f.envelope.graph, nodes: [{ ...f.envelope.graph.nodes[0], parentId: f.node }] } })).rejects.toThrow();
    expect(f.title()).toBe('Original');
  });
  it('preserves local views and atomically records the epoch and authored graph', async () => {
    const f = await fixture();
    f.db.exec({ sql: "INSERT INTO view_state(project_id,view_id,scroll_top) VALUES(?,'outline',42)", bind: [f.project] });
    expect(await f.handler.installSnapshotAtomic(f.project, f.envelope)).toEqual({ revision: 0, recoveryRequired: false });
    expect(f.title()).toBe('Authoritative'); expect(readOutbox(f.db, f.project).streamEpoch).toBe(1);
    const views = f.db.exec({ sql: 'SELECT scroll_top FROM view_state WHERE project_id = ?', bind: [f.project], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { scroll_top: number }[];
    expect(views[0].scroll_top).toBe(42);
  });
  it('retains unmatched pending work with unknown identity instead of replaying it', async () => {
    const f = await fixture(); const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    expect((await f.handler.installSnapshotAtomic(f.project, f.envelope)).recoveryRequired).toBe(true);
    const state = readOutbox(f.db, f.project); expect(state.entries[0].command).toEqual(command); expect(state.recoveryReason).toBe('RECOVERY_IDENTITY_UNAVAILABLE'); expect(f.title()).toBe('Authoritative');
  });
  it('replays pending work only with verified same-epoch complete history, retaining original wire', async () => {
    const f = await fixture(); await f.handler.installSnapshotAtomic(f.project, f.envelope);
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    await f.handler.installSnapshotAtomic(f.project, f.envelope);
    expect(f.title()).toBe('Pending'); const state = readOutbox(f.db, f.project); expect(state.entries[0].commitAttemptId).toBe(2); expect(state.entries[0].command).toEqual(command);
  });
  it('does not replay an own toggle already represented in the authoritative graph', async () => {
    const f = await fixture(); const command = validateProductCommand({ type: 'ToggleNodeCompleted', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, completed: true });
    const result = f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const unavailable = { availability: 'unavailable' as const, knownTargets: [], reason: 'LEGACY_METADATA_UNAVAILABLE' };
    const envelope: RecoveryEnvelope = { ...f.envelope, serverRevision: 1, graph: { ...f.envelope.graph, project: { ...f.envelope.graph.project, revision: 1 }, nodes: [{ ...f.envelope.graph.nodes[0], completed: true }] }, confirmedHistory: [{ command, result, payloadDigest: await recoveryPayloadDigest(command), actorId: null, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0', serverRevision: 1, receiptRevisionAvailability: 'authoritative', recordedAtIso: null, label: null, commandFootprint: unavailable, effectFootprint: unavailable, deletionMetadata: 'not-applicable' }] };
    await f.handler.installSnapshotAtomic(f.project, envelope); expect(readOutbox(f.db, f.project).entries).toHaveLength(0);
    const completed = f.db.exec({ sql: 'SELECT completed FROM nodes WHERE id = ?', bind: [f.node], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { completed: number }[]; expect(completed[0].completed).toBe(1);
  });
  it('rolls graph, archive and cursor back when replacement fails after archival', async () => {
    const f = await fixture(); f.db.exec(`CREATE TEMP TRIGGER fail_recovery_${f.project.replaceAll('-', '')} BEFORE INSERT ON nodes WHEN NEW.project_id='${f.project}' BEGIN SELECT RAISE(ABORT,'synthetic recovery failure'); END`);
    await expect(f.handler.installSnapshotAtomic(f.project, f.envelope)).rejects.toThrow();
    expect(f.title()).toBe('Original'); expect(readOutbox(f.db, f.project).streamEpoch).toBeNull();
    const count = f.db.exec({ sql: 'SELECT COUNT(*) AS count FROM collaboration_recovery_archive WHERE project_id = ?', bind: [f.project], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { count: number }[]; expect(count[0].count).toBe(0);
  });
  it('preserves a recovery-required archive across epoch replacement even without pending edits', async () => {
    const f = await fixture(); await f.handler.installSnapshotAtomic(f.project, f.envelope);
    expect((await f.handler.installSnapshotAtomic(f.project, { ...f.envelope, streamEpoch: 2 })).recoveryRequired).toBe(true);
    const state = readOutbox(f.db, f.project); expect(state.streamEpoch).toBe(2); expect(state.recoveryReason).toBe('STREAM_EPOCH_CHANGED');
  });
  it('rejects a changed payload under an existing pending command ID without replacing state', async () => {
    const f = await fixture();
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const changed = { ...command, title: 'Different wire payload' };
    const rejected = { type: 'ProductCommandRejected' as const, protocolVersion: '1.0.0' as const, commandId: command.commandId, projectId: f.project, code: 'NODE_NOT_FOUND' as const };
    const envelope = { ...f.envelope, terminalRejections: [{ command: changed, payloadDigest: await recoveryPayloadDigest(changed), result: rejected, actorId: null, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0' }] };
    await expect(f.handler.installSnapshotAtomic(f.project, envelope)).rejects.toThrow('COMMAND_IDENTITY_CONFLICT');
    expect(f.title()).toBe('Pending'); expect(readOutbox(f.db, f.project).entries).toHaveLength(1);
  });
  it('durably retains a terminal rejection and original content after replacement', async () => {
    const f = await fixture(); const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Recoverable pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    await f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [{ command, payloadDigest: await recoveryPayloadDigest(command), actorId: null, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0', result: { type: 'ProductCommandRejected', protocolVersion: '1.0.0', commandId: command.commandId, projectId: f.project, code: 'NODE_NOT_FOUND' } }] });
    const state = readOutbox(f.db, f.project); expect(state.entries).toHaveLength(0); expect(state.rejected?.[0].command).toEqual(command); expect(state.rejected?.[0].reason).toBe('NODE_NOT_FOUND');
  });
  it('upgrades a v18 cursor in place while preserving cursor and legacy epoch uncertainty', async () => {
    const f = await fixture(); f.db.exec('ALTER TABLE collaboration_cursor RENAME TO recovery_test_cursor');
    f.db.exec('CREATE TABLE collaboration_cursor(project_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL)');
    f.db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor) VALUES(?,7)', bind: [f.project] });
    initializeCollaborationSchema(f.db); const state = readOutbox(f.db, f.project);
    expect(state.cursor).toBe(7); expect(state.streamEpoch).toBeNull(); expect(state.recoveryRequired).toBe(false);
    f.db.exec('DROP TABLE collaboration_cursor'); f.db.exec('ALTER TABLE recovery_test_cursor RENAME TO collaboration_cursor');
  });
  it('binds original actorless wire to trusted actor without rewriting its digest', async () => {
    const f = await fixture(); const actorId = createUuidV7();
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const result = { type: 'ProductCommandRejected' as const, protocolVersion: '1.0.0' as const, commandId: command.commandId, projectId: f.project, code: 'NODE_NOT_FOUND' as const };
    const terminal = { command, result, payloadDigest: await recoveryPayloadDigest(command), actorId, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0' };
    await validateRecoveryEnvelope({ ...f.envelope, terminalRejections: [terminal] }, f.project);
    const explicit = { ...command, actorId: createUuidV7() };
    await expect(validateRecoveryEnvelope({ ...f.envelope, terminalRejections: [{ ...terminal, command: explicit, payloadDigest: await recoveryPayloadDigest(explicit) }] }, f.project)).rejects.toThrow();
    await f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [terminal] });
    expect(readOutbox(f.db, f.project).entries).toHaveLength(0);
  });
  it('admits declared legacy actor enrichment but refuses changed content and original wire enrichment', async () => {
    const f = await fixture(); const actorId = createUuidV7();
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const admitted = { ...command, actorId }; const changed = { ...admitted, title: 'Other' };
    const terminal = { command: admitted, result: { type: 'ProductCommandRejected' as const, protocolVersion: '1.0.0' as const, commandId: command.commandId, projectId: f.project, code: 'NODE_NOT_FOUND' as const }, payloadDigest: await recoveryPayloadDigest(admitted), actorId, wireIdentityAvailability: 'legacy-admitted-wire' as const, protocolVersion: '1.0.0' };
    await expect(f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [{ ...terminal, command: changed, payloadDigest: await recoveryPayloadDigest(changed) }] })).rejects.toThrow('COMMAND_IDENTITY_CONFLICT');
    await expect(f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [{ ...terminal, wireIdentityAvailability: 'original' }] })).rejects.toThrow('COMMAND_IDENTITY_CONFLICT');
    await f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [terminal] });
    expect(readOutbox(f.db, f.project).entries).toHaveLength(0);
  });
  it('rejects malformed authoritative effects and repeated footprint targets', async () => {
    const f = await fixture(); const command = validateProductCommand({ type: 'ToggleNodeCompleted', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node });
    const result = { type: 'ProductCommandApplied' as const, protocolVersion: '1.0.0' as const, commandId: command.commandId, projectId: f.project, baseRevision: 0, targetRevision: 1, outcome: 'VfsCommitAccepted' as const, disposition: 'NewCommit' as const, changeSet: { protocolVersion: '1.0.0' as const, projectId: f.project, baseRevision: 0, targetRevision: 1, changes: [{ type: 'NodeCompletedToggled' as const, nodeId: f.node, completed: true, priorCompleted: false }] } };
    const fp = { availability: 'complete' as const, reason: null, knownTargets: [{ kind: 'field' as const, entityType: 'node', id: f.node, field: 'completed' }] };
    const entry = { command, result, payloadDigest: await recoveryPayloadDigest(command), actorId: null, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0', serverRevision: 1, receiptRevisionAvailability: 'authoritative' as const, recordedAtIso: null, label: null, commandFootprint: fp, effectFootprint: fp, deletionMetadata: 'not-applicable' as const };
    const envelope = { ...f.envelope, serverRevision: 1, graph: { ...f.envelope.graph, project: { ...f.envelope.graph.project, revision: 1 } }, confirmedHistory: [entry] };
    await validateRecoveryEnvelope(envelope, f.project);
    await expect(validateRecoveryEnvelope({ ...envelope, confirmedHistory: [{ ...entry, effectFootprint: { ...fp, knownTargets: [...fp.knownTargets, ...fp.knownTargets] } }] }, f.project)).rejects.toThrow();
    await expect(validateRecoveryEnvelope({ ...envelope, confirmedHistory: [{ ...entry, result: { ...result, changeSet: { ...result.changeSet, changes: [{ ...result.changeSet.changes[0], completed: 'true' }] } } }] }, f.project)).rejects.toThrow();
  });
  it('validates typed containment while allowing untyped bridging and saved forecast references', async () => {
    const f = await fixture(); const child = createUuidV7();
    const parent = { ...f.envelope.graph.nodes[0], nodeType: 'Feature' };
    const nested = { ...parent, id: child, parentId: f.node, position: -1024, nodeType: 'Vision' };
    const graph = { ...f.envelope.graph, nodes: [parent, nested] };
    await expect(validateRecoveryEnvelope({ ...f.envelope, graph }, f.project)).rejects.toThrow();
    await validateRecoveryEnvelope({ ...f.envelope, graph: { ...graph, nodes: [{ ...parent, nodeType: null }, nested] } }, f.project);
    await validateRecoveryEnvelope({ ...f.envelope, graph: { ...graph, nodes: [{ ...parent, nodeType: 'Historical custom type' }, nested], typeTemplateFields: [{ projectId: f.project, nodeType: 'Historical custom type', fieldKey: 'legacy', fieldLabel: 'Synthetic', position: -1024 }] } }, f.project);
    const stale = createUuidV7(); const person = createUuidV7();
    const plan = { projectId: f.project, selectedFeatureIds: JSON.stringify([stale]), parallelGroups: '[]', blockedFeatureIds: '[]', pointsPerSprint: null, sprintLengthDays: null, cadence: 'fixed-contiguous', startSprintOrdinal: null, startDate: null, policyVersion: 'staffed-capacity-v1', planningLevel: 'Feature', roster: JSON.stringify([{ id: person, name: 'Synthetic', weightUnits: 100 }]), assignments: JSON.stringify({ [stale]: [person] }), sprintPlan: '{}' };
    await validateRecoveryEnvelope({ ...f.envelope, graph: { ...f.envelope.graph, forecastPlans: [plan] } }, f.project);
    await expect(validateRecoveryEnvelope({ ...f.envelope, graph: { ...f.envelope.graph, forecastPlans: [{ ...plan, roster: JSON.stringify([{ id: person, name: 'Synthetic', weightUnits: '100' }]) }] } }, f.project)).rejects.toThrow();
  });
  it('blocks a known legacy terminal with unavailable actor identity even under complete coverage', async () => {
    const f = await fixture(); await f.handler.installSnapshotAtomic(f.project, f.envelope);
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const outcome = await f.handler.installSnapshotAtomic(f.project, { ...f.envelope, terminalRejections: [{ command, result: { type: 'ProductCommandRejected', protocolVersion: '1.0.0', commandId: command.commandId, projectId: f.project, code: 'NODE_NOT_FOUND' }, actorId: null, payloadDigest: await recoveryPayloadDigest(command), wireIdentityAvailability: 'legacy-admitted-wire', protocolVersion: '1.0.0' }] });
    expect(outcome.recoveryRequired).toBe(true);
    expect(readOutbox(f.db, f.project).entries[0].commitAttemptId).toBe(1);
    expect(readOutbox(f.db, f.project).recoveryReason).toBe('RECOVERY_IDENTITY_UNAVAILABLE');
  });
  it('refuses an actor-uncertain legacy own acknowledgement before changing pending state', async () => {
    const f = await fixture(); await f.handler.installSnapshotAtomic(f.project, f.envelope);
    const command = validateProductCommand({ type: 'SetNodeTitle', protocolVersion: '1.0.0', commandId: createUuidV7(), projectId: f.project, baseRevision: 0, expectedRevision: 1, nodeId: f.node, title: 'Pending' });
    f.handler.applyWithOutbox(command, { commandId: command.commandId, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-06T00:00:00Z' }, f.project);
    const historyEntry = { ...await boundHistoryFixture(command, 1), wireIdentityAvailability: 'legacy-admitted-wire' as const, actorId: null };
    await expect(f.handler.applyConfirmedRebaseAtomic(f.project, { command, ownEcho: true, serverRevision: 1, streamEpoch: 1, historyEntry }, [], [])).rejects.toThrow('REBASE_HISTORY_IDENTITY_UNAVAILABLE');
    expect(f.title()).toBe('Pending'); expect(readOutbox(f.db, f.project).entries).toHaveLength(1); expect(readOutbox(f.db, f.project).cursor).toBe(0);
  });

  it('archives confirmed-ahead local state before replacement and blocks a Synced condition', async () => {
    const f = await fixture();
    f.db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch) VALUES(?,5,1)', bind: [f.project] });
    expect(await f.handler.installSnapshotAtomic(f.project, f.envelope)).toEqual({ revision: 0, recoveryRequired: true });
    const state = readOutbox(f.db, f.project);
    expect(state.recoveryRequired).toBe(true); expect(state.recoveryReason).toBe('CONFIRMED_AHEAD');
    // The cursor follows the authoritative cut; it never takes a MAX across the restore.
    expect(state.cursor).toBe(0);
    const archives = f.db.exec({ sql: 'SELECT prior_epoch, prior_cursor, reason, archive_json FROM collaboration_recovery_archive WHERE project_id = ?', bind: [f.project], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { prior_epoch: number; prior_cursor: number; reason: string; archive_json: string }[];
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({ prior_epoch: 1, prior_cursor: 5, reason: 'CONFIRMED_AHEAD' });
    const archived = JSON.parse(archives[0].archive_json) as { nodes: { title: string }[] };
    expect(archived.nodes.map((n) => n.title)).toEqual(['Original']);
    expect(f.title()).toBe('Authoritative');
  });
  it('keeps legacy deletion metadata explicitly incomplete through recovery instead of manufacturing a bundle', async () => {
    const f = await fixture();
    const command = createDeleteSubtreeWireCommand({ ...createDeleteSubtreeCommand({ commandId: createUuidV7(), projectId: f.project, nodeId: f.node }), baseRevision: 0 });
    const applied = f.handler.apply(command) as ProductCommandApplied;
    expect(applied.type).toBe('ProductCommandApplied');
    // Legacy servers recorded the deletion without a bundle.
    const legacyResult = { ...applied, changeSet: { ...applied.changeSet!, changes: applied.changeSet!.changes.map((change) => {
      if (change.type !== 'SubtreeDeleted') return change;
      const { deletionBundle: _omitted, ...rest } = change; void _omitted; return rest;
    }) } };
    const unavailable = { availability: 'unavailable' as const, knownTargets: [], reason: 'LEGACY_METADATA_UNAVAILABLE' };
    const entry = { command, result: legacyResult, payloadDigest: await recoveryPayloadDigest(command), actorId: null, wireIdentityAvailability: 'original' as const, protocolVersion: '1.0.0', serverRevision: 1, receiptRevisionAvailability: 'authoritative' as const, recordedAtIso: null, label: null, commandFootprint: unavailable, effectFootprint: unavailable, deletionMetadata: 'legacy-incomplete' as const };
    const envelope: RecoveryEnvelope = { ...f.envelope, serverRevision: 1, graph: { ...f.envelope.graph, project: { ...f.envelope.graph.project, revision: 1 }, nodes: [] }, confirmedHistory: [entry] };
    await expect(f.handler.installSnapshotAtomic(f.project, { ...envelope, confirmedHistory: [{ ...entry, deletionMetadata: 'complete' }] })).rejects.toThrow();
    await f.handler.installSnapshotAtomic(f.project, envelope);
    const stored = f.db.exec({ sql: 'SELECT entry_json FROM collaboration_authoritative_history WHERE project_id = ?', bind: [f.project], rowMode: 'object', returnValue: 'resultRows' }) as unknown as { entry_json: string }[];
    expect(stored).toHaveLength(1);
    const kept = JSON.parse(stored[0].entry_json) as { deletionMetadata: string; result: { changeSet: { changes: Record<string, unknown>[] } } };
    expect(kept.deletionMetadata).toBe('legacy-incomplete');
    const deleted = kept.result.changeSet.changes.find((change) => change.type === 'SubtreeDeleted');
    expect(deleted).toBeDefined(); expect(Object.hasOwn(deleted!, 'deletionBundle')).toBe(false);
  });
});

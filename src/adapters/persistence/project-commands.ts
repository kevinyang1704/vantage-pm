import { validateDeletionBundle } from '../../contracts/deletion-bundle';
import { captureDeletionBundle, deletionBasicNodes, restoreDeletionBundle } from './deletion-bundle.persistence';
import { initializeCollaborationSchema, isValidQueuedAtISO, OUTBOX_ORDER } from './collaboration-outbox';
import { RECOVERY_GRAPH_TABLES, type RecoveryEnvelope } from '../../contracts/collaboration-recovery';
import { validateRecoveryEnvelope, validateConfirmedHistoryEntry } from '../../contracts/collaboration-recovery.validation';
import { validateProductCommand } from '../../contracts/repository-commands';
import { canonicalizeJcs } from '../../../spikes/phase-0-durability/src/attestation';
/**
 * Product command application (Story 1.6 Task 7, Story 2.3 Task 5, Story 2.4 Task 3).
 *
 * Applies product commands (CreateProject, RenameProject, CreateNode,
 * SetNodeTitle, SetNodeBodyText, MoveNode) against the product SQLite schema.
 * One SQLite transaction per command.
 */

import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import { PRODUCT_SCHEMA_DDL, PRODUCT_SCHEMA_VERSION, readUserVersion, assertWritableSchema } from './schema';
import { migrateWorkspaceSchema, readActiveWorkspaceId } from './workspace-operations';
import type {
  CreateProjectCommand,
  RenameProjectCommand,
  DeleteProjectWireCommand,
  CreateNodeWireCommand,
  SetNodeTitleWireCommand,
  SetNodeBodyTextWireCommand,
  MoveNodeWireCommand,
  DeleteSubtreeWireCommand,
  DuplicateSubtreeWireCommand,
  RestoreSubtreeWireCommand,
  SetNodeTypeWireCommand,
  SetNodeCustomFieldWireCommand,
  PromoteFieldToTemplateWireCommand,
  SetNodeScheduleWireCommand,
  ToggleNodeCompletedWireCommand,
  SetNodeEffortWireCommand,
  SetNodePointsDoneWireCommand,
  SetNodeStatusWireCommand,
  SetThemeWeightWireCommand,
  CreatePhaseWireCommand,
  RenamePhaseWireCommand,
  ReorderPhasesWireCommand,
  AssignNodePhaseWireCommand,
  DeletePhaseWireCommand,
  RestorePhaseWireCommand,
  MovePhaseWireCommand,
  CreateUnlockEdgeWireCommand,
  DeleteUnlockEdgeWireCommand,
  AddNodeQuestionWireCommand,
  UpdateNodeQuestionWireCommand,
  ResolveNodeQuestionWireCommand,
  ReorderNodeQuestionsWireCommand,
  MoveNodeQuestionWireCommand,
  DeleteNodeQuestionWireCommand,
  ConfigureForecastPlanWireCommand,
  SetForecastMembershipWireCommand,
  RemoveForecastPlanWireCommand,
  ReorderForecastFeaturesWireCommand,
  SetForecastParallelGroupsWireCommand,
  RestoreForecastScopeWireCommand,
  SetForecastSequenceWireCommand,
  SetForecastBlockerWireCommand,
  CreateForecastScenarioWireCommand,
  RemoveForecastScenarioWireCommand,
  RestoreForecastScenarioWireCommand,
  SetForecastPlanningLevelWireCommand,
  RestoreForecastPlanningLevelWireCommand,
  AddForecastPersonWireCommand,
  UpdateForecastPersonWireCommand,
  RemoveForecastPersonWireCommand,
  RestoreForecastPersonWireCommand,
  SetForecastAssignmentsWireCommand,
  SetForecastPolicyWireCommand,
  MoveForecastFeatureWireCommand,
  SetForecastAssignmentWireCommand,
  ProductCommand,
  ProductCommandResult,
  ProductCommandApplied,
  ProductCommandRejected,
} from '../../contracts/repository-commands';
import type { ChangeSet, NodeChange, NodeSnapshot } from '../../contracts/change-set';
import {
  parsePosition,
  formatPosition,
  rebalanceSiblingPositions,
  positionBetween,
} from '../../domain/tree/sibling-position.policy';
import { applyAnchoredMove } from '../../domain/collaboration/anchor-placement.policy';
import {
  canParentNodeType,
  validateTypedNeighborhood,
} from '../../domain/tree/node-hierarchy.policy';
import type { NodeType } from '../../domain/tree/node.entity';
import { coerceDeliveryStatus } from '../../domain/tree/node.entity';
import {
  readForecastPlan,
  insertEmptyForecastPlan,
  writeForecastPlan,
  deleteForecastPlan,
  readForecastScenario,
  insertForecastScenario,
  deleteForecastScenario,
  ForecastPlanCorruptError,
} from './forecast-operations';
import {
  createForecastPlan,
  createForecastConfiguration,
} from '../../domain/forecast/forecast-plan.entity';
import type { ForecastParallelGroup, ForecastPerson } from '../../domain/forecast/forecast-plan.entity';
import type { ForecastGroupChange } from '../../domain/forecast/forecast.commands';
import { ensureLocalActor } from './local-actor';
import { isPersistedForecastScenario } from '../../domain/forecast/scenario';
import type { PersistedForecastScenario, ScenarioFeatureFact } from '../../domain/forecast/scenario';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import type { ForecastInputs } from '../../domain/forecast/forecast-result';

// Re-export for convenience
export type { ProductCommandResult };

// ── Helpers ────────────────────────────────────────────────────────────────

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string, bind?: readonly SqlValue[]): Row[] {
  return db.exec({
    sql,
    ...(bind ? { bind } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Row[];
}

function integer(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

/**
 * The single-move group change that inverts a forward MoveForecastFeature group
 * change (Story 27.2, AC 27.2-3): join ↔ leave, unchanged stays unchanged. A
 * `leave` inverts to a `join` with the partner it had before the move.
 */
function inverseGroupChange(
  forward: ForecastGroupChange,
  priorGroups: readonly ForecastParallelGroup[],
  featureId: string,
): ForecastGroupChange {
  if (forward.kind === 'unchanged') return Object.freeze({ kind: 'unchanged' });
  if (forward.kind === 'join') return Object.freeze({ kind: 'leave' });
  const prior = priorGroups.find((g) => g.featureIds.includes(featureId));
  const partner = prior?.featureIds.find((id) => id !== featureId);
  return partner === undefined
    ? Object.freeze({ kind: 'unchanged' })
    : Object.freeze({ kind: 'join', partnerId: partner });
}

// ── Handler ────────────────────────────────────────────────────────────────

function sameWireCommand(left: ProductCommand, right: ProductCommand, serverEcho = false): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    return item;
  });
  const normalizedLeft: Record<string, unknown> = { ...left };
  const echoed: Record<string, unknown> = { ...right };
  // Match only declared Rust serde defaults; authored nulls elsewhere remain significant.
  const omittedNullFields: Partial<Record<ProductCommand['type'], readonly string[]>> = {
    MoveNode: ['afterId', 'beforeId', 'intendedIndex'],
    SetNodeEffort: ['restoredAssignments'],
    RestoreForecastScope: ['assignments'],
    RestoreForecastPlanningLevel: ['assignments'],
    RestoreForecastPerson: ['assignments'],
  };
  for (const value of [normalizedLeft, echoed]) {
    for (const field of omittedNullFields[left.type] ?? []) if (value[field] == null) delete value[field];
    if (left.type === 'ConfigureForecastPlan' && value.planningLevel === undefined) value.planningLevel = null;
    if ((left.type === 'RestoreForecastScope' || left.type === 'RestoreForecastPlanningLevel') && value.blockedFeatureIds === undefined) value.blockedFeatureIds = [];
  }
  if (serverEcho && left.actorId === undefined) delete echoed.actorId;
  return canonical(normalizedLeft) === canonical(echoed);
}

export class ProductCommandHandler {
  constructor(private readonly db: Database) {}

  /** Savepoint stack for nested transactions (Story 27.7 atomic batch, H04). */
  #savepoints: string[] = [];

  /**
   * Begin a command transaction. When an outer batch is active, opens a
   * SAVEPOINT instead of a new BEGIN, so a command plus its outbox entry can
   * commit in ONE transaction (R4/H04). Returns the savepoint name to release.
   */
  beginCommand(): string {
    if (this.#savepoints.length > 0) {
      const name = `pm_cmd_${this.#savepoints.length}`;
      this.db.exec(`SAVEPOINT ${name}`);
      this.#savepoints.push(name);
      return name;
    }
    // Exec BEFORE recording the frame: if BEGIN fails, the stack stays clean so
    // a later command is not mis-nested (H-review/r3).
    this.db.exec('BEGIN IMMEDIATE');
    this.#savepoints.push('');
    return '';
  }

  /** Assert the passed name is the innermost transaction, then pop it. */
  #popSavepoint(name: string): void {
    const top = this.#savepoints[this.#savepoints.length - 1];
    if (top !== name) {
      throw new Error(`SAVEPOINT_STACK_MISMATCH: expected ${String(top)}, got ${name}`);
    }
    this.#savepoints.pop();
  }

  /** Commit/release the innermost command transaction or savepoint. */
  commitCommand(name: string): void {
    // Pop in `finally` so a SQL failure (which leaves SQLite's own transaction
    // state ambiguous) never desyncs our stack and collides a later savepoint
    // name with a still-live one. Rethrow the failure to the caller.
    try {
      if (name === '') this.db.exec('COMMIT');
      else this.db.exec(`RELEASE ${name}`);
    } catch (error) {
      // A failed COMMIT (e.g. deferred FK or storage exhaustion) can leave
      // SQLite's transaction open. Roll it back before discarding our frame.
      try {
        if (name === '') this.db.exec('ROLLBACK');
        else { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); }
      } catch { /* preserve commit failure */ }
      throw error;
    } finally {
      this.#popSavepoint(name);
    }
  }

  /** Roll back the innermost command transaction or savepoint. */
  rollbackCommand(name: string): void {
    // Attempt rollback; preserve the original error if rollback itself fails.
    try {
      if (name === '') {
        this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
      }
    } catch { /* preserve original error */ } finally {
      this.#popSavepoint(name);
    }
  }

  /** Project-scoped durable confirmed checkpoint. Pending edits never overwrite it. */
  #captureConfirmed(projectId: string): void {
    const snapshot: Record<string, Row[]> = {};
    for (const ddl of PRODUCT_SCHEMA_DDL) {
      const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl)?.[1];
      if (!table || ['workspaces', 'app_settings', 'view_state'].includes(table)) continue;
      if (table === 'projects') snapshot[table] = rows(this.db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
      else snapshot[table] = rows(this.db, `SELECT * FROM ${table} WHERE project_id = ?`, [projectId]);
    }
    this.db.exec({ sql: `INSERT INTO collaboration_confirmed_state(project_id, snapshot_json) VALUES(?, ?)
      ON CONFLICT(project_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`, bind: [projectId, JSON.stringify(snapshot)] });
  }

  #restoreConfirmed(projectId: string): boolean {
    const checkpoint = rows(this.db, 'SELECT snapshot_json FROM collaboration_confirmed_state WHERE project_id = ?', [projectId])[0];
    if (!checkpoint) return false;
    const snapshot = JSON.parse(String(checkpoint.snapshot_json)) as Record<string, Row[]>;
    const allowed = new Set(PRODUCT_SCHEMA_DDL.map((ddl) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(ddl)?.[1]).filter((table) => table && !['workspaces', 'app_settings', 'view_state'].includes(table)));
    if (Object.keys(snapshot).some((table) => !allowed.has(table))) throw new Error('CONFIRMED_SNAPSHOT_INVALID');
    // Deferred checks allow self-referencing nodes and cross-table dependencies
    // to be restored together, including IDs deleted by optimistic subtrees.
    this.db.exec('PRAGMA defer_foreign_keys = ON');
    const tables = Object.keys(snapshot).filter((table) => table !== 'projects');
    for (const table of [...tables].reverse()) {
      this.db.exec({ sql: `DELETE FROM ${table} WHERE project_id = ?`, bind: [projectId] });
    }
    const project = snapshot.projects?.[0];
    if (!project) throw new Error('CONFIRMED_PROJECT_MISSING');
    const columns = Object.keys(project).filter((column) => column !== 'id' && column !== 'workspace_id');
    this.db.exec({ sql: `UPDATE projects SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`, bind: [...columns.map((column) => project[column]), projectId] });
    for (const table of tables) for (const row of snapshot[table]) {
      const names = Object.keys(row);
      this.db.exec({ sql: `INSERT INTO ${table}(${names.join(', ')}) VALUES(${names.map(() => '?').join(', ')})`, bind: names.map((column) => row[column]) });
    }
    return true;
  }

  #initializeRebaseJournal(): void {
    assertWritableSchema(this.db);
    initializeCollaborationSchema(this.db);
  }

  /** Authoritative replacement and pending reconciliation commit as one operation. */
  async installSnapshotAtomic(projectId: string, input: RecoveryEnvelope): Promise<Readonly<{ revision: number; recoveryRequired: boolean }>> {
    // Hash validation is asynchronous and must finish before opening SQLite's transaction.
    const envelope = await validateRecoveryEnvelope(input, projectId);
    this.#initializeRebaseJournal();
    const transaction = this.beginCommand();
    try {
      const prior = rows(this.db, 'SELECT * FROM collaboration_cursor WHERE project_id = ?', [projectId])[0];
      const priorEpoch = prior?.stream_epoch == null ? null : Number(prior.stream_epoch);
      const priorCursor = Number(prior?.cursor ?? 0);
      const priorRequired = Boolean(prior?.recovery_required);
      const pending = rows(this.db, `SELECT * FROM collaboration_outbox WHERE project_id = ? ORDER BY ${OUTBOX_ORDER}`, [projectId]);
      const matched = new Map<string, ProductCommandResult>();
      const uncertainTerminal = new Set<string>();
      const terminal = [...envelope.confirmedHistory, ...envelope.terminalRejections];
      for (const entry of pending) {
        const command = JSON.parse(String(entry.command_json)) as ProductCommand;
        validateProductCommand(command);
        if (command.projectId !== projectId || command.commandId !== entry.command_id || !Number.isSafeInteger(Number(entry.commit_attempt_id)) || Number(entry.commit_attempt_id) < 1 || !isValidQueuedAtISO(String(entry.queued_at_iso))) throw new Error('INVALID_OUTBOX_METADATA');
        const found = terminal.find(item => item.command.commandId === command.commandId);
        if (!found) continue;
        if (found.wireIdentityAvailability === 'legacy-admitted-wire' && found.actorId === null) { uncertainTerminal.add(command.commandId); continue; }
        // Original history binds exact bytes semantically; old admitted history has
        // only its explicitly documented serde and trusted actor compatibility.
        const legacy = { ...command };
        if (legacy.actorId == null && found.actorId !== null) legacy.actorId = found.actorId;
        const equal = found.wireIdentityAvailability === 'original'
          ? canonicalizeJcs(command) === canonicalizeJcs(found.command)
          : sameWireCommand(legacy, found.command);
        if (!equal) throw new Error('COMMAND_IDENTITY_CONFLICT');
        matched.set(command.commandId, found.result);
      }
      const sameHistory = uncertainTerminal.size === 0 && priorEpoch === envelope.streamEpoch && priorCursor >= envelope.historyFloor && priorCursor <= envelope.serverRevision && envelope.dedupCoverage === 'complete' && !priorRequired && pending.every(entry => matched.has(String(entry.command_id)) || (JSON.parse(String(entry.command_json)) as ProductCommand).baseRevision >= envelope.historyFloor);
      const ambiguous = pending.some(entry => !matched.has(String(entry.command_id))) && !sameHistory;
      const ahead = priorCursor > envelope.serverRevision;
      const changedEpoch = priorEpoch !== null && priorEpoch !== envelope.streamEpoch;
      const recoveryRequired = priorRequired || ambiguous || ahead || changedEpoch;
      const reason = ahead ? 'CONFIRMED_AHEAD' : ambiguous ? 'RECOVERY_IDENTITY_UNAVAILABLE' : priorEpoch !== envelope.streamEpoch ? 'STREAM_EPOCH_CHANGED' : 'AUTHORITATIVE_REPLACEMENT';
      const archive: Record<string, unknown> = {};
      for (const [, table] of RECOVERY_GRAPH_TABLES) archive[table] = rows(this.db, `SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'} = ?`, [projectId]);
      for (const table of ['collaboration_outbox', 'collaboration_cursor', 'collaboration_confirmed_state', 'collaboration_attempt_receipt', 'collaboration_rejections', 'collaboration_outbox_quarantine', 'collaboration_quarantine_metadata', 'collaboration_authoritative_history', 'collaboration_recovery_envelope', 'product_command_receipt']) archive[table] = rows(this.db, `SELECT * FROM ${table} WHERE project_id = ?`, [projectId]);
      this.db.exec({ sql: 'INSERT INTO collaboration_recovery_archive(project_id,prior_epoch,prior_cursor,reason,archive_json,created_at_iso) VALUES(?,?,?,?,?,?)', bind: [projectId, priorEpoch, priorCursor, reason, JSON.stringify(archive, (_key, value: unknown) => value instanceof Uint8Array ? { sqliteBlob: Array.from(value) } : value), new Date().toISOString()] });
      if (!rows(this.db, 'SELECT id FROM projects WHERE id = ?', [projectId]).length) throw new Error('PROJECT_NOT_FOUND');
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      for (const [, table] of [...RECOVERY_GRAPH_TABLES].reverse()) if (table !== 'projects') this.db.exec({ sql: `DELETE FROM ${table} WHERE project_id = ?`, bind: [projectId] });
      for (const [key, table, fields] of RECOVERY_GRAPH_TABLES) {
        if (key === 'project') { this.db.exec({ sql: 'UPDATE projects SET name = ?, revision = ? WHERE id = ?', bind: [envelope.graph.project.name, envelope.graph.project.revision, projectId] }); continue; }
        for (const value of envelope.graph[key]) {
          const row = value as unknown as Record<string, SqlValue | boolean>;
          this.db.exec({ sql: `INSERT INTO ${table}(${fields.map(([, column]) => column).join(',')}) VALUES(${fields.map(() => '?').join(',')})`, bind: fields.map(([field]) => typeof row[field] === 'boolean' ? Number(row[field]) : row[field] as SqlValue) });
        }
      }
      this.db.exec({ sql: 'DELETE FROM product_command_receipt WHERE project_id = ?', bind: [projectId] });
      this.db.exec({ sql: 'DELETE FROM collaboration_authoritative_history WHERE project_id = ?', bind: [projectId] });
      for (const entry of envelope.confirmedHistory) this.db.exec({ sql: 'INSERT INTO collaboration_authoritative_history(project_id,stream_epoch,server_revision,entry_json) VALUES(?,?,?,?)', bind: [projectId, envelope.streamEpoch, entry.serverRevision, JSON.stringify(entry)] });
      this.db.exec({ sql: 'INSERT INTO collaboration_recovery_envelope(project_id,envelope_json) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET envelope_json=excluded.envelope_json', bind: [projectId, JSON.stringify(envelope)] });
      for (const entry of pending) {
        const result = matched.get(String(entry.command_id));
        if (!result) continue;
        if (result.type === 'ProductCommandRejected') this.#retainRejection(projectId, { commandId: String(entry.command_id), commandJson: String(entry.command_json), commitAttemptId: Number(entry.commit_attempt_id), queuedAtISO: String(entry.queued_at_iso) }, result.code);
        this.db.exec({ sql: 'DELETE FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', bind: [projectId, entry.command_id] });
      }
      this.#captureConfirmed(projectId);
      if (sameHistory && !recoveryRequired) {
        const unsent = pending.filter(entry => !matched.has(String(entry.command_id))).map(entry => {
          const attempt = Number(entry.commit_attempt_id) + 1; if (!Number.isSafeInteger(attempt)) throw new Error('INVALID_COMMIT_ATTEMPT');
          return { commandId: String(entry.command_id), command: JSON.parse(String(entry.command_json)) as ProductCommand, commandJson: String(entry.command_json), commitAttemptId: attempt, queuedAtISO: String(entry.queued_at_iso), groupId: entry.group_id == null ? undefined : String(entry.group_id) };
        });
        this.#replayAtomically(projectId, unsent, (entry) => {
          this.db.exec({ sql: 'UPDATE collaboration_outbox SET commit_attempt_id = ? WHERE project_id = ? AND command_id = ?', bind: [entry.commitAttemptId, projectId, entry.commandId] });
        });
      }
      this.db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor,stream_epoch,recovery_required,recovery_reason) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET cursor=excluded.cursor,stream_epoch=excluded.stream_epoch,recovery_required=excluded.recovery_required,recovery_reason=excluded.recovery_reason', bind: [projectId, envelope.serverRevision, envelope.streamEpoch, Number(recoveryRequired), recoveryRequired ? reason : null] });
      const revision = Number(rows(this.db, 'SELECT revision FROM projects WHERE id = ?', [projectId])[0].revision);
      this.commitCommand(transaction);
      return Object.freeze({ revision, recoveryRequired });
    } catch (error) { this.rollbackCommand(transaction); throw error; }
  }

  #recordAttempt(projectId: string, commandId: string, attempt: number, commandJson: string, result: unknown): void {
    this.db.exec({ sql: `INSERT INTO collaboration_attempt_receipt(project_id, command_id, commit_attempt_id, command_json, result_json)
      VALUES(?, ?, ?, ?, ?) ON CONFLICT(project_id, command_id, commit_attempt_id) DO NOTHING`,
      bind: [projectId, commandId, attempt, commandJson, JSON.stringify(result)] });
  }

  #retainRejection(projectId: string, entry: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>, reason: string): void {
    this.db.exec({ sql: `INSERT INTO collaboration_rejections(project_id, command_id, command_json, commit_attempt_id, queued_at_iso, reason) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, command_id) DO NOTHING`, bind: [projectId, entry.commandId, entry.commandJson, entry.commitAttemptId, entry.queuedAtISO, reason] });
  }

  /** A composite gesture either applies every component, or commits none. */
  applyBatch(commands: readonly ProductCommand[]): readonly ProductCommandResult[] {
    if (commands.length === 0) return Object.freeze([]);
    if (commands.some((command) => command.projectId !== commands[0].projectId)) throw new Error('BATCH_PROJECT_ID_MISMATCH');
    // A synced project has no authoritative atomic server group yet; refuse the
    // whole group rather than committing components that would sync separately.
    if (rows(this.db, 'SELECT 1 FROM collaboration_cursor WHERE project_id = ? LIMIT 1', [commands[0].projectId]).length > 0) {
      return Object.freeze([Object.freeze({ type: 'ProductCommandRejected', protocolVersion: commands[0].protocolVersion, commandId: commands[0].commandId, projectId: commands[0].projectId, code: 'SHARED_ATOMIC_GROUP_UNAVAILABLE' }) as ProductCommandResult]);
    }
    const outer = this.beginCommand();
    try {
      const results: ProductCommandResult[] = [];
      for (const command of commands) {
        const result = this.apply(command);
        results.push(result);
        if (result.type !== 'ProductCommandApplied') {
          this.rollbackCommand(outer);
          return Object.freeze([result]);
        }
      }
      this.commitCommand(outer);
      return Object.freeze(results);
    } catch (error) {
      try { this.rollbackCommand(outer); } catch { /* preserve original */ }
      throw error;
    }
  }

  /**
   * Apply a command AND write its durable outbox entry in ONE transaction, so a
   * crash can never acknowledge a locally-applied edit whose outbox entry was
   * not written (R4/H04). Used by the browser sync-repository adapter.
   */
  applyWithOutbox(
    command: ProductCommand,
    outbox: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>,
    projectId: string,
  ): ProductCommandResult {
    // A mis-wired caller must never key an outbox row to the wrong project or
    // command (H04). The outbox row's ids are always the command's own ids.
    if (outbox.commandId !== command.commandId) {
      throw new Error('OUTBOX_COMMAND_ID_MISMATCH');
    }
    if (projectId !== command.projectId) {
      throw new Error('OUTBOX_PROJECT_ID_MISMATCH');
    }
    if (!isValidQueuedAtISO(outbox.queuedAtISO) || !Number.isSafeInteger(outbox.commitAttemptId) || outbox.commitAttemptId < 1) throw new Error('COMMIT_ATTEMPT_INVALID');
    const persistedCommand = JSON.parse(outbox.commandJson) as Record<string, unknown>;
    const suppliedCommand = command as unknown as Record<string, unknown>;
    if (Object.keys(persistedCommand).length !== Object.keys(suppliedCommand).length || Object.keys(suppliedCommand).some((key) => JSON.stringify(persistedCommand[key]) !== JSON.stringify(suppliedCommand[key]))) throw new Error('OUTBOX_COMMAND_PAYLOAD_MISMATCH');
    // One outer transaction wraps the command (which opens a savepoint) and the
    // outbox write, so they commit or roll back together.
    this.#initializeRebaseJournal();
    const outer = this.beginCommand();
    let closed = false;
    try {
      const priorAttempt = rows(this.db, 'SELECT command_json, result_json FROM collaboration_attempt_receipt WHERE project_id = ? AND command_id = ? AND commit_attempt_id = ?', [projectId, command.commandId, outbox.commitAttemptId])[0];
      if (priorAttempt) {
        if (!sameWireCommand(JSON.parse(String(priorAttempt.command_json)) as ProductCommand, command)) throw new Error('ATTEMPT_PAYLOAD_MISMATCH');
        const cached = JSON.parse(String(priorAttempt.result_json)) as ProductCommandResult;
        this.commitCommand(outer);
        closed = true;
        return cached;
      }
      if (rows(this.db, 'SELECT command_id FROM collaboration_attempt_receipt WHERE project_id = ? AND command_id = ? LIMIT 1', [projectId, command.commandId]).length) throw new Error('ATTEMPT_REQUIRES_REBASE');
      if (rows(this.db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? LIMIT 1', [projectId]).length === 0) this.#captureConfirmed(projectId);
      const result = this.apply(command);
      this.#recordAttempt(projectId, command.commandId, outbox.commitAttemptId, outbox.commandJson, result);
      if (result.type !== 'ProductCommandApplied') {
        if (rows(this.db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? LIMIT 1', [projectId]).length === 0) this.db.exec({ sql: 'DELETE FROM collaboration_confirmed_state WHERE project_id = ?', bind: [projectId] });
        this.commitCommand(outer);
        closed = true;
        return result;
      }
      this.db.exec({
        sql: `INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso)
              VALUES(?, ?, ?, ?, ?)
              ON CONFLICT(project_id, command_id) DO UPDATE SET
                command_json = excluded.command_json,
                commit_attempt_id = excluded.commit_attempt_id,
                queued_at_iso = excluded.queued_at_iso`,
        bind: [projectId, outbox.commandId, outbox.commandJson, outbox.commitAttemptId, outbox.queuedAtISO],
      });
      this.commitCommand(outer);
      closed = true;
      return result;
    } catch (error) {
      // `commitCommand` pops its savepoint even on failure; only roll back when
      // the transaction is still open, never double-pop.
      if (!closed) {
        try { this.rollbackCommand(outer); } catch { /* preserve original */ }
      }
      throw error;
    }
  }

  /**
   * Re-apply pending work at the current revision, one unit at a time: a single
   * edit, or a composite gesture's consecutive members as ONE savepoint. A
   * refused member rolls its whole gesture back and retains every member as
   * rejected work (the refused one with its own code), so a gesture is never
   * left half re-applied. `keep` re-queues a surviving entry.
   */
  #replayAtomically(
    projectId: string,
    entries: readonly Readonly<{ commandId: string; command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string; groupId?: string }>[],
    keep: (entry: Readonly<{ commandId: string; command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string; groupId?: string; groupIndex?: number }>) => void,
  ): void {
    for (let start = 0; start < entries.length;) {
      let end = start + 1;
      const groupId = entries[start].groupId;
      if (groupId !== undefined) while (end < entries.length && entries[end].groupId === groupId) end += 1;
      const unit = entries.slice(start, end);
      start = end;
      const savepoint = this.beginCommand();
      let refused: { index: number; result: ProductCommandResult } | null = null;
      const results: ProductCommandResult[] = [];
      try {
        for (const [index, entry] of unit.entries()) {
          const current = Number(rows(this.db, 'SELECT revision FROM projects WHERE id = ?', [projectId])[0].revision);
          const command = validateProductCommand(Object.freeze({ ...entry.command, baseRevision: current, expectedRevision: current + 1 }) as ProductCommand);
          const result = this.apply(command);
          results.push(result);
          if (result.type !== 'ProductCommandApplied') { refused = { index, result }; break; }
        }
      } catch (error) { this.rollbackCommand(savepoint); throw error; }
      if (refused) {
        this.rollbackCommand(savepoint);
        for (const [index, entry] of unit.entries()) {
          const result = index === refused.index ? refused.result : groupRefusal(entry.command);
          this.#recordAttempt(projectId, entry.commandId, entry.commitAttemptId, entry.commandJson, result);
          this.#retainRejection(projectId, { commandId: entry.commandId, commandJson: entry.commandJson, commitAttemptId: entry.commitAttemptId, queuedAtISO: entry.queuedAtISO }, result.type === 'ProductCommandRejected' ? result.code : 'ATOMIC_GROUP_REJECTED');
          this.db.exec({ sql: 'DELETE FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', bind: [projectId, entry.commandId] });
        }
        continue;
      }
      for (const [index, entry] of unit.entries()) {
        this.#recordAttempt(projectId, entry.commandId, entry.commitAttemptId, entry.commandJson, results[index]);
        keep(entry);
      }
      this.commitCommand(savepoint);
    }
  }

  /**
   * A composite gesture on a shared project (Story 27.2): apply every member
   * and queue every outbox entry, tagged with one group id, in ONE
   * transaction. A refused member commits nothing and returns that refusal
   * alone, exactly like the local `applyBatch` contract.
   */
  applyGroupWithOutbox(
    projectId: string,
    members: readonly Readonly<{ command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string }>[],
    groupId: string,
  ): readonly ProductCommandResult[] {
    if (members.length === 0) return Object.freeze([]);
    if (!groupId.length || groupId.length > 128) throw new Error('OUTBOX_GROUP_INVALID');
    for (const member of members) {
      if (member.command.projectId !== projectId) throw new Error('OUTBOX_PROJECT_ID_MISMATCH');
      if (!isValidQueuedAtISO(member.queuedAtISO) || member.commitAttemptId !== 1) throw new Error('COMMIT_ATTEMPT_INVALID');
      if (!sameWireCommand(JSON.parse(member.commandJson) as ProductCommand, member.command)) throw new Error('OUTBOX_COMMAND_PAYLOAD_MISMATCH');
    }
    if (new Set(members.map((member) => member.command.commandId)).size !== members.length) throw new Error('OUTBOX_GROUP_INVALID');
    this.#initializeRebaseJournal();
    const outer = this.beginCommand();
    try {
      for (const member of members) {
        if (rows(this.db, 'SELECT command_id FROM collaboration_attempt_receipt WHERE project_id = ? AND command_id = ? LIMIT 1', [projectId, member.command.commandId]).length) throw new Error('ATTEMPT_REQUIRES_REBASE');
      }
      if (rows(this.db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? LIMIT 1', [projectId]).length === 0) this.#captureConfirmed(projectId);
      const results: ProductCommandResult[] = [];
      for (const [index, member] of members.entries()) {
        const result = this.apply(member.command);
        if (result.type !== 'ProductCommandApplied') {
          this.rollbackCommand(outer);
          return Object.freeze([result]);
        }
        results.push(result);
        this.#recordAttempt(projectId, member.command.commandId, member.commitAttemptId, member.commandJson, result);
        this.db.exec({
          sql: `INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso, group_id, group_index)
                VALUES(?, ?, ?, ?, ?, ?, ?)`,
          bind: [projectId, member.command.commandId, member.commandJson, member.commitAttemptId, member.queuedAtISO, groupId, index],
        });
      }
      this.commitCommand(outer);
      return Object.freeze(results);
    } catch (error) {
      try { this.rollbackCommand(outer); } catch { /* preserve original */ }
      throw error;
    }
  }

  /**
   * Apply one recoverable rebase operation (R4/H04) in ONE transaction: remove
   * rejected pending entries, apply the confirmed remote command (unless own
   * echo), re-queue the surviving pending commands with their bumped commit
   * attempt, and advance the stream cursor. A crash can never leave a partial
   * rebase (rejected work durably dropped, survivors unqueued, or cursor ahead
   * of applied state). Returns the remote apply result, or null for an own echo.
   */
  applyRebaseAtomic(
    projectId: string,
    remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch?: number; historyEntry?: import('../../contracts/collaboration-recovery').ConfirmedHistoryEntry }>,
    toReapply: readonly Readonly<{ commandId: string; command: ProductCommand; commitAttemptId: number; queuedAtISO: string; groupId?: string; groupIndex?: number }>[],
    rejected: readonly Readonly<{ commandId: string; reason?: string }>[],
  ): ProductCommandResult | null {
    if (remote.command.projectId !== projectId || toReapply.some((entry) => entry.command.projectId !== projectId || entry.commandId !== entry.command.commandId)) throw new Error('REBASE_PROJECT_OR_COMMAND_MISMATCH');
    if (!Number.isSafeInteger(remote.serverRevision) || remote.serverRevision < 1 || toReapply.some((entry) => !isValidQueuedAtISO(entry.queuedAtISO) || !Number.isSafeInteger(entry.commitAttemptId) || entry.commitAttemptId < 1)) throw new Error('REBASE_REVISION_OR_ATTEMPT_INVALID');
    this.#initializeRebaseJournal();
    const outer = this.beginCommand();
    let closed = false;
    let remoteResult: ProductCommandResult | null = null;
    try {
      const handled = new Set([...toReapply.map((entry) => entry.commandId), ...rejected.map((entry) => entry.commandId), ...(remote.ownEcho ? [remote.command.commandId] : [])]);
      const pending = rows(this.db, 'SELECT command_id, command_json, commit_attempt_id FROM collaboration_outbox WHERE project_id = ?', [projectId]);
      const cursor = Number(rows(this.db, 'SELECT cursor FROM collaboration_cursor WHERE project_id = ?', [projectId])[0]?.cursor ?? 0);
      if (remote.streamEpoch !== undefined) {
        const state = rows(this.db, 'SELECT stream_epoch,recovery_required FROM collaboration_cursor WHERE project_id = ?', [projectId])[0];
        if (state?.stream_epoch !== remote.streamEpoch || Boolean(state?.recovery_required) || !remote.historyEntry) throw new Error('REBASE_EPOCH_OR_RECOVERY_REQUIRED');
      }
      if (remote.serverRevision !== cursor + 1 || (remote.ownEcho && !pending.some((r) => r.command_id === remote.command.commandId))) throw new Error('REBASE_STALE_CURSOR_OR_UNKNOWN_ECHO');
      if (handled.size !== toReapply.length + rejected.length + (remote.ownEcho ? 1 : 0)) throw new Error('REBASE_DUPLICATE_ENTRY');
      for (const entry of toReapply) {
        const original = pending.find((r) => r.command_id === entry.commandId);
        if (!original || Number(original.commit_attempt_id) + 1 !== entry.commitAttemptId || !sameWireCommand(JSON.parse(String(original.command_json)) as ProductCommand, entry.command)) throw new Error('REBASE_ATTEMPT_OR_PAYLOAD_MISMATCH');
      }
      if (pending.some((entry) => !handled.has(String(entry.command_id)))) throw new Error('REBASE_PENDING_ENTRY_OMITTED');
      if (remote.ownEcho) {
        const original = JSON.parse(String(pending.find((r) => r.command_id === remote.command.commandId)?.command_json)) as ProductCommand;
        const legacy = { ...original };
        if (legacy.actorId == null && remote.historyEntry?.actorId != null) legacy.actorId = remote.historyEntry.actorId;
        const equal = remote.historyEntry?.wireIdentityAvailability === 'original' ? canonicalizeJcs(original) === canonicalizeJcs(remote.command) : sameWireCommand(legacy, remote.command, !remote.historyEntry);
        if (!equal) throw new Error('REBASE_ECHO_PAYLOAD_MISMATCH');
      }
      if (rejected.some((r) => !pending.some((p) => p.command_id === r.commandId) || (r.reason !== undefined && (!r.reason.length || r.reason.length > 256)))) throw new Error('REBASE_REJECTION_INVALID');
      const restored = this.#restoreConfirmed(projectId);
      if (!restored && rows(this.db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? LIMIT 1', [projectId]).length > 0) throw new Error('REBASE_CONFIRMED_CHECKPOINT_REQUIRED');
      for (const r of rejected) {
        const pending = rows(this.db, 'SELECT command_json, commit_attempt_id, queued_at_iso FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', [projectId, r.commandId])[0];
        if (pending) this.#retainRejection(projectId, { commandId: r.commandId, commandJson: String(pending.command_json), commitAttemptId: Number(pending.commit_attempt_id), queuedAtISO: String(pending.queued_at_iso) }, r.reason ?? 'RebasePreconditionFailed');
        this.db.exec({ sql: 'DELETE FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', bind: [projectId, r.commandId] });
      }
      if (remote.ownEcho) this.db.exec({ sql: 'DELETE FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', bind: [projectId, remote.command.commandId] });
      // An echo is authoritative replay after rollback, especially for toggles.
      if (!remote.ownEcho || restored) {
        const revision = rows(this.db, 'SELECT revision FROM projects WHERE id = ?', [projectId])[0];
        const baseRevision = Number(revision?.revision);
        const command = Object.freeze({ ...remote.command, ...(remote.command.actorId == null && remote.historyEntry?.actorId != null ? { actorId: remote.historyEntry.actorId } : {}), baseRevision, expectedRevision: baseRevision + 1 }) as ProductCommand;
        remoteResult = this.apply(command);
        if (remoteResult.type !== 'ProductCommandApplied') throw new Error(`REMOTE_REBASE_REJECTED:${remoteResult.code}`);
      }
      this.#captureConfirmed(projectId);
      this.#replayAtomically(projectId, toReapply.map((entry) => ({ ...entry, commandJson: JSON.stringify(entry.command) })), (entry) => {
        this.db.exec({
          sql: `INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso, group_id, group_index)
                VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, command_id) DO UPDATE SET
                command_json = excluded.command_json, commit_attempt_id = excluded.commit_attempt_id, queued_at_iso = excluded.queued_at_iso`,
          bind: [projectId, entry.commandId, entry.commandJson, entry.commitAttemptId, entry.queuedAtISO, entry.groupId ?? null, entry.groupIndex ?? null],
        });
      });
      if (rows(this.db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? LIMIT 1', [projectId]).length === 0) this.db.exec({ sql: 'DELETE FROM collaboration_confirmed_state WHERE project_id = ?', bind: [projectId] });
      this.db.exec({ sql: `INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, ?)
        ON CONFLICT(project_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`, bind: [projectId, remote.serverRevision] });
      if (remote.historyEntry) this.db.exec({ sql: 'INSERT INTO collaboration_authoritative_history(project_id,stream_epoch,server_revision,entry_json) VALUES(?,?,?,?)', bind: [projectId, remote.streamEpoch!, remote.serverRevision, JSON.stringify(remote.historyEntry)] });
      this.commitCommand(outer);
      closed = true;
      return remote.ownEcho ? null : remoteResult;
    } catch (error) {
      if (!closed) { try { this.rollbackCommand(outer); } catch { /* preserve original */ } }
      throw error;
    }
  }

  /** Production stream boundary; historical fixture-only rebase does not admit wire input. */
  async applyConfirmedRebaseAtomic(projectId: string, remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch?: number; historyEntry?: import('../../contracts/collaboration-recovery').ConfirmedHistoryEntry }>, survivors: readonly import('../../application/collaboration/sync-client').OutboxEntry[], rejected: readonly Readonly<{ commandId: string; reason?: string }>[]): Promise<ProductCommandResult | null> {
    if (!Number.isSafeInteger(remote.streamEpoch) || (remote.streamEpoch ?? 0) < 1 || !remote.historyEntry) throw new Error('REBASE_EPOCH_OR_HISTORY_MISSING');
    const historyEntry = await validateConfirmedHistoryEntry(remote.historyEntry, projectId);
    if (historyEntry.serverRevision !== remote.serverRevision || canonicalizeJcs(historyEntry.command) !== canonicalizeJcs(remote.command)) throw new Error('REBASE_HISTORY_IDENTITY_CONFLICT');
    if (remote.ownEcho && historyEntry.wireIdentityAvailability === 'legacy-admitted-wire' && historyEntry.actorId === null) throw new Error('REBASE_HISTORY_IDENTITY_UNAVAILABLE');
    return this.applyRebaseAtomic(projectId, { ...remote, historyEntry }, survivors, rejected);
  }

  /**
   * Initialize the product schema.
   * Idempotent — safe to call on every startup.
   * Caller must ensure foreign_keys = ON before calling.
   */
  initializeSchema(): void {
    // CREATE TABLE IF NOT EXISTS leaves legacy columns untouched. Migrate
    // before creating indexes that reference those columns (Epic 17).
    const isIndex = (ddl: string): boolean => /^CREATE (?:UNIQUE )?INDEX/i.test(ddl.trim());
    for (const ddl of PRODUCT_SCHEMA_DDL.filter((statement) => !isIndex(statement))) {
      this.db.exec(ddl);
    }
    initializeCollaborationSchema(this.db);
    migrateWorkspaceSchema(this.db);
    for (const ddl of PRODUCT_SCHEMA_DDL.filter(isIndex)) {
      this.db.exec(ddl);
    }
  }

  /**
   * The plain local entry point. A shared project's edits must commit with
   * their outbox entry through its live session; this path has none, so an
   * edit here (from a local-only build, or before the session connects) would
   * never reach the team and could later be replaced by the service's copy.
   * Refuse it. Creating a project and deleting the local copy stay allowed.
   * (Same rule as the native `handler::apply`.)
   */
  applyLocal(command: ProductCommand): ProductCommandResult {
    if (command.type !== 'CreateProject' && command.type !== 'DeleteProject'
      && rows(this.db, 'SELECT 1 FROM collaboration_cursor WHERE project_id = ? LIMIT 1', [command.projectId]).length > 0) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: command.protocolVersion, commandId: command.commandId, projectId: command.projectId, code: 'SHARED_PROJECT_NOT_CONNECTED' }) as ProductCommandResult;
    }
    return this.apply(command);
  }

  /**
   * Apply a product command.
   * One SQLite transaction per command.
   */
  apply(command: ProductCommand): ProductCommandResult {
    // Unsupported future schema: reject before any command application or replay (Story 22.15 AC 22.15-2/-3).
    const currentVersion = readUserVersion(this.db);
    if (currentVersion > PRODUCT_SCHEMA_VERSION) {
      return {
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: 'projectId' in command ? command.projectId : '',
        code: 'UNSUPPORTED_NEWER_SCHEMA',
      };
    }

    // Story 27.3: stamp actor identity on the envelope. The local actor is the
    // actor for a local project; a shared project supplies its own actorId from
    // the sync client. ensureLocalActor also backfills pre-v17 receipts.
    const actorId = command.actorId ?? ensureLocalActor(this.db);
    const stamped = command.actorId === actorId
      ? command
      : (Object.freeze({ ...command, actorId }) as ProductCommand);

    // Check for duplicate commandId (idempotent replay)
    const prior = rows(
      this.db,
      `SELECT command_id, project_id, command_type, base_revision, target_revision, result_json
       FROM product_command_receipt WHERE command_id = ?`,
      [command.commandId],
    )[0];

    if (prior) {
      return this.#handleDuplicate(stamped, prior);
    }

    const result = this.#applyNew(stamped);
    // Persist the actor on the receipt (the handlers commit their own
    // transaction; this metadata write is a no-op when already set).
    if (result.type === 'ProductCommandApplied') {
      this.db.exec({
        sql: 'UPDATE product_command_receipt SET actor_id = ? WHERE command_id = ?',
        bind: [actorId, command.commandId],
      });
    }
    return result;
  }

  #applyNew(command: ProductCommand): ProductCommandResult {
    try {
      switch (command.type) {
      case 'CreateProject':
        return this.#applyCreateProject(command);
      case 'RenameProject':
        return this.#applyRenameProject(command);
      case 'DeleteProject':
        return this.#applyDeleteProject(command);
      case 'CreateNode':
        return this.#applyCreateNode(command);
      case 'SetNodeTitle':
        return this.#applySetNodeTitle(command);
      case 'SetNodeBodyText':
        return this.#applySetNodeBodyText(command);
      case 'MoveNode':
        return this.#applyMoveNode(command);
      case 'DeleteSubtree':
        return this.#applyDeleteSubtree(command);
      case 'DuplicateSubtree':
        return this.#applyDuplicateSubtree(command);
      case 'RestoreSubtree':
        return this.#applyRestoreSubtree(command);
      case 'SetNodeType':
        return this.#applySetNodeType(command);
      case 'SetNodeCustomField':
        return this.#applySetNodeCustomField(command);
      case 'PromoteFieldToTemplate':
        return this.#applyPromoteFieldToTemplate(command);
      case 'SetNodeSchedule':
        return this.#applySetNodeSchedule(command);
      case 'ToggleNodeCompleted':
        return this.#applyToggleNodeCompleted(command);
      case 'SetNodeEffort':
        return this.#applySetNodeEffort(command);
      case 'SetNodePointsDone':
        return this.#applySetNodePointsDone(command);
      case 'SetNodeStatus':
        return this.#applySetNodeStatus(command);
      case 'SetThemeWeight':
        return this.#applySetThemeWeight(command);
      case 'CreatePhase':
        return this.#applyCreatePhase(command);
      case 'RenamePhase':
        return this.#applyRenamePhase(command);
      case 'ReorderPhases':
        return this.#applyReorderPhases(command);
      case 'MovePhase':
        return this.#applyMovePhase(command);
      case 'AssignNodePhase':
        return this.#applyAssignNodePhase(command);
      case 'DeletePhase':
        return this.#applyDeletePhase(command);
      case 'RestorePhase':
        return this.#applyRestorePhase(command);
      case 'CreateUnlockEdge':
        return this.#applyCreateUnlockEdge(command);
      case 'DeleteUnlockEdge':
        return this.#applyDeleteUnlockEdge(command);
      case 'DismissFinding':
        return this.#applyDismissFinding(command);
      case 'UndismissFinding':
        return this.#applyUndismissFinding(command);
      case 'RecordAffectedReasons':
        return this.#applyRecordAffectedReasons(command);
      case 'AcknowledgeAffectedReason':
        return this.#applyAcknowledgeAffectedReason(command);
      case 'ClearNodeAffectedReasons':
        return this.#applyClearNodeAffectedReasons(command);
      case 'AddNodeQuestion':
        return this.#applyAddNodeQuestion(command);
      case 'UpdateNodeQuestion':
        return this.#applyUpdateNodeQuestion(command);
      case 'ResolveNodeQuestion':
        return this.#applyResolveNodeQuestion(command);
      case 'ReorderNodeQuestions':
        return this.#applyReorderNodeQuestions(command);
      case 'MoveNodeQuestion':
        return this.#applyMoveNodeQuestion(command);
      case 'DeleteNodeQuestion':
        return this.#applyDeleteNodeQuestion(command);
      case 'ConfigureForecastPlan':
        return this.#applyConfigureForecastPlan(command);
      case 'RemoveForecastPlan':
        return this.#applyRemoveForecastPlan(command);
      case 'SetForecastMembership':
        return this.#applySetForecastMembership(command);
      case 'SetForecastBlocker':
        return this.#applySetForecastBlocker(command);
      case 'CreateForecastScenario':
        return this.#applyCreateForecastScenario(command);
      case 'RemoveForecastScenario':
        return this.#applyRemoveForecastScenario(command);
      case 'RestoreForecastScenario':
        return this.#applyRestoreForecastScenario(command);
      case 'ReorderForecastFeatures':
        return this.#applyReorderForecastFeatures(command);
      case 'SetForecastSequence':
        return this.#applySetForecastSequence(command);
      case 'SetForecastParallelGroups':
        return this.#applySetForecastParallelGroups(command);
      case 'RestoreForecastScope':
        return this.#applyRestoreForecastScope(command);
      case 'SetForecastPlanningLevel':
        return this.#applySetForecastPlanningLevel(command);
      case 'RestoreForecastPlanningLevel':
        return this.#applyRestoreForecastPlanningLevel(command);
      case 'AddForecastPerson':
        return this.#applyAddForecastPerson(command);
      case 'UpdateForecastPerson':
        return this.#applyUpdateForecastPerson(command);
      case 'RemoveForecastPerson':
        return this.#applyRemoveForecastPerson(command);
      case 'RestoreForecastPerson':
        return this.#applyRestoreForecastPerson(command);
      case 'SetForecastAssignments':
        return this.#applySetForecastAssignments(command);
      case 'SetForecastPolicy':
        return this.#applySetForecastPolicy(command);
      case 'MoveForecastFeature':
        return this.#applyMoveForecastFeature(command);
      case 'SetForecastAssignment':
        return this.#applySetForecastAssignment(command);
      }
    } catch (err) {
      if (err instanceof ForecastPlanCorruptError) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_PLAN_CORRUPT',
          column: err.column,
        });
      }
      throw err;
    }
  }

  // ── Duplicate handling ───────────────────────────────────────────

  #handleDuplicate(command: ProductCommand, prior: Row): ProductCommandResult {
    const identityMatches =
      prior.project_id === command.projectId &&
      prior.command_type === command.type &&
      integer(prior.base_revision) === command.baseRevision;

    const storedResult = JSON.parse(String(prior.result_json)) as ProductCommandApplied;
    const change = storedResult.changeSet?.changes[0];
    const scenarioIdentityMatches = (() => {
      if (command.type === 'CreateForecastScenario') {
        if (change?.type !== 'ForecastScenarioCreated') return false;
        const s = change.scenario;
        return s.scenarioId === command.scenarioId && s.label === command.label && s.baselineRevision === command.baselineRevision && s.baselineFingerprint === command.expectedMaterialFingerprint && s.createdAtISO === command.createdAtISO && JSON.stringify(s.patch) === JSON.stringify(command.patch);
      }
      if (command.type === 'RemoveForecastScenario') return change?.type === 'ForecastScenarioRemoved' && change.scenarioId === command.scenarioId;
      if (command.type === 'RestoreForecastScenario') return change?.type === 'ForecastScenarioRestored' && JSON.stringify(change.scenario) === JSON.stringify(command.scenario);
      if (command.type === 'AddForecastPerson') {
        const added = storedResult.changeSet?.changes.find((c) => c.type === 'ForecastPersonAdded');
        if (added?.type !== 'ForecastPersonAdded') return false;
        return added.person.id === command.personId && added.person.name === command.name && added.person.weightUnits === command.weightUnits;
      }
      if (command.type === 'UpdateForecastPerson') {
        if (change?.type !== 'ForecastPersonUpdated') return false;
        return change.personId === command.personId && change.name === command.name && change.weightUnits === command.weightUnits;
      }
      if (command.type === 'RemoveForecastPerson') {
        if (change?.type !== 'ForecastPersonRemoved') return false;
        return change.person.id === command.personId;
      }
      if (command.type === 'RestoreForecastPerson') {
        const restored = storedResult.changeSet?.changes.find((c) => c.type === 'ForecastPersonRestored');
        if (restored?.type !== 'ForecastPersonRestored') return false;
        return restored.person.id === command.person.id && restored.person.name === command.person.name && restored.person.weightUnits === command.person.weightUnits;
      }
      if (command.type === 'SetForecastAssignments') {
        const setAssignments = storedResult.changeSet?.changes.find((c) => c.type === 'ForecastAssignmentsSet');
        if (setAssignments?.type !== 'ForecastAssignmentsSet') return false;
        return (
          setAssignments.featureId === command.featureId &&
          setAssignments.personIds.length === command.personIds.length &&
          setAssignments.personIds.every((id, idx) => id === command.personIds[idx])
        );
      }
      if (command.type === 'SetForecastPolicy') {
        const setPolicy = storedResult.changeSet?.changes.find((c) => c.type === 'ForecastPolicySet');
        if (setPolicy?.type !== 'ForecastPolicySet') return false;
        return setPolicy.policyVersion === command.policyVersion;
      }
      return true;
    })();

    if (!identityMatches || !scenarioIdentityMatches) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'COMMAND_IDENTITY_CONFLICT',
      });
    }

    return Object.freeze({
      ...storedResult,
      disposition: 'StoredResultReturned',
    });
  }

  // ── CreateProject ────────────────────────────────────────────────

  #applyCreateProject(command: CreateProjectCommand): ProductCommandResult {
    const existing = rows(
      this.db,
      'SELECT id FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (existing) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: 0,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      // Epic 17: a new project is born into whichever workspace is active.
      // Read (never repair) the pointer here — we are already inside this
      // command's transaction, and ensureDefaultWorkspace() has run at open,
      // so the invariants hold. Stamping it in the same INSERT means a project
      // row is never briefly workspace-less, even across a crash.
      const workspaceId = readActiveWorkspaceId(this.db);
      this.db.exec({
        sql: 'INSERT INTO projects(id, name, revision, workspace_id) VALUES(?, ?, ?, ?)',
        bind: [command.projectId, command.name, command.expectedRevision, workspaceId],
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── RenameProject ────────────────────────────────────────────────

  #applyRenameProject(command: RenameProjectCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE projects SET name = ?, revision = ? WHERE id = ?',
        bind: [command.name, command.expectedRevision, command.projectId],
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DeleteProject ────────────────────────────────────────────────

  #applyDeleteProject(command: DeleteProjectWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
      });

      // Receipt is written BEFORE the cascade delete so a retried
      // DeleteProject (same commandId) replays this stored result.
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      // ON DELETE CASCADE removes nodes, phases, edges, findings, view_state
      // for this project in one cascade walk. Receipts survive (no cascade).
      this.db.exec({
        sql: 'DELETE FROM projects WHERE id = ?',
        bind: [command.projectId],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── CreateNode ───────────────────────────────────────────────────

  #applyCreateNode(command: CreateNodeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
        projectId: command.projectId,
      });
    }

    if (command.parentId !== null) {
      const parent = rows(
        this.db,
        'SELECT id FROM nodes WHERE id = ? AND project_id = ?',
        [command.parentId, command.projectId],
      )[0];
      if (!parent) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'PARENT_NOT_FOUND',
          projectId: command.projectId,
          nodeId: command.parentId,
        });
      }
    }

    const changes: NodeChange[] = [];
    const targetPos = parsePosition(command.position);

    const __pmTxn = this.beginCommand();
    try {
      // Check if position collides
      const existingPos = rows(
        this.db,
        "SELECT id FROM nodes WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND position = ?",
        [command.projectId, command.parentId ?? '', Number(targetPos)],
      )[0];

      let finalPosition = targetPos;

      if (existingPos) {
        const siblingRows = rows(
          this.db,
          "SELECT id, position FROM nodes WHERE project_id = ? AND IFNULL(parent_id, '') = ? ORDER BY position ASC",
          [command.projectId, command.parentId ?? ''],
        );

        const siblingIds = siblingRows.map((r) => String(r.id));
        const rebalanced = rebalanceSiblingPositions([...siblingIds, command.nodeId]);

        for (const item of rebalanced) {
          if (item.nodeId !== command.nodeId) {
            this.db.exec({
              sql: 'UPDATE nodes SET position = ? WHERE id = ?',
              bind: [Number(item.position), item.nodeId],
            });
          } else {
            finalPosition = item.position;
          }
        }

        changes.push({
          type: 'SiblingPositionsRebalanced',
          parentId: command.parentId,
          positions: rebalanced.map((r) => ({ nodeId: r.nodeId, position: formatPosition(r.position) })),
        });
      }

      this.db.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?, ?, ?, ?, ?, ?)',
        bind: [
          command.nodeId,
          command.projectId,
          command.parentId,
          command.title,
          null,
          Number(finalPosition),
        ],
      });

      changes.push({
        type: 'NodeCreated',
        nodeId: command.nodeId,
        parentId: command.parentId,
        position: formatPosition(finalPosition),
        title: command.title,
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeTitle ──────────────────────────────────────────────────

  #applySetNodeTitle(command: SetNodeTitleWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
        projectId: command.projectId,
      });
    }

    const node = rows(
      this.db,
      'SELECT id, title FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!node) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET title = ? WHERE id = ? AND project_id = ?',
        bind: [command.title, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeTitleSet' as const,
            nodeId: command.nodeId,
            title: command.title,
            priorTitle: String(node.title ?? ''),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeBodyText ───────────────────────────────────────────────

  #applySetNodeBodyText(command: SetNodeBodyTextWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
        projectId: command.projectId,
      });
    }

    const node = rows(
      this.db,
      'SELECT id, body_text FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!node) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET body_text = ? WHERE id = ? AND project_id = ?',
        bind: [command.bodyText, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeBodyTextSet' as const,
            nodeId: command.nodeId,
            bodyText: command.bodyText,
            priorBodyText:
              node.body_text !== null && node.body_text !== undefined
                ? String(node.body_text)
                : null,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── MoveNode (Story 2.4) ──────────────────────────────────────────

  #applyMoveNode(command: MoveNodeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
        projectId: command.projectId,
      });
    }

    const node = rows(
      this.db,
      'SELECT id, parent_id, position, node_type FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!node) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    if (command.newParentId !== null) {
      const newParent = rows(
        this.db,
        'SELECT id, parent_id, node_type FROM nodes WHERE id = ? AND project_id = ?',
        [command.newParentId, command.projectId],
      )[0];

      if (!newParent) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'PARENT_NOT_FOUND',
          projectId: command.projectId,
          nodeId: command.newParentId,
        });
      }

      // Acyclicity check: walk parents of newParentId to ensure nodeId is not an ancestor
      let currentParentId: string | null = command.newParentId;
      let depth = 0;
      const allProjectNodes = rows(
        this.db,
        'SELECT id, parent_id FROM nodes WHERE project_id = ?',
        [command.projectId],
      );
      const parentMap = new Map<string, string | null>();
      for (const r of allProjectNodes) {
        parentMap.set(String(r.id), r.parent_id !== null ? String(r.parent_id) : null);
      }

      while (currentParentId !== null && depth <= allProjectNodes.length) {
        if (currentParentId === command.nodeId) {
          return Object.freeze({
            type: 'ProductCommandRejected',
            protocolVersion: PROTOCOL_VERSION,
            commandId: command.commandId,
            code: 'CYCLE_DETECTED',
            projectId: command.projectId,
            nodeId: command.nodeId,
          });
        }
        currentParentId = parentMap.get(currentParentId) ?? null;
        depth++;
      }

      // Hierarchy check: ensure parent rank <= child rank (permissive with null)
      const parentType = (newParent.node_type as NodeType | null) ?? null;
      const childType = (node.node_type as NodeType | null) ?? null;
      if (!canParentNodeType(parentType, childType)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'HIERARCHY_CONFLICT',
          projectId: command.projectId,
          nodeId: command.nodeId,
        });
      }
    }

    const previousParentId = node.parent_id !== null ? String(node.parent_id) : null;
    const previousPosition = formatPosition(BigInt(Number(node.position)));
    // Story 27.2 D8(c): when the command carries anchors/index, resolve the
    // placement from them (mirroring the native handler) instead of the bare
    // decimal position; otherwise the local path is unchanged.
    const hasAnchors =
      command.afterId != null || command.beforeId != null || command.intendedIndex != null;
    let targetPos = parsePosition(command.newPosition);
    if (hasAnchors) {
      const siblingRows = rows(
        this.db,
        "SELECT id, position FROM nodes WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND id != ? ORDER BY position ASC, id ASC",
        [command.projectId, command.newParentId ?? '', command.nodeId],
      );
      const orderedIds = siblingRows.map((r) => String(r.id));
      const resolved = applyAnchoredMove(orderedIds, command.nodeId, {
        afterId: command.afterId ?? null,
        beforeId: command.beforeId ?? null,
        intendedIndex: command.intendedIndex ?? 0,
      });
      if (resolved.kind === 'SelfAnchor' || !resolved.ids) {
        return Object.freeze({
          type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId, code: 'SELF_ANCHOR',
          projectId: command.projectId, nodeId: command.nodeId,
        });
      }
      const resolvedIds = resolved.ids;
      const idx = resolvedIds.indexOf(command.nodeId);
      const before = idx > 0 ? BigInt(Number(siblingRows.find((r) => String(r.id) === resolvedIds[idx - 1])?.position ?? 0)) : null;
      const after =
        idx >= 0 && idx + 1 < resolvedIds.length
          ? BigInt(Number(siblingRows.find((r) => String(r.id) === resolvedIds[idx + 1])?.position ?? 0))
          : null;
      const between = positionBetween(before, after);
      if (between.kind === 'Position') targetPos = between.position;
    }
    const changes: NodeChange[] = [];

    const __pmTxn = this.beginCommand();
    try {
      // Check for position collision at destination
      const existingPos = rows(
        this.db,
        "SELECT id FROM nodes WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND position = ? AND id != ?",
        [command.projectId, command.newParentId ?? '', Number(targetPos), command.nodeId],
      )[0];

      let finalPosition = targetPos;

      if (existingPos) {
        const siblingRows = rows(
          this.db,
          "SELECT id, position FROM nodes WHERE project_id = ? AND IFNULL(parent_id, '') = ? AND id != ? ORDER BY position ASC",
          [command.projectId, command.newParentId ?? '', command.nodeId],
        );

        const siblingIds = siblingRows.map((r) => String(r.id));
        const rebalanced = rebalanceSiblingPositions([...siblingIds, command.nodeId]);

        for (const item of rebalanced) {
          if (item.nodeId !== command.nodeId) {
            this.db.exec({
              sql: 'UPDATE nodes SET position = ? WHERE id = ?',
              bind: [Number(item.position), item.nodeId],
            });
          } else {
            finalPosition = item.position;
          }
        }

        changes.push({
          type: 'SiblingPositionsRebalanced',
          parentId: command.newParentId,
          positions: rebalanced.map((r) => ({ nodeId: r.nodeId, position: formatPosition(r.position) })),
        });
      }

      // Single row write for whole subtree move!
      this.db.exec({
        sql: 'UPDATE nodes SET parent_id = ?, position = ? WHERE id = ? AND project_id = ?',
        bind: [command.newParentId, Number(finalPosition), command.nodeId, command.projectId],
      });

      changes.push({
        type: 'NodeMoved',
        nodeId: command.nodeId,
        parentId: command.newParentId,
        position: formatPosition(finalPosition),
        priorParentId: previousParentId,
        priorPosition: previousPosition,
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DeleteSubtree (Story 2.6) ────────────────────────────────────

  /**
   * Story 22.14 AC 22.14-1/-2: a plan-touching command must refuse a damaged
   * stored plan before it writes anything. `readForecastPlan` throws
   * `ForecastPlanCorruptError`, which `apply` folds into the typed
   * `FORECAST_PLAN_CORRUPT` rejection with the offending column. Call this
   * before the first mutation so no node, scenario, revision or receipt lands.
   */
  #requireReadableForecastPlan(projectId: string): void {
    readForecastPlan(this.db, projectId);
  }

  #applyDeleteSubtree(command: DeleteSubtreeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    // Story 22.14 AC 22.14-1 names subtree delete among the plan-touching
    // commands (assignment cleanup); refuse a damaged cell before reading nodes
    // or deleting anything. NOTE: neither runtime currently prunes
    // `forecast_plans.assignments` for a deleted subtree — that cleanup gap is
    // tracked as deferred work against 22.14-1. The guard is still required so
    // a damaged plan is never mutated by this command.
    this.#requireReadableForecastPlan(command.projectId);

    const __pmTxn = this.beginCommand();
    try {
      const deletionBundle = captureDeletionBundle(this.db,command.projectId,command.nodeId);
      if (deletionBundle.nodes.length === 0) {
        this.rollbackCommand(__pmTxn);
        return Object.freeze({type:'ProductCommandRejected',protocolVersion:PROTOCOL_VERSION,commandId:command.commandId,code:'NODE_NOT_FOUND'});
      }
      const snapshots = deletionBasicNodes(deletionBundle);
      try { validateDeletionBundle(deletionBundle,command.projectId,command.nodeId,snapshots); }
      catch {
        this.rollbackCommand(__pmTxn);
        return Object.freeze({type:'ProductCommandRejected',protocolVersion:PROTOCOL_VERSION,commandId:command.commandId,code:'INVALID_DELETION_BUNDLE'});
      }

      this.db.exec({
        sql: 'DELETE FROM nodes WHERE id = ? AND project_id = ?',
        bind: [command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'SubtreeDeleted' as const,
            rootNodeId: command.nodeId,
            nodes: Object.freeze(snapshots),
            deletionBundle,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DuplicateSubtree (Story 2.6) ─────────────────────────────────

  #applyDuplicateSubtree(command: DuplicateSubtreeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const sourceRows = rows(
      this.db,
      `WITH RECURSIVE subtree(id, parent_id, title, body_text, position, depth) AS (
        SELECT id, parent_id, title, body_text, position, 0
        FROM nodes
        WHERE id = ? AND project_id = ?
        UNION ALL
        SELECT n.id, n.parent_id, n.title, n.body_text, n.position, s.depth + 1
        FROM nodes n
        JOIN subtree s ON n.parent_id = s.id
        WHERE n.project_id = ?
      )
      SELECT * FROM subtree ORDER BY depth ASC, position ASC`,
      [command.sourceNodeId, command.projectId, command.projectId],
    );

    if (sourceRows.length === 0) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const duplicatedSnapshots: NodeSnapshot[] = [];

    const __pmTxn = this.beginCommand();
    try {
      const sourceRoot = sourceRows[0];
      const rootParentId = sourceRoot.parent_id !== null && sourceRoot.parent_id !== undefined ? String(sourceRoot.parent_id) : null;

      for (const row of sourceRows) {
        const srcId = String(row.id);
        const isRoot = srcId === command.sourceNodeId;
        const targetId = isRoot ? command.newRootId : (command.idMap[srcId] ?? srcId);
        const parentId = isRoot
          ? rootParentId
          : (command.idMap[String(row.parent_id)] ?? String(row.parent_id));
        const position = isRoot ? command.newPosition : String(row.position);

        this.db.exec({
          sql: `INSERT INTO nodes(id, project_id, parent_id, title, body_text, position)
                VALUES(?, ?, ?, ?, ?, ?)`,
          bind: [
            targetId,
            command.projectId,
            parentId,
            String(row.title ?? ''),
            row.body_text !== null && row.body_text !== undefined ? String(row.body_text) : null,
            position,
          ],
        });

        duplicatedSnapshots.push({
          nodeId: targetId,
          parentId,
          title: String(row.title ?? ''),
          bodyText: row.body_text !== null && row.body_text !== undefined ? String(row.body_text) : null,
          position,
          depth: Number(row.depth),
        });
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'SubtreeDuplicated' as const,
            sourceRootId: command.sourceNodeId,
            newRootId: command.newRootId,
            nodes: Object.freeze(duplicatedSnapshots),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── RestoreSubtree (Story 2.6) ───────────────────────────────────

  #applyRestoreSubtree(command: RestoreSubtreeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      if (command.deletionBundle !== undefined) {
        const code = restoreDeletionBundle(this.db,command.deletionBundle,command.projectId,command.rootNodeId,command.nodes);
        if (code !== null) {
          this.rollbackCommand(__pmTxn);
          return Object.freeze({type:'ProductCommandRejected',protocolVersion:PROTOCOL_VERSION,commandId:command.commandId,code});
        }
      } else {
      const sorted = [...command.nodes].sort((a, b) => a.depth - b.depth);

      for (const node of sorted) {
        this.db.exec({
          sql: `INSERT INTO nodes(id, project_id, parent_id, title, body_text, position)
                VALUES(?, ?, ?, ?, ?, ?)`,
          bind: [
            node.nodeId,
            command.projectId,
            node.parentId,
            node.title,
            node.bodyText,
            Number(node.position),
          ],
        });
      }

      }
      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'SubtreeRestored' as const,
            rootNodeId: command.rootNodeId,
            nodes: Object.freeze([...command.nodes]),
            ...(command.deletionBundle === undefined ? {} : {deletionBundle:validateDeletionBundle(command.deletionBundle,command.projectId,command.rootNodeId,command.nodes)}),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeType (Story 3.1) ───────────────────────────────────────

  #applySetNodeType(command: SetNodeTypeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT parent_id, node_type FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    let parentType: NodeType | null = null;
    if (nodeRow.parent_id !== null) {
      const parentRow = rows(
        this.db,
        'SELECT node_type FROM nodes WHERE id = ? AND project_id = ?',
        [String(nodeRow.parent_id), command.projectId],
      )[0];
      if (parentRow) {
        parentType = (parentRow.node_type as NodeType | null) ?? null;
      }
    }

    const childRows = rows(
      this.db,
      'SELECT node_type FROM nodes WHERE parent_id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    );
    const childTypes = childRows.map((r) => (r.node_type as NodeType | null) ?? null);

    const validation = validateTypedNeighborhood({
      parentType,
      proposedType: command.nodeType,
      childTypes,
    });

    if (!validation.valid) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'HIERARCHY_CONFLICT',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    const priorNodeType = (nodeRow.node_type as NodeType | null) ?? null;

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET node_type = ? WHERE id = ? AND project_id = ?',
        bind: [command.nodeType, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeTypeSet' as const,
            nodeId: command.nodeId,
            nodeType: command.nodeType,
            priorNodeType,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeCustomField (Story 3.2) ────────────────────────────────

  #applySetNodeCustomField(command: SetNodeCustomFieldWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorRow = rows(
      this.db,
      'SELECT field_value FROM node_custom_fields WHERE project_id = ? AND node_id = ? AND field_key = ?',
      [command.projectId, command.nodeId, command.fieldKey],
    )[0];

    const priorFieldValue = priorRow && priorRow.field_value !== undefined && priorRow.field_value !== null
      ? String(priorRow.field_value)
      : null;

    const __pmTxn = this.beginCommand();
    try {
      if (command.fieldValue === null) {
        this.db.exec({
          sql: 'DELETE FROM node_custom_fields WHERE project_id = ? AND node_id = ? AND field_key = ?',
          bind: [command.projectId, command.nodeId, command.fieldKey],
        });
      } else {
        this.db.exec({
          sql: `INSERT INTO node_custom_fields(project_id, node_id, field_key, field_value)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(project_id, node_id, field_key) DO UPDATE SET field_value = excluded.field_value`,
          bind: [command.projectId, command.nodeId, command.fieldKey, command.fieldValue],
        });
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeCustomFieldSet' as const,
            nodeId: command.nodeId,
            fieldKey: command.fieldKey,
            fieldValue: command.fieldValue,
            priorFieldValue,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── PromoteFieldToTemplate (Story 3.2) ────────────────────────────

  #applyPromoteFieldToTemplate(command: PromoteFieldToTemplateWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const maxPosRow = rows(
      this.db,
      'SELECT MAX(position) as max_pos FROM type_template_fields WHERE project_id = ? AND node_type = ?',
      [command.projectId, command.nodeType],
    )[0];

    const nextPosition = (Number(maxPosRow?.max_pos ?? 0) || 0) + 1;

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `INSERT INTO type_template_fields(project_id, node_type, field_key, field_label, position)
              VALUES(?, ?, ?, ?, ?)
              ON CONFLICT(project_id, node_type, field_key) DO UPDATE SET field_label = excluded.field_label`,
        bind: [command.projectId, command.nodeType, command.fieldKey, command.fieldLabel, nextPosition],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'FieldTemplatePromoted' as const,
            nodeType: command.nodeType,
            fieldKey: command.fieldKey,
            fieldLabel: command.fieldLabel,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeSchedule (Story 3.4) ───────────────────────────────────

  #applySetNodeSchedule(command: SetNodeScheduleWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT start_date, end_date, duration_days, schedule_source_mode FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorStartDate = nodeRow.start_date ? String(nodeRow.start_date) : null;
    const priorEndDate = nodeRow.end_date ? String(nodeRow.end_date) : null;
    const priorDurationDays = nodeRow.duration_days !== null && nodeRow.duration_days !== undefined ? Number(nodeRow.duration_days) : null;
    const priorSourceMode = (nodeRow.schedule_source_mode as import('../../domain/tree/node.entity').ScheduleSourceMode) ?? 'none';

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `UPDATE nodes
              SET start_date = ?, end_date = ?, duration_days = ?, schedule_source_mode = ?
              WHERE id = ? AND project_id = ?`,
        bind: [
          command.startDate,
          command.endDate,
          command.durationDays,
          command.sourceMode,
          command.nodeId,
          command.projectId,
        ],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeScheduleSet' as const,
            nodeId: command.nodeId,
            startDate: command.startDate,
            endDate: command.endDate,
            durationDays: command.durationDays,
            sourceMode: command.sourceMode,
            priorStartDate,
            priorEndDate,
            priorDurationDays,
            priorSourceMode,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── ToggleNodeCompleted (Story 3.5) ───────────────────────────────

  #applyToggleNodeCompleted(command: ToggleNodeCompletedWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT completed FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorCompleted = Boolean(nodeRow.completed);

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET completed = ? WHERE id = ? AND project_id = ?',
        bind: [command.completed ? 1 : 0, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeCompletedToggled' as const,
            nodeId: command.nodeId,
            completed: command.completed,
            priorCompleted,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeEffort (Story 3.6) ─────────────────────────────────────

  #applySetNodeEffort(command: SetNodeEffortWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT effort_points, effort_points_done FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorEffortPoints = nodeRow.effort_points !== null && nodeRow.effort_points !== undefined
      ? Number(nodeRow.effort_points)
      : null;

    // Story 26.5 AC 26.5-2: lowering `effortPoints` below the recorded points
    // done is a conflict, refused with a named rejection — never silently
    // clamped. Clearing the estimate (null) while progress is recorded is the
    // same conflict. A refusal leaves the row and revision untouched.
    const priorPointsDone = nodeRow.effort_points_done !== null && nodeRow.effort_points_done !== undefined
      ? Number(nodeRow.effort_points_done)
      : null;
    if (priorPointsDone !== null && (command.effortPoints === null || command.effortPoints < priorPointsDone)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'EFFORT_BELOW_POINTS_DONE',
        priorPointsDone,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    let clearedAssignments: readonly string[] | undefined;
    let nextPlanToWrite: import('../../domain/forecast/forecast-plan.entity').ForecastPlan | null = null;

    if (command.effortPoints === 0 && priorPlan?.assignments?.[command.nodeId]) {
      clearedAssignments = priorPlan.assignments[command.nodeId];
      const nextAssignments = { ...priorPlan.assignments };
      delete nextAssignments[command.nodeId];
      nextPlanToWrite = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan.selectedFeatureIds,
        parallelGroups: priorPlan.parallelGroups,
        blockedFeatureIds: priorPlan.blockedFeatureIds,
        configuration: priorPlan.configuration,
        policyVersion: priorPlan.policyVersion,
        planningLevel: priorPlan.planningLevel,
        roster: priorPlan.roster,
        assignments: nextAssignments,
      });
    } else if (command.restoredAssignments && priorPlan) {
      const nextAssignments = {
        ...priorPlan.assignments,
        [command.nodeId]: command.restoredAssignments,
      };
      nextPlanToWrite = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan.selectedFeatureIds,
        parallelGroups: priorPlan.parallelGroups,
        blockedFeatureIds: priorPlan.blockedFeatureIds,
        configuration: priorPlan.configuration,
        policyVersion: priorPlan.policyVersion,
        planningLevel: priorPlan.planningLevel,
        roster: priorPlan.roster,
        assignments: nextAssignments,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET effort_points = ? WHERE id = ? AND project_id = ?',
        bind: [command.effortPoints, command.nodeId, command.projectId],
      });

      if (nextPlanToWrite) {
        writeForecastPlan(this.db, nextPlanToWrite);
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeEffortSet' as const,
            nodeId: command.nodeId,
            effortPoints: command.effortPoints,
            priorEffortPoints,
            ...(clearedAssignments ? { clearedAssignments } : {}),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodePointsDone (Story 26.5, FC-FR5) ────────────────────────

  /**
   * Records (or clears) points done on an item. Shape validation lives in the
   * domain command; the cross-field rule `0 <= done <= effortPoints` needs the
   * stored estimate, so it is enforced here. A value above the estimate, or a
   * value on an item with no estimate, is refused with a named rejection and
   * the row/revision are untouched — never clamped.
   */
  #applySetNodePointsDone(command: SetNodePointsDoneWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT effort_points, effort_points_done FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const effortPoints = nodeRow.effort_points !== null && nodeRow.effort_points !== undefined
      ? Number(nodeRow.effort_points)
      : null;
    const priorEffortPointsDone =
      nodeRow.effort_points_done !== null && nodeRow.effort_points_done !== undefined
        ? Number(nodeRow.effort_points_done)
        : null;

    if (command.effortPointsDone !== null) {
      if (effortPoints === null || effortPoints <= 0) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'POINTS_DONE_CONFLICT',
        });
      }
      if (command.effortPointsDone > effortPoints) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'POINTS_DONE_CONFLICT',
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET effort_points_done = ? WHERE id = ? AND project_id = ?',
        bind: [command.effortPointsDone, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodePointsDoneSet' as const,
            nodeId: command.nodeId,
            effortPointsDone: command.effortPointsDone,
            priorEffortPointsDone,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetNodeStatus (outline status badging) ────────────────────────

  #applySetNodeStatus(command: SetNodeStatusWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT delivery_status FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorDeliveryStatus = coerceDeliveryStatus(nodeRow.delivery_status);

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET delivery_status = ? WHERE id = ? AND project_id = ?',
        bind: [command.deliveryStatus, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeStatusSet' as const,
            nodeId: command.nodeId,
            deliveryStatus: command.deliveryStatus,
            priorDeliveryStatus,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetThemeWeight (Story 3.6) ────────────────────────────────────

  #applySetThemeWeight(command: SetThemeWeightWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT strategic_weight FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorStrategicWeight = nodeRow.strategic_weight !== null && nodeRow.strategic_weight !== undefined
      ? Number(nodeRow.strategic_weight)
      : null;

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET strategic_weight = ? WHERE id = ? AND project_id = ?',
        bind: [command.strategicWeight, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ThemeWeightSet' as const,
            nodeId: command.nodeId,
            strategicWeight: command.strategicWeight,
            priorStrategicWeight,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── CreatePhase (Story 3.7) ───────────────────────────────────────

  #applyCreatePhase(command: CreatePhaseWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'INSERT INTO phases(id, project_id, name, position) VALUES(?, ?, ?, ?)',
        bind: [command.phaseId, command.projectId, command.name, command.position],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'PhaseCreated' as const,
            phaseId: command.phaseId,
            name: command.name,
            position: command.position,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── RenamePhase (Story 3.7) ───────────────────────────────────────

  #applyRenamePhase(command: RenamePhaseWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const phaseRow = rows(
      this.db,
      'SELECT name FROM phases WHERE id = ? AND project_id = ?',
      [command.phaseId, command.projectId],
    )[0];

    if (!phaseRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PHASE_NOT_FOUND',
      });
    }

    const priorName = String(phaseRow.name);

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE phases SET name = ? WHERE id = ? AND project_id = ?',
        bind: [command.name, command.phaseId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'PhaseRenamed' as const,
            phaseId: command.phaseId,
            name: command.name,
            priorName,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── ReorderPhases (Story 3.7) ─────────────────────────────────────

  #applyReorderPhases(command: ReorderPhasesWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPhasesRows = rows(
      this.db,
      'SELECT id, position FROM phases WHERE project_id = ?',
      [command.projectId],
    );

    const priorPhases = priorPhasesRows.map((r) =>
      Object.freeze({ phaseId: String(r.id), position: String(r.position) }),
    );

    const __pmTxn = this.beginCommand();
    try {
      for (const p of command.phases) {
        this.db.exec({
          sql: 'UPDATE phases SET position = ? WHERE id = ? AND project_id = ?',
          bind: [p.position, p.phaseId, command.projectId],
        });
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'PhasesReordered' as const,
            phases: command.phases,
            priorPhases: Object.freeze(priorPhases),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── MovePhase (Story 27.2, D8(c), R3) ─────────────────────────────

  /**
   * Move one phase to a new place among its siblings using after/before
   * anchors. Only one revision advances; the whole-list `ReorderPhases` inverse
   * is still produced from the resulting order so undo stays unchanged.
   */
  #applyMovePhase(command: MovePhaseWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }

    const phaseRows = rows(this.db, 'SELECT id, position FROM phases WHERE project_id = ?', [command.projectId]);
    const ordered = phaseRows
      .map((r) => Object.freeze({ phaseId: String(r.id), position: BigInt(Number(r.position)) }))
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.phaseId.localeCompare(b.phaseId)))
      .map((p) => p.phaseId);

    if (!ordered.includes(command.phaseId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PHASE_NOT_FOUND', projectId: command.projectId, phaseId: command.phaseId });
    }

    const moved = applyAnchoredMove(ordered, command.phaseId, {
      afterId: command.afterId,
      beforeId: command.beforeId,
      intendedIndex: command.intendedIndex,
    });
    if (moved.kind === 'SelfAnchor' || !moved.ids) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'SELF_ANCHOR', projectId: command.projectId, phaseId: command.phaseId });
    }

    // Rebalance the whole phase set to contiguous gap positions (one undo unit).
    const nextPhases = moved.ids.map((phaseId, index) =>
      Object.freeze({ phaseId, position: String((BigInt(index) + 1n) * 4294967296n) }),
    );
    const priorPhases = ordered.map((phaseId, index) =>
      Object.freeze({ phaseId, position: String((BigInt(index) + 1n) * 4294967296n) }),
    );

    const __pmTxn = this.beginCommand();
    try {
      for (const p of nextPhases) {
        this.db.exec({ sql: 'UPDATE phases SET position = ? WHERE id = ? AND project_id = ?', bind: [p.position, p.phaseId, command.projectId] });
      }
      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });
      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([{ type: 'PhasesReordered' as const, phases: Object.freeze(nextPhases), priorPhases: Object.freeze(priorPhases) }]),
      });
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId,
        projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet,
      });
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)],
      });
      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── AssignNodePhase (Story 3.7) ───────────────────────────────────

  #applyAssignNodePhase(command: AssignNodePhaseWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    if (command.phaseId !== null) {
      const phaseExists = rows(
        this.db,
        'SELECT id FROM phases WHERE id = ? AND project_id = ?',
        [command.phaseId, command.projectId],
      )[0];
      if (!phaseExists) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'PHASE_NOT_FOUND',
        });
      }
    }

    const nodeRow = rows(
      this.db,
      'SELECT phase_id FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const priorPhaseId = nodeRow.phase_id ? String(nodeRow.phase_id) : null;

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE nodes SET phase_id = ? WHERE id = ? AND project_id = ?',
        bind: [command.phaseId, command.nodeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodePhaseAssigned' as const,
            nodeId: command.nodeId,
            phaseId: command.phaseId,
            priorPhaseId,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DeletePhase (Story 3.7) ───────────────────────────────────────

  #applyDeletePhase(command: DeletePhaseWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const phaseRow = rows(
      this.db,
      'SELECT name, position FROM phases WHERE id = ? AND project_id = ?',
      [command.phaseId, command.projectId],
    )[0];

    if (!phaseRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PHASE_NOT_FOUND',
      });
    }

    const assignedRows = rows(
      this.db,
      'SELECT id FROM nodes WHERE phase_id = ? AND project_id = ?',
      [command.phaseId, command.projectId],
    );

    const priorAssignments: Record<string, string | null> = {};
    for (const r of assignedRows) {
      priorAssignments[String(r.id)] = command.phaseId;
    }

    const __pmTxn = this.beginCommand();
    try {
      for (const [nodeId, newPhaseId] of Object.entries(command.reassignments)) {
        this.db.exec({
          sql: 'UPDATE nodes SET phase_id = ? WHERE id = ? AND project_id = ?',
          bind: [newPhaseId, nodeId, command.projectId],
        });
      }

      this.db.exec({
        sql: 'DELETE FROM phases WHERE id = ? AND project_id = ?',
        bind: [command.phaseId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'PhaseDeleted' as const,
            phaseId: command.phaseId,
            name: String(phaseRow.name),
            position: String(phaseRow.position),
            reassignments: command.reassignments,
            priorAssignments: Object.freeze(priorAssignments),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── RestorePhase (Story 3.7) ──────────────────────────────────────

  #applyRestorePhase(command: RestorePhaseWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'INSERT INTO phases(id, project_id, name, position) VALUES(?, ?, ?, ?)',
        bind: [command.phaseId, command.projectId, command.name, command.position],
      });

      for (const [nodeId, phaseId] of Object.entries(command.priorAssignments)) {
        this.db.exec({
          sql: 'UPDATE nodes SET phase_id = ? WHERE id = ? AND project_id = ?',
          bind: [phaseId, nodeId, command.projectId],
        });
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'PhaseRestored' as const,
            phaseId: command.phaseId,
            name: command.name,
            position: command.position,
            priorAssignments: command.priorAssignments,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── CreateUnlockEdge (Story 3.8) ──────────────────────────────────

  #applyCreateUnlockEdge(command: CreateUnlockEdgeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const srcExists = rows(
      this.db,
      'SELECT id FROM nodes WHERE id = ? AND project_id = ?',
      [command.sourceNodeId, command.projectId],
    )[0];
    const tgtExists = rows(
      this.db,
      'SELECT id FROM nodes WHERE id = ? AND project_id = ?',
      [command.targetNodeId, command.projectId],
    )[0];

    if (!srcExists || !tgtExists) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
      });
    }

    const existingEdge = rows(
      this.db,
      'SELECT id FROM unlock_edges WHERE project_id = ? AND source_node_id = ? AND target_node_id = ?',
      [command.projectId, command.sourceNodeId, command.targetNodeId],
    )[0];

    if (existingEdge) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'EDGE_CONFLICT',
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'INSERT INTO unlock_edges(id, project_id, source_node_id, target_node_id) VALUES(?, ?, ?, ?)',
        bind: [command.edgeId, command.projectId, command.sourceNodeId, command.targetNodeId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'UnlockEdgeCreated' as const,
            edgeId: command.edgeId,
            sourceNodeId: command.sourceNodeId,
            targetNodeId: command.targetNodeId,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DeleteUnlockEdge (Story 3.8) ──────────────────────────────────

  #applyDeleteUnlockEdge(command: DeleteUnlockEdgeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const edgeRow = rows(
      this.db,
      'SELECT source_node_id, target_node_id FROM unlock_edges WHERE id = ? AND project_id = ?',
      [command.edgeId, command.projectId],
    )[0];

    const sourceNodeId = edgeRow ? String(edgeRow.source_node_id) : (command.sourceNodeId ?? '');
    const targetNodeId = edgeRow ? String(edgeRow.target_node_id) : (command.targetNodeId ?? '');

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'DELETE FROM unlock_edges WHERE id = ? AND project_id = ?',
        bind: [command.edgeId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'UnlockEdgeDeleted' as const,
            edgeId: command.edgeId,
            sourceNodeId,
            targetNodeId,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 4 Command Implementations ───────────────────────────────

  #applyDismissFinding(command: import('../../contracts/repository-commands').DismissFindingWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `INSERT OR REPLACE INTO finding_dismissals(
                project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.projectId,
          command.findingId,
          command.findingKind,
          command.targetId,
          command.fingerprint,
          command.dismissedAt,
        ],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'FindingDismissed' as const,
            findingId: command.findingId,
            findingKind: command.findingKind,
            targetId: command.targetId,
            fingerprint: command.fingerprint,
            dismissedAt: command.dismissedAt,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyUndismissFinding(command: import('../../contracts/repository-commands').UndismissFindingWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorDismissal = rows(
      this.db,
      `SELECT dismissed_at FROM finding_dismissals
        WHERE project_id = ? AND finding_kind = ? AND target_id = ? AND fingerprint = ?`,
      [command.projectId, command.findingKind, command.targetId, command.fingerprint],
    )[0];
    const priorDismissedAt = priorDismissal ? String(priorDismissal.dismissed_at) : '1970-01-01T00:00:00Z';

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `DELETE FROM finding_dismissals
              WHERE project_id = ? AND finding_kind = ? AND target_id = ? AND fingerprint = ?`,
        bind: [
          command.projectId,
          command.findingKind,
          command.targetId,
          command.fingerprint,
        ],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'FindingUndismissed' as const,
            findingId: command.findingId,
            findingKind: command.findingKind,
            targetId: command.targetId,
            fingerprint: command.fingerprint,
            priorDismissedAt,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyRecordAffectedReasons(command: import('../../contracts/repository-commands').RecordAffectedReasonsWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      for (const r of command.reasons) {
        this.db.exec({
          sql: `INSERT OR REPLACE INTO affected_reasons(
                  id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days, causal_date_summary, created_at, acknowledged_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          bind: [
            r.id,
            command.projectId,
            r.affectedNodeId,
            r.causalNodeId,
            r.causalNodeTitle,
            r.deltaDays,
            r.causalDateSummary,
            r.createdAt,
          ],
        });
      }

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'AffectedReasonsRecorded' as const,
            reasons: command.reasons,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyAcknowledgeAffectedReason(command: import('../../contracts/repository-commands').AcknowledgeAffectedReasonWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `UPDATE affected_reasons
              SET acknowledged_at = ?
              WHERE project_id = ? AND id = ?`,
        bind: [command.acknowledgedAt, command.projectId, command.reasonId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'AffectedReasonAcknowledged' as const,
            reasonId: command.reasonId,
            acknowledgedAt: command.acknowledgedAt,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyClearNodeAffectedReasons(command: import('../../contracts/repository-commands').ClearNodeAffectedReasonsWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `DELETE FROM affected_reasons
              WHERE project_id = ? AND affected_node_id = ?`,
        bind: [command.projectId, command.nodeId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── AddNodeQuestion (Story 16.1) ──────────────────────────────────

  #applyAddNodeQuestion(command: AddNodeQuestionWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const node = rows(
      this.db,
      'SELECT id FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!node) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `INSERT INTO node_open_questions(
                id, project_id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
              ) VALUES(?, ?, ?, ?, 'OPEN', NULL, ?, NULL, ?)`,
        bind: [
          command.questionId,
          command.projectId,
          command.nodeId,
          command.questionText,
          Number(command.position),
          command.createdAtISO,
        ],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeQuestionAdded' as const,
            questionId: command.questionId,
            nodeId: command.nodeId,
            questionText: command.questionText,
            position: command.position,
            createdAtISO: command.createdAtISO,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── UpdateNodeQuestion (Story 16.1) ───────────────────────────────

  #applyUpdateNodeQuestion(command: UpdateNodeQuestionWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const question = rows(
      this.db,
      'SELECT question_text FROM node_open_questions WHERE id = ? AND project_id = ?',
      [command.questionId, command.projectId],
    )[0];

    if (!question) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.questionId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'UPDATE node_open_questions SET question_text = ? WHERE id = ? AND project_id = ?',
        bind: [command.questionText, command.questionId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeQuestionUpdated' as const,
            questionId: command.questionId,
            questionText: command.questionText,
            priorQuestionText: String(question.question_text ?? ''),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── ResolveNodeQuestion (Story 16.1) ──────────────────────────────

  #applyResolveNodeQuestion(command: ResolveNodeQuestionWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const question = rows(
      this.db,
      'SELECT status, decision_text, resolved_at_iso FROM node_open_questions WHERE id = ? AND project_id = ?',
      [command.questionId, command.projectId],
    )[0];

    if (!question) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.questionId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: `UPDATE node_open_questions
              SET status = 'DECIDED', decision_text = ?, resolved_at_iso = ?
              WHERE id = ? AND project_id = ?`,
        bind: [command.decisionText, command.resolvedAtISO, command.questionId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeQuestionResolved' as const,
            questionId: command.questionId,
            decisionText: command.decisionText,
            resolvedAtISO: command.resolvedAtISO,
            priorStatus: (question.status as 'OPEN' | 'DECIDED') ?? 'OPEN',
            priorDecisionText:
              question.decision_text !== null && question.decision_text !== undefined
                ? String(question.decision_text)
                : null,
            priorResolvedAtISO:
              question.resolved_at_iso !== null && question.resolved_at_iso !== undefined
                ? String(question.resolved_at_iso)
                : null,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── ReorderNodeQuestions (Story 16.1) ─────────────────────────────

  #applyReorderNodeQuestions(command: ReorderNodeQuestionsWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const node = rows(
      this.db,
      'SELECT id FROM nodes WHERE id = ? AND project_id = ?',
      [command.nodeId, command.projectId],
    )[0];

    if (!node) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }

    const existingRows = rows(
      this.db,
      'SELECT id FROM node_open_questions WHERE project_id = ? AND node_id = ? ORDER BY position ASC',
      [command.projectId, command.nodeId],
    );
    const existingIds = existingRows.map((r) => String(r.id));

    const requestedSet = new Set(command.questionIds);
    const existingSet = new Set(existingIds);
    if (requestedSet.size !== command.questionIds.length || requestedSet.size !== existingSet.size) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.nodeId,
      });
    }
    for (const id of command.questionIds) {
      if (!existingSet.has(id)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'NODE_NOT_FOUND',
          projectId: command.projectId,
          nodeId: command.nodeId,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      command.questionIds.forEach((questionId, index) => {
        this.db.exec({
          sql: 'UPDATE node_open_questions SET position = ? WHERE id = ? AND project_id = ?',
          bind: [index + 1, questionId, command.projectId],
        });
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeQuestionsReordered' as const,
            nodeId: command.nodeId,
            questionIds: Object.freeze([...command.questionIds]),
            priorQuestionIds: Object.freeze(existingIds),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── MoveNodeQuestion (Story 27.2, D8(c), R3) ──────────────────────

  #applyMoveNodeQuestion(command: MoveNodeQuestionWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }

    const node = rows(this.db, 'SELECT id FROM nodes WHERE id = ? AND project_id = ?', [command.nodeId, command.projectId])[0];
    if (!node) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'NODE_NOT_FOUND', projectId: command.projectId, nodeId: command.nodeId });
    }

    const existingRows = rows(
      this.db,
      'SELECT id FROM node_open_questions WHERE project_id = ? AND node_id = ? ORDER BY position ASC',
      [command.projectId, command.nodeId],
    );
    const existingIds = existingRows.map((r) => String(r.id));
    if (!existingIds.includes(command.questionId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'NODE_NOT_FOUND', projectId: command.projectId, nodeId: command.nodeId });
    }

    const moved = applyAnchoredMove(existingIds, command.questionId, {
      afterId: command.afterId,
      beforeId: command.beforeId,
      intendedIndex: command.intendedIndex,
    });
    if (moved.kind === 'SelfAnchor' || !moved.ids) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'SELF_ANCHOR', projectId: command.projectId, nodeId: command.nodeId });
    }

    const __pmTxn = this.beginCommand();
    try {
      moved.ids.forEach((questionId, index) => {
        this.db.exec({ sql: 'UPDATE node_open_questions SET position = ? WHERE id = ? AND project_id = ?', bind: [index + 1, questionId, command.projectId] });
      });
      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });
      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([{ type: 'NodeQuestionsReordered' as const, nodeId: command.nodeId, questionIds: Object.freeze([...moved.ids]), priorQuestionIds: Object.freeze(existingIds) }]),
      });
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId,
        projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet,
      });
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)],
      });
      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── DeleteNodeQuestion (Story 16.1) ───────────────────────────────

  #applyDeleteNodeQuestion(command: DeleteNodeQuestionWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = integer(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const question = rows(
      this.db,
      `SELECT node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
       FROM node_open_questions WHERE id = ? AND project_id = ?`,
      [command.questionId, command.projectId],
    )[0];

    if (!question) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'NODE_NOT_FOUND',
        projectId: command.projectId,
        nodeId: command.questionId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      this.db.exec({
        sql: 'DELETE FROM node_open_questions WHERE id = ? AND project_id = ?',
        bind: [command.questionId, command.projectId],
      });

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'NodeQuestionDeleted' as const,
            questionId: command.questionId,
            nodeId: String(question.node_id ?? ''),
            questionText: String(question.question_text ?? ''),
            status: (question.status as 'OPEN' | 'DECIDED') ?? 'OPEN',
            decisionText:
              question.decision_text !== null && question.decision_text !== undefined
                ? String(question.decision_text)
                : null,
            position: String(question.position ?? 0),
            resolvedAtISO:
              question.resolved_at_iso !== null && question.resolved_at_iso !== undefined
                ? String(question.resolved_at_iso)
                : null,
            createdAtISO: String(question.created_at_iso ?? ''),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 18: ConfigureForecastPlan (Story 18.2) ────────────────────────
  // One atomic command covers the complete configuration group — capacity,
  // sprint length, cadence, start ordinal, and start date — so one UI save
  // never splits into separate capacity and cadence commits (AC 18.1-3,
  // UX-DR9). Incomplete and zero values remain stored and distinctly
  // explained (AC 18.5-4).

  #applyConfigureForecastPlan(command: ConfigureForecastPlanWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorConfiguration = priorPlan?.configuration ?? null;
    // Story 21.13 D5: a carried planning level applies only at CREATION — the
    // edit-in-place path always preserves the stored level (the Change-dialog
    // owns level switches, which clear scope atomically). The UI only sends a
    // level on the first save, so the edit branch never receives one.
    const appliedLevel = !priorPlan ? (command.planningLevel ?? null) : null;
    const effectiveLevel = appliedLevel ?? priorPlan?.planningLevel ?? 'Feature';

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan?.selectedFeatureIds ?? [],
        parallelGroups: priorPlan?.parallelGroups ?? [],
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: createForecastConfiguration({
          pointsPerSprint: command.pointsPerSprint,
          sprintLengthDays: command.sprintLengthDays,
          startSprintOrdinal: command.startSprintOrdinal,
          startDate: command.startDate,
        }),
        policyVersion: priorPlan?.policyVersion,
        // Story 21.10: the plan's level is preserved across configuration
        // saves — a Theme-level plan stays Theme-level. Story 21.13 D5:
        // creation may carry the level chosen on the step card atomically.
        planningLevel: effectiveLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastConfigurationSet' as const,
        pointsPerSprint: command.pointsPerSprint,
        sprintLengthDays: command.sprintLengthDays,
        startSprintOrdinal: command.startSprintOrdinal,
        startDate: command.startDate,
        priorPointsPerSprint: priorConfiguration?.pointsPerSprint ?? null,
        priorSprintLengthDays: priorConfiguration?.sprintLengthDays ?? null,
        priorStartSprintOrdinal: priorConfiguration?.startSprintOrdinal ?? null,
        priorStartDate: priorConfiguration?.startDate ?? null,
      });
      // The level rides the SAME command, so its forward state is reported in
      // the SAME changeset — the analysis engine learns Theme-level without a
      // second command (the async chip flip D4 accommodated, gone).
      if (appliedLevel && appliedLevel !== 'Feature') {
        changes.push({
          type: 'ForecastPlanningLevelSet' as const,
          planningLevel: appliedLevel,
          selectedFeatureIds: [],
          parallelGroups: [],
          blockedFeatureIds: [],
          priorPlanningLevel: 'Feature',
          priorSelectedFeatureIds: [],
          priorParallelGroups: [],
          priorBlockedFeatureIds: [],
        });
      }

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 21: RemoveForecastPlan (Story 21.13, D5) ────────────────────────
  // The exact inverse of atomic plan CREATION: deletes the forecast_plans row
  // so a single Undo returns to the pre-creation state (the level step).
  // Dispatched only through the undo engine; Redo replays the forward
  // ConfigureForecastPlan, recreating the plan with its configuration and
  // level. Scenarios are untouched — by undo-stack LIFO order they are all
  // removed before the creation entry is ever popped.

  #applyRemoveForecastPlan(command: RemoveForecastPlanWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    if (!priorPlan) {
      // Undo of a creation always finds the row the forward command wrote;
      // a missing row means the command was never applicable here.
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_CONFIG_INVALID',
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      deleteForecastPlan(this.db, command.projectId);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ForecastPlanRemoved' as const,
            projectId: command.projectId,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 18: SetForecastMembership (Story 18.2) ────────────────────────
  // Inclusion appends by default (AR-18); exclusion removes only that ID.
  // Excluding a group member updates group membership in the same
  // transaction; a resulting singleton group dissolves and both changes are
  // reported (AR-19). Invalid references can be explicitly excluded; the
  // system never silently shrinks scope (AC 18.1-4).

  #applySetForecastMembership(command: SetForecastMembershipWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];

    // Excluding a Feature that is not in scope is a no-op — reject it rather
    // than commit an identical plan, bump the revision, and push a
    // non-invertible entry onto the undo stack (symmetric with the
    // already-present check on the inclusion path).
    if (!command.included && !priorIds.includes(command.featureId)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_SCOPE_INVALID',
        projectId: command.projectId,
        nodeId: command.featureId,
      });
    }

    if (command.included) {
      if (priorIds.includes(command.featureId)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      }

      // Inclusion must resolve to a same-project Feature (AC 18.6-4).
      const nodeRow = rows(
        this.db,
        'SELECT node_type FROM nodes WHERE id = ? AND project_id = ?',
        [command.featureId, command.projectId],
      )[0];
      if (!nodeRow) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      }
      if (nodeRow.node_type !== (priorPlan?.planningLevel ?? 'Feature')) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      }

      // Parent/descendant overlap is rejected by name (AR-4). Walks are
      // visited-bounded so a corrupt parent_id chain cannot spin.
      const allNodes = rows(
        this.db,
        'SELECT id, parent_id, node_type FROM nodes WHERE project_id = ?',
        [command.projectId],
      );
      const parentOf = new Map<string, string | null>();
      for (const r of allNodes) {
        parentOf.set(String(r.id), r.parent_id !== null && r.parent_id !== undefined ? String(r.parent_id) : null);
      }
      const priorIdSet = new Set(priorIds);
      const rejectOverlap = () =>
        Object.freeze({
          type: 'ProductCommandRejected' as const,
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID' as const,
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      // Is an ancestor of the new Feature already selected?
      {
        const visited = new Set<string>([command.featureId]);
        let ancestor = parentOf.get(command.featureId) ?? null;
        while (ancestor !== null && !visited.has(ancestor)) {
          visited.add(ancestor);
          if (priorIdSet.has(ancestor)) return rejectOverlap();
          ancestor = parentOf.get(ancestor) ?? null;
        }
      }
      // Is the new Feature an ancestor of an already-selected Feature?
      for (const id of priorIds) {
        const visited = new Set<string>([id]);
        let a = parentOf.get(id) ?? null;
        while (a !== null && !visited.has(a)) {
          visited.add(a);
          if (a === command.featureId) return rejectOverlap();
          a = parentOf.get(a) ?? null;
        }
      }
    }

    // Compute the next scope and groups.
    let nextIds: readonly string[];
    let nextGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
    if (command.included) {
      nextIds = Object.freeze([...priorIds, command.featureId]);
      nextGroups = priorGroups;
    } else {
      nextIds = Object.freeze(priorIds.filter((id) => id !== command.featureId));
      // Excluding a group member updates group membership in the same
      // transaction; a resulting singleton group dissolves (AR-19).
      nextGroups = Object.freeze(
        priorGroups
          .map((g) =>
            Object.freeze({
              featureIds: Object.freeze(g.featureIds.filter((id) => id !== command.featureId)),
            }),
          )
          .filter((g) => g.featureIds.length >= 2),
      );
    }

    // Excluding a Feature also clears any forecast-owned blocker on it, in the
    // same transaction; the ForecastScopeSet change carries both the prior and
    // next blocked sets so the cleanup is reported and fully reversible
    // (Story 20.1 AC5, AR-19). A delete/retype never reaches here — it leaves
    // a visible invalid reference until the PM explicitly excludes it.
    const priorBlocked = priorPlan?.blockedFeatureIds ?? [];
    const nextBlocked = command.included
      ? priorBlocked
      : priorBlocked.filter((id) => id !== command.featureId);

    let nextAssignments = priorPlan?.assignments;
    let clearedAssignments: readonly string[] | undefined;
    if (!command.included && priorPlan?.assignments?.[command.featureId]) {
      clearedAssignments = priorPlan.assignments[command.featureId];
      const copy = { ...priorPlan.assignments };
      delete copy[command.featureId];
      nextAssignments = copy;
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: nextIds,
        parallelGroups: nextGroups,
        blockedFeatureIds: nextBlocked,
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: nextAssignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastScopeSet' as const,
        selectedFeatureIds: nextIds,
        parallelGroups: nextGroups,
        priorSelectedFeatureIds: priorIds,
        priorParallelGroups: priorGroups,
        blockedFeatureIds: nextPlan.blockedFeatureIds,
        priorBlockedFeatureIds: priorBlocked,
        ...(clearedAssignments ? { clearedAssignments } : {}),
        ...(priorPlan?.assignments ? { priorAssignments: priorPlan.assignments } : {}),
        ...(nextAssignments ? { assignments: nextAssignments } : {}),
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 20: SetForecastBlocker (Story 20.1) ───────────────────────────
  // Marks or clears a forecast-owned blocker on one *included* Feature. The
  // blocker is never inferred from unlock edges, cycles, or delivery status
  // and adds no delay duration — it only makes an otherwise-complete numeric
  // result `conditional` (AR-12). A no-op (already blocked / already clear /
  // not in scope) is rejected rather than committed as an empty revision.

  #applySetForecastBlocker(command: SetForecastBlockerWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorBlocked = priorPlan?.blockedFeatureIds ?? [];
    const isBlocked = priorBlocked.includes(command.featureId);

    if (command.blocked) {
      // Only an included Feature can carry a blocker (AC 20.1-1).
      if (!priorIds.includes(command.featureId)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      }
      if (isBlocked) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_BLOCKER_INVALID',
          projectId: command.projectId,
          nodeId: command.featureId,
        });
      }
    } else if (!isBlocked) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_BLOCKER_INVALID',
        projectId: command.projectId,
        nodeId: command.featureId,
      });
    }

    const nextBlocked = command.blocked
      ? [...priorBlocked, command.featureId]
      : priorBlocked.filter((id) => id !== command.featureId);

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorIds,
        parallelGroups: priorPlan?.parallelGroups ?? [],
        blockedFeatureIds: nextBlocked,
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ForecastBlockerSet' as const,
            featureId: command.featureId,
            blocked: command.blocked,
            priorBlocked: isBlocked,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 20: Forecast scenarios (Story 20.4) ──────────────────────────
  // A saved scenario is a durable workflow fact — inputs only, never a
  // computed result (AD-22). CreateForecastScenario extracts the baseline
  // scope/config/groups/blocked set and the union fact map from THIS
  // snapshot at the previewed revision, atomically with its receipt and
  // revision (AR-22). Staleness is caught by the central revision check —
  // any forecast-fact change bumps the project revision, so a stale preview
  // fails REVISION_CONFLICT before this runs.

  #buildScenarioFactMap(projectId: string, ids: readonly string[]): Record<string, ScenarioFeatureFact> {
    const parentOf = new Map<string, string | null>();
    const typeOf = new Map<string, string | null>();
    const projectOf = new Map<string, string>();
    const effortOf = new Map<string, number | null>();
    for (const r of rows(this.db, 'SELECT id, parent_id, node_type, project_id, effort_points FROM nodes WHERE project_id = ?', [projectId])) {
      const id = String(r.id);
      parentOf.set(id, r.parent_id != null ? String(r.parent_id) : null);
      typeOf.set(id, r.node_type != null ? String(r.node_type) : null);
      projectOf.set(id, String(r.project_id));
      effortOf.set(id, r.effort_points != null ? Number(r.effort_points) : null);
    }
    const map: Record<string, ScenarioFeatureFact> = {};
    for (const id of new Set(ids)) {
      const exists = typeOf.has(id);
      const ancestors: string[] = [];
      const visited = new Set<string>([id]);
      let cur = parentOf.get(id) ?? null;
      while (cur !== null && !visited.has(cur)) {
        visited.add(cur);
        ancestors.push(cur);
        cur = parentOf.get(cur) ?? null;
      }
      map[id] = Object.freeze({
        effortPoints: exists ? effortOf.get(id) ?? null : null,
        // Story 21.9 AC 2: the fact records the node's ACTUAL type — not a
        // Feature-only boolean — so a Theme- or Component-level scenario
        // evaluates and diffs correctly.
        nodeType: exists ? (typeOf.get(id) ?? '') : '',
        projectId: exists ? projectOf.get(id) ?? '' : '',
        ancestorIds: Object.freeze(ancestors),
      });
    }
    return map;
  }

  #applyCreateForecastScenario(command: CreateForecastScenarioWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }
    // The preview must have been taken at the current revision (AC 20.4-2).
    if (command.baselineRevision !== currentRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_STALE', projectId: command.projectId });
    }
    if (readForecastScenario(this.db, command.scenarioId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_INVALID', projectId: command.projectId });
    }

    const plan = readForecastPlan(this.db, command.projectId);
    const orderedScope = plan?.selectedFeatureIds ?? [];
    const patchScope = command.patch.orderedScope ?? [];
    const assignedIds = plan?.policyVersion === 'staffed-capacity-v1' && plan.assignments ? Object.keys(plan.assignments) : [];
    const patchAssignedIds = command.patch.assignmentOverrides ? Object.keys(command.patch.assignmentOverrides) : [];
    const unionIds = [...new Set([...orderedScope, ...patchScope, ...assignedIds, ...patchAssignedIds])];
    const factMap = this.#buildScenarioFactMap(command.projectId, unionIds);
    // Story 21.9 AC 3: the estimate filter accepts members whose captured
    // type equals the plan's level — never a Feature-only boolean, which
    // dropped every estimate of a Theme- or Component-level scenario.
    const capturedLevel = plan?.planningLevel ?? 'Feature';

    const currentInputs: ForecastInputs = Object.freeze({
      projectId: command.projectId,
      projectRevision: currentRevision,
      policyVersion: plan?.policyVersion ?? 'shared-capacity-v1',
      selectedFeatureIds: Object.freeze([...orderedScope]),
      estimates: Object.freeze(Object.fromEntries(orderedScope.flatMap((id) => factMap[id]?.nodeType === capturedLevel ? [[id, factMap[id].effortPoints]] : []))),
      pointsPerSprint: plan?.configuration.pointsPerSprint ?? null,
      sprintLengthDays: plan?.configuration.sprintLengthDays ?? null,
      startSprintOrdinal: plan?.configuration.startSprintOrdinal ?? null,
      startDate: plan?.configuration.startDate ?? null,
      parallelGroups: Object.freeze([...(plan?.parallelGroups ?? [])]),
      blockedFeatureIds: Object.freeze([...(plan?.blockedFeatureIds ?? [])]),
      ...(plan?.policyVersion === 'staffed-capacity-v1' ? {
        roster: plan.roster,
        assignments: plan.assignments,
      } : {}),
    });
    if (computeForecastFingerprintSync(forecastMaterialFacts(currentInputs)) !== command.expectedMaterialFingerprint) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_STALE', projectId: command.projectId });
    }

    // Reject a patch that references a node that is not at the plan's level
    // in this project at save time — the PM must correct the selection first.
    for (const id of patchScope) {
      const f = factMap[id];
      if (!f || f.nodeType !== capturedLevel || f.projectId !== command.projectId) {
        return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_INVALID', projectId: command.projectId, nodeId: id });
      }
    }

    const scenario: PersistedForecastScenario = Object.freeze({
      scenarioId: command.scenarioId,
      projectId: command.projectId,
      label: command.label,
      baselineRevision: command.baselineRevision,
      baselineFingerprint: command.expectedMaterialFingerprint,
      policyVersion: plan?.policyVersion ?? 'shared-capacity-v1',
      createdAtISO: command.createdAtISO,
      baseline: Object.freeze({
        // Story 21.9 AC 1: the baseline records the level it was captured at.
        planningLevel: capturedLevel,
        orderedScope: Object.freeze([...orderedScope]),
        configuration: plan?.configuration ?? createForecastConfiguration({ pointsPerSprint: null, sprintLengthDays: null, startSprintOrdinal: null, startDate: null }),
        parallelGroups: Object.freeze((plan?.parallelGroups ?? []).map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }))),
        blockedFeatureIds: Object.freeze([...(plan?.blockedFeatureIds ?? [])]),
        factMap: Object.freeze(factMap),
        ...(plan?.policyVersion === 'staffed-capacity-v1' ? {
          roster: plan.roster ? Object.freeze(plan.roster.map((p) => Object.freeze({ id: p.id, name: p.name, weightUnits: p.weightUnits }))) : undefined,
          assignments: plan.assignments ? Object.freeze({ ...plan.assignments }) : undefined,
        } : {}),
      }),
      patch: command.patch,
    });

    if (!isPersistedForecastScenario(scenario, command.projectId)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_SCENARIO_INVALID',
        projectId: command.projectId,
      });
    }

    return this.#commitScenario(command, scenario, {
      type: 'ForecastScenarioCreated' as const,
      scenario,
    });
  }

  #applyRemoveForecastScenario(command: RemoveForecastScenarioWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }
    // Plan-touching scenario command: refuse a damaged plan before mutating
    // (Story 22.14 AC 22.14-1/-2).
    this.#requireReadableForecastPlan(command.projectId);
    const existing = readForecastScenario(this.db, command.scenarioId);
    if (!existing || existing.projectId !== command.projectId) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_NOT_FOUND', projectId: command.projectId });
    }
    return this.#commitScenario(command, null, {
      type: 'ForecastScenarioRemoved' as const,
      scenarioId: command.scenarioId,
      scenario: existing,
    }, command.scenarioId);
  }

  #applyRestoreForecastScenario(command: RestoreForecastScenarioWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }
    // Plan-touching scenario command: refuse a damaged plan before mutating
    // (Story 22.14 AC 22.14-1/-2).
    this.#requireReadableForecastPlan(command.projectId);
    if (!isPersistedForecastScenario(command.scenario, command.projectId) || readForecastScenario(this.db, command.scenario.scenarioId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCENARIO_INVALID', projectId: command.projectId });
    }
    return this.#commitScenario(command, command.scenario, {
      type: 'ForecastScenarioRestored' as const,
      scenario: command.scenario,
    });
  }

  /** Shared atomic write for the three scenario commands. */
  #commitScenario(
    command: CreateForecastScenarioWireCommand | RemoveForecastScenarioWireCommand | RestoreForecastScenarioWireCommand,
    scenarioToInsert: PersistedForecastScenario | null,
    change: NodeChange,
    scenarioToDelete?: string,
  ): ProductCommandResult {
    const __pmTxn = this.beginCommand();
    try {
      if (scenarioToDelete) deleteForecastScenario(this.db, scenarioToDelete);
      if (scenarioToInsert) insertForecastScenario(this.db, scenarioToInsert);

      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([change]),
      });
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)],
      });
      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 19: ReorderForecastFeatures (Story 19.2) ────────────────────────
  // Exact permutation of current selectedFeatureIds; group contiguity checked.
  // Splits are rejected with FORECAST_GROUP_SPLIT.

  #applyReorderForecastFeatures(command: ReorderForecastFeaturesWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];

    // Permutation check: lengths match, every id is in priorIds, no duplicate IDs.
    const newIdSet = new Set(command.featureIds);
    const isPermutation =
      command.featureIds.length === priorIds.length &&
      newIdSet.size === command.featureIds.length &&
      priorIds.every((id) => newIdSet.has(id));

    if (!isPermutation) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_SCOPE_INVALID',
        projectId: command.projectId,
      });
    }

    // Contiguity check for existing parallel groups:
    // Every group in priorGroups must remain contiguous in command.featureIds.
    for (const group of priorGroups) {
      const indices = group.featureIds.map((id) => command.featureIds.indexOf(id));
      const min = Math.min(...indices);
      const max = Math.max(...indices);
      if (max - min + 1 !== group.featureIds.length) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_GROUP_SPLIT',
          projectId: command.projectId,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: command.featureIds,
        parallelGroups: priorGroups,
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastOrderSet' as const,
        selectedFeatureIds: command.featureIds,
        priorSelectedFeatureIds: priorIds,
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  /** One revision advances both ordering facts, preventing split reorder/group writes. */
  #applySetForecastSequence(command: SetForecastSequenceWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];
    const ids = new Set(command.featureIds);
    if (command.featureIds.length !== priorIds.length || ids.size !== command.featureIds.length || !priorIds.every((id) => ids.has(id))) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCOPE_INVALID', projectId: command.projectId });
    }
    const seen = new Set<string>();
    const canonicalGroups: ForecastParallelGroup[] = [];
    for (const group of command.parallelGroups) {
      const members = group.featureIds;
      if (members.length < 2 || members.some((id) => !ids.has(id) || seen.has(id))) return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_GROUP_INVALID', projectId: command.projectId });
      for (const id of members) seen.add(id);
      const canonical = command.featureIds.filter((id) => members.includes(id));
      const first = command.featureIds.indexOf(canonical[0]);
      if (canonical.length !== members.length || canonical.some((id, index) => command.featureIds[first + index] !== id)) return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_GROUP_INVALID', projectId: command.projectId });
      canonicalGroups.push(Object.freeze({ featureIds: Object.freeze(canonical) }));
    }
    if (priorPlan?.policyVersion === 'staffed-capacity-v1') {
      const conflict = this.#findStaffingConcurrencyConflict(
        command.projectId,
        canonicalGroups,
        priorPlan.assignments,
        priorPlan.roster,
      );
      if (conflict) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_ASSIGNMENT_CONFLICT',
          personId: conflict.personId,
          conflictingFeatureIds: conflict.conflictingFeatureIds,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) insertEmptyForecastPlan(this.db, command.projectId);
      writeForecastPlan(this.db, createForecastPlan({ projectId: command.projectId, selectedFeatureIds: command.featureIds, parallelGroups: canonicalGroups, blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [], configuration: priorPlan?.configuration, policyVersion: priorPlan?.policyVersion, planningLevel: priorPlan?.planningLevel, roster: priorPlan?.roster, assignments: priorPlan?.assignments }));
      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });
      const changeSet: ChangeSet = Object.freeze({ protocolVersion: PROTOCOL_VERSION, projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision, changes: Object.freeze([{ type: 'ForecastSequenceSet' as const, selectedFeatureIds: command.featureIds, parallelGroups: canonicalGroups, priorSelectedFeatureIds: priorIds, priorParallelGroups: priorGroups }]) });
      const result: ProductCommandApplied = Object.freeze({ type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision, outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet });
      this.db.exec({ sql: 'INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)', bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)] });
      this.commitCommand(__pmTxn); return result;
    } catch (error) { try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ } throw error; }
  }

  // ── Epic 19: SetForecastParallelGroups (Story 19.2) ──────────────────────
  // Complete-set group replacement. Each group >= 2 members, in-scope, contiguous, disjoint.

  #applySetForecastParallelGroups(command: SetForecastParallelGroupsWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];

    const priorIdSet = new Set(priorIds);
    const seenGroupIds = new Set<string>();

    for (const group of command.parallelGroups) {
      if (group.featureIds.length < 2) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_GROUP_INVALID',
          projectId: command.projectId,
        });
      }

      // Check within-group duplicates, scope, and disjointness
      const groupSet = new Set<string>();
      for (const id of group.featureIds) {
        if (!priorIdSet.has(id) || groupSet.has(id) || seenGroupIds.has(id)) {
          return Object.freeze({
            type: 'ProductCommandRejected',
            protocolVersion: PROTOCOL_VERSION,
            commandId: command.commandId,
            code: 'FORECAST_GROUP_INVALID',
            projectId: command.projectId,
            nodeId: id,
          });
        }
        groupSet.add(id);
        seenGroupIds.add(id);
      }

      // Contiguity in current order:
      const indices = group.featureIds.map((id) => priorIds.indexOf(id));
      const min = Math.min(...indices);
      const max = Math.max(...indices);
      if (max - min + 1 !== group.featureIds.length) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_GROUP_INVALID',
          projectId: command.projectId,
        });
      }
    }

    if (priorPlan?.policyVersion === 'staffed-capacity-v1') {
      const conflict = this.#findStaffingConcurrencyConflict(
        command.projectId,
        command.parallelGroups,
        priorPlan.assignments,
        priorPlan.roster,
      );
      if (conflict) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_ASSIGNMENT_CONFLICT',
          personId: conflict.personId,
          conflictingFeatureIds: conflict.conflictingFeatureIds,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const canonicalGroups = command.parallelGroups.map((group) => Object.freeze({
        featureIds: Object.freeze(priorIds.filter((id) => group.featureIds.includes(id))),
      }));
      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorIds,
        parallelGroups: canonicalGroups,
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastParallelGroupsSet' as const,
        parallelGroups: canonicalGroups,
        priorParallelGroups: priorGroups,
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 19: RestoreForecastScope (Story 19.2) ───────────────────────────
  // Restores selectedFeatureIds and parallelGroups atomically.

  #applyRestoreForecastScope(command: RestoreForecastScopeWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];
    const priorBlocked = priorPlan?.blockedFeatureIds ?? [];

    // Selected feature IDs must be unique and exist as Feature nodes in project
    const idSet = new Set<string>();
    for (const id of command.selectedFeatureIds) {
      if (idSet.has(id)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: id,
        });
      }
      idSet.add(id);

      const nodeRow = rows(
        this.db,
        'SELECT node_type FROM nodes WHERE id = ? AND project_id = ?',
        [id, command.projectId],
      )[0];
      if (!nodeRow || nodeRow.node_type !== 'Feature') {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: id,
        });
      }
    }

    // Validate parallel groups
    const seenGroupIds = new Set<string>();
    for (const group of command.parallelGroups) {
      if (group.featureIds.length < 2) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_GROUP_INVALID',
          projectId: command.projectId,
        });
      }

      const groupSet = new Set<string>();
      for (const id of group.featureIds) {
        if (!idSet.has(id) || groupSet.has(id) || seenGroupIds.has(id)) {
          return Object.freeze({
            type: 'ProductCommandRejected',
            protocolVersion: PROTOCOL_VERSION,
            commandId: command.commandId,
            code: 'FORECAST_GROUP_INVALID',
            projectId: command.projectId,
            nodeId: id,
          });
        }
        groupSet.add(id);
        seenGroupIds.add(id);
      }

      // Contiguity in target order
      const indices = group.featureIds.map((id) => command.selectedFeatureIds.indexOf(id));
      const min = Math.min(...indices);
      const max = Math.max(...indices);
      if (max - min + 1 !== group.featureIds.length) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_GROUP_INVALID',
          projectId: command.projectId,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: command.selectedFeatureIds,
        parallelGroups: command.parallelGroups,
        blockedFeatureIds: command.blockedFeatureIds,
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: command.assignments ?? priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastScopeSet' as const,
        selectedFeatureIds: command.selectedFeatureIds,
        parallelGroups: command.parallelGroups,
        priorSelectedFeatureIds: priorIds,
        priorParallelGroups: priorGroups,
        blockedFeatureIds: nextPlan.blockedFeatureIds,
        priorBlockedFeatureIds: priorBlocked,
        ...(command.assignments ? { assignments: command.assignments } : {}),
        ...(priorPlan?.assignments ? { priorAssignments: priorPlan.assignments } : {}),
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 21: SetForecastPlanningLevel (Story 21.7, D4/D7) ────────────────
  // Switches the plan's planning level and atomically clears scope, parallel
  // groups, and blockers in one SQLite transaction and one ChangeSet (FR-13).
  // The inverse (RestoreForecastPlanningLevel) restores all four columns in a
  // single step so Undo returns the plan to its pre-switch state.

  #applySetForecastPlanningLevel(command: SetForecastPlanningLevelWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorLevel = priorPlan?.planningLevel ?? 'Feature';
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];
    const priorBlocked = priorPlan?.blockedFeatureIds ?? [];

    // A no-op switch (same level) is rejected rather than committed as an
    // empty revision.
    if (priorLevel === command.planningLevel) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_CONFIG_INVALID',
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: [],
        parallelGroups: [],
        blockedFeatureIds: [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: command.planningLevel,
        roster: priorPlan?.roster,
        assignments: {},
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastPlanningLevelSet' as const,
        planningLevel: command.planningLevel,
        priorPlanningLevel: priorLevel,
        selectedFeatureIds: nextPlan.selectedFeatureIds,
        parallelGroups: nextPlan.parallelGroups,
        blockedFeatureIds: nextPlan.blockedFeatureIds,
        priorSelectedFeatureIds: priorIds,
        priorParallelGroups: priorGroups,
        priorBlockedFeatureIds: priorBlocked,
        ...(priorPlan?.assignments ? { priorAssignments: priorPlan.assignments } : {}),
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyRestoreForecastPlanningLevel(command: RestoreForecastPlanningLevelWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorLevel = priorPlan?.planningLevel ?? 'Feature';

    // Validate the restored scope members exist at the restored level.
    const idSet = new Set<string>();
    for (const id of command.selectedFeatureIds) {
      if (idSet.has(id)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: id,
        });
      }
      idSet.add(id);
      const nodeRow = rows(
        this.db,
        'SELECT node_type FROM nodes WHERE id = ? AND project_id = ?',
        [id, command.projectId],
      )[0];
      if (!nodeRow || nodeRow.node_type !== command.planningLevel) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_SCOPE_INVALID',
          projectId: command.projectId,
          nodeId: id,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: command.selectedFeatureIds,
        parallelGroups: command.parallelGroups,
        blockedFeatureIds: command.blockedFeatureIds,
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: command.planningLevel,
        roster: priorPlan?.roster,
        assignments: command.assignments ?? priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastPlanningLevelSet' as const,
        planningLevel: command.planningLevel,
        priorPlanningLevel: priorLevel,
        selectedFeatureIds: nextPlan.selectedFeatureIds,
        parallelGroups: nextPlan.parallelGroups,
        blockedFeatureIds: nextPlan.blockedFeatureIds,
        priorSelectedFeatureIds: priorPlan?.selectedFeatureIds ?? [],
        priorParallelGroups: priorPlan?.parallelGroups ?? [],
        priorBlockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        ...(command.assignments ? { assignments: command.assignments } : {}),
        ...(priorPlan?.assignments ? { priorAssignments: priorPlan.assignments } : {}),
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 22: Forecast Roster Commands (Story 22.3) ───────────────────────

  #applyAddForecastPerson(command: AddForecastPersonWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    if (
      typeof command.name !== 'string' ||
      command.name.trim().length === 0 ||
      !Number.isSafeInteger(command.weightUnits) ||
      command.weightUnits <= 0
    ) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_INVALID',
        projectId: command.projectId,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    if (priorPlan?.roster.some((p) => p.id === command.personId)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_EXISTS',
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const newPerson: ForecastPerson = Object.freeze({
        id: command.personId,
        name: command.name.trim(),
        weightUnits: command.weightUnits,
      });

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan?.selectedFeatureIds ?? [],
        parallelGroups: priorPlan?.parallelGroups ?? [],
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: [...(priorPlan?.roster ?? []), newPerson],
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastPersonAdded' as const,
        projectId: command.projectId,
        person: newPerson,
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyUpdateForecastPerson(command: UpdateForecastPersonWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    if (
      typeof command.name !== 'string' ||
      command.name.trim().length === 0 ||
      !Number.isSafeInteger(command.weightUnits) ||
      command.weightUnits <= 0
    ) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_INVALID',
        projectId: command.projectId,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const existing = priorPlan?.roster.find((p) => p.id === command.personId);
    if (!existing) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      const updatedRoster = priorPlan!.roster.map((p) =>
        p.id === command.personId
          ? Object.freeze({ id: p.id, name: command.name.trim(), weightUnits: command.weightUnits })
          : p,
      );

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan!.selectedFeatureIds,
        parallelGroups: priorPlan!.parallelGroups,
        blockedFeatureIds: priorPlan!.blockedFeatureIds,
        configuration: priorPlan!.configuration,
        policyVersion: priorPlan!.policyVersion,
        planningLevel: priorPlan!.planningLevel,
        roster: updatedRoster,
        assignments: priorPlan!.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ForecastPersonUpdated' as const,
            projectId: command.projectId,
            personId: command.personId,
            name: command.name.trim(),
            weightUnits: command.weightUnits,
            priorName: existing.name,
            priorWeightUnits: existing.weightUnits,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyRemoveForecastPerson(command: RemoveForecastPersonWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const existing = priorPlan?.roster.find((p) => p.id === command.personId);
    if (!existing) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_NOT_FOUND',
        projectId: command.projectId,
      });
    }

    const nextRoster = priorPlan!.roster.filter((p) => p.id !== command.personId);
    const nextAssignments: Record<string, readonly string[]> = {};
    for (const [fId, pList] of Object.entries(priorPlan!.assignments ?? {})) {
      const filtered = pList.filter((id) => id !== command.personId);
      if (filtered.length > 0) {
        nextAssignments[fId] = Object.freeze(filtered);
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan!.selectedFeatureIds,
        parallelGroups: priorPlan!.parallelGroups,
        blockedFeatureIds: priorPlan!.blockedFeatureIds,
        configuration: priorPlan!.configuration,
        policyVersion: priorPlan!.policyVersion,
        planningLevel: priorPlan!.planningLevel,
        roster: nextRoster,
        assignments: nextAssignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ForecastPersonRemoved' as const,
            projectId: command.projectId,
            person: existing,
            ...(priorPlan!.assignments ? { priorAssignments: priorPlan!.assignments } : {}),
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applyRestoreForecastPerson(command: RestoreForecastPersonWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    if (
      !command.person ||
      typeof command.person.id !== 'string' ||
      typeof command.person.name !== 'string' ||
      command.person.name.trim().length === 0 ||
      !Number.isSafeInteger(command.person.weightUnits) ||
      command.person.weightUnits <= 0
    ) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_INVALID',
        projectId: command.projectId,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    if (priorPlan?.roster.some((p) => p.id === command.person.id)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_PERSON_EXISTS',
        projectId: command.projectId,
      });
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const restoredPerson: ForecastPerson = Object.freeze({
        id: command.person.id,
        name: command.person.name.trim(),
        weightUnits: command.person.weightUnits,
      });

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan?.selectedFeatureIds ?? [],
        parallelGroups: priorPlan?.parallelGroups ?? [],
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: [...(priorPlan?.roster ?? []), restoredPerson],
        assignments: command.assignments ?? priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastPersonRestored' as const,
        projectId: command.projectId,
        person: restoredPerson,
        ...(command.assignments ? { assignments: command.assignments } : {}),
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── Epic 22: Staffing Assignments and Policy (Story 22.4) ─────────────────

  #findStaffingConcurrencyConflict(
    projectId: string,
    groups: readonly Readonly<{ featureIds: readonly string[] }>[],
    assignments: Readonly<Record<string, readonly string[]>> | undefined,
    roster: readonly ForecastPerson[],
  ): { personId: string; conflictingFeatureIds: readonly string[] } | null {
    if (!assignments || roster.length === 0 || groups.length === 0) {
      return null;
    }

    const effortCache = new Map<string, number | null>();
    const getEffort = (featureId: string): number | null => {
      if (effortCache.has(featureId)) return effortCache.get(featureId)!;
      const r = rows(this.db, 'SELECT effort_points FROM nodes WHERE id = ? AND project_id = ?', [featureId, projectId])[0];
      const pts = r && r.effort_points !== null && r.effort_points !== undefined ? Number(r.effort_points) : null;
      effortCache.set(featureId, pts);
      return pts;
    };

    for (const group of groups) {
      for (const person of roster) {
        const conflicting: string[] = [];
        for (const featureId of group.featureIds) {
          const assignedPersons = assignments[featureId];
          if (assignedPersons && assignedPersons.includes(person.id)) {
            const effort = getEffort(featureId);
            if (effort !== null && effort > 0) {
              conflicting.push(featureId);
            }
          }
        }
        if (conflicting.length > 1) {
          return { personId: person.id, conflictingFeatureIds: Object.freeze(conflicting) };
        }
      }
    }

    return null;
  }

  #applySetForecastAssignments(command: SetForecastAssignmentsWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    if (!priorPlan?.selectedFeatureIds.includes(command.featureId)) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_SCOPE_INVALID',
        projectId: command.projectId,
        nodeId: command.featureId,
      });
    }

    const nodeRow = rows(
      this.db,
      'SELECT effort_points FROM nodes WHERE id = ? AND project_id = ?',
      [command.featureId, command.projectId],
    )[0];

    if (!nodeRow) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_SCOPE_INVALID',
        projectId: command.projectId,
        nodeId: command.featureId,
      });
    }

    const effort = nodeRow.effort_points !== null && nodeRow.effort_points !== undefined
      ? Number(nodeRow.effort_points)
      : null;

    if (effort === 0 && command.personIds.length > 0) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_ASSIGNMENT_ZERO_WORK',
        featureId: command.featureId,
      });
    }

    // Check for duplicate personIds
    if (new Set(command.personIds).size !== command.personIds.length) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_ASSIGNMENT_INVALID',
        projectId: command.projectId,
      });
    }

    // Check all personIds belong to roster
    for (const pid of command.personIds) {
      if (!priorPlan.roster.some((p) => p.id === pid)) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_ASSIGNMENT_INVALID',
          personId: pid,
        });
      }
    }

    const priorPersonIds = priorPlan.assignments?.[command.featureId] ?? [];
    const nextAssignments = { ...priorPlan.assignments };
    if (command.personIds.length > 0) {
      nextAssignments[command.featureId] = command.personIds;
    } else {
      delete nextAssignments[command.featureId];
    }

    // In staffed mode, check for parallel bucket concurrency conflict
    if (priorPlan.policyVersion === 'staffed-capacity-v1') {
      const conflict = this.#findStaffingConcurrencyConflict(
        command.projectId,
        priorPlan.parallelGroups,
        nextAssignments,
        priorPlan.roster,
      );
      if (conflict) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_ASSIGNMENT_CONFLICT',
          personId: conflict.personId,
          conflictingFeatureIds: conflict.conflictingFeatureIds,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan.selectedFeatureIds,
        parallelGroups: priorPlan.parallelGroups,
        blockedFeatureIds: priorPlan.blockedFeatureIds,
        configuration: priorPlan.configuration,
        policyVersion: priorPlan.policyVersion,
        planningLevel: priorPlan.planningLevel,
        roster: priorPlan.roster,
        assignments: nextAssignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([
          {
            type: 'ForecastAssignmentsSet' as const,
            projectId: command.projectId,
            featureId: command.featureId,
            personIds: command.personIds,
            priorPersonIds,
          },
        ]),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  #applySetForecastPolicy(command: SetForecastPolicyWireCommand): ProductCommandResult {
    const project = rows(
      this.db,
      'SELECT id, revision FROM projects WHERE id = ?',
      [command.projectId],
    )[0];

    if (!project) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'PROJECT_NOT_FOUND',
      });
    }

    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'REVISION_CONFLICT',
        expectedRevision: currentRevision,
      });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorPolicy = priorPlan?.policyVersion ?? 'shared-capacity-v1';

    if (priorPolicy === command.policyVersion) {
      return Object.freeze({
        type: 'ProductCommandRejected',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        code: 'FORECAST_POLICY_INVALID',
        projectId: command.projectId,
      });
    }

    // When switching to staffed mode, validate retained assignments against parallel groups
    if (command.policyVersion === 'staffed-capacity-v1' && priorPlan) {
      const conflict = this.#findStaffingConcurrencyConflict(
        command.projectId,
        priorPlan.parallelGroups,
        priorPlan.assignments,
        priorPlan.roster,
      );
      if (conflict) {
        return Object.freeze({
          type: 'ProductCommandRejected',
          protocolVersion: PROTOCOL_VERSION,
          commandId: command.commandId,
          code: 'FORECAST_ASSIGNMENT_CONFLICT',
          personId: conflict.personId,
          conflictingFeatureIds: conflict.conflictingFeatureIds,
        });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) {
        insertEmptyForecastPlan(this.db, command.projectId);
      }

      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan?.selectedFeatureIds ?? [],
        parallelGroups: priorPlan?.parallelGroups ?? [],
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: command.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      });
      writeForecastPlan(this.db, nextPlan);

      this.db.exec({
        sql: 'UPDATE projects SET revision = ? WHERE id = ?',
        bind: [command.expectedRevision, command.projectId],
      });

      const changes: NodeChange[] = [];
      if (!priorPlan) {
        changes.push({
          type: 'ForecastPlanCreated' as const,
          projectId: command.projectId,
        });
      }
      changes.push({
        type: 'ForecastPolicySet' as const,
        projectId: command.projectId,
        policyVersion: command.policyVersion,
        priorPolicyVersion: priorPolicy,
      });

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });

      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied',
        protocolVersion: PROTOCOL_VERSION,
        commandId: command.commandId,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted',
        disposition: 'NewCommit',
        changeSet,
      });

      this.db.exec({
        sql: `INSERT INTO product_command_receipt(
                command_id, project_id, command_type, base_revision, target_revision, result_json
              ) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.type,
          command.baseRevision,
          command.expectedRevision,
          JSON.stringify(result),
        ],
      });

      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── SetForecastAssignment (Story 27.2, D8(d)) ─────────────────────

  /**
   * Assign or unassign one roster person on one forecast item. Single-person
   * delta; produces the same `ForecastAssignmentsSet` ChangeSet (final set for
   * the item) the whole-list command produced, so projections/undo are
   * unchanged.
   */
  #applySetForecastAssignment(command: SetForecastAssignmentWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    if (!priorPlan?.selectedFeatureIds.includes(command.featureId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCOPE_INVALID', projectId: command.projectId, nodeId: command.featureId });
    }

    const nodeRow = rows(this.db, 'SELECT effort_points FROM nodes WHERE id = ? AND project_id = ?', [command.featureId, command.projectId])[0];
    if (!nodeRow) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCOPE_INVALID', projectId: command.projectId, nodeId: command.featureId });
    }
    const effort = nodeRow.effort_points !== null && nodeRow.effort_points !== undefined ? Number(nodeRow.effort_points) : null;

    if (!priorPlan.roster.some((p) => p.id === command.personId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_ASSIGNMENT_INVALID', personId: command.personId });
    }

    const priorPersonIds = priorPlan.assignments?.[command.featureId] ?? [];
    const isAssigned = priorPersonIds.includes(command.personId);
    if (command.assigned === isAssigned) {
      // No-op: refuse rather than advance a revision for nothing.
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_ASSIGNMENT_INVALID', projectId: command.projectId });
    }
    if (command.assigned && effort === 0) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_ASSIGNMENT_ZERO_WORK', featureId: command.featureId });
    }

    const nextPersonIds = command.assigned
      ? [...priorPersonIds, command.personId]
      : priorPersonIds.filter((id) => id !== command.personId);
    const nextAssignments = { ...priorPlan.assignments };
    if (nextPersonIds.length > 0) nextAssignments[command.featureId] = nextPersonIds;
    else delete nextAssignments[command.featureId];

    if (priorPlan.policyVersion === 'staffed-capacity-v1') {
      const conflict = this.#findStaffingConcurrencyConflict(command.projectId, priorPlan.parallelGroups, nextAssignments, priorPlan.roster);
      if (conflict) {
        return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_ASSIGNMENT_CONFLICT', personId: conflict.personId, conflictingFeatureIds: conflict.conflictingFeatureIds });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      const nextPlan = createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: priorPlan.selectedFeatureIds,
        parallelGroups: priorPlan.parallelGroups,
        blockedFeatureIds: priorPlan.blockedFeatureIds,
        configuration: priorPlan.configuration,
        policyVersion: priorPlan.policyVersion,
        planningLevel: priorPlan.planningLevel,
        roster: priorPlan.roster,
        assignments: nextAssignments,
      });
      writeForecastPlan(this.db, nextPlan);
      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });
      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze([{ type: 'ForecastAssignmentsSet' as const, projectId: command.projectId, featureId: command.featureId, personIds: Object.freeze([...nextPersonIds]), priorPersonIds: Object.freeze([...priorPersonIds]) }]),
      });
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId,
        projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet,
      });
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)],
      });
      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }

  // ── MoveForecastFeature (Story 27.2, D8(c), R3) ───────────────────

  /**
   * Move one scope member in forecast priority order, with an optional group
   * change, using after/before anchors. Single-move replacement for the
   * whole-list `SetForecastSequence`. Produces `ForecastOrderSet` and (on a
   * group change) `ForecastParallelGroupsSet` so existing projections/undo are
   * unchanged.
   */
  #applyMoveForecastFeature(command: MoveForecastFeatureWireCommand): ProductCommandResult {
    const project = rows(this.db, 'SELECT id, revision FROM projects WHERE id = ?', [command.projectId])[0];
    if (!project) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'PROJECT_NOT_FOUND' });
    }
    const currentRevision = Number(project.revision);
    if (currentRevision !== command.baseRevision) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'REVISION_CONFLICT', expectedRevision: currentRevision });
    }

    const priorPlan = readForecastPlan(this.db, command.projectId);
    const priorIds = priorPlan?.selectedFeatureIds ?? [];
    const priorGroups = priorPlan?.parallelGroups ?? [];
    if (!priorIds.includes(command.featureId)) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_SCOPE_INVALID', projectId: command.projectId, nodeId: command.featureId });
    }

    const moved = applyAnchoredMove(priorIds, command.featureId, {
      afterId: command.afterId,
      beforeId: command.beforeId,
      intendedIndex: command.intendedIndex,
    });
    if (moved.kind === 'SelfAnchor' || !moved.ids) {
      return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_GROUP_INVALID', projectId: command.projectId, nodeId: command.featureId });
    }
    const nextIds = moved.ids;

    // Rebuild groups in the new order following the group change.
    let nextGroups: ForecastParallelGroup[];
    if (command.groupChange.kind === 'join') {
      const partner = command.groupChange.partnerId;
      if (partner === command.featureId || !nextIds.includes(partner)) {
        return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_GROUP_INVALID', projectId: command.projectId, nodeId: partner });
      }
      // Drop the mover from any prior group, then place it with the partner's
      // contiguous neighbours.
      const rebuilt: ForecastParallelGroup[] = [];
      for (const g of priorGroups) {
        const kept = g.featureIds.filter((id) => id !== command.featureId);
        if (kept.length >= 2) rebuilt.push(Object.freeze({ featureIds: Object.freeze([...kept]) }));
      }
      const partnerGroup = rebuilt.find((g) => g.featureIds.includes(partner));
      if (partnerGroup) {
        rebuilt.splice(rebuilt.indexOf(partnerGroup), 1, Object.freeze({ featureIds: Object.freeze([...partnerGroup.featureIds, command.featureId]) }));
      } else {
        rebuilt.push(Object.freeze({ featureIds: Object.freeze([partner, command.featureId]) }));
      }
      nextGroups = rebuilt;
    } else if (command.groupChange.kind === 'leave') {
      nextGroups = [];
      for (const g of priorGroups) {
        const kept = g.featureIds.filter((id) => id !== command.featureId);
        if (kept.length >= 2) nextGroups.push(Object.freeze({ featureIds: Object.freeze([...kept]) }));
      }
    } else {
      nextGroups = priorGroups.map((g) => Object.freeze({ featureIds: Object.freeze([...g.featureIds]) }));
    }

    // Contiguity repair: a group the move split keeps only its contiguous run
    // around the first member; groups with <2 survivors dissolve (the wire
    // contract rejects singleton groups, Story 21.3 AC 10).
    const canonicalized: ForecastParallelGroup[] = [];
    for (const g of nextGroups) {
      const members = new Set(g.featureIds);
      const positions = nextIds
        .map((id, index) => (members.has(id) ? index : -1))
        .filter((index) => index !== -1);
      if (positions.length < 2) continue;
      const run: string[] = [];
      for (let i = 0; i < positions.length; i += 1) {
        if (positions[i] !== positions[0] + i) break;
        run.push(nextIds[positions[i]]);
      }
      if (run.length >= 2) canonicalized.push(Object.freeze({ featureIds: Object.freeze([...run]) }));
    }

    if (priorPlan?.policyVersion === 'staffed-capacity-v1') {
      const conflict = this.#findStaffingConcurrencyConflict(command.projectId, canonicalized, priorPlan.assignments, priorPlan.roster);
      if (conflict) {
        return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId, code: 'FORECAST_ASSIGNMENT_CONFLICT', personId: conflict.personId, conflictingFeatureIds: conflict.conflictingFeatureIds });
      }
    }

    const __pmTxn = this.beginCommand();
    try {
      if (!priorPlan) insertEmptyForecastPlan(this.db, command.projectId);
      writeForecastPlan(this.db, createForecastPlan({
        projectId: command.projectId,
        selectedFeatureIds: nextIds,
        parallelGroups: canonicalized,
        blockedFeatureIds: priorPlan?.blockedFeatureIds ?? [],
        configuration: priorPlan?.configuration,
        policyVersion: priorPlan?.policyVersion,
        planningLevel: priorPlan?.planningLevel,
        roster: priorPlan?.roster,
        assignments: priorPlan?.assignments,
      }));
      this.db.exec({ sql: 'UPDATE projects SET revision = ? WHERE id = ?', bind: [command.expectedRevision, command.projectId] });

      const changes: NodeChange[] = [];
      if (!priorPlan) changes.push({ type: 'ForecastPlanCreated' as const, projectId: command.projectId });
      // `priorMove` makes undo a single move (AC 27.2-3); order change first so
      // the inverse policy selects it. A group change is a second record.
      const priorIdx = priorIds.indexOf(command.featureId);
      changes.push({
        type: 'ForecastOrderSet' as const,
        selectedFeatureIds: Object.freeze([...nextIds]),
        priorSelectedFeatureIds: Object.freeze([...priorIds]),
        priorMove: Object.freeze({
          featureId: command.featureId,
          afterId: priorIdx > 0 ? priorIds[priorIdx - 1] : null,
          beforeId: priorIdx < priorIds.length - 1 ? priorIds[priorIdx + 1] : null,
          intendedIndex: priorIdx < 0 ? 0 : priorIdx,
          groupChange: inverseGroupChange(command.groupChange, priorGroups, command.featureId),
        }),
      });
      if (command.groupChange.kind !== 'unchanged') {
        changes.push({ type: 'ForecastParallelGroupsSet' as const, parallelGroups: Object.freeze(canonicalized.map((g) => Object.freeze({ featureIds: g.featureIds }))), priorParallelGroups: Object.freeze(priorGroups.map((g) => Object.freeze({ featureIds: g.featureIds }))) });
      }

      const changeSet: ChangeSet = Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        targetRevision: command.expectedRevision,
        changes: Object.freeze(changes),
      });
      const result: ProductCommandApplied = Object.freeze({
        type: 'ProductCommandApplied', protocolVersion: PROTOCOL_VERSION, commandId: command.commandId,
        projectId: command.projectId, baseRevision: command.baseRevision, targetRevision: command.expectedRevision,
        outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet,
      });
      this.db.exec({
        sql: `INSERT INTO product_command_receipt(command_id, project_id, command_type, base_revision, target_revision, result_json) VALUES(?, ?, ?, ?, ?, ?)`,
        bind: [command.commandId, command.projectId, command.type, command.baseRevision, command.expectedRevision, JSON.stringify(result)],
      });
      this.commitCommand(__pmTxn);
      return result;
    } catch (error) {
      try { this.rollbackCommand(__pmTxn); } catch { /* preserve */ }
      throw error;
    }
  }
}

/** The terminal result recorded for a gesture member refused because another member was. */
function groupRefusal(command: ProductCommand): ProductCommandResult {
  return Object.freeze({ type: 'ProductCommandRejected', protocolVersion: command.protocolVersion, commandId: command.commandId, projectId: command.projectId, code: 'ATOMIC_GROUP_REJECTED' }) as ProductCommandResult;
}

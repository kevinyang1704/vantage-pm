import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import { commandApplied, repositoryRejected, validateCommandApplied, type ApplyCommandRequest, type RepositoryResponse } from './repository-protocol';

type Row = Record<string, SqlValue>;

export type LedgerInspection = Readonly<{
  quickCheck: string;
  mutationCount: number;
  authoredFactCount: number;
  workflowFactCount: number;
  fixtureAuthoredFactCount: number;
  fixtureWorkflowFactCount: number;
  commandReceiptCount: number;
  recordedResultCount: number;
  storedRevision: number;
  nextRevision: number;
  recordedResultHash: string | null;
  recordedBaseRevision: number;
  recordedTargetRevision: number;
  safeValueHash: string;
  partialMutation: boolean;
  semanticState: string;
}>;

export type StartupRecovery = Readonly<{
  quickCheck: 'ok';
  authoritativeRevision: number;
  writerEpoch: number;
  receiptCount: number;
  resultCount: number;
}>;

export type LedgerChainRecord = Readonly<{
  commandId: string;
  projectId: string;
  baseRevision: number;
  targetRevision: number;
  safeValueHash: string;
  resultJson: string;
  safeResultHash: string;
  receiptProjectId: string | null;
  appliedRevision: number;
  resultCode: string | null;
  receiptSafeResultHash: string | null;
}>;

export function validateCanonicalLedgerChain(input: Readonly<{
  projectId: string;
  initialRevision: number;
  initialSafeStateHash: string;
  authoritativeRevision: number;
  authoritativeSafeStateHash: string;
  mutationCount: number;
  receiptCount: number;
  orphanReceiptCount: number;
  records: readonly LedgerChainRecord[];
}>): void {
  let expectedBase = input.initialRevision;
  let expectedStateHash = input.initialSafeStateHash;
  for (const row of input.records) {
    if (row.baseRevision !== expectedBase || row.targetRevision !== row.baseRevision + 1) {
      throw new Error('RECONCILIATION_FAILED:NON_CONTIGUOUS_REVISION_CHAIN');
    }
    if (
      row.receiptProjectId !== input.projectId || row.appliedRevision !== row.targetRevision ||
      row.resultCode !== 'VFS_COMMIT_ACCEPTED' || row.receiptSafeResultHash !== row.safeResultHash ||
      row.safeResultHash !== row.safeValueHash
    ) throw new Error('RECONCILIATION_FAILED:RECEIPT_RESULT_MISMATCH');
    let parsed: unknown;
    try { parsed = JSON.parse(row.resultJson); }
    catch { throw new Error('RECONCILIATION_FAILED:CANONICAL_RESULT_JSON_INVALID'); }
    const canonical = validateCommandApplied(parsed);
    if (
      JSON.stringify(canonical) !== row.resultJson || canonical.commandId !== row.commandId ||
      canonical.projectId !== input.projectId || canonical.baseRevision !== row.baseRevision ||
      canonical.targetRevision !== row.targetRevision || canonical.repositoryResult.safeValueHash !== row.safeValueHash ||
      canonical.repositoryResult.resultingRevision !== row.targetRevision ||
      canonical.receipt.appliedRevision !== row.targetRevision || canonical.receipt.commandId !== row.commandId ||
      canonical.receipt.projectId !== input.projectId || canonical.disposition !== 'NewCommit'
    ) throw new Error('RECONCILIATION_FAILED:CANONICAL_RESULT_MISMATCH');
    expectedBase = row.targetRevision;
    expectedStateHash = row.safeValueHash;
  }
  if (
    input.orphanReceiptCount !== 0 || input.records.length !== input.receiptCount ||
    input.records.length !== input.mutationCount || input.authoritativeRevision !== expectedBase ||
    input.authoritativeSafeStateHash !== expectedStateHash
  ) throw new Error('RECONCILIATION_FAILED:AUTHORITATIVE_STATE_MISMATCH');
}

function rows(db: Database, sql: string, bind?: readonly SqlValue[]): Row[] {
  return db.exec({ sql, ...(bind ? { bind } : {}), rowMode: 'object', returnValue: 'resultRows' }) as Row[];
}

function integer(value: SqlValue | undefined): number {
  return Number(value ?? 0);
}

export class SqliteRepositoryLedger {
  constructor(private readonly db: Database) {}

  initializeFixture(projectId: string, initialRevision: number, safeStateHash: string, existingDatabase = false): void {
    if (existingDatabase) {
      const required = new Set(['project_state', 'authored_fact', 'workflow_fact', 'command_result', 'command_receipt']);
      for (const row of rows(this.db, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
        required.delete(String(row.name));
      }
      if (required.size) throw new Error(`LEDGER_SCHEMA_MISSING_ON_RESTART:${[...required].sort().join(',')}`);
      const state = rows(this.db, 'SELECT 1 AS present FROM project_state WHERE project_id = ?', [projectId])[0];
      if (!state) throw new Error('FIXTURE_MISSING_ON_RESTART');
      this.db.exec(`CREATE TABLE IF NOT EXISTS repository_meta(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 0)
      )`);
      this.db.exec(`INSERT OR IGNORE INTO repository_meta(singleton, writer_epoch) VALUES(1, 0)`);
      return;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_state(
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK(revision >= 0),
        safe_value_hash TEXT NOT NULL,
        mutation_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS authored_fact(
        project_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        safe_fact_hash TEXT NOT NULL,
        PRIMARY KEY(project_id, fact_id),
        FOREIGN KEY(project_id) REFERENCES project_state(project_id)
      );
      CREATE TABLE IF NOT EXISTS workflow_fact(
        project_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        safe_fact_hash TEXT NOT NULL,
        PRIMARY KEY(project_id, fact_id),
        FOREIGN KEY(project_id) REFERENCES project_state(project_id)
      );
      CREATE TABLE IF NOT EXISTS command_result(
        command_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        target_revision INTEGER NOT NULL,
        safe_value_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        safe_result_hash TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES project_state(project_id)
      );
      CREATE TABLE IF NOT EXISTS command_receipt(
        command_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        applied_revision INTEGER NOT NULL,
        result_code TEXT NOT NULL CHECK(result_code = 'VFS_COMMIT_ACCEPTED'),
        safe_result_hash TEXT NOT NULL,
        FOREIGN KEY(command_id) REFERENCES command_result(command_id),
        FOREIGN KEY(project_id) REFERENCES project_state(project_id)
      );
      CREATE TABLE IF NOT EXISTS repository_meta(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        writer_epoch INTEGER NOT NULL CHECK(writer_epoch >= 0)
      );
    `);
    this.db.exec(`INSERT OR IGNORE INTO repository_meta(singleton, writer_epoch) VALUES(1, 0)`);
    this.db.exec({
      sql: `INSERT OR IGNORE INTO project_state(project_id, revision, safe_value_hash, mutation_count)
            VALUES(?, ?, ?, 0)`,
      bind: [projectId, initialRevision, safeStateHash],
    });
  }

  recoverStartup(projectId: string, fixture: { initialRevision: number; safeStateHash: string }): StartupRecovery {
    const quickCheck = String(rows(this.db, 'PRAGMA quick_check')[0]?.quick_check ?? 'missing');
    if (quickCheck !== 'ok') throw new Error(`INTEGRITY_CHECK_FAILED:${quickCheck}`);
    const state = rows(this.db, 'SELECT revision, safe_value_hash, mutation_count FROM project_state WHERE project_id = ?', [projectId])[0];
    if (!state) throw new Error('RECONCILIATION_FAILED:PROJECT_STATE_MISSING');
    const chain = rows(
      this.db,
      `SELECT r.command_id, r.project_id, r.base_revision, r.target_revision, r.safe_value_hash,
              r.result_json, r.safe_result_hash, c.project_id AS receipt_project_id,
              c.applied_revision, c.result_code, c.safe_result_hash AS receipt_safe_result_hash
       FROM command_result r
       LEFT JOIN command_receipt c ON c.command_id = r.command_id
       WHERE r.project_id = ?
       ORDER BY r.target_revision, r.command_id`,
      [projectId],
    );
    const orphanReceipts = integer(rows(
      this.db,
      `SELECT count(*) AS orphan_count FROM command_receipt c
       LEFT JOIN command_result r ON r.command_id = c.command_id
       WHERE c.project_id = ? AND r.command_id IS NULL`,
      [projectId],
    )[0]?.orphan_count);
    const resultCount = chain.length;
    const receiptCount = integer(rows(this.db, 'SELECT count(*) AS count FROM command_receipt WHERE project_id = ?', [projectId])[0]?.count);
    const authoritativeRevision = integer(state.revision);
    validateCanonicalLedgerChain({
      projectId, initialRevision: fixture.initialRevision, initialSafeStateHash: fixture.safeStateHash,
      authoritativeRevision, authoritativeSafeStateHash: String(state.safe_value_hash),
      mutationCount: integer(state.mutation_count), receiptCount, orphanReceiptCount: orphanReceipts,
      records: chain.map((row) => ({
        commandId: String(row.command_id), projectId: String(row.project_id),
        baseRevision: integer(row.base_revision), targetRevision: integer(row.target_revision),
        safeValueHash: String(row.safe_value_hash), resultJson: String(row.result_json), safeResultHash: String(row.safe_result_hash),
        receiptProjectId: row.receipt_project_id == null ? null : String(row.receipt_project_id),
        appliedRevision: integer(row.applied_revision), resultCode: row.result_code == null ? null : String(row.result_code),
        receiptSafeResultHash: row.receipt_safe_result_hash == null ? null : String(row.receipt_safe_result_hash),
      })),
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('UPDATE repository_meta SET writer_epoch = writer_epoch + 1 WHERE singleton = 1');
      if (this.db.changes() !== 1) throw new Error('RECONCILIATION_FAILED:WRITER_EPOCH_MISSING');
      const writerEpoch = integer(rows(this.db, 'SELECT writer_epoch FROM repository_meta WHERE singleton = 1')[0]?.writer_epoch);
      this.db.exec('COMMIT');
      return {
        quickCheck: 'ok',
        authoritativeRevision,
        writerEpoch,
        receiptCount,
        resultCount,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original recovery failure */ }
      throw error;
    }
  }

  closeStatements(): void {
    // Statements are prepared per call by oo1.exec, so the queue is empty at this boundary.
  }

  apply(request: ApplyCommandRequest): RepositoryResponse {
    const { command } = request;
    const prior = rows(
      this.db,
      `SELECT project_id, base_revision, target_revision, safe_value_hash, result_json
       FROM command_result WHERE command_id = ?`,
      [command.commandId],
    )[0];
    if (prior) {
      const identityMatches =
        prior.project_id === command.projectId &&
        integer(prior.base_revision) === command.baseRevision &&
        integer(prior.target_revision) === command.expectedRevision &&
        prior.safe_value_hash === command.safeValueHash;
      if (!identityMatches) return repositoryRejected(request.requestId, 'COMMAND_IDENTITY_CONFLICT', undefined, request);
      const stored = validateCommandApplied(JSON.parse(String(prior.result_json)));
      return {
        ...stored,
        requestId: request.requestId,
        contextId: request.contextId,
        ownerSessionId: request.ownerSessionId,
        writerEpoch: request.writerEpoch,
        disposition: 'StoredResultReturned',
      };
    }

    const state = rows(this.db, 'SELECT revision FROM project_state WHERE project_id = ?', [command.projectId])[0];
    const expectedRevision = state ? integer(state.revision) : 0;
    if (!state || expectedRevision !== command.baseRevision) {
      return repositoryRejected(request.requestId, 'REVISION_CONFLICT', expectedRevision, request);
    }

    const response = commandApplied(request);
    const canonical = JSON.stringify(response);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec({
        sql: `UPDATE project_state
              SET revision = ?, safe_value_hash = ?, mutation_count = mutation_count + 1
              WHERE project_id = ? AND revision = ?`,
        bind: [command.expectedRevision, command.safeValueHash, command.projectId, command.baseRevision],
      });
      if (this.db.changes() !== 1) throw new Error('REVISION_CHANGED_DURING_TRANSACTION');
      this.db.exec({
        sql: `INSERT INTO command_result(
                command_id, project_id, base_revision, target_revision, safe_value_hash, result_json, safe_result_hash
              ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          command.commandId,
          command.projectId,
          command.baseRevision,
          command.expectedRevision,
          command.safeValueHash,
          canonical,
          command.safeValueHash,
        ],
      });
      this.db.exec({
        sql: `INSERT INTO command_receipt(command_id, project_id, applied_revision, result_code, safe_result_hash)
              VALUES(?, ?, ?, 'VFS_COMMIT_ACCEPTED', ?)`,
        bind: [command.commandId, command.projectId, command.expectedRevision, command.safeValueHash],
      });
      this.db.exec('COMMIT');
      return response;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  inspect(projectId: string, commandId: string, fixture: { initialRevision: number; safeStateHash: string }): LedgerInspection {
    const quickCheck = String(rows(this.db, 'PRAGMA quick_check')[0]?.quick_check ?? 'missing');
    const state = rows(
      this.db,
      `SELECT revision, safe_value_hash, mutation_count FROM project_state WHERE project_id = ?`,
      [projectId],
    )[0];
    const counts = rows(
      this.db,
      `SELECT
         (SELECT count(*) FROM authored_fact WHERE project_id = ?) AS authored_count,
         (SELECT count(*) FROM workflow_fact WHERE project_id = ?) AS workflow_count,
         (SELECT count(*) FROM command_receipt WHERE project_id = ?) AS receipt_count,
         (SELECT count(*) FROM command_result WHERE project_id = ?) AS result_count`,
      [projectId, projectId, projectId, projectId],
    )[0];
    const result = rows(
      this.db,
      `SELECT base_revision, target_revision, safe_value_hash, safe_result_hash
       FROM command_result WHERE command_id = ? AND project_id = ?`,
      [commandId, projectId],
    )[0];
    const receipt = rows(
      this.db,
      `SELECT applied_revision, safe_result_hash FROM command_receipt WHERE command_id = ? AND project_id = ?`,
      [commandId, projectId],
    )[0];
    const revision = integer(state?.revision);
    const mutationCount = integer(state?.mutation_count);
    const receiptCount = integer(counts?.receipt_count);
    const recordedResultCount = integer(counts?.result_count);
    const recordedBaseRevision = integer(result?.base_revision);
    const recordedTargetRevision = integer(result?.target_revision);
    const exactBaseline =
      recordedResultCount === 0 && receiptCount === 0 && mutationCount === 0 &&
      revision === fixture.initialRevision && String(state?.safe_value_hash ?? '') === fixture.safeStateHash;
    const exactCommand =
      recordedResultCount === 1 && receiptCount === 1 && mutationCount === 1 &&
      recordedBaseRevision === fixture.initialRevision && recordedTargetRevision === fixture.initialRevision + 1 &&
      revision === recordedTargetRevision && integer(receipt?.applied_revision) === recordedTargetRevision &&
      String(result?.safe_value_hash ?? '') === String(state?.safe_value_hash ?? '') &&
      String(result?.safe_result_hash ?? '') === String(state?.safe_value_hash ?? '') &&
      String(receipt?.safe_result_hash ?? '') === String(result?.safe_result_hash ?? '');
    const partialMutation =
      receiptCount !== recordedResultCount ||
      mutationCount !== recordedResultCount ||
      (!exactBaseline && !exactCommand);
    const semanticState = JSON.stringify({
      projectId,
      revision,
      safeValueHash: String(state?.safe_value_hash ?? ''),
      mutationCount,
      receiptCount,
      recordedResultCount,
    });
    return {
      quickCheck,
      mutationCount,
      authoredFactCount: integer(counts?.authored_count),
      workflowFactCount: integer(counts?.workflow_count),
      fixtureAuthoredFactCount: 0,
      fixtureWorkflowFactCount: 0,
      commandReceiptCount: receiptCount,
      recordedResultCount,
      storedRevision: revision,
      nextRevision: revision + 1,
      recordedResultHash: result ? String(result.safe_result_hash) : null,
      recordedBaseRevision,
      recordedTargetRevision,
      safeValueHash: String(state?.safe_value_hash ?? ''),
      partialMutation,
      semanticState,
    };
  }
}

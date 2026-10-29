import { parseLocalFileState, validateLocalSnapshot } from '../../application/portable-file/local-merge';
import { initializeLocalFileSchema, readLocalFileStateDb, writeLocalFileStateDb, applyLocalFileMergeDb, readLocalFileRecoveryDb, restoreLocalFileMergeDb, type LocalFileMergeInput, type LocalFileRecovery } from './local-file-store';
/**
 * Dedicated Repository Worker for Product Commands (Story 2.3 Task 6, AD-3).
 *
 * Runs off the main thread, opens/manages SQLite instance, initializes schema,
 * and processes ProductCommand requests via ProductCommandHandler.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import { ProductCommandHandler } from './project-commands';
import { PRODUCT_SCHEMA_VERSION, NewerSchemaVersionError, readUserVersion, assertWritableSchema } from './schema';
import { ensureLocalActor } from './local-actor';
import { initializeCollaborationSchema, readOutbox, deleteOutboxEntry } from './collaboration-outbox';
import type { OutboxState } from '../../application/collaboration/sync-client';
import { validateProductCommand, type ProductCommand, type ProductCommandResult } from '../../contracts/repository-commands';
import { validateProductCommandBatch, validateProductCommandBatchResults } from './product-batch.protocol';
import type { OutlineNodeReadModel, OutlineReadModel } from '../../application/outline/outline-read-model';
import type {
  ViewId,
  ViewStateSnapshot,
  ViewStatePatch,
} from '../../contracts/view-state';
import {
  createViewStateSnapshot,
  applyViewStatePatch,
} from '../../contracts/view-state';
import type { WorkspaceOverviewProjection } from '../../contracts/workspace-overview';
import { projectWorkspaceOverview, assembleWorkspaceOverview } from '../../application/workspace/workspace-overview.projection';
import { WorkspaceSummaryCache } from './workspace-summary-cache';
import type { WorkspaceRegistry, WorkspaceMutationResult } from '../../contracts/workspace';
import {
  migrateWorkspaceSchema,
  ensureDefaultWorkspace,
  readActiveWorkspaceId,
  queryWorkspaceRegistry,
  createWorkspaceOp,
  renameWorkspaceOp,
  deleteWorkspaceOp,
  moveProjectToWorkspaceOp,
  setActiveWorkspaceOp,
} from './workspace-operations';

export type WorkerRequest =
  | Readonly<{type: 'LocalFileOperation'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; operation: 'read'|'write'|'apply'|'recovery'|'restore';projectId:string;expectedRevision?:number;stateJson?:string;operationId?:string;input?:LocalFileMergeInput}>
  | Readonly<{ type: 'InstallCollaborationSnapshot'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; projectId: string; envelope: import('../../contracts/collaboration-recovery').RecoveryEnvelope }>
  | Readonly<{ type: 'ReadCollaborationOutbox' | 'DiscardCollaborationOutboxEntry'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; projectId: string; commandId?: string }>
  | Readonly<{ type: 'ReadCollaborationHistory'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; projectId: string; before: number | null; limit: number }>
  | Readonly<{ type: 'ForgetCollaboration'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; projectId: string }>
  | Readonly<{
      type: 'Initialize';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'ApplyProductCommand';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      command: ProductCommand;
    }>
  | Readonly<{
      type: 'ApplyProductCommandBatch';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      commands: readonly ProductCommand[];
    }>
  | Readonly<{
      type: 'ApplyCommandWithOutbox';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      command: ProductCommand;
      projectId: string;
      outbox: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>;
    }>
  | Readonly<{
      type: 'ApplyGroupWithOutbox';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      groupId: string;
      members: readonly Readonly<{ command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string }>[];
    }>
  | Readonly<{
      type: 'ApplyRebaseAtomic';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch?: number; historyEntry?: import('../../contracts/collaboration-recovery').ConfirmedHistoryEntry }>;
      toReapply: readonly Readonly<{ commandId: string; command: ProductCommand; commitAttemptId: number; queuedAtISO: string; groupId?: string; groupIndex?: number }>[];
      rejected: readonly Readonly<{ commandId: string; reason?: string }>[];
    }>
  | Readonly<{
      type: 'QueryProjectNodes';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
    }>
  | Readonly<{
      type: 'QueryProjects';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'QueryWorkspaceOverview';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'QueryNodeEdges';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      nodeId: string;
    }>
  | Readonly<{
      type: 'QuerySubtreeEdges';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      rootNodeId: string;
    }>
  | Readonly<{
      type: 'QueryDismissals';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
    }>
  | Readonly<{
      type: 'QueryAffectedReasons';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
    }>
  | Readonly<{
      type: 'QueryAnalysisSnapshot';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
    }>
  | Readonly<{
      type: 'QueryViewState';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      viewId: ViewId;
    }>
  | Readonly<{
      type: 'QueryPortableSnapshot';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
    }>
  | Readonly<{
      type: 'BatchImportPortable';
      localFileStateJson?: string;
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      snapshot: import('../../contracts/portable-file.schema').PortableProjectSnapshot;
    }>
  | Readonly<{
      type: 'UpdateViewState';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projectId: string;
      viewId: ViewId;
      baseRevision: number;
      patch: ViewStatePatch;
    }>
  | Readonly<{
      type: 'GetStorageStatus';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'ResetDatabase';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'ReleaseStorage';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  // ── Epic 17: workspace registry ──────────────────────────────────
  | Readonly<{
      type: 'QueryWorkspaceRegistry';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'MutateWorkspace';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      /**
       * One message for all five workspace mutations rather than five
       * message types: they share a request shape, a result shape, and a
       * single dispatch branch, so splitting them would triple the protocol
       * surface for no added type safety at the call site.
       */
      mutation:
        | Readonly<{ kind: 'Create'; workspaceId: string; name: string }>
        | Readonly<{ kind: 'Rename'; workspaceId: string; name: string }>
        | Readonly<{ kind: 'Delete'; workspaceId: string }>
        | Readonly<{ kind: 'SetActive'; workspaceId: string }>
        | Readonly<{ kind: 'MoveProject'; projectId: string; workspaceId: string }>;
    }>;

export type WorkerResponse =
  | Readonly<{type:'LocalFileResult';protocolVersion:typeof PROTOCOL_VERSION;requestId:string;result:string|null|void|{revision:number}|LocalFileRecovery}>
  | Readonly<{ type: 'SnapshotInstallResult'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; revision: number; recoveryRequired: boolean }>
  | Readonly<{ type: 'CollaborationOutboxResult'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; state: OutboxState }>
  | Readonly<{ type: 'CollaborationHistoryResult'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; rows: readonly import('./collaboration-outbox').CollaborationHistoryRow[] }>
  | Readonly<{ type: 'CollaborationForgotten'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string }>
  | Readonly<{
      type: 'WorkerReady';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      isOpfs: boolean;
    }>
  | Readonly<{
      type: 'DatabaseReset';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'StorageReleased';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
    }>
  | Readonly<{
      type: 'ProductCommandResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      result: ProductCommandResult;
    }>
  | Readonly<{
      type: 'ProductCommandBatchResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      results: readonly ProductCommandResult[];
    }>
  | Readonly<{
      type: 'RebaseResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      result: ProductCommandResult | null;
    }>
  | Readonly<{
      type: 'ProjectNodesResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      model: OutlineReadModel;
    }>
  | Readonly<{
      type: 'ProjectsResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      projects: readonly { id: string; name: string; revision: number }[];
    }>
  | Readonly<{
      type: 'WorkspaceOverviewResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      overview: WorkspaceOverviewProjection;
    }>
  | Readonly<{
      type: 'NodeEdgesResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      edges: { inbound: readonly UnlockEdge[]; outbound: readonly UnlockEdge[] };
    }>
  | Readonly<{
      type: 'SubtreeEdgesResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      edges: readonly UnlockEdge[];
    }>
  | Readonly<{
      type: 'DismissalsResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      dismissals: readonly import('../../contracts/analysis-protocol').FindingDismissal[];
    }>
  | Readonly<{
      type: 'AffectedReasonsResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      reasons: readonly import('../../contracts/analysis-protocol').AffectedReason[];
    }>
  | Readonly<{
      type: 'AnalysisSnapshotResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      snapshot: import('../../contracts/analysis-protocol').AnalysisSnapshotRequest;
    }>
  | Readonly<{
      type: 'ViewStateResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      snapshot: ViewStateSnapshot;
    }>
  | Readonly<{
      type: 'PortableSnapshotResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      snapshot: import('../../contracts/portable-file.schema').PortableProjectSnapshot;
    }>
  | Readonly<{
      type: 'BatchImportResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      result: { ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string };
    }>
  | Readonly<{
      type: 'UpdateViewStateResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      outcome: { kind: 'Applied'; snapshot: ViewStateSnapshot } | { kind: 'StaleBase'; snapshot: ViewStateSnapshot };
    }>
  | Readonly<{
      type: 'StorageStatusResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      isOpfs: boolean;
    }>
  | Readonly<{
      type: 'WorkspaceRegistryResult';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      registry: WorkspaceRegistry;
    }>
  | Readonly<{
      type: 'WorkspaceMutationResponse';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      result: WorkspaceMutationResult;
    }>
  | Readonly<{
      type: 'WorkerError';
      protocolVersion: typeof PROTOCOL_VERSION;
      requestId: string;
      error: string;
      /** Typed reason when the worker refused (e.g. `UNSUPPORTED_NEWER_SCHEMA`). */
      code?: string;
    }>;

let db: Database | null = null;
let handler: ProductCommandHandler | null = null;
let isOpfsStorage = false;
// Retained so the pool's sync access handles can be handed back when the page
// goes away. Without that release the successor page contends with handles the
// dying page still owns (see releaseStorage).
let sahPool: { pauseVfs?: () => void } | null = null;
/**
 * Story 22.15 AC 22.15-2/-3 / review L8: a newer-schema refusal is terminal.
 * Once this build discovers a database it does not understand, it must not
 * retry the open and fall back to an empty writable `:memory:` database —
 * that would silently present an empty workspace over a newer file. Every
 * subsequent `initWorkerDatabase()` rethrows this exact error.
 */
let refusedNewerSchema: NewerSchemaVersionError | null = null;
const workspaceSummaryCache = new WorkspaceSummaryCache();

/**
 * Hand the OPFS sync access handles back before this page's worker dies.
 *
 * A SAH can only be held by one owner at a time, and the browser releases the
 * handles of a torn-down worker lazily. On reload the successor's
 * `installOpfsSAHPoolVfs` therefore raced the predecessor and burned its whole
 * retry budget on NoModificationAllowedError — costing seconds per navigation
 * and, when the budget ran out, silently degrading to an in-memory database
 * that shows an empty workspace.
 */
function releaseStorage(): void {
  try {
    db?.close();
  } catch {
    // The database may already be closed; releasing the pool still matters.
  }
  db = null;
  handler = null;
  try {
    sahPool?.pauseVfs?.();
  } catch {
    // Best effort: the page is going away regardless.
  }
  sahPool = null;
}

async function openOpfsDatabaseWithRetry(sqlite3: any): Promise<{ db: Database; vfsName: string }> {
  const maxAttempts = 15;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const vfsName = `pmapp-sah-${attempt}-${Date.now()}`;
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: vfsName,
        directory: '/pmapp/data',
        initialCapacity: 6,
        clearOnInit: false,
      });
      sahPool = pool;
      const selectedVfs = pool.vfsName ?? vfsName;
      const dbInstance = new sqlite3.oo1.DB('/pmapp/data/repository.sqlite3', 'c', selectedVfs);
      // Unsupported future schema: reject BEFORE any pragma that writes the file (Story 22.15 AC 22.15-2).
      const initialVersion = readUserVersion(dbInstance);
      if (initialVersion > PRODUCT_SCHEMA_VERSION) {
        // Release the connection and pool this attempt just acquired before
        // aborting: leaving them retained made the successor's
        // `installOpfsSAHPoolVfs` race handles this worker still held, and a
        // retry could then exhaust its budget and downgrade to `:memory:`
        // (review L8).
        try { dbInstance.close(); } catch { /* best effort */ }
        try { pool.pauseVfs?.(); } catch { /* best effort */ }
        sahPool = null;
        throw new NewerSchemaVersionError(initialVersion, PRODUCT_SCHEMA_VERSION);
      }
      // synchronous=FULL, not NORMAL. Under a rollback journal, NORMAL lets
      // the journal delete be reordered ahead of the database write, so an OS
      // crash or power loss can leave the pair torn — SQLite documents that as
      // a corruption risk, not merely the loss of the last transaction. WAL,
      // the usual way to make NORMAL safe, is unavailable on the OPFS SAH pool
      // VFS. This file is the user's only copy of their work, so the extra
      // xSync (a FileSystemSyncAccessHandle flush) per commit is bought
      // deliberately; measured cost is a few ms on a human-paced write load.
      // ignore_check_constraints: the node_type CHECK is baked into legacy
      // databases and cannot be ALTERed; the type vocabulary is enforced in
      // the domain layer instead (validateTypedNeighborhood / isValidNodeType).
      dbInstance.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=ON;');
      return { db: dbInstance, vfsName: selectedVfs };
    } catch (err) {
      lastError = err;
      if (err instanceof NewerSchemaVersionError || (err instanceof Error && err.name === 'NewerSchemaVersionError')) {
        throw err;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(400, attempt * 100)));
      }
    }
  }

  throw lastError;
}

let initInFlight: Promise<ProductCommandHandler> | null = null;

export async function initWorkerDatabase(): Promise<ProductCommandHandler> {
  if (handler && db) return handler;
  // A future-schema database was already discovered: keep refusing with the
  // same typed error rather than reopening (and possibly falling back to an
  // empty writable `:memory:` database) on every request (review L8).
  if (refusedNewerSchema) throw refusedNewerSchema;
  // Every message handler opens with `await initWorkerDatabase()`, so a burst
  // of messages arriving before the first open resolves used to start one open
  // per message. Each raced the others for the same OPFS sync access handles:
  // one won, the rest exhausted their retry budget on
  // NoModificationAllowedError and then overwrote the module-level `db` with
  // an in-memory fallback — losing the OPFS database, and with it the
  // workspace, after several seconds of retry storm. Share one attempt.
  initInFlight ??= openDatabase().finally(() => {
    initInFlight = null;
  });
  return initInFlight;
}

async function openDatabase(): Promise<ProductCommandHandler> {
  const sqlite3 = await sqlite3InitModule();

  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
      const { db: opfsDb } = await openOpfsDatabaseWithRetry(sqlite3);
      db = opfsDb;
      isOpfsStorage = true;
    } catch (err) {
      if (err instanceof NewerSchemaVersionError || (err instanceof Error && err.name === 'NewerSchemaVersionError')) {
        // Terminal refusal: never downgrade to an empty writable database
        // after discovering a future schema (review L8).
        refusedNewerSchema = err as NewerSchemaVersionError;
        throw err;
      }
      console.warn('Failed to install OPFS SAH Pool VFS, falling back to :memory:', err);
      db = new sqlite3.oo1.DB(':memory:', 'c');
      db.exec('PRAGMA foreign_keys = ON; PRAGMA ignore_check_constraints = ON;');
      isOpfsStorage = false;
    }
  } else {
    db = new sqlite3.oo1.DB(':memory:', 'c');
    db.exec('PRAGMA foreign_keys = ON;');
    isOpfsStorage = false;
  }

  try {
    handler = prepareProductDatabase(db);
  } catch (err) {
    if (err instanceof NewerSchemaVersionError || (err instanceof Error && err.name === 'NewerSchemaVersionError')) {
      // The OPFS attempt already checked, but a refused schema must still
      // release the handles this worker acquired and stay terminal.
      refusedNewerSchema = err as NewerSchemaVersionError;
      const refused = db;
      db = null;
      handler = null;
      isOpfsStorage = false;
      try { refused?.close(); } catch { /* best effort */ }
      try { sahPool?.pauseVfs?.(); } catch { /* best effort */ }
      sahPool = null;
      throw err;
    }
    throw err;
  }
  return handler;
}

/**
 * The browser startup schema sequence, run on every open against whatever
 * database the VFS produced — fresh, current, or any supported predecessor.
 * Exported so the upgrade qualification (Story 22.13) drives exactly this
 * sequence over populated legacy databases rather than a copy of it.
 *
 * Story 22.15 AC 22.15-1: the whole sequence (schema, migrations, backfill and
 * the final `PRAGMA user_version` marker) runs inside ONE transaction, so the
 * marker commits atomically with the last migration step. A crash before the
 * commit therefore rolls the whole change back to the predecessor state rather
 * than leaving changed schema/data under the old marker. `PRAGMA user_version`
 * is transactional in SQLite (verified), so it is safe to set before COMMIT.
 *
 * No handler is returned — so nothing can write — until the whole sequence has
 * completed. Callers must NOT already hold an open transaction.
 */
export function prepareProductDatabase(target: Database): ProductCommandHandler {
  assertWritableSchema(target);
  const initializedHandler = new ProductCommandHandler(target);
  target.exec('BEGIN IMMEDIATE');
  try {
    initializedHandler.initializeSchema();
    migrateViewStateViewportColumns(target);
    migrateNodeColumns(target);
    migrateForecastSchema(target);
    migrateActorSchema(target);
    initializeCollaborationSchema(target);
    initializeLocalFileSchema(target);
    // Epic 17: `initializeSchema()` above already ran `migrateWorkspaceSchema`
    // (workspaces table + projects.workspace_id); calling it again here was
    // redundant (Story 25.2 AC 25.2-5). The one-time backfill still needs the
    // column to exist, which `initializeSchema()` guarantees. Order matters —
    // backfill after the column.
    ensureDefaultWorkspace(target);
    target.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION}`);
    target.exec('COMMIT');
  } catch (error) {
    try { target.exec('ROLLBACK'); } catch { /* preserve */ }
    throw error;
  }
  return initializedHandler;
}

/**
 * Epic 10 (E10-AR9) + Epic 15 (E15-AR2): adds the visual-tree viewport
 * columns (`pan_x`, `pan_y`, `scale`) and the side-navigation collapsed
 * flag (`nav_collapsed`) to an existing `view_state` table. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the migration is guarded by a
 * `PRAGMA table_info` check. Safe to run on every startup; fresh databases
 * already carry the columns in the baseline DDL.
 */
function migrateViewStateViewportColumns(target: Database): void {
  const rows = target.exec({
    sql: 'PRAGMA table_info(view_state)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
  const names = new Set((rows ?? []).map((r) => String(r.name)));
  if (!names.has('pan_x')) {
    target.exec('ALTER TABLE view_state ADD COLUMN pan_x REAL NOT NULL DEFAULT 0.0');
  }
  if (!names.has('pan_y')) {
    target.exec('ALTER TABLE view_state ADD COLUMN pan_y REAL NOT NULL DEFAULT 0.0');
  }
  if (!names.has('scale')) {
    target.exec('ALTER TABLE view_state ADD COLUMN scale REAL NOT NULL DEFAULT 1.0');
  }
  if (!names.has('nav_collapsed')) {
    target.exec('ALTER TABLE view_state ADD COLUMN nav_collapsed INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * Outline status badging (product schema v9): adds the `delivery_status`
 * column to an existing `nodes` table. Guarded by `PRAGMA table_info` since
 * SQLite has no `ADD COLUMN IF NOT EXISTS`. Bare nullable TEXT (no CHECK) —
 * a legacy NULL row is read back as 'not_started'; the value is validated in
 * the domain command. Safe on every startup; fresh databases already carry
 * the column in the baseline DDL.
 */
function migrateNodeColumns(target: Database): void {
  const rows = target.exec({
    sql: 'PRAGMA table_info(nodes)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
  const names = new Set((rows ?? []).map((r) => String(r.name)));
  if (!names.has('delivery_status')) {
    target.exec('ALTER TABLE nodes ADD COLUMN delivery_status TEXT');
  }
  // Story 26.5 (product schema v16): points done on an in-progress item.
  // Nullable with no default, so a migrated row and a fresh row both read
  // back as "not recorded" (null).
  if (!names.has('effort_points_done')) {
    target.exec('ALTER TABLE nodes ADD COLUMN effort_points_done INTEGER');
  }
}

/**
 * Forecast blockers + scenarios (product schema v11 / v12, Epic 20). Adds
 * `forecast_plans.blocked_feature_ids` (Story 20.1) and the
 * `forecast_scenarios` table (Story 20.4). Guarded by `PRAGMA table_info` /
 * `IF NOT EXISTS` since SQLite has no `ADD COLUMN IF NOT EXISTS`. Constant
 * defaults keep a migrated schema and a fresh baseline identical. Safe on
 * every startup.
 */
function migrateForecastSchema(target: Database): void {
  const rows = target.exec({
    sql: 'PRAGMA table_info(forecast_plans)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
  const names = new Set((rows ?? []).map((r) => String(r.name)));
  if (!names.has('blocked_feature_ids')) {
    target.exec("ALTER TABLE forecast_plans ADD COLUMN blocked_feature_ids TEXT NOT NULL DEFAULT '[]'");
  }
  // Story 21.7 (schema v13): the plan's node hierarchy level. Constant
  // default keeps a migrated schema and a fresh baseline identical.
  if (!names.has('planning_level')) {
    target.exec("ALTER TABLE forecast_plans ADD COLUMN planning_level TEXT NOT NULL DEFAULT 'Feature'");
  }
  // Story 22.3 (schema v14): the project roster for staffed forecasting.
  if (!names.has('roster')) {
    target.exec("ALTER TABLE forecast_plans ADD COLUMN roster TEXT NOT NULL DEFAULT '[]'");
  }
  // Story 22.4 (schema v15): the per-item assignments for staffed forecasting.
  if (!names.has('assignments')) {
    target.exec("ALTER TABLE forecast_plans ADD COLUMN assignments TEXT NOT NULL DEFAULT '{}'");
  }
  target.exec(`CREATE TABLE IF NOT EXISTS forecast_scenarios(
    scenario_id        TEXT    PRIMARY KEY,
    project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label              TEXT    NOT NULL,
    baseline_revision  INTEGER NOT NULL,
    baseline_fingerprint TEXT  NOT NULL,
    policy_version     TEXT    NOT NULL DEFAULT 'shared-capacity-v1',
    created_at_iso     TEXT    NOT NULL,
    baseline_json      TEXT    NOT NULL,
    patch_json         TEXT    NOT NULL
  )`);
  target.exec('CREATE INDEX IF NOT EXISTS forecast_scenarios_by_project ON forecast_scenarios(project_id, created_at_iso)');
}

/**
 * Actor identity (product schema v17, Story 27.3). Adds the `actor_id` column
 * to `product_command_receipt` on an existing database. Guarded by
 * `PRAGMA table_info` since SQLite has no `ADD COLUMN IF NOT EXISTS`. Bare
 * nullable TEXT (no default): existing receipts migrate to the local actor's id
 * lazily through the backfill in `ensureLocalActor`.
 */
function migrateActorSchema(target: Database): void {
  const rows = target.exec({
    sql: 'PRAGMA table_info(product_command_receipt)',
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, unknown>[];
  const names = new Set((rows ?? []).map((r) => String(r.name)));
  if (!names.has('actor_id')) {
    target.exec('ALTER TABLE product_command_receipt ADD COLUMN actor_id TEXT');
  }
}

export function getDatabase(): Database | null {
  return db;
}

export function getIsOpfs(): boolean {
  return isOpfsStorage;
}

import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';
import { coerceDeliveryStatus } from '../../domain/tree/node.entity';
import { calculateAcceptanceRatio } from '../../domain/tree/acceptance-criteria.policy';
import { resolveEffectiveField } from '../../domain/tree/field-inheritance.policy';
import { deriveAncestorSpan } from '../../domain/tree/schedule.policy';
import { computeNodeEdgeCounts } from '../../domain/edge/unlock-edge.policy';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';

export function queryProjectNodes(projectId: string): OutlineReadModel {
  if (!db) {
    return {
      projectId,
      projectRevision: 0,
      nodes: [],
      phases: [],
      unlockEdges: [],
    };
  }

  const projRow = db.exec({
    sql: 'SELECT revision FROM projects WHERE id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  })[0] as Record<string, unknown> | undefined;

  const projectRevision = projRow ? Number(projRow.revision) : 0;

  // 1. Query phases
  const phaseRows = db.exec({
    sql: 'SELECT id, project_id, name, position FROM phases WHERE project_id = ? ORDER BY position ASC',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const phases: Phase[] = phaseRows.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    position: BigInt(Number(r.position)),
  }));

  const phaseMap = new Map<string, Phase>(phases.map((p) => [p.id, p]));

  // 2. Query unlock edges
  const edgeRows = db.exec({
    sql: 'SELECT id, project_id, source_node_id, target_node_id FROM unlock_edges WHERE project_id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const unlockEdges: UnlockEdge[] = edgeRows.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    sourceNodeId: String(r.source_node_id),
    targetNodeId: String(r.target_node_id),
  }));

  // 3. Query custom fields
  const customFieldRows = db.exec({
    sql: 'SELECT node_id, field_key, field_value FROM node_custom_fields WHERE project_id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const customFieldMap = new Map<string, Record<string, string>>();
  for (const r of customFieldRows) {
    const nId = String(r.node_id);
    let dict = customFieldMap.get(nId);
    if (!dict) {
      dict = {};
      customFieldMap.set(nId, dict);
    }
    if (r.field_value !== null && r.field_value !== undefined) {
      dict[String(r.field_key)] = String(r.field_value);
    }
  }

  // 4. Query nodes
  const nodeRows = db.exec({
    sql: `SELECT id, parent_id, title, body_text, position, node_type, start_date, end_date, duration_days,
                 schedule_source_mode, completed, effort_points, effort_points_done, strategic_weight, phase_id, delivery_status
          FROM nodes WHERE project_id = ? ORDER BY position ASC`,
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  // 4b. Query open questions (Story 16.1 AC4) — pre-sorted by position ascending.
  const questionRows = db.exec({
    sql: `SELECT id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
          FROM node_open_questions WHERE project_id = ? ORDER BY position ASC`,
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];
  const questionsByNode = new Map<string, import('../../domain/tree/node-question.entity').NodeOpenQuestion[]>();
  for (const q of questionRows) {
    const nodeId = String(q.node_id);
    const list = questionsByNode.get(nodeId) ?? [];
    list.push(
      Object.freeze({
        id: String(q.id),
        projectId,
        nodeId,
        questionText: String(q.question_text ?? ''),
        status: (q.status as import('../../domain/tree/node-question.entity').NodeQuestionStatus) ?? 'OPEN',
        decisionText: q.decision_text !== null && q.decision_text !== undefined ? String(q.decision_text) : null,
        position: BigInt(Number(q.position ?? 0)),
        resolvedAtISO: q.resolved_at_iso !== null && q.resolved_at_iso !== undefined ? String(q.resolved_at_iso) : null,
        createdAtISO: String(q.created_at_iso ?? ''),
      }),
    );
    questionsByNode.set(nodeId, list);
  }

  // Build tree map for inheritance and child queries
  const minimalNodes = new Map<string, { id: string; parentId: string | null; title: string }>();
  const childrenMap = new Map<string | null, { id: string; nodeType: string | null; completed: boolean }[]>();

  for (const r of nodeRows) {
    const id = String(r.id);
    const parentId = r.parent_id !== null && r.parent_id !== undefined ? String(r.parent_id) : null;
    const title = String(r.title ?? '');
    minimalNodes.set(id, { id, parentId, title });

    let list = childrenMap.get(parentId);
    if (!list) {
      list = [];
      childrenMap.set(parentId, list);
    }
    list.push({
      id,
      nodeType: (r.node_type as string | null) ?? null,
      completed: Boolean(r.completed),
    });
  }

  // Derived ancestor spans (UAT #8): for every node, compute the earliest
  // start / latest end across all dated descendants when the node itself has
  // no authored dates. Used by the Outline to surface the same rollup the
  // Gantt already shows ("Parent nodes automatically roll up..." — README).
  const datedDescendantSpan = new Map<string, { startDate: string | null; endDate: string | null; durationDays: number | null }>();
  function collectDatedDescendantSpan(nodeId: string): { startDate: string | null; endDate: string | null; durationDays: number | null } {
    const cached = datedDescendantSpan.get(nodeId);
    if (cached) return cached;
    const childIds = childrenMap.get(nodeId) ?? [];
    const descendantDates: { startDate: string | null; endDate: string | null }[] = [];
    for (const child of childIds) {
      const row = nodeRows.find((nr) => String(nr.id) === child.id);
      if (row && row.start_date) descendantDates.push({ startDate: String(row.start_date), endDate: row.end_date ? String(row.end_date) : null });
      if (row && row.end_date && !row.start_date) descendantDates.push({ startDate: null, endDate: String(row.end_date) });
      const childSpan = collectDatedDescendantSpan(child.id);
      if (childSpan.startDate || childSpan.endDate) descendantDates.push(childSpan);
    }
    const span = deriveAncestorSpan(descendantDates);
    datedDescendantSpan.set(nodeId, span);
    return span;
  }
  for (const r of nodeRows) {
    collectDatedDescendantSpan(String(r.id));
  }

  const nodes: OutlineNodeReadModel[] = nodeRows.map((r) => {
    const id = String(r.id);
    const parentId = r.parent_id !== null && r.parent_id !== undefined ? String(r.parent_id) : null;
    const title = String(r.title ?? '');
    const nodeType = (r.node_type as import('../../domain/tree/node.entity').NodeType | null) ?? null;
    const phaseId = r.phase_id ? String(r.phase_id) : null;
    const phaseName = phaseId && phaseMap.has(phaseId) ? phaseMap.get(phaseId)!.name : null;

    // Phase inheritance
    const effectivePhase = resolveEffectiveField(minimalNodes, id, (nId) => {
      const row = nodeRows.find((nr) => String(nr.id) === nId);
      if (!row || !row.phase_id) return { kind: 'inherit' };
      const pId = String(row.phase_id);
      const name = phaseMap.get(pId)?.name ?? pId;
      return { kind: 'explicit', value: name };
    });

    // Inbound / Outbound counts
    const edgeCounts = computeNodeEdgeCounts(id, unlockEdges);

    // Acceptance summary
    const children = childrenMap.get(id) ?? [];
    const acceptance = calculateAcceptanceRatio(children);

    // Derived ancestor span — surfaced only when no authored dates exist
    const span = datedDescendantSpan.get(id) ?? { startDate: null, endDate: null, durationDays: null };
    const hasAuthoredDates = r.start_date || r.end_date || r.duration_days !== null;

    return {
      id,
      parentId,
      title,
      bodyText: r.body_text !== null && r.body_text !== undefined ? String(r.body_text) : null,
      position: BigInt(Number(r.position)),
      typeTag: nodeType ? formatNodeTypeTag(nodeType) : null,
      nodeType,
      startDate: r.start_date ? String(r.start_date) : null,
      endDate: r.end_date ? String(r.end_date) : null,
      durationDays: r.duration_days !== null && r.duration_days !== undefined ? Number(r.duration_days) : null,
      scheduleSourceMode: (r.schedule_source_mode as import('../../domain/tree/node.entity').ScheduleSourceMode | null) ?? null,
      derivedStartDate: !hasAuthoredDates ? span.startDate : null,
      derivedEndDate: !hasAuthoredDates ? span.endDate : null,
      derivedDurationDays: !hasAuthoredDates ? span.durationDays : null,
      completed: Boolean(r.completed),
      effortPoints: r.effort_points !== null && r.effort_points !== undefined ? Number(r.effort_points) : null,
      effortPointsDone:
        r.effort_points_done !== null && r.effort_points_done !== undefined ? Number(r.effort_points_done) : null,
      strategicWeight: r.strategic_weight !== null && r.strategic_weight !== undefined ? Number(r.strategic_weight) : null,
      deliveryStatus: coerceDeliveryStatus(r.delivery_status),
      phaseId,
      phaseName,
      effectivePhaseName: effectivePhase.effectiveValue ?? null,
      effectivePhaseSource: effectivePhase.source,
      unlocksCount: edgeCounts.unlocksCount,
      unlockedByCount: edgeCounts.unlockedByCount,
      customFields: Object.freeze(customFieldMap.get(id) ?? {}),
      acceptanceSummary: nodeType === 'Feature' ? acceptance.ratioText : null,
      openQuestions: Object.freeze(questionsByNode.get(id) ?? Object.freeze([])),
    };
  });

  return {
    projectId,
    projectRevision,
    nodes: Object.freeze(nodes),
    phases: Object.freeze(phases),
    unlockEdges: Object.freeze(unlockEdges),
  };
}

export function queryNodeEdges(
  projectId: string,
  nodeId: string,
): { inbound: readonly UnlockEdge[]; outbound: readonly UnlockEdge[] } {
  if (!db) return { inbound: [], outbound: [] };

  const rows = db.exec({
    sql: 'SELECT id, project_id, source_node_id, target_node_id FROM unlock_edges WHERE project_id = ? AND (source_node_id = ? OR target_node_id = ?)',
    bind: [projectId, nodeId, nodeId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const inbound: UnlockEdge[] = [];
  const outbound: UnlockEdge[] = [];

  for (const r of rows) {
    const edge: UnlockEdge = {
      id: String(r.id),
      projectId: String(r.project_id),
      sourceNodeId: String(r.source_node_id),
      targetNodeId: String(r.target_node_id),
    };
    if (edge.targetNodeId === nodeId) {
      inbound.push(edge);
    }
    if (edge.sourceNodeId === nodeId) {
      outbound.push(edge);
    }
  }

  return Object.freeze({
    inbound: Object.freeze(inbound),
    outbound: Object.freeze(outbound),
  });
}

export function querySubtreeEdges(
  projectId: string,
  rootNodeId: string,
): readonly UnlockEdge[] {
  if (!db) return [];

  const nodeRows = db.exec({
    sql: `WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id = ? AND project_id = ?
      UNION ALL
      SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id WHERE n.project_id = ?
    ) SELECT id FROM subtree`,
    bind: [rootNodeId, projectId, projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const subtreeNodeIds = new Set<string>(nodeRows.map((r) => String(r.id)));

  const allEdges = db.exec({
    sql: 'SELECT id, project_id, source_node_id, target_node_id FROM unlock_edges WHERE project_id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  const scopedEdges: UnlockEdge[] = [];
  for (const r of allEdges) {
    const src = String(r.source_node_id);
    const tgt = String(r.target_node_id);
    if (subtreeNodeIds.has(src) || subtreeNodeIds.has(tgt)) {
      scopedEdges.push({
        id: String(r.id),
        projectId: String(r.project_id),
        sourceNodeId: src,
        targetNodeId: tgt,
      });
    }
  }

  return Object.freeze(scopedEdges);
}

export function queryDismissals(projectId: string): readonly import('../../contracts/analysis-protocol').FindingDismissal[] {
  if (!db) return [];
  const rows = db.exec({
    sql: 'SELECT project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at FROM finding_dismissals WHERE project_id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        projectId: String(r.project_id),
        findingId: String(r.finding_id),
        findingKind: r.finding_kind as import('../../contracts/analysis-protocol').CoherenceFindingKind,
        targetId: String(r.target_id),
        fingerprint: String(r.fingerprint),
        dismissedAt: String(r.dismissed_at),
      }),
    ),
  );
}

export function queryAffectedReasons(projectId: string): readonly import('../../contracts/analysis-protocol').AffectedReason[] {
  if (!db) return [];
  const rows = db.exec({
    sql: 'SELECT id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days, causal_date_summary, created_at, acknowledged_at FROM affected_reasons WHERE project_id = ? ORDER BY created_at DESC',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];

  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        id: String(r.id),
        projectId: String(r.project_id),
        affectedNodeId: String(r.affected_node_id),
        causalNodeId: String(r.causal_node_id),
        causalNodeTitle: String(r.causal_node_title),
        deltaDays: Number(r.delta_days),
        causalDateSummary: String(r.causal_date_summary),
        createdAt: String(r.created_at),
        acknowledgedAt: r.acknowledged_at ? String(r.acknowledged_at) : null,
      }),
    ),
  );
}

/**
 * Saved historical scenarios for a project (Story 20.4 / 20.5). A read model
 * for the Compare experience — never through the analysis snapshot.
 */
export function queryForecastScenarios(
  projectId: string,
): readonly import('../../domain/forecast/scenario').PersistedForecastScenario[] {
  if (!db) return [];
  try {
    return readForecastScenarios(db, projectId);
  } catch {
    return [];
  }
}

export function queryAnalysisSnapshot(projectId: string): import('../../contracts/analysis-protocol').AnalysisSnapshotRequest {
  const model = queryProjectNodes(projectId);
  const dismissals = queryDismissals(projectId);
  // A corrupt forecast_plans cell must not take down coherence analysis:
  // omit the plan and carry a recoverable marker instead (Story 18.2).
  let forecastPlan: ReturnType<typeof readForecastPlan> = null;
  let forecastPlanError: string | undefined;
  try {
    forecastPlan = readForecastPlan(db!, projectId);
  } catch (err) {
    forecastPlanError = err instanceof Error ? err.message : 'FORECAST_PLAN_CORRUPT';
  }

  const domainNodes = model.nodes.map((n) =>
    Object.freeze({
      id: n.id,
      projectId: model.projectId,
      parentId: n.parentId,
      title: n.title,
      bodyText: null,
      position: n.position,
      nodeType: n.nodeType,
      startDate: n.startDate,
      endDate: n.endDate,
      durationDays: n.durationDays,
      scheduleSourceMode: n.scheduleSourceMode,
      completed: n.completed,
      effortPoints: n.effortPoints,
      effortPointsDone: n.effortPointsDone,
      strategicWeight: n.strategicWeight,
      phaseId: n.phaseId,
      deliveryStatus: n.deliveryStatus,
    }),
  );

  const forecastScenarios = queryForecastScenarios(model.projectId);

  return Object.freeze({
    type: 'AnalysisSnapshot',
    projectId: model.projectId,
    projectRevision: model.projectRevision,
    nodes: Object.freeze(domainNodes),
    phases: model.phases ?? [],
    unlockEdges: model.unlockEdges ?? [],
    dismissals,
    ...(forecastPlan ? { forecastPlan } : {}),
    ...(forecastPlanError ? { forecastPlanError } : {}),
    ...(forecastScenarios.length > 0 ? { forecastScenarios } : {}),
  });
}

/**
 * Projects in one workspace.
 *
 * Scoped to the active workspace by default (Epic 17). Pass an explicit
 * workspaceId to read a different one; pass `null` to read every project in
 * the store regardless of workspace — used only by the portable-export and
 * backup paths, which operate on the whole file.
 */
export function queryProjects(
  workspaceId?: string | null,
): readonly { id: string; name: string; revision: number }[] {
  if (!db) return [];

  const scope = workspaceId === undefined ? readActiveWorkspaceId(db) : workspaceId;

  const rows = db.exec(
    scope === null
      ? {
          sql: 'SELECT id, name, revision FROM projects ORDER BY name ASC',
          rowMode: 'object',
          returnValue: 'resultRows',
        }
      : {
          sql: 'SELECT id, name, revision FROM projects WHERE workspace_id = ? ORDER BY name ASC',
          bind: [scope],
          rowMode: 'object',
          returnValue: 'resultRows',
        },
  ) as Record<string, unknown>[];

  return Object.freeze(
    rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      revision: Number(r.revision),
    })),
  );
}

export function queryWorkspaceOverview(workspaceId?: string | null): WorkspaceOverviewProjection {
  const projects = queryProjects(workspaceId);

  const rows = projects.map((p) => {
    const cached = workspaceSummaryCache.get(p.id, p.revision);
    if (cached) {
      return cached;
    }

    const snapshot = queryAnalysisSnapshot(p.id);
    const input = mapSnapshotToInput(p, snapshot);
    const row = projectWorkspaceOverview([input]).projects[0];
    workspaceSummaryCache.set(p.id, p.revision, row);
    return row;
  });

  return assembleWorkspaceOverview(rows);
}

function mapSnapshotToInput(
  project: { id: string; name: string; revision: number },
  snapshot: import('../../contracts/analysis-protocol').AnalysisSnapshotRequest,
): import('../../application/workspace/workspace-overview.projection').ProjectAnalysisInput {
  return Object.freeze({
    projectId: project.id,
    projectName: project.name,
    projectRevision: project.revision,
    nodes: snapshot.nodes,
    phases: snapshot.phases ?? [],
    unlockEdges: snapshot.unlockEdges ?? [],
    dismissals: snapshot.dismissals ?? [],
  });
}

export function queryViewState(projectId: string, viewId: ViewId): ViewStateSnapshot {
  if (!db) {
    return createViewStateSnapshot({ projectId, viewId, viewStateRevision: 0 });
  }

  const row = db.exec({
    sql: 'SELECT * FROM view_state WHERE project_id = ? AND view_id = ?',
    bind: [projectId, viewId],
    rowMode: 'object',
    returnValue: 'resultRows',
  })[0] as Record<string, unknown> | undefined;

  if (!row) {
    return createViewStateSnapshot({ projectId, viewId, viewStateRevision: 0 });
  }

  let collapsed: readonly string[] = [];
  try {
    collapsed = JSON.parse(String(row.collapsed_node_ids ?? '[]'));
  } catch {
    collapsed = [];
  }

  return createViewStateSnapshot({
    projectId,
    viewId,
    viewStateRevision: Number(row.view_state_revision ?? 0),
    fields: {
      collapsedNodeIds: collapsed,
      zoomRootId: row.zoom_root_id ? String(row.zoom_root_id) : null,
      scrollTop: Number(row.scroll_top ?? 0),
      focusedThemeId: row.focused_theme_id ? String(row.focused_theme_id) : null,
      dateWindowStart: row.date_window_start ? String(row.date_window_start) : null,
      dateWindowEnd: row.date_window_end ? String(row.date_window_end) : null,
      granularity: (row.granularity as 'week' | 'month' | 'quarter') ?? null,
      panX: row.pan_x !== undefined && row.pan_x !== null ? Number(row.pan_x) : 0,
      panY: row.pan_y !== undefined && row.pan_y !== null ? Number(row.pan_y) : 0,
      scale: row.scale !== undefined && row.scale !== null ? Number(row.scale) : 1,
      navCollapsed: Number(row.nav_collapsed ?? 0) !== 0,
    },
  });
}

export function updateViewState(
  projectId: string,
  viewId: ViewId,
  baseRevision: number,
  patch: ViewStatePatch,
): { kind: 'Applied'; snapshot: ViewStateSnapshot } | { kind: 'StaleBase'; snapshot: ViewStateSnapshot } {
  // View-state writes bypass `apply`; refuse a database a newer tab has
  // upgraded (Story 22.15 AC 22.15-2/-3, review L2).
  if (db) assertWritableSchema(db);
  const current = queryViewState(projectId, viewId);
  if (current.viewStateRevision !== baseRevision) {
    return { kind: 'StaleBase', snapshot: current };
  }

  const nextFields = applyViewStatePatch(current.fields, patch);
  const nextRevision = current.viewStateRevision + 1;

  if (db) {
    db.exec({
      sql: `
        INSERT INTO view_state(
          project_id, view_id, view_state_revision, collapsed_node_ids, zoom_root_id,
          scroll_top, focused_theme_id, date_window_start, date_window_end, granularity,
          pan_x, pan_y, scale, nav_collapsed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, view_id) DO UPDATE SET
          view_state_revision = excluded.view_state_revision,
          collapsed_node_ids  = excluded.collapsed_node_ids,
          zoom_root_id        = excluded.zoom_root_id,
          scroll_top          = excluded.scroll_top,
          focused_theme_id    = excluded.focused_theme_id,
          date_window_start   = excluded.date_window_start,
          date_window_end     = excluded.date_window_end,
          granularity         = excluded.granularity,
          pan_x               = excluded.pan_x,
          pan_y               = excluded.pan_y,
          scale               = excluded.scale,
          nav_collapsed       = excluded.nav_collapsed
      `,
      bind: [
        projectId,
        viewId,
        nextRevision,
        JSON.stringify(nextFields.collapsedNodeIds),
        nextFields.zoomRootId,
        nextFields.scrollTop,
        nextFields.focusedThemeId,
        nextFields.dateWindowStart,
        nextFields.dateWindowEnd,
        nextFields.granularity,
        nextFields.panX,
        nextFields.panY,
        nextFields.scale,
        nextFields.navCollapsed ? 1 : 0,
      ],
    });
  }

  const updatedSnapshot = createViewStateSnapshot({
    projectId,
    viewId,
    viewStateRevision: nextRevision,
    fields: nextFields,
  });

  return { kind: 'Applied', snapshot: updatedSnapshot };
}

export function resetWorkerDatabase(): void {
  if (db) {
    // Reset is a durable mutation boundary and does not go through `apply`;
    // never wipe a database a newer tab has upgraded (Story 22.15 AC
    // 22.15-2/-3, review L2). `initWorkerDatabase` already rethrows a terminal
    // refusal, but a live upgrade after open is caught here.
    assertWritableSchema(db);
    // Story 25.2 AC 25.2-4: the wipe, schema baseline, workspace migration and
    // version marker are ONE transaction. A failure partway through rolls back
    // to the pre-reset store instead of leaving a half-wiped one.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        'DELETE FROM nodes; DELETE FROM phases; DELETE FROM unlock_edges; DELETE FROM node_custom_fields; DELETE FROM finding_dismissals; DELETE FROM affected_reasons; DELETE FROM node_open_questions; DELETE FROM forecast_scenarios; DELETE FROM forecast_plans; DELETE FROM view_state; DELETE FROM product_command_receipt; DELETE FROM projects;',
      );
      handler = new ProductCommandHandler(db);
      handler.initializeSchema();
      // Story 21.12 AC 3: the reset path must restore the same schema and
      // invariant state the open path guarantees. `initializeSchema()` only
      // runs the baseline DDL (`CREATE TABLE IF NOT EXISTS`), which is a no-op
      // on a legacy database whose `projects` table predates Epic 17 — so a
      // reset on such a database left `projects.workspace_id` missing and every
      // workspace-scoped query threw `no such column: workspace_id`. Run the
      // same ordered migration + backfill the open path runs (repository.worker
      // openDatabase: migrateWorkspaceSchema then ensureDefaultWorkspace).
      //
      // Workspaces / app_settings policy on reset: they are retained (the reset
      // wipes project data, not the workspace registry), and
      // `ensureDefaultWorkspace` re-resolves `active_workspace_id` against the
      // now-empty `projects` table — the "wipe projects, keep workspaces"
      // ambiguity is resolved in favour of keeping the registry, which is
      // exactly what the open path's invariant repair already guarantees.
      migrateWorkspaceSchema(db);
      ensureDefaultWorkspace(db);
      db.exec(`PRAGMA user_version = ${PRODUCT_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction may already be aborted */ }
      handler = new ProductCommandHandler(db);
      throw err;
    }
    workspaceSummaryCache.clear();
  }
}

// ── Portable snapshot query + batch import (E13 Tasks 2 & 4) ───────────────

import type {
  PortableNode,
  PortablePhase,
  PortableProjectSnapshot,
  PortableUnlockEdge,
  PortableNodeCustomField,
  PortableTypeTemplateField,
  PortableFindingDismissal,
  PortableAffectedReason,
  PortableNodeOpenQuestion,
  PortableForecastPlan,
  PortableForecastScenario,
} from '../../contracts/portable-file.schema';
import { readForecastPlan, readForecastScenarios, insertForecastScenario } from './forecast-operations';

function rowsOf(db: Database, sql: string, bind: readonly unknown[]): Record<string, unknown>[] {
  return db.exec({ sql, bind: bind as SqlValue[], rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[];
}

import type { SqlValue } from '@sqlite.org/sqlite-wasm';

/**
 * Reads one current authoritative portable snapshot for a project directly
 * from the durable tables (E13 Task 2). Excludes `view_state` and
 * `product_command_receipt` by contract; includes `finding_dismissals` and
 * `affected_reasons` as durable workflow facts.
 */
export function queryPortableSnapshot(projectId: string): PortableProjectSnapshot {
  if (!db) {
    throw new Error('STORAGE_NOT_READY');
  }

  const projRow = rowsOf(db, 'SELECT id, name, revision FROM projects WHERE id = ?', [projectId])[0];
  if (!projRow) {
    throw new Error('PROJECT_NOT_FOUND');
  }
  const projectName = String(projRow.name ?? '');
  const projectRevision = Number(projRow.revision ?? 0);

  const phaseRows = rowsOf(db, 'SELECT id, name, position FROM phases WHERE project_id = ? ORDER BY position ASC', [projectId]);
  const phases: PortablePhase[] = phaseRows.map((r) =>
    Object.freeze({ id: String(r.id), name: String(r.name), position: String(r.position) }),
  );

  const nodeRows = rowsOf(
    db,
    `SELECT id, parent_id, title, body_text, position, node_type, start_date, end_date,
            duration_days, schedule_source_mode, completed, effort_points, effort_points_done, strategic_weight, phase_id, delivery_status
     FROM nodes WHERE project_id = ? ORDER BY position ASC`,
    [projectId],
  );
  const nodes: PortableNode[] = nodeRows.map((r) =>
    Object.freeze({
      id: String(r.id),
      parentId: r.parent_id !== null && r.parent_id !== undefined ? String(r.parent_id) : null,
      title: String(r.title ?? ''),
      bodyText: r.body_text !== null && r.body_text !== undefined ? String(r.body_text) : null,
      position: String(r.position),
      nodeType: r.node_type !== null && r.node_type !== undefined ? String(r.node_type) : null,
      startDate: r.start_date !== null && r.start_date !== undefined ? String(r.start_date) : null,
      endDate: r.end_date !== null && r.end_date !== undefined ? String(r.end_date) : null,
      durationDays: r.duration_days !== null && r.duration_days !== undefined ? Number(r.duration_days) : null,
      scheduleSourceMode:
        r.schedule_source_mode !== null && r.schedule_source_mode !== undefined
          ? String(r.schedule_source_mode)
          : null,
      completed: Boolean(r.completed),
      effortPoints: r.effort_points !== null && r.effort_points !== undefined ? Number(r.effort_points) : null,
      effortPointsDone:
        r.effort_points_done !== null && r.effort_points_done !== undefined ? Number(r.effort_points_done) : null,
      strategicWeight:
        r.strategic_weight !== null && r.strategic_weight !== undefined ? Number(r.strategic_weight) : null,
      phaseId: r.phase_id !== null && r.phase_id !== undefined ? String(r.phase_id) : null,
      deliveryStatus: coerceDeliveryStatus(r.delivery_status),
    }) as PortableNode,
  );

  const edgeRows = rowsOf(db, 'SELECT id, source_node_id, target_node_id FROM unlock_edges WHERE project_id = ?', [projectId]);
  const unlockEdges: PortableUnlockEdge[] = edgeRows.map((r) =>
    Object.freeze({
      id: String(r.id),
      sourceNodeId: String(r.source_node_id),
      targetNodeId: String(r.target_node_id),
    }),
  );

  const customFieldRows = rowsOf(db, 'SELECT node_id, field_key, field_value FROM node_custom_fields WHERE project_id = ?', [projectId]);
  const nodeCustomFields: PortableNodeCustomField[] = customFieldRows.map((r) =>
    Object.freeze({
      nodeId: String(r.node_id),
      fieldKey: String(r.field_key),
      fieldValue: r.field_value !== null && r.field_value !== undefined ? String(r.field_value) : null,
    }),
  );

  const templateRows = rowsOf(db, 'SELECT node_type, field_key, field_label, position FROM type_template_fields WHERE project_id = ? ORDER BY position ASC', [projectId]);
  const typeTemplateFields: PortableTypeTemplateField[] = templateRows.map((r) =>
    Object.freeze({
      nodeType: String(r.node_type),
      fieldKey: String(r.field_key),
      fieldLabel: String(r.field_label),
      position: Number(r.position),
    }),
  );

  const dismissalRows = rowsOf(
    db,
    'SELECT finding_id, finding_kind, target_id, fingerprint, dismissed_at FROM finding_dismissals WHERE project_id = ?',
    [projectId],
  );
  const findingDismissals: PortableFindingDismissal[] = dismissalRows.map((r) =>
    Object.freeze({
      findingId: String(r.finding_id),
      findingKind: String(r.finding_kind),
      targetId: String(r.target_id),
      fingerprint: String(r.fingerprint),
      dismissedAt: String(r.dismissed_at),
    }),
  );

  const reasonRows = rowsOf(
    db,
    `SELECT id, affected_node_id, causal_node_id, causal_node_title, delta_days, causal_date_summary, created_at, acknowledged_at
     FROM affected_reasons WHERE project_id = ? ORDER BY created_at ASC`,
    [projectId],
  );
  const affectedReasons: PortableAffectedReason[] = reasonRows.map((r) =>
    Object.freeze({
      id: String(r.id),
      affectedNodeId: String(r.affected_node_id),
      causalNodeId: String(r.causal_node_id),
      causalNodeTitle: String(r.causal_node_title),
      deltaDays: Number(r.delta_days),
      causalDateSummary: String(r.causal_date_summary),
      createdAt: String(r.created_at),
      acknowledgedAt: r.acknowledged_at !== null && r.acknowledged_at !== undefined ? String(r.acknowledged_at) : null,
    }),
  );

  const questionRows = rowsOf(
    db,
    `SELECT id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
     FROM node_open_questions WHERE project_id = ? ORDER BY position ASC`,
    [projectId],
  );
  const openQuestions: PortableNodeOpenQuestion[] = questionRows.map((r) =>
    Object.freeze({
      id: String(r.id),
      nodeId: String(r.node_id),
      questionText: String(r.question_text ?? ''),
      status: String(r.status ?? 'OPEN') as 'OPEN' | 'DECIDED',
      decisionText: r.decision_text !== null && r.decision_text !== undefined ? String(r.decision_text) : null,
      position: String(r.position ?? 0),
      resolvedAtISO: r.resolved_at_iso !== null && r.resolved_at_iso !== undefined ? String(r.resolved_at_iso) : null,
      createdAtISO: String(r.created_at_iso ?? ''),
    }),
  );

  // Epic 18: the optional project-owned forecast plan (Story 18.2). Computed
  // results and receipts are absent by contract (AR-14, AD-21).
  const plan = readForecastPlan(db, projectId);
  let forecastPlan: PortableForecastPlan | undefined;
  if (plan) {
    forecastPlan = Object.freeze({
      selectedFeatureIds: plan.selectedFeatureIds,
      parallelGroups: plan.parallelGroups,
      ...(plan.blockedFeatureIds.length > 0 ? { blockedFeatureIds: plan.blockedFeatureIds } : {}),
      pointsPerSprint: plan.configuration.pointsPerSprint,
      sprintLengthDays: plan.configuration.sprintLengthDays,
      cadence: plan.configuration.cadence,
      startSprintOrdinal: plan.configuration.startSprintOrdinal,
      startDate: plan.configuration.startDate,
      policyVersion: plan.policyVersion,
      planningLevel: plan.planningLevel,
      roster: plan.roster,
      assignments: plan.assignments,
    });
  }

  // Epic 20, Story 20.4: saved historical scenarios travel with the file —
  // inputs only, validated as self-contained facts on import.
  const scenarios = readForecastScenarios(db, projectId);
  const forecastScenarios: PortableForecastScenario[] | undefined =
    scenarios.length > 0
      ? scenarios.map((s) =>
          Object.freeze({
            scenarioId: s.scenarioId,
            label: s.label,
            baselineRevision: s.baselineRevision,
            baselineFingerprint: s.baselineFingerprint,
            policyVersion: s.policyVersion,
            createdAtISO: s.createdAtISO,
            baseline: s.baseline,
            patch: s.patch,
          }),
        )
      : undefined;

  return Object.freeze({
    projectId,
    projectName,
    projectRevision,
    phases: Object.freeze(phases),
    nodes: Object.freeze(nodes),
    nodeCustomFields: Object.freeze(nodeCustomFields),
    typeTemplateFields: Object.freeze(typeTemplateFields),
    unlockEdges: Object.freeze(unlockEdges),
    findingDismissals: Object.freeze(findingDismissals),
    affectedReasons: Object.freeze(affectedReasons),
    openQuestions: Object.freeze(openQuestions),
    ...(forecastPlan ? { forecastPlan } : {}),
    ...(forecastScenarios ? { forecastScenarios: Object.freeze(forecastScenarios) } : {}),
  });
}

/**
 * Batch-imports a validated portable snapshot atomically (E13 Task 4).
 * One transaction inserts the project, phases, nodes in containment-safe
 * order (depth-first so parents precede children), custom/template fields,
 * unlock edges, dismissals, and affected reasons. Preserves stable IDs and
 * persisted sibling positions. Rejects a duplicate project identity without
 * overwriting. Any failure rolls back and leaves existing projects unchanged.
 */
export function batchImportPortable(
  snapshot: PortableProjectSnapshot,
  localFileStateJson?: string,
): { ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string } {
  if (!db) {
    return { ok: false, code: 'STORAGE_NOT_READY' };
  }
  if(localFileStateJson!==undefined){validateLocalSnapshot(snapshot);parseLocalFileState(localFileStateJson,snapshot);}
  // Portable import writes directly; refuse a database a newer tab has
  // upgraded (Story 22.15 AC 22.15-2/-3, review L2). Typed, not a throw — the
  // import result union carries a refusal code.
  try {
    assertWritableSchema(db);
  } catch (err) {
    if (err instanceof NewerSchemaVersionError || (err instanceof Error && err.name === 'NewerSchemaVersionError')) {
      return { ok: false, code: 'UNSUPPORTED_NEWER_SCHEMA' };
    }
    throw err;
  }
  const existing = rowsOf(db, 'SELECT id FROM projects WHERE id = ?', [snapshot.projectId])[0];
  if (existing) {
    return { ok: false, code: 'DUPLICATE_PROJECT_ID', cause: snapshot.projectId };
  }

  // Topological order: parents before children (pre-order walk of the
  // parent pointers is guaranteed acyclic by the validator; here we sort by
  // depth-first insertion so FK constraints hold).
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string | null, PortableNode[]>();
  for (const n of snapshot.nodes) {
    const key = n.parentId;
    const list = childrenByParent.get(key) ?? [];
    list.push(n);
    childrenByParent.set(key, list);
  }
  const ordered: PortableNode[] = [];
  const visit = (parentId: string | null): void => {
    const children = childrenByParent.get(parentId) ?? [];
    for (const child of children) {
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(null);
  // Any node whose parent was not a root (should not happen after validation,
  // but guard against orphaned cycles by appending leftovers).
  const orderedIds = new Set(ordered.map((n) => n.id));
  for (const n of snapshot.nodes) {
    if (!orderedIds.has(n.id)) ordered.push(n);
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    // An imported project joins the active workspace, like CreateProject: the
    // shelf and overview list only that workspace, so a NULL workspace_id left
    // a successful import invisible.
    db.exec({
      sql: 'INSERT INTO projects(id, name, revision, workspace_id) VALUES(?, ?, 1, ?)',
      bind: [snapshot.projectId, snapshot.projectName, readActiveWorkspaceId(db)],
    });
    for (const phase of snapshot.phases) {
      db.exec({
        sql: 'INSERT INTO phases(id, project_id, name, position) VALUES(?, ?, ?, ?)',
        bind: [phase.id, snapshot.projectId, phase.name, String(phase.position)],
      });
    }
    for (const node of ordered) {
      db.exec({
        sql: `INSERT INTO nodes(
                id, project_id, parent_id, title, body_text, position, node_type, start_date, end_date,
                duration_days, schedule_source_mode, completed, effort_points, effort_points_done, strategic_weight, phase_id, delivery_status
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          node.id,
          snapshot.projectId,
          node.parentId,
          node.title,
          node.bodyText,
          String(node.position),
          node.nodeType,
          node.startDate,
          node.endDate,
          node.durationDays,
          node.scheduleSourceMode,
          node.completed ? 1 : 0,
          node.effortPoints,
          node.effortPointsDone,
          node.strategicWeight,
          node.phaseId,
          node.deliveryStatus ?? 'not_started',
        ],
      });
    }
    for (const field of snapshot.nodeCustomFields) {
      db.exec({
        sql: 'INSERT INTO node_custom_fields(project_id, node_id, field_key, field_value) VALUES(?, ?, ?, ?)',
        bind: [snapshot.projectId, field.nodeId, field.fieldKey, field.fieldValue],
      });
    }
    for (const template of snapshot.typeTemplateFields) {
      db.exec({
        sql: 'INSERT INTO type_template_fields(project_id, node_type, field_key, field_label, position) VALUES(?, ?, ?, ?, ?)',
        bind: [snapshot.projectId, template.nodeType, template.fieldKey, template.fieldLabel, template.position],
      });
    }
    for (const edge of snapshot.unlockEdges) {
      db.exec({
        sql: 'INSERT INTO unlock_edges(id, project_id, source_node_id, target_node_id) VALUES(?, ?, ?, ?)',
        bind: [edge.id, snapshot.projectId, edge.sourceNodeId, edge.targetNodeId],
      });
    }
    for (const dismissal of snapshot.findingDismissals) {
      db.exec({
        sql: 'INSERT INTO finding_dismissals(project_id, finding_id, finding_kind, target_id, fingerprint, dismissed_at) VALUES(?, ?, ?, ?, ?, ?)',
        bind: [snapshot.projectId, dismissal.findingId, dismissal.findingKind, dismissal.targetId, dismissal.fingerprint, dismissal.dismissedAt],
      });
    }
    for (const reason of snapshot.affectedReasons) {
      db.exec({
        sql: `INSERT INTO affected_reasons(
                id, project_id, affected_node_id, causal_node_id, causal_node_title, delta_days,
                causal_date_summary, created_at, acknowledged_at
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          reason.id,
          snapshot.projectId,
          reason.affectedNodeId,
          reason.causalNodeId,
          reason.causalNodeTitle,
          reason.deltaDays,
          reason.causalDateSummary,
          reason.createdAt,
          reason.acknowledgedAt,
        ],
      });
    }
    for (const question of snapshot.openQuestions ?? []) {
      db.exec({
        sql: `INSERT INTO node_open_questions(
                id, project_id, node_id, question_text, status, decision_text, position, resolved_at_iso, created_at_iso
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          question.id,
          snapshot.projectId,
          question.nodeId,
          question.questionText,
          question.status,
          question.decisionText,
          String(question.position),
          question.resolvedAtISO,
          question.createdAtISO,
        ],
      });
    }
    // Epic 18: the optional project-owned forecast plan (Story 18.2). Import
    // validates completely before one transaction; the plan is inserted with
    // the rest of the project's durable facts.
    if (snapshot.forecastPlan) {
      db.exec({
        sql: `INSERT INTO forecast_plans(
                project_id, selected_feature_ids, parallel_groups, blocked_feature_ids, points_per_sprint,
                sprint_length_days, cadence, start_sprint_ordinal, start_date, policy_version, planning_level,
                roster, assignments
              ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          snapshot.projectId,
          JSON.stringify(snapshot.forecastPlan.selectedFeatureIds),
          JSON.stringify(snapshot.forecastPlan.parallelGroups.map((g) => ({ featureIds: g.featureIds }))),
          JSON.stringify(snapshot.forecastPlan.blockedFeatureIds ?? []),
          snapshot.forecastPlan.pointsPerSprint,
          snapshot.forecastPlan.sprintLengthDays,
          snapshot.forecastPlan.cadence,
          snapshot.forecastPlan.startSprintOrdinal,
          snapshot.forecastPlan.startDate,
          snapshot.forecastPlan.policyVersion,
          // Story 21.7 AC 7: the portable-import INSERT carries planning_level.
          // A v5 file has no level yet — normalize to the default (Story 21.8
          // will persist it in the v6 envelope).
          (snapshot.forecastPlan as { planningLevel?: string }).planningLevel ?? 'Feature',
          JSON.stringify((snapshot.forecastPlan as { roster?: readonly unknown[] }).roster ?? []),
          JSON.stringify((snapshot.forecastPlan as { assignments?: Record<string, readonly unknown[]> }).assignments ?? {}),
        ],
      });
    }
    // Epic 20, Story 20.4: saved scenarios, inside the same import transaction.
    for (const scenario of snapshot.forecastScenarios ?? []) {
      // Story 21.9 AC 4: a v5 scenario baseline has no planningLevel and its
      // facts carry the legacy isFeature boolean — normalize both on import
      // (baseline_json is TEXT; no migration). isFeature: true -> 'Feature',
      // false -> 'Theme' (a non-Feature type, preserving Feature-level
      // NOT_A_FEATURE behavior byte-identically).
      const rawLevel = (scenario.baseline as { planningLevel?: string }).planningLevel;
      const planningLevel: 'Theme' | 'Component' | 'Feature' =
        rawLevel === 'Theme' || rawLevel === 'Component' || rawLevel === 'Feature' ? rawLevel : 'Feature';
      const factMap: Record<string, { effortPoints: number | null; nodeType: string; projectId: string; ancestorIds: readonly string[] }> = {};
      for (const [id, fact] of Object.entries(scenario.baseline.factMap)) {
        const legacy = fact as { isFeature?: boolean; nodeType?: string };
        factMap[id] = {
          effortPoints: fact.effortPoints,
          nodeType: legacy.nodeType ?? (legacy.isFeature === true ? 'Feature' : 'Theme'),
          projectId: fact.projectId,
          ancestorIds: fact.ancestorIds,
        };
      }
      const baseline = {
        ...scenario.baseline,
        planningLevel,
        factMap,
      };
      insertForecastScenario(db, {
        scenarioId: scenario.scenarioId,
        projectId: snapshot.projectId,
        label: scenario.label,
        baselineRevision: scenario.baselineRevision,
        baselineFingerprint: scenario.baselineFingerprint,
        policyVersion: scenario.policyVersion as 'shared-capacity-v1',
        createdAtISO: scenario.createdAtISO,
        baseline,
        patch: scenario.patch,
      });
    }
    if(localFileStateJson!==undefined){ db.exec({sql:'INSERT INTO local_file_state(project_id,state_json) VALUES(?,?)',bind:[snapshot.projectId,localFileStateJson]}); }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // preserve original
    }
    return { ok: false, code: 'IMPORT_FAILED', cause: err instanceof Error ? err.message : String(err) };
  }
  workspaceSummaryCache.invalidate(snapshot.projectId);
  return { ok: true, projectId: snapshot.projectId, revision: 1 };
}

// ── Web Worker Message Handler ─────────────────────────────────────────────

if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function') {
  const workerScope = self as unknown as DedicatedWorkerGlobalScope;

  workerScope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)) return;

    try {
      if (data.type === 'Initialize') {
        await initWorkerDatabase();
        workerScope.postMessage({
          type: 'WorkerReady',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          isOpfs: isOpfsStorage,
        });
        return;
      }

      if (data.type === 'ResetDatabase') {
        await initWorkerDatabase();
        resetWorkerDatabase();
        workerScope.postMessage({
          type: 'DatabaseReset',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
        });
        return;
      }

      if (data.type === 'ReleaseStorage') {
        releaseStorage();
        workerScope.postMessage({
          type: 'StorageReleased',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
        });
        return;
      }

      if (data.type === 'ApplyProductCommandBatch') {
        const commands = validateProductCommandBatch(data.commands);
        const cmdHandler = await initWorkerDatabase();
        const results = validateProductCommandBatchResults(commands, cmdHandler.applyBatch(commands));
        if (results.every(result => result.type === 'ProductCommandApplied')) workspaceSummaryCache.invalidate(commands[0].projectId);
        workerScope.postMessage({ type: 'ProductCommandBatchResult', protocolVersion: PROTOCOL_VERSION, requestId: data.requestId, results });
        return;
      }
      if (data.type === 'ApplyProductCommand') {
        const cmdHandler = await initWorkerDatabase();
        const validated = validateProductCommand(data.command);
        const result = cmdHandler.applyLocal(validated);
        if (result.type === 'ProductCommandApplied') {
          workspaceSummaryCache.invalidate(result.projectId);
        }
        workerScope.postMessage({
          type: 'ProductCommandResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          result,
        });
        return;
      }

      if (data.type === 'ForgetCollaboration') {
        await initWorkerDatabase();
        const db = getDatabase()!;
        initializeCollaborationSchema(db);
        const { forgetCollaboration } = await import('./collaboration-outbox');
        forgetCollaboration(db, data.projectId);
        workerScope.postMessage({ type: 'CollaborationForgotten', protocolVersion: PROTOCOL_VERSION, requestId: data.requestId });
        return;
      }

      if (data.type === 'ReadCollaborationHistory') {
        await initWorkerDatabase();
        const db = getDatabase()!;
        initializeCollaborationSchema(db);
        const { readCollaborationHistoryRows } = await import('./collaboration-outbox');
        workerScope.postMessage({ type: 'CollaborationHistoryResult', protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId, rows: readCollaborationHistoryRows(db, data.projectId, data.before, data.limit) });
        return;
      }

      if (data.type === 'ReadCollaborationOutbox' || data.type === 'DiscardCollaborationOutboxEntry') {
        await initWorkerDatabase();
        const db = getDatabase()!;
        initializeCollaborationSchema(db);
        if (data.type === 'DiscardCollaborationOutboxEntry') {
          if (!data.commandId) throw new Error('Missing outbox command ID');
          deleteOutboxEntry(db, data.projectId, data.commandId);
        }
        workerScope.postMessage({ type: 'CollaborationOutboxResult', protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId, state: readOutbox(db, data.projectId) });
        return;
      }

      if (data.type === 'ApplyCommandWithOutbox') {
        const cmdHandler = await initWorkerDatabase();
        migrateActorSchema(getDatabase()!);
        initializeCollaborationSchema(getDatabase()!);
        const validated = validateProductCommand(data.command);
        // Command + durable outbox entry in ONE transaction (R4/H04).
        const result = cmdHandler.applyWithOutbox(validated, data.outbox, data.projectId);
        if (result.type === 'ProductCommandApplied') {
          workspaceSummaryCache.invalidate(result.projectId);
        }
        workerScope.postMessage({
          type: 'ProductCommandResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          result,
        });
        return;
      }

      if (data.type === 'ApplyGroupWithOutbox') {
        const cmdHandler = await initWorkerDatabase();
        migrateActorSchema(getDatabase()!);
        initializeCollaborationSchema(getDatabase()!);
        // A composite gesture: every member + its outbox entry in ONE transaction.
        const members = data.members.map((member) => ({ ...member, command: validateProductCommand(member.command) }));
        const results = cmdHandler.applyGroupWithOutbox(data.projectId, members, data.groupId);
        if (results.every((result) => result.type === 'ProductCommandApplied')) workspaceSummaryCache.invalidate(data.projectId);
        workerScope.postMessage({ type: 'ProductCommandBatchResult', protocolVersion: PROTOCOL_VERSION, requestId: data.requestId, results });
        return;
      }

      if (data.type === 'ApplyRebaseAtomic') {
        const cmdHandler = await initWorkerDatabase();
        migrateActorSchema(getDatabase()!);
        initializeCollaborationSchema(getDatabase()!);
        // The whole rebase in ONE transaction (R4/H04). The remote command is
        // validated; survivor commands were validated when first queued.
        const remote = { ...data.remote, command: validateProductCommand(data.remote.command) };
        const toReapply = data.toReapply.map((e) => ({ ...e, command: validateProductCommand(e.command) }));
        const remoteResult = await cmdHandler.applyConfirmedRebaseAtomic(data.projectId, remote, toReapply, data.rejected);
        if (remoteResult?.type === 'ProductCommandApplied') {
          workspaceSummaryCache.invalidate(remoteResult.projectId);
        }
        workerScope.postMessage({
          type: 'RebaseResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          result: remoteResult,
        });
        return;
      }

      if (data.type === 'LocalFileOperation') {
        await initWorkerDatabase(); if(!db)throw new Error('STORAGE_NOT_READY');
        const result=runLocalFileOperation(data); workspaceSummaryCache.invalidate(data.projectId);
        workerScope.postMessage({type:'LocalFileResult',protocolVersion:PROTOCOL_VERSION,requestId:data.requestId,result});return;
      }
      if (data.type === 'InstallCollaborationSnapshot') {
        const cmdHandler = await initWorkerDatabase();
        const outcome = await cmdHandler.installSnapshotAtomic(data.projectId, data.envelope);
        workspaceSummaryCache.invalidate(data.projectId);
        workerScope.postMessage({ type: 'SnapshotInstallResult', protocolVersion: PROTOCOL_VERSION, requestId: data.requestId, ...outcome });
        return;
      }

      if (data.type === 'QueryProjectNodes') {
        await initWorkerDatabase();
        const model = queryProjectNodes(data.projectId);
        workerScope.postMessage({
          type: 'ProjectNodesResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          model,
        });
        return;
      }

      if (data.type === 'QueryProjects') {
        await initWorkerDatabase();
        const projects = queryProjects();
        workerScope.postMessage({
          type: 'ProjectsResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          projects,
        });
        return;
      }

      if (data.type === 'QueryWorkspaceRegistry') {
        await initWorkerDatabase();
        workerScope.postMessage({
          type: 'WorkspaceRegistryResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          registry: queryWorkspaceRegistry(db!),
        });
        return;
      }

      if (data.type === 'MutateWorkspace') {
        await initWorkerDatabase();
        const m = data.mutation;
        let result: WorkspaceMutationResult;
        switch (m.kind) {
          case 'Create':
            result = createWorkspaceOp(db!, { workspaceId: m.workspaceId, name: m.name });
            break;
          case 'Rename':
            result = renameWorkspaceOp(db!, { workspaceId: m.workspaceId, name: m.name });
            break;
          case 'Delete':
            result = deleteWorkspaceOp(db!, { workspaceId: m.workspaceId });
            break;
          case 'SetActive':
            result = setActiveWorkspaceOp(db!, { workspaceId: m.workspaceId });
            break;
          case 'MoveProject':
            result = moveProjectToWorkspaceOp(db!, {
              projectId: m.projectId,
              workspaceId: m.workspaceId,
            });
            break;
        }
        workerScope.postMessage({
          type: 'WorkspaceMutationResponse',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          result,
        });
        return;
      }

      if (data.type === 'QueryWorkspaceOverview') {
        await initWorkerDatabase();
        const overview = queryWorkspaceOverview();
        workerScope.postMessage({
          type: 'WorkspaceOverviewResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          overview,
        });
        return;
      }

      if (data.type === 'QueryNodeEdges') {
        await initWorkerDatabase();
        const edges = queryNodeEdges(data.projectId, data.nodeId);
        workerScope.postMessage({
          type: 'NodeEdgesResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          edges,
        });
        return;
      }

      if (data.type === 'QuerySubtreeEdges') {
        await initWorkerDatabase();
        const edges = querySubtreeEdges(data.projectId, data.rootNodeId);
        workerScope.postMessage({
          type: 'SubtreeEdgesResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          edges,
        });
        return;
      }

      if (data.type === 'QueryDismissals') {
        await initWorkerDatabase();
        const dismissals = queryDismissals(data.projectId);
        workerScope.postMessage({
          type: 'DismissalsResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          dismissals,
        });
        return;
      }

      if (data.type === 'QueryAffectedReasons') {
        await initWorkerDatabase();
        const reasons = queryAffectedReasons(data.projectId);
        workerScope.postMessage({
          type: 'AffectedReasonsResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          reasons,
        });
        return;
      }

      if (data.type === 'QueryAnalysisSnapshot') {
        await initWorkerDatabase();
        const snapshot = queryAnalysisSnapshot(data.projectId);
        workerScope.postMessage({
          type: 'AnalysisSnapshotResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          snapshot,
        });
        return;
      }

      if (data.type === 'QueryViewState') {
        await initWorkerDatabase();
        const snapshot = queryViewState(data.projectId, data.viewId);
        workerScope.postMessage({
          type: 'ViewStateResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          snapshot,
        });
        return;
      }

      if (data.type === 'UpdateViewState') {
        await initWorkerDatabase();
        const outcome = updateViewState(data.projectId, data.viewId, data.baseRevision, data.patch);
        workerScope.postMessage({
          type: 'UpdateViewStateResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          outcome,
        });
        return;
      }

      if (data.type === 'QueryPortableSnapshot') {
        await initWorkerDatabase();
        const snapshot = queryPortableSnapshot(data.projectId);
        workerScope.postMessage({
          type: 'PortableSnapshotResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          snapshot,
        });
        return;
      }

      if (data.type === 'BatchImportPortable') {
        await initWorkerDatabase();
        const result = batchImportPortable(data.snapshot,data.localFileStateJson);
        workerScope.postMessage({
          type: 'BatchImportResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          result,
        });
        return;
      }

      if (data.type === 'GetStorageStatus') {
        await initWorkerDatabase();
        workerScope.postMessage({
          type: 'StorageStatusResult',
          protocolVersion: PROTOCOL_VERSION,
          requestId: data.requestId,
          isOpfs: isOpfsStorage,
        });
        return;
      }
    } catch (error) {
      // Story 21.12 Task 1: surface the failing statement and call site so a
      // schema error can never hide in console noise again.
      const message = error instanceof Error ? error.message : String(error);
      // A typed refusal (e.g. UNSUPPORTED_NEWER_SCHEMA) keeps its code so the
      // client can show the canonical guidance rather than a bare error string
      // (Story 22.15 AC 22.15-2, review L2).
      const code = (error as { code?: unknown } | null)?.code;
      console.error(`[repository.worker] ${data.type} failed: ${message}`, error);
      workerScope.postMessage({
        type: 'WorkerError',
        protocolVersion: PROTOCOL_VERSION,
        requestId: data.requestId,
        error: message,
        ...(typeof code === 'string' ? { code } : {}),
      });
    }
  });
}

export function runLocalFileOperation(data: Extract<WorkerRequest,{type:'LocalFileOperation'}>): string|null|void|{revision:number}|LocalFileRecovery {
 if(!db)throw new Error('STORAGE_NOT_READY');
 switch(data.operation){
 case 'read':return readLocalFileStateDb(db,data.projectId);
 case 'write':return writeLocalFileStateDb(db,data.projectId,data.expectedRevision!,data.stateJson!,()=>queryPortableSnapshot(data.projectId));
 case 'recovery':return readLocalFileRecoveryDb(db,data.projectId);
 case 'apply':if(!data.input||data.input.projectId!==data.projectId)throw new Error('INVALID_MERGE_REQUEST');return applyLocalFileMergeDb(db,data.input,()=>queryPortableSnapshot(data.projectId));
 case 'restore':return restoreLocalFileMergeDb(db,data.projectId,data.expectedRevision!,data.operationId!,()=>queryPortableSnapshot(data.projectId));
 }
}

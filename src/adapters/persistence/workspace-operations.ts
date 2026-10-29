/**
 * Workspace registry operations (Epic 17).
 *
 * All SQL for the `workspaces` table, the `projects.workspace_id` column, and
 * the `active_workspace_id` app setting. Kept out of repository.worker.ts so
 * that file stays the message-dispatch surface rather than growing a second
 * domain's worth of queries.
 *
 * These are NOT ProductCommands — see the header of `contracts/workspace.ts`
 * for why. There is no baseRevision, no receipt, and no ChangeSet: a workspace
 * mutation is applied directly, the same way `updateViewState` is.
 *
 * Every mutation returns the full refreshed registry rather than a delta. The
 * list is bounded by how many workspaces a person will realistically make
 * (tens, not thousands), so re-reading it is cheaper than maintaining an
 * invalidation protocol, and it means the caller can never render a switcher
 * built from a stale count.
 */

import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { assertWritableSchema } from './schema';
import {
  createWorkspaceRegistry,
  ACTIVE_WORKSPACE_SETTING_KEY,
  type WorkspaceRegistry,
  type WorkspaceRow,
  type WorkspaceMutationResult,
} from '../../contracts/workspace';
import {
  validateWorkspaceName,
  decideWorkspaceDelete,
  DEFAULT_WORKSPACE_NAME,
} from '../../domain/workspace/workspace.policy';

type Row = Record<string, SqlValue>;

function rows(db: Database, sql: string, bind?: readonly SqlValue[]): Row[] {
  return db.exec({
    sql,
    ...(bind ? { bind } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Row[];
}

function rejected(
  code: Extract<WorkspaceMutationResult, { type: 'WorkspaceMutationRejected' }>['code'],
  projectCount?: number,
): WorkspaceMutationResult {
  return Object.freeze({
    type: 'WorkspaceMutationRejected',
    code,
    ...(projectCount === undefined ? {} : { projectCount }),
  } as const);
}

// ── Schema migration ───────────────────────────────────────────────────────

/**
 * Epic 17: adds the `workspaces` table, the `app_settings` table, and the
 * `projects.workspace_id` column to an existing database.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column is guarded by a
 * `PRAGMA table_info` check, matching migrateViewStateViewportColumns(). Safe
 * to run on every startup; fresh databases already carry all three from the
 * baseline DDL and only the (idempotent) backfill in ensureDefaultWorkspace
 * does any work.
 */
export function migrateWorkspaceSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspaces(
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    position INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS workspaces_by_position ON workspaces(position)');
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings(
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const cols = rows(db, 'PRAGMA table_info(projects)');
  const names = new Set(cols.map((r) => String(r.name)));
  if (!names.has('workspace_id')) {
    // No REFERENCES clause on ADD COLUMN: SQLite permits it, but the added
    // column would be NULL for every existing row and an immediate FK check
    // on a NULL is a no-op anyway. The constraint that matters — refusing to
    // drop a workspace that still holds projects — is enforced for freshly
    // created databases by the baseline DDL and for every database by
    // decideWorkspaceDelete(). Keeping ADD COLUMN unconstrained avoids a full
    // table rebuild on a file that is the user's only copy of their work.
    db.exec('ALTER TABLE projects ADD COLUMN workspace_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS projects_by_workspace ON projects(workspace_id, name)');
  }
}

// ── Invariant repair ───────────────────────────────────────────────────────

/**
 * Guarantee the two invariants the rest of the feature assumes:
 *   1. At least one workspace exists.
 *   2. Every project has a non-null workspace_id.
 *   3. `active_workspace_id` resolves to a workspace that actually exists.
 *
 * Runs on every database open. Idempotent, and cheap once satisfied (three
 * indexed reads and no writes).
 *
 * Returns the resolved active workspace id.
 */
export function ensureDefaultWorkspace(db: Database): string {
  // This repair WRITES (it backfills projects and repoints the active
  // workspace), and it is reachable from read paths — `queryWorkspaceRegistry`
  // runs it on every `QueryWorkspaceRegistry` message. Guard it here so a live
  // upgrade by another tab can never be mutated through a "read"
  // (Story 22.15 AC 22.15-2/-3, review L2). Callers that already own the open
  // transaction (prepareProductDatabase) have checked the same thing first.
  assertWritableSchema(db);
  let existing = rows(db, 'SELECT id, position FROM workspaces ORDER BY position ASC, id ASC');

  if (existing.length === 0) {
    const id = createUuidV7();
    db.exec({
      sql: 'INSERT INTO workspaces(id, name, position) VALUES(?, ?, 0)',
      bind: [id, DEFAULT_WORKSPACE_NAME],
    });
    existing = [{ id, position: 0 }];
  }

  const fallbackId = String(existing[0].id);

  // Backfill: any project without a home lands in the lowest-positioned
  // workspace. This is the one-time migration for every project that existed
  // before workspaces did.
  db.exec({
    sql: 'UPDATE projects SET workspace_id = ? WHERE workspace_id IS NULL',
    bind: [fallbackId],
  });

  // A project can also be orphaned by a workspace row disappearing out from
  // under it (a hand-edited database, or a restore from a backup taken at a
  // different point). Re-home rather than leaving it unreachable in every
  // workspace-scoped query.
  db.exec({
    sql: `UPDATE projects SET workspace_id = ?
          WHERE workspace_id NOT IN (SELECT id FROM workspaces)`,
    bind: [fallbackId],
  });

  const stored = rows(db, 'SELECT value FROM app_settings WHERE key = ?', [
    ACTIVE_WORKSPACE_SETTING_KEY,
  ])[0];
  const storedId = stored ? String(stored.value) : null;
  const storedIsValid =
    storedId !== null && existing.some((w) => String(w.id) === storedId);

  if (!storedIsValid) {
    writeActiveWorkspaceId(db, fallbackId);
    return fallbackId;
  }
  return storedId;
}

function writeActiveWorkspaceId(db: Database, workspaceId: string): void {
  db.exec({
    sql: `INSERT INTO app_settings(key, value) VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    bind: [ACTIVE_WORKSPACE_SETTING_KEY, workspaceId],
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────

export function queryWorkspaceRegistry(db: Database): WorkspaceRegistry {
  const activeWorkspaceId = ensureDefaultWorkspace(db);

  const workspaceRows = rows(
    db,
    `SELECT w.id, w.name, w.position, COUNT(p.id) AS project_count
       FROM workspaces w
       LEFT JOIN projects p ON p.workspace_id = w.id
      GROUP BY w.id, w.name, w.position
      ORDER BY w.position ASC, w.name ASC`,
  );

  const workspaces: WorkspaceRow[] = workspaceRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    position: Number(r.position),
    projectCount: Number(r.project_count ?? 0),
  }));

  return createWorkspaceRegistry(workspaces, activeWorkspaceId);
}

export function getActiveWorkspaceId(db: Database): string {
  return ensureDefaultWorkspace(db);
}

/**
 * Read the active workspace pointer WITHOUT repairing anything.
 *
 * ensureDefaultWorkspace() writes (it backfills and repoints), which makes it
 * the wrong thing to call from inside a caller's open transaction — notably
 * ProductCommandHandler's CreateProject, which needs to stamp the new row's
 * workspace_id inside its own BEGIN IMMEDIATE. By then the invariants already
 * hold, because ensureDefaultWorkspace ran at database open.
 *
 * Falls back to the lowest-positioned workspace, then to null if the store
 * genuinely has no workspaces (only reachable if this is called before the
 * database was opened through openDatabase()).
 */
export function readActiveWorkspaceId(db: Database): string | null {
  const stored = rows(db, 'SELECT value FROM app_settings WHERE key = ?', [
    ACTIVE_WORKSPACE_SETTING_KEY,
  ])[0];
  if (stored) {
    const id = String(stored.value);
    if (workspaceExists(db, id)) return id;
  }
  const first = rows(
    db,
    'SELECT id FROM workspaces ORDER BY position ASC, id ASC LIMIT 1',
  )[0];
  return first ? String(first.id) : null;
}

function countProjectsIn(db: Database, workspaceId: string): number {
  const row = rows(db, 'SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?', [
    workspaceId,
  ])[0];
  return Number(row?.n ?? 0);
}

function workspaceExists(db: Database, workspaceId: string): boolean {
  return rows(db, 'SELECT id FROM workspaces WHERE id = ?', [workspaceId]).length > 0;
}

// ── Mutations ──────────────────────────────────────────────────────────────

/**
 * Create a workspace and make it active.
 *
 * Switching to the new workspace immediately is deliberate: the user just
 * named a place to put work, so landing them anywhere else would make the
 * next action ("put something in it") harder to find.
 */
export function createWorkspaceOp(
  db: Database,
  input: { workspaceId: string; name: string },
): WorkspaceMutationResult {
  assertWritableSchema(db);
  const validation = validateWorkspaceName(input.name);
  if (!validation.valid) {
    return rejected('INVALID_WORKSPACE_NAME');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const maxRow = rows(db, 'SELECT MAX(position) AS p FROM workspaces')[0];
    const nextPosition = maxRow?.p === null || maxRow?.p === undefined ? 0 : Number(maxRow.p) + 1;

    db.exec({
      sql: 'INSERT INTO workspaces(id, name, position) VALUES(?, ?, ?)',
      bind: [input.workspaceId, validation.trimmed, nextPosition],
    });
    writeActiveWorkspaceId(db, input.workspaceId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }

  return Object.freeze({
    type: 'WorkspaceMutationApplied',
    registry: queryWorkspaceRegistry(db),
  } as const);
}

export function renameWorkspaceOp(
  db: Database,
  input: { workspaceId: string; name: string },
): WorkspaceMutationResult {
  assertWritableSchema(db);
  if (!workspaceExists(db, input.workspaceId)) {
    return rejected('WORKSPACE_NOT_FOUND');
  }
  const validation = validateWorkspaceName(input.name);
  if (!validation.valid) {
    return rejected('INVALID_WORKSPACE_NAME');
  }

  db.exec({
    sql: 'UPDATE workspaces SET name = ? WHERE id = ?',
    bind: [validation.trimmed, input.workspaceId],
  });

  return Object.freeze({
    type: 'WorkspaceMutationApplied',
    registry: queryWorkspaceRegistry(db),
  } as const);
}

/**
 * Delete an empty workspace.
 *
 * Refused while it still holds projects, and refused for the last remaining
 * workspace — see decideWorkspaceDelete(). Deleting a workspace never touches
 * a project.
 */
export function deleteWorkspaceOp(
  db: Database,
  input: { workspaceId: string },
): WorkspaceMutationResult {
  assertWritableSchema(db);
  if (!workspaceExists(db, input.workspaceId)) {
    return rejected('WORKSPACE_NOT_FOUND');
  }

  const projectCount = countProjectsIn(db, input.workspaceId);
  const totalWorkspaceCount = Number(
    rows(db, 'SELECT COUNT(*) AS n FROM workspaces')[0]?.n ?? 0,
  );

  const decision = decideWorkspaceDelete({ projectCount, totalWorkspaceCount });
  if (!decision.allowed) {
    return rejected(decision.cause, decision.projectCount);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec({ sql: 'DELETE FROM workspaces WHERE id = ?', bind: [input.workspaceId] });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  }

  // If the deleted workspace was active, ensureDefaultWorkspace (called by
  // queryWorkspaceRegistry) repoints the pointer at a surviving workspace.
  return Object.freeze({
    type: 'WorkspaceMutationApplied',
    registry: queryWorkspaceRegistry(db),
  } as const);
}

/**
 * Re-home a project into a different workspace.
 *
 * One UPDATE, and deliberately does NOT bump the project's revision:
 * `projects.revision` is the optimistic-concurrency token for the command
 * pipeline, and workspace membership is not project content. Bumping it would
 * invalidate the workspace summary cache and every in-flight command's
 * baseRevision for a change that altered no node, phase, or edge.
 */
export function moveProjectToWorkspaceOp(
  db: Database,
  input: { projectId: string; workspaceId: string },
): WorkspaceMutationResult {
  assertWritableSchema(db);
  if (!workspaceExists(db, input.workspaceId)) {
    return rejected('WORKSPACE_NOT_FOUND');
  }
  const project = rows(db, 'SELECT id FROM projects WHERE id = ?', [input.projectId])[0];
  if (!project) {
    return rejected('PROJECT_NOT_FOUND');
  }

  db.exec({
    sql: 'UPDATE projects SET workspace_id = ? WHERE id = ?',
    bind: [input.workspaceId, input.projectId],
  });

  return Object.freeze({
    type: 'WorkspaceMutationApplied',
    registry: queryWorkspaceRegistry(db),
  } as const);
}

export function setActiveWorkspaceOp(
  db: Database,
  input: { workspaceId: string },
): WorkspaceMutationResult {
  assertWritableSchema(db);
  if (!workspaceExists(db, input.workspaceId)) {
    return rejected('WORKSPACE_NOT_FOUND');
  }
  writeActiveWorkspaceId(db, input.workspaceId);
  return Object.freeze({
    type: 'WorkspaceMutationApplied',
    registry: queryWorkspaceRegistry(db),
  } as const);
}

/**
 * Durable outbox store (Story 27.7, R4).
 *
 * The local outbox must survive a crash: a locally committed edit is durable
 * before acknowledgement. This store keeps the queue in `app_settings`-style
 * project-local SQLite rows (a dedicated table), so restarting the app with a
 * non-empty queue loses nothing. It is adapter code; the decision logic lives in
 * `application/collaboration/sync-client.ts`.
 *
 * Only composed when the `collaboration` flag is on (AD-20). A local project
 * never creates this table.
 */

import type { Database, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { ProductCommand } from '../../contracts/repository-commands';
import { validateProductCommand } from '../../contracts/repository-commands';
import type { OutboxEntry, OutboxState } from '../../application/collaboration/sync-client';

export const OUTBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS collaboration_outbox(
  project_id       TEXT NOT NULL,
  command_id       TEXT NOT NULL,
  command_json     TEXT NOT NULL,
  commit_attempt_id INTEGER NOT NULL,
  queued_at_iso    TEXT NOT NULL,
  group_id         TEXT,
  group_index      INTEGER,
  PRIMARY KEY (project_id, command_id)
)`;

/**
 * Queue order: commit time, with a composite gesture's members kept together
 * and in gesture order (UUIDv7 ids are not ordered within one millisecond).
 */
export const OUTBOX_ORDER = 'queued_at_iso, COALESCE(group_id, command_id), COALESCE(group_index, 0), command_id';

export const CURSOR_SCHEMA = `CREATE TABLE IF NOT EXISTS collaboration_cursor(
  project_id TEXT PRIMARY KEY,
  cursor     INTEGER NOT NULL,
  stream_epoch INTEGER,
  recovery_required INTEGER NOT NULL DEFAULT 0,
  recovery_reason TEXT
)`;

/**
 * Corrupt outbox rows are quarantined visibly (H05) instead of being silently
 * dropped, so the user learns that queued work could not be read rather than
 * losing it without notice. A quarantined row is kept for inspection/recovery.
 */
export const QUARANTINE_SCHEMA = `CREATE TABLE IF NOT EXISTS collaboration_outbox_quarantine(
  project_id   TEXT NOT NULL,
  command_id   TEXT NOT NULL,
  raw_json     TEXT,
  quarantined_at_iso TEXT NOT NULL,
  PRIMARY KEY (project_id, command_id)
)`;

// Sidecars are excluded from PRODUCT_SCHEMA_DDL's authored checkpoint enumeration.
export const COLLABORATION_JOURNAL_DDL = [OUTBOX_SCHEMA, CURSOR_SCHEMA, QUARANTINE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS collaboration_confirmed_state(project_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS collaboration_attempt_receipt(project_id TEXT NOT NULL, command_id TEXT NOT NULL, commit_attempt_id INTEGER NOT NULL, command_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(project_id, command_id, commit_attempt_id))`,
  `CREATE TABLE IF NOT EXISTS collaboration_rejections(project_id TEXT NOT NULL, command_id TEXT NOT NULL, command_json TEXT NOT NULL, commit_attempt_id INTEGER NOT NULL, queued_at_iso TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(project_id, command_id))`,
  `CREATE TABLE IF NOT EXISTS collaboration_quarantine_metadata(recovery_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, command_id TEXT NOT NULL, metadata_json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS collaboration_rejections_by_project ON collaboration_rejections(project_id)`,
  `CREATE TABLE IF NOT EXISTS collaboration_authoritative_history(project_id TEXT NOT NULL, stream_epoch INTEGER NOT NULL, server_revision INTEGER NOT NULL, entry_json TEXT NOT NULL, PRIMARY KEY(project_id,stream_epoch,server_revision))`,
  `CREATE TABLE IF NOT EXISTS collaboration_recovery_envelope(project_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS collaboration_recovery_archive(recovery_id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, prior_epoch INTEGER, prior_cursor INTEGER NOT NULL, reason TEXT NOT NULL, archive_json TEXT NOT NULL, created_at_iso TEXT NOT NULL)`,
] as const;
export function initializeCollaborationSchema(db: Database): void {
  for (const ddl of COLLABORATION_JOURNAL_DDL) db.exec(ddl);
  const columns = new Set(rows(db, 'PRAGMA table_info(collaboration_cursor)').map(row => String(row.name)));
  for (const [name, declaration] of [['stream_epoch', 'INTEGER'], ['recovery_required', 'INTEGER NOT NULL DEFAULT 0'], ['recovery_reason', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE collaboration_cursor ADD COLUMN ${name} ${declaration}`);
  }
  const outboxColumns = new Set(rows(db, 'PRAGMA table_info(collaboration_outbox)').map(row => String(row.name)));
  for (const [name, declaration] of [['group_id', 'TEXT'], ['group_index', 'INTEGER']]) {
    if (!outboxColumns.has(name)) db.exec(`ALTER TABLE collaboration_outbox ADD COLUMN ${name} ${declaration}`);
  }
}

function rows(db: Database, sql: string, bind?: readonly SqlValue[]): Record<string, SqlValue>[] {
  return db.exec({
    sql,
    ...(bind ? { bind } : {}),
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as unknown as Record<string, SqlValue>[];
}

/**
 * The project is local again (owner stopped sharing): drop its sync state in
 * one transaction so local-only behaviour (atomic composite gestures) returns.
 * Retained rejected work, quarantined rows and recovery archives are kept.
 */
export function forgetCollaboration(db: Database, projectId: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['collaboration_cursor', 'collaboration_outbox', 'collaboration_confirmed_state', 'collaboration_attempt_receipt', 'collaboration_authoritative_history', 'collaboration_recovery_envelope']) {
      db.exec({ sql: `DELETE FROM ${table} WHERE project_id = ?`, bind: [projectId] });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** One confirmed authoritative history row (activity/attribution, 27.8). */
export interface CollaborationHistoryRow {
  readonly serverRevision: number;
  readonly streamEpoch: number;
  readonly entry: unknown;
}

/** Newest-first confirmed history in the current stream epoch, paged. */
export function readCollaborationHistoryRows(db: Database, projectId: string, before: number | null, limit: number): CollaborationHistoryRow[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (before !== null && (!Number.isSafeInteger(before) || before < 1))) throw new Error('HISTORY_PAGE_INVALID');
  const epoch = rows(db, 'SELECT stream_epoch FROM collaboration_cursor WHERE project_id = ?', [projectId])[0]?.stream_epoch;
  if (epoch === undefined || epoch === null) return [];
  const found = rows(db, `SELECT server_revision, entry_json FROM collaboration_authoritative_history
    WHERE project_id = ? AND stream_epoch = ? AND server_revision < ? ORDER BY server_revision DESC LIMIT ?`,
  [projectId, epoch, before ?? Number.MAX_SAFE_INTEGER, limit]);
  const result: CollaborationHistoryRow[] = [];
  for (const row of found) {
    try {
      result.push(Object.freeze({ serverRevision: Number(row.server_revision), streamEpoch: Number(epoch), entry: JSON.parse(String(row.entry_json)) as unknown }));
    } catch { /* A malformed row is skipped rather than failing the page. */ }
  }
  return result;
}

export function isValidQueuedAtISO(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60;
}

function parsedEntry(projectId: string, row: Record<string, SqlValue>): OutboxEntry {
  if (typeof row.command_id !== 'string' || typeof row.command_json !== 'string' || typeof row.commit_attempt_id !== 'number' || typeof row.queued_at_iso !== 'string') throw new Error('OUTBOX_METADATA_INVALID');
  const command = JSON.parse(row.command_json) as ProductCommand;
  validateProductCommand(command);
  if (command.commandId !== row.command_id || command.projectId !== projectId || !Number.isSafeInteger(row.commit_attempt_id) || row.commit_attempt_id < 1 || !isValidQueuedAtISO(row.queued_at_iso)) throw new Error('OUTBOX_METADATA_INVALID');
  const group = parsedGroup(row);
  return Object.freeze({ commandId: row.command_id, command, commitAttemptId: row.commit_attempt_id, queuedAtISO: row.queued_at_iso, ...group });
}

/** Composite-gesture membership of an outbox row; both columns or neither. */
function parsedGroup(row: Record<string, SqlValue>): { groupId?: string; groupIndex?: number } {
  if (row.group_id == null && row.group_index == null) return {};
  if (typeof row.group_id !== 'string' || !row.group_id.length || row.group_id.length > 128
    || typeof row.group_index !== 'number' || !Number.isSafeInteger(row.group_index) || row.group_index < 0) throw new Error('OUTBOX_GROUP_INVALID');
  return { groupId: row.group_id, groupIndex: row.group_index };
}
function metadataJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? { integer: item.toString() } : item instanceof Uint8Array ? { blob: [...item] } : item);
}
function quarantineRow(db: Database, projectId: string, table: 'collaboration_outbox' | 'collaboration_rejections', row: Record<string, SqlValue>, atISO: string): string {
  const commandId = typeof row.command_id === 'string' ? row.command_id : `invalid-value:${metadataJson(row.command_id)}`;
  const raw = typeof row.command_json === 'string' ? row.command_json : metadataJson(row.command_json);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec({ sql: 'INSERT OR REPLACE INTO collaboration_outbox_quarantine VALUES(?, ?, ?, ?)', bind: [projectId, commandId, raw, atISO] });
    db.exec({ sql: 'INSERT INTO collaboration_quarantine_metadata(project_id, command_id, metadata_json) VALUES(?, ?, ?)', bind: [projectId, commandId, metadataJson({ source: table, projectId, ...row })] });
    db.exec({ sql: `DELETE FROM ${table} WHERE project_id = ? AND command_id IS ?`, bind: [projectId, row.command_id] });
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve error */ } throw error; }
  return commandId;
}
export function readOutbox(db: Database, projectId: string, quarantineAtISO = new Date().toISOString()): OutboxState {
  const corrupt: string[] = [];
  const entries: OutboxEntry[] = [];
  const rejected: Readonly<OutboxEntry & { reason: string }>[] = [];
  for (const table of ['collaboration_outbox', 'collaboration_rejections'] as const) {
    const columns = table === 'collaboration_rejections' ? 'command_id, command_json, commit_attempt_id, queued_at_iso, reason' : 'command_id, command_json, commit_attempt_id, queued_at_iso, group_id, group_index';
    const order = table === 'collaboration_rejections' ? 'queued_at_iso, command_id' : OUTBOX_ORDER;
    for (const row of rows(db, `SELECT ${columns} FROM ${table} WHERE project_id = ? ORDER BY ${order}`, [projectId])) {
      try {
        const entry = parsedEntry(projectId, row);
        if (table === 'collaboration_rejections') {
          if (typeof row.reason !== 'string' || !row.reason.length || row.reason.length > 256) throw new Error('REJECTION_REASON_INVALID');
          rejected.push(Object.freeze({ ...entry, reason: row.reason }));
        } else entries.push(entry);
      } catch {
        try { corrupt.push(quarantineRow(db, projectId, table, row, quarantineAtISO)); }
        catch { corrupt.push(String(row.command_id)); }
      }
    }
  }
  const cursor = rows(db, 'SELECT cursor, stream_epoch, recovery_required, recovery_reason FROM collaboration_cursor WHERE project_id = ?', [projectId])[0];
  return Object.freeze({ entries: Object.freeze(entries), rejected: Object.freeze(rejected), cursor: cursor ? Number(cursor.cursor) : 0, resyncRequired: false,
    streamEpoch: cursor?.stream_epoch == null ? null : Number(cursor.stream_epoch), recoveryRequired: Boolean(cursor?.recovery_required), recoveryReason: cursor?.recovery_reason == null ? null : String(cursor.recovery_reason),
    corrupt: Object.freeze([...new Set([...corrupt, ...rows(db, 'SELECT command_id FROM collaboration_outbox_quarantine WHERE project_id = ?', [projectId]).map((r) => String(r.command_id))])].sort()),
  });
}

/**
 * Commit a locally applied edit into the durable outbox in one transaction, so
 * the queue entry is durable before the edit is acknowledged (R4).
 */
export function putOutboxEntry(db: Database, projectId: string, entry: OutboxEntry): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec({
      sql: `INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso, group_id, group_index)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, command_id) DO UPDATE SET
              command_json = excluded.command_json,
              commit_attempt_id = excluded.commit_attempt_id,
              queued_at_iso = excluded.queued_at_iso`,
      bind: [projectId, entry.commandId, JSON.stringify(entry.command), entry.commitAttemptId, entry.queuedAtISO, entry.groupId ?? null, entry.groupIndex ?? null],
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve */ }
    throw error;
  }
}

/** Remove one rejected/abandoned entry from the durable queue. */
export function deleteOutboxEntry(db: Database, projectId: string, commandId: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (rows(db, 'SELECT command_id FROM collaboration_outbox WHERE project_id = ? AND command_id = ?', [projectId, commandId]).length) throw new Error('ACTIVE_OUTBOX_DISCARD_REQUIRES_REBASE');
    for (const table of ['collaboration_rejections', 'collaboration_outbox_quarantine', 'collaboration_quarantine_metadata']) db.exec({ sql: `DELETE FROM ${table} WHERE project_id = ? AND command_id = ?`, bind: [projectId, commandId] });
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve error */ } throw error; }
}

/** Remove confirmed entries and advance the cursor in one transaction. */
export function confirmOutboxEntries(db: Database, projectId: string, commandIds: readonly string[], cursor: number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const commandId of commandIds) {
      db.exec({
        sql: 'DELETE FROM collaboration_outbox WHERE project_id = ? AND command_id = ?',
        bind: [projectId, commandId],
      });
    }
    db.exec({
      sql: `INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, ?)
            ON CONFLICT(project_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`,
      bind: [projectId, cursor],
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve */ }
    throw error;
  }
}

import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { prepareProductDatabase } from './repository.worker';
import { PRODUCT_SCHEMA_VERSION, readUserVersion } from './schema';
import { readOutbox, isValidQueuedAtISO, deleteOutboxEntry } from './collaboration-outbox';
import { createSetNodeTitleWireCommand, createCreateProjectCommand, type ProductCommand } from '../../contracts/repository-commands';
import { createSetNodeTitleCommand } from '../../domain/tree/set-node-title.command';
import { createCreateProjectCommand as domainProject } from '../../domain/project/create-project.command';

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
beforeAll(async () => { sqlite3 = await sqlite3InitModule(); });
const P = '019ffe00-0000-7000-8000-000000000001';
const N = '019ffe00-0000-7000-8000-000000000002';
const id = (n: number) => `019ffe00-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
function rows(db: Database, sql: string): Record<string, unknown>[] { return db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) as unknown as Record<string, unknown>[]; }
function dump(db: Database) { return Object.fromEntries(rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => [String(r.name), rows(db, `SELECT * FROM ${String(r.name)} ORDER BY rowid`)])); }
function fixture() {
  const db = new sqlite3.oo1.DB(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const handler = prepareProductDatabase(db);
  handler.apply(createCreateProjectCommand(domainProject({ commandId: id(10), projectId: P, name: 'Synthetic' })));
  db.exec({ sql: 'INSERT INTO nodes(id,project_id,title,position) VALUES(?,?,?,?)', bind: [N, P, 'Confirmed', 1000] });
  db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id,cursor) VALUES(?,1)', bind: [P] });
  const command = (n: number, baseRevision = 1) => createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: id(n), projectId: P, nodeId: N, baseRevision, title: `Synthetic ${n}` }));
  const outbox = (c: ReturnType<typeof command>, attempt = 1) => ({ commandId: c.commandId, commandJson: JSON.stringify(c), commitAttemptId: attempt, queuedAtISO: '2026-10-05T00:00:00Z' });
  return { db, handler, command, outbox };
}

describe('coordinated collaboration schema v18 and recovery parity', () => {
  it('normalizes declared null MoveNode anchors on server echo and refuses authored anchor changes', () => {
    const { db, handler } = fixture();
    try {
      const anchored: ProductCommand = { type: 'MoveNode', protocolVersion: '1.0.0', commandId: id(11), projectId: P, baseRevision: 1, expectedRevision: 2, nodeId: N, newParentId: null, newPosition: '1000', afterId: null, beforeId: null, intendedIndex: 0 };
      const queue = { commandId: anchored.commandId, commandJson: JSON.stringify(anchored), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' };
      expect(handler.applyWithOutbox(anchored, queue, P).type).toBe('ProductCommandApplied');
      const echoed = Object.fromEntries(Object.entries(anchored).filter(([key]) => key !== 'afterId' && key !== 'beforeId')) as ProductCommand;
      handler.applyRebaseAtomic(P, { command: { ...echoed, actorId: id(99) }, ownEcho: true, serverRevision: 2 }, [], []);
      expect(readOutbox(db, P).entries).toEqual([]);
      db.exec({ sql: 'INSERT INTO nodes(id,project_id,title,position) VALUES(?,?,?,?)', bind: [id(3), P, 'Sibling', 2000] });
      const next: ProductCommand = { ...anchored, commandId: id(12), baseRevision: 2, expectedRevision: 3, beforeId: id(3) };
      handler.applyWithOutbox(next, { ...queue, commandId: next.commandId, commandJson: JSON.stringify(next) }, P);
      const before = dump(db);
      expect(() => handler.applyRebaseAtomic(P, { command: { ...next, afterId: id(3) }, ownEcho: true, serverRevision: 3 }, [], [])).toThrow();
      expect(dump(db)).toEqual(before);
    } finally { db.close(); }
  });
  it('preserves every corrupt envelope when active, rejected and later rows share one command ID', () => {
    const { db } = fixture();
    try {
      const commandId = id(30);
      db.exec({ sql: `INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?,?,'active original','bad-attempt','bad-date')`, bind: [P, commandId] });
      db.exec({ sql: `INSERT INTO collaboration_rejections VALUES(?,?,'rejected original','bad-attempt','bad-date','TargetDeleted')`, bind: [P, commandId] });
      expect(readOutbox(db, P).corrupt).toEqual([commandId]);
      db.exec({ sql: `INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?,?,'later original','bad-attempt','bad-date')`, bind: [P, commandId] });
      expect(readOutbox(db, P).corrupt).toEqual([commandId]);
      const metadata = rows(db, 'SELECT metadata_json FROM collaboration_quarantine_metadata ORDER BY recovery_id').map((r) => JSON.parse(String(r.metadata_json)) as Record<string, unknown>);
      expect(metadata.map((r) => r.command_json)).toEqual(['active original', 'rejected original', 'later original']);
    } finally { db.close(); }
  });
  it('accepts reordered server echo with omitted actor enrichment but refuses an actor substitution', () => {
    const { db, handler, command, outbox } = fixture();
    try {
      const c = command(11); handler.applyWithOutbox(c, outbox(c), P);
      const reordered = Object.fromEntries([...Object.entries(c)].reverse()) as ProductCommand;
      const echoed = { ...reordered, actorId: id(99) };
      handler.applyRebaseAtomic(P, { command: echoed, ownEcho: true, serverRevision: 2 }, [], []);
      expect(readOutbox(db, P).entries).toEqual([]);
      const attributed = { ...command(12, 2), actorId: id(98) };
      handler.applyWithOutbox(attributed, outbox(attributed), P);
      const before = dump(db);
      expect(() => handler.applyRebaseAtomic(P, { command: { ...attributed, actorId: id(99) }, ownEcho: true, serverRevision: 3 }, [], [])).toThrow();
      expect(dump(db)).toEqual(before);
    } finally { db.close(); }
  });

  it('malformed retained and active metadata do not block valid work and all raw metadata survives', () => {
    const { db, handler, command, outbox } = fixture();
    try {
      const valid = command(11); handler.applyWithOutbox(valid, outbox(valid), P);
      for (const table of ['collaboration_outbox', 'collaboration_rejections']) {
        for (const [index, invalid] of ['attempt-text', 'attempt-blob', 'json', 'wrong-id', 'wrong-project', 'date'].entries()) {
          const rowId = id(index + 30 + (table === 'collaboration_rejections' ? 10 : 0));
          const payload = { ...command(12), commandId: invalid === 'wrong-id' ? id(999) : rowId, ...(invalid === 'wrong-project' ? { projectId: id(999) } : {}) };
          const raw = invalid === 'json' ? '{' : JSON.stringify(payload);
          const attempt = invalid === 'attempt-text' ? 'invalid-attempt' : invalid === 'attempt-blob' ? new Uint8Array([1, 2, 3]) : 1;
          const date = invalid === 'date' ? '2026-02-30T00:00:00Z' : '2026-10-05T00:00:00Z';
          db.exec({ sql: table === 'collaboration_rejections' ? `INSERT INTO collaboration_rejections VALUES(?,?,?,?,?,'TargetDeleted')` : 'INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?,?,?,?,?)', bind: [P, rowId, raw, attempt, date] });
        }
      }
      const state = readOutbox(db, P);
      expect(state.entries.map((r) => r.command)).toEqual([valid]); expect(state.rejected).toEqual([]); expect(state.corrupt).toHaveLength(12);
      const metadata = rows(db, 'SELECT metadata_json FROM collaboration_quarantine_metadata').map((r) => JSON.parse(String(r.metadata_json)) as Record<string, unknown>);
      expect(metadata.some((r) => r.commit_attempt_id === 'invalid-attempt')).toBe(true);
      expect(metadata.some((r) => JSON.stringify(r.commit_attempt_id) === '{"blob":[1,2,3]}')).toBe(true);
      expect(readOutbox(db, P).corrupt).toEqual(state.corrupt);
    } finally { db.close(); }
  });
  it('creates all sidecars on fresh and populated v17 upgrades without changing authored facts', () => {
    const { db, handler, command, outbox } = fixture();
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(20); expect(readUserVersion(db)).toBe(20);
      const c = command(11); handler.applyWithOutbox(c, outbox(c), P);
      const authored = rows(db, 'SELECT * FROM nodes');
      db.exec('DROP TABLE collaboration_rejections; PRAGMA user_version=17');
      prepareProductDatabase(db);
      expect(readUserVersion(db)).toBe(20); expect(rows(db, 'SELECT * FROM nodes')).toEqual(authored);
      expect(readOutbox(db, P).entries[0].command).toEqual(c);
      const names = rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collaboration_%'").map((r) => r.name).sort();
      expect(names).toEqual(['collaboration_attempt_receipt', 'collaboration_authoritative_history', 'collaboration_confirmed_state', 'collaboration_cursor', 'collaboration_outbox', 'collaboration_outbox_quarantine', 'collaboration_quarantine_metadata', 'collaboration_recovery_archive', 'collaboration_recovery_envelope', 'collaboration_rejections']);
    } finally { db.close(); }
  });

  it.each([0, 17])('failed journal setup rolls back schema, data and the marker from v%s', (version) => {
    const db = version === 0 ? new sqlite3.oo1.DB(':memory:') : fixture().db;
    try {
      if (version === 17) db.exec('DROP TABLE collaboration_rejections; DROP TABLE collaboration_cursor');
      db.exec(`CREATE VIEW collaboration_rejections AS SELECT 1; PRAGMA user_version=${version}`);
      const before = dump(db);
      expect(() => prepareProductDatabase(db)).toThrow();
      expect(readUserVersion(db)).toBe(version); expect(dump(db)).toEqual(before);
      expect(rows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_cursor'")).toEqual([]);
    } finally { db.close(); }
  });

  it('keeps stable wire payload and immutable typed attempt outcomes across rejection and retry', () => {
    const { db, handler, command, outbox } = fixture();
    try {
      const c = command(11); const initial = handler.applyWithOutbox(c, outbox(c), P);
      handler.applyRebaseAtomic(P, { command: command(12), ownEcho: false, serverRevision: 2 }, [{ commandId: c.commandId, command: c, commitAttemptId: 2, queuedAtISO: outbox(c).queuedAtISO }], []);
      expect(readOutbox(db, P).entries[0].command).toEqual(c);
      const before = dump(db);
      expect(handler.applyWithOutbox(c, outbox(c), P)).toEqual(initial); expect(dump(db)).toEqual(before);
      expect(() => handler.applyWithOutbox(command(11, 3), outbox(command(11, 3), 3), P)).toThrow(); expect(dump(db)).toEqual(before);
      handler.applyRebaseAtomic(P, { command: command(13), ownEcho: false, serverRevision: 3 }, [], [{ commandId: c.commandId, reason: 'TargetDeleted' }]);
      expect(readOutbox(db, P).rejected?.[0]).toMatchObject({ command: c, reason: 'TargetDeleted' });
      const after = dump(db); expect(handler.applyWithOutbox(c, outbox(c), P)).toEqual(initial); expect(dump(db)).toEqual(after);
      deleteOutboxEntry(db, P, c.commandId); expect(readOutbox(db, P).rejected).toEqual([]);
    } finally { db.close(); }
  });

  it('refuses gaps, bogus echoes, unknown rejection IDs, changed survivors and active discard without mutation', () => {
    const { db, handler, command, outbox } = fixture();
    try {
      const c = command(11); handler.applyWithOutbox(c, outbox(c), P); const before = dump(db);
      const survivor = { commandId: c.commandId, command: c, commitAttemptId: 2, queuedAtISO: outbox(c).queuedAtISO };
      for (const serverRevision of [1, 3]) expect(() => handler.applyRebaseAtomic(P, { command: command(12), ownEcho: false, serverRevision }, [survivor], [])).toThrow();
      expect(() => handler.applyRebaseAtomic(P, { command: command(12), ownEcho: true, serverRevision: 2 }, [survivor], [])).toThrow();
      expect(() => handler.applyRebaseAtomic(P, { command: command(11, 2), ownEcho: true, serverRevision: 2 }, [], [])).toThrow();
      expect(() => handler.applyRebaseAtomic(P, { command: command(12), ownEcho: false, serverRevision: 2 }, [survivor], [{ commandId: id(99), reason: 'Unknown' }])).toThrow();
      expect(() => handler.applyRebaseAtomic(P, { command: command(12), ownEcho: false, serverRevision: 2 }, [{ ...survivor, command: command(11, 2) }], [])).toThrow();
      expect(() => deleteOutboxEntry(db, P, c.commandId)).toThrow(); expect(dump(db)).toEqual(before);
    } finally { db.close(); }
  });

  it('quarantines impossible calendar dates and retains their payload visibly across reads', () => {
    const { db, command } = fixture();
    try {
      expect(isValidQueuedAtISO('2026-10-05T12:00:00-04:00')).toBe(true);
      expect(isValidQueuedAtISO('2026-02-30T00:00:00Z')).toBe(false);
      const c = command(11); db.exec({ sql: 'INSERT INTO collaboration_outbox(project_id,command_id,command_json,commit_attempt_id,queued_at_iso) VALUES(?,?,?,?,?)', bind: [P, c.commandId, JSON.stringify(c), 1, '2026-02-30T00:00:00Z'] });
      expect(readOutbox(db, P).corrupt).toEqual([c.commandId]); expect(readOutbox(db, P).corrupt).toEqual([c.commandId]);
      expect(rows(db, 'SELECT raw_json FROM collaboration_outbox_quarantine')[0].raw_json).toBe(JSON.stringify(c));
    } finally { db.close(); }
  });
});

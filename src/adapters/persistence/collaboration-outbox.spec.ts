/**
 * Story 27.7 durable outbox (AC 27.7-4, R4): a queued edit survives a "restart"
 * (a fresh read of the same database), and confirmation removes it and advances
 * the cursor atomically.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import {
  confirmOutboxEntries,
  initializeCollaborationSchema,
  putOutboxEntry,
  readOutbox,
} from './collaboration-outbox';
import { createUuidV7, PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ProductCommand } from '../../contracts/repository-commands';
import { createSetNodeTitleWireCommand } from '../../contracts/repository-commands';
import { createSetNodeTitleCommand } from '../../domain/tree/set-node-title.command';

const A = '019ff000-0000-7000-8000-0000000000a0';

let projectSeq = 0;
function uniqueProjectId(): string {
  projectSeq += 1;
  return createUuidV7();
}

function command(projectId: string, commandId: string): ProductCommand {
  return createSetNodeTitleWireCommand(
    createSetNodeTitleCommand({ commandId, projectId, baseRevision: 0, nodeId: A, title: 'X' }),
  );
}

describe('collaboration outbox durability (Story 27.7, R4)', () => {
  it('a queued edit is durable across a fresh read (crash-safe)', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const P = uniqueProjectId();

    putOutboxEntry(db, P, { commandId: '019ff000-0000-7000-8000-0000000000c1', command: command(P, '019ff000-0000-7000-8000-0000000000c1'), commitAttemptId: 1, queuedAtISO: '2026-09-30T00:00:00Z' });
    // A fresh read of the same database (a restart) sees the queued edit.
    const restored = readOutbox(db, P);
    expect(restored.entries).toHaveLength(1);
    expect(restored.entries[0].commandId).toBe('019ff000-0000-7000-8000-0000000000c1');
    expect(restored.cursor).toBe(0);
  });

  it('re-queueing the same command id updates the attempt (rollback/re-apply)', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const P = uniqueProjectId();

    putOutboxEntry(db, P, { commandId: '019ff000-0000-7000-8000-0000000000c2', command: command(P, '019ff000-0000-7000-8000-0000000000c2'), commitAttemptId: 1, queuedAtISO: '2026-09-30T00:00:00Z' });
    putOutboxEntry(db, P, { commandId: '019ff000-0000-7000-8000-0000000000c2', command: command(P, '019ff000-0000-7000-8000-0000000000c2'), commitAttemptId: 2, queuedAtISO: '2026-09-30T00:00:01Z' });
    const state = readOutbox(db, P);
    const entry = state.entries.find((e) => e.commandId === '019ff000-0000-7000-8000-0000000000c2')!;
    expect(entry.commitAttemptId).toBe(2);
    // No duplicate row.
    expect(state.entries.filter((e) => e.commandId === '019ff000-0000-7000-8000-0000000000c2')).toHaveLength(1);
  });

  it('confirmation removes the entry and advances the cursor', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const P = uniqueProjectId();
    putOutboxEntry(db, P, { commandId: '019ff000-0000-7000-8000-0000000000c3', command: command(P, '019ff000-0000-7000-8000-0000000000c3'), commitAttemptId: 1, queuedAtISO: '2026-09-30T00:00:00Z' });

    confirmOutboxEntries(db, P, ['019ff000-0000-7000-8000-0000000000c3'], 5);
    const state = readOutbox(db, P);
    expect(state.entries).toHaveLength(0);
    expect(state.cursor).toBe(5);

    // A later, lower cursor never moves the recorded cursor backwards.
    confirmOutboxEntries(db, P, [], 3);
    expect(readOutbox(db, P).cursor).toBe(5);
  });

  it('a corrupt row is quarantined visibly, not silently dropped (H05)', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const P = uniqueProjectId();
    // One good row and one corrupt row.
    putOutboxEntry(db, P, { commandId: '019ff000-0000-7000-8000-0000000000ab', command: command(P, '019ff000-0000-7000-8000-0000000000ab'), commitAttemptId: 1, queuedAtISO: '2026-09-30T00:00:00Z' });
    db.exec({
      sql: `INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso)
            VALUES(?, ?, '{not json', 1, ?)`,
      bind: [P, 'bad', '2026-09-30T00:00:01Z'],
    });

    const state = readOutbox(db, P, '2026-10-04T00:00:00Z');
    // The good row survives; the bad row is surfaced in the quarantine.
    expect(state.entries.map((e) => e.commandId)).toEqual(['019ff000-0000-7000-8000-0000000000ab']);
    expect(state.corrupt).toContain('bad');
    const quarantined = db.exec({
      sql: 'SELECT command_id, raw_json FROM collaboration_outbox_quarantine WHERE project_id = ?',
      bind: [P], rowMode: 'object', returnValue: 'resultRows',
    }) as unknown as { command_id: string; raw_json: string }[];
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].command_id).toBe('bad');
  });
});

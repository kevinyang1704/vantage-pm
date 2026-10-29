/**
 * Story 27.7 (R4/H04): a command and its durable outbox entry commit in ONE
 * transaction. A crash can never leave an acknowledged local edit whose outbox
 * entry was not written, and a rolled-back command never leaves a queued edit.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { initializeCollaborationSchema, readOutbox } from './collaboration-outbox';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  createCreateProjectCommand,
  createSetNodeTitleWireCommand,
  createDeleteSubtreeWireCommand,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { createSetNodeTitleCommand } from '../../domain/tree/set-node-title.command';
import { createDeleteSubtreeCommand } from '../../domain/tree/delete-subtree.command';

let seq = 0;
function nextId(): string {
  seq += 1;
  return createUuidV7();
}

describe('command + outbox atomicity (Story 27.7, R4/H04)', () => {
  it('commits the command and the outbox entry together', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);

    const projectId = nextId();
    handler.apply(
      createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Atomic' })),
    );

    const nodeId = nextId();
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projectId, 'N', 1000, 'Feature'],
    });
    const rev = Number(
      (db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { revision: number }[])[0].revision,
    );

    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({
      commandId: nextId(),
      projectId,
      baseRevision: rev,
      nodeId,
      title: 'Atomic title',
    }));
    const result = handler.applyWithOutbox(
      command,
      {
        commandId: command.commandId,
        commandJson: JSON.stringify(command),
        commitAttemptId: 1,
        queuedAtISO: '2026-10-05T00:00:00Z',
      },
      projectId,
    );

    expect(result.type).toBe('ProductCommandApplied');
    const outbox = readOutbox(db, projectId);
    expect(outbox.entries.map((e) => e.commandId)).toEqual([command.commandId]);
  });

  it('a rejected command never leaves a queued outbox entry', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);

    const projectId = nextId();
    handler.apply(
      createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Reject' })),
    );

    const nodeId = nextId();
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projectId, 'N', 1000, 'Feature'],
    });

    // Wrong expected revision → rejected by the handler.
    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({
      commandId: nextId(),
      projectId,
      baseRevision: 99,
      nodeId,
      title: 'Nope',
    }));
    const result = handler.applyWithOutbox(
      command,
      {
        commandId: command.commandId,
        commandJson: JSON.stringify(command),
        commitAttemptId: 1,
        queuedAtISO: '2026-10-05T00:00:00Z',
      },
      projectId,
    );

    expect(result.type).toBe('ProductCommandRejected');
    expect(readOutbox(db, projectId).entries).toHaveLength(0);
  });

  it('rolls back the command when the outbox write fails (no split ack)', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);

    const projectId = nextId();
    handler.apply(
      createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Rollback' })),
    );

    const nodeId = nextId();
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projectId, 'N', 1000, 'Feature'],
    });
    const rev = Number(
      (db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { revision: number }[])[0].revision,
    );

    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({
      commandId: nextId(),
      projectId,
      baseRevision: rev,
      nodeId,
      title: 'Should roll back',
    }));

    // Drop the outbox table out from under the write to force the second half
    // of the transaction to fail after the command has been applied.
    db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON collaboration_outbox BEGIN SELECT RAISE(ABORT, 'outbox failure'); END`);

    expect(() =>
      handler.applyWithOutbox(
        command,
        {
          commandId: command.commandId,
          commandJson: JSON.stringify(command),
          commitAttemptId: 1,
          queuedAtISO: '2026-10-05T00:00:00Z',
        },
        projectId,
      ),
    ).toThrow();

    // The title command was rolled back with the failed outbox write.
    const titleRow = db.exec({
      sql: 'SELECT title FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as { title: string }[];
    expect(titleRow[0].title).toBe('N');
    const newRev = Number(
      (db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { revision: number }[])[0].revision,
    );
    expect(newRev).toBe(rev);
    db.exec('DROP TRIGGER IF EXISTS fail_outbox');
  });
});

describe('rebase atomicity (Story 27.7, R4/H04)', () => {
  it('runs reject-removal, remote apply, survivor re-queue and cursor as ONE transaction', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);

    const projectId = nextId();
    handler.apply(
      createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Rebase' })),
    );
    const nodeId = nextId();
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projectId, 'N', 1000, 'Feature'],
    });
    const rev = Number(
      (db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { revision: number }[])[0].revision,
    );

    const remote = createSetNodeTitleWireCommand(
      createSetNodeTitleCommand({ commandId: nextId(), projectId, baseRevision: rev, nodeId, title: 'Remote' }),
    );
    const survivor = createSetNodeTitleWireCommand(
      createSetNodeTitleCommand({ commandId: nextId(), projectId, baseRevision: rev + 1, nodeId, title: 'Survivor' }),
    );

    const rejectedCommand = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: '019ff000-0000-7000-8000-0000000000ff', projectId, baseRevision: rev, nodeId, title: 'Rejected optimistic' }));
    handler.applyWithOutbox(rejectedCommand, { commandId: rejectedCommand.commandId, commandJson: JSON.stringify(rejectedCommand), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    handler.applyWithOutbox(survivor, { commandId: survivor.commandId, commandJson: JSON.stringify(survivor), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:01Z' }, projectId);
    db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, 1)', bind: [projectId] });
    const outcome = handler.applyRebaseAtomic(
      projectId,
      { command: remote, ownEcho: false, serverRevision: remote.baseRevision + 1 },
      [{ commandId: survivor.commandId, command: survivor, commitAttemptId: 2, queuedAtISO: '2026-10-05T00:00:00Z' }],
      [{ commandId: '019ff000-0000-7000-8000-0000000000ff' }],
    );

    expect(outcome?.type).toBe('ProductCommandApplied');
    // The survivor is queued with its bumped attempt; the cursor advanced.
    const outbox = readOutbox(db, projectId);
    expect(outbox.entries.map((e) => e.commandId)).toEqual([survivor.commandId]);
    expect(outbox.cursor).toBe(remote.baseRevision + 1);
  });

  it('rolls the whole rebase back when a survivor apply throws', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);

    const projectId = nextId();
    handler.apply(
      createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'RebaseRollback' })),
    );
    const nodeId = nextId();
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projectId, 'N', 1000, 'Feature'],
    });
    const rev = Number(
      (db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projectId],
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { revision: number }[])[0].revision,
    );

    const remote = createSetNodeTitleWireCommand(
      createSetNodeTitleCommand({ commandId: nextId(), projectId, baseRevision: rev, nodeId, title: 'Remote' }),
    );
    const survivor = createSetNodeTitleWireCommand(
      createSetNodeTitleCommand({ commandId: nextId(), projectId, baseRevision: rev, nodeId, title: 'Survivor' }),
    );
    handler.applyWithOutbox(survivor, { commandId: survivor.commandId, commandJson: JSON.stringify(survivor), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, 1)', bind: [projectId] });
    // Force the survivor re-queue insert to fail after the remote apply has run,
    // proving the whole rebase (including the remote apply and cursor) rolls back.
    db.exec(
      `CREATE TRIGGER fail_survivor BEFORE INSERT ON collaboration_outbox
       WHEN NEW.command_id = '${survivor.commandId}'
       BEGIN SELECT RAISE(ABORT, 'forced'); END`,
    );

    expect(() =>
      handler.applyRebaseAtomic(
        projectId,
        { command: remote, ownEcho: false, serverRevision: remote.baseRevision + 1 },
        [{ commandId: survivor.commandId, command: survivor, commitAttemptId: 2, queuedAtISO: '2026-10-05T00:00:00Z' }],
        [],
      ),
    ).toThrow();

    // Nothing committed: no cursor, no remote title applied, no queued survivor.
    const outbox = readOutbox(db, projectId);
    expect(outbox.entries).toHaveLength(1);
    expect(outbox.entries[0].commitAttemptId).toBe(1);
    expect(outbox.cursor).toBe(1);
    const titleRow = db.exec({
      sql: 'SELECT title FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as { title: string }[];
    expect(titleRow[0].title).toBe('Survivor');
    db.exec('DROP TRIGGER IF EXISTS fail_survivor');
  });
});


describe('confirmed-state rollback and attempt replay', () => {
  async function fixture() {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    db.exec('DROP TRIGGER IF EXISTS fail_cursor');
    const projectId = nextId();
    handler.apply(createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Confirmed' })));
    const nodeId = nextId();
    db.exec({ sql: 'INSERT INTO nodes(id, project_id, title, position) VALUES(?, ?, ?, ?)', bind: [nodeId, projectId, 'Before', 1000] });
    const command = (title: string, baseRevision: number) => createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: nextId(), projectId, nodeId, title, baseRevision }));
    const title = () => (db.exec({ sql: 'SELECT title FROM nodes WHERE id = ?', bind: [nodeId], rowMode: 'object', returnValue: 'resultRows' }) as { title: string }[])[0].title;
    db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, 1)', bind: [projectId] });
    return { handler, db, projectId, nodeId, command, title };
  }

  it('replays a previously applied survivor under its same command ID and new attempt', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    const pending = command('My retained text', 1);
    const queue = { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' };
    handler.applyWithOutbox(pending, queue, projectId);
    const remote = command('Teammate', 1);
    handler.applyRebaseAtomic(projectId, { command: remote, ownEcho: false, serverRevision: 2 }, [{ commandId: pending.commandId, command: pending, commitAttemptId: 2, queuedAtISO: queue.queuedAtISO }], []);
    expect(title()).toBe('My retained text');
    const outbox = readOutbox(db, projectId);
    expect(outbox.entries[0].commitAttemptId).toBe(2);
    expect(outbox.entries[0].command).toEqual(pending);
    // An old local retry cannot resurrect the old outbox attempt.
    handler.applyWithOutbox(pending, queue, projectId);
    expect(readOutbox(db, projectId).entries[0].commitAttemptId).toBe(2);
    const receipts = db.exec({ sql: 'SELECT commit_attempt_id FROM collaboration_attempt_receipt WHERE command_id = ? ORDER BY commit_attempt_id', bind: [pending.commandId], rowMode: 'object', returnValue: 'resultRows' }) as { commit_attempt_id: number }[];
    expect(receipts.map((row) => row.commit_attempt_id)).toEqual([1, 2]);
  });

  it('removes rejected optimistic content while retaining its complete recovery payload', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    const pending = command('Recovery content', 1);
    handler.applyWithOutbox(pending, { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    const remote = command('Authoritative text', 1);
    handler.applyRebaseAtomic(projectId, { command: remote, ownEcho: false, serverRevision: 2 }, [], [{ commandId: pending.commandId }]);
    expect(title()).toBe('Authoritative text');
    expect(readOutbox(db, projectId).entries).toHaveLength(0);
    const retained = db.exec({ sql: 'SELECT command_json, result_json FROM collaboration_attempt_receipt WHERE command_id = ?', bind: [pending.commandId], rowMode: 'object', returnValue: 'resultRows' }) as { command_json: string; result_json: string }[];
    expect(JSON.parse(retained[0].command_json).title).toBe('Recovery content');
    expect(JSON.parse(retained[0].result_json).type).toBe('ProductCommandApplied');
    expect(readOutbox(db, projectId).rejected?.[0].command).toEqual(pending);
  });

  it('restores the optimistic model, original receipts and queue after a rebase write fails', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    const pending = command('Still mine', 1);
    handler.applyWithOutbox(pending, { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    db.exec(`CREATE TRIGGER fail_cursor BEFORE INSERT ON collaboration_cursor BEGIN SELECT RAISE(ABORT, 'cursor failure'); END`);
    expect(() => handler.applyRebaseAtomic(projectId, { command: command('Remote', 1), ownEcho: false, serverRevision: 2 }, [], [{ commandId: pending.commandId }])).toThrow();
    expect(title()).toBe('Still mine');
    expect(readOutbox(db, projectId).entries[0].commitAttemptId).toBe(1);
    expect(handler.apply(pending).type).toBe('ProductCommandApplied');
  });

  it('preserves local view state changed while optimistic work is pending', async () => {
    const { handler, db, projectId, command } = await fixture();
    db.exec({ sql: 'INSERT INTO view_state(project_id, view_id, scroll_top, pan_x) VALUES(?, ?, ?, ?)', bind: [projectId, 'outline', 10, 20] });
    const pending = command('Pending title', 1);
    handler.applyWithOutbox(pending, { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    db.exec({ sql: 'UPDATE view_state SET scroll_top = ?, pan_x = ? WHERE project_id = ?', bind: [120, 500, projectId] });
    handler.applyRebaseAtomic(projectId, { command: command('Remote title', 1), ownEcho: false, serverRevision: 2 }, [], [{ commandId: pending.commandId }]);
    const view = db.exec({ sql: 'SELECT scroll_top, pan_x FROM view_state WHERE project_id = ?', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }) as { scroll_top: number; pan_x: number }[];
    expect(view).toEqual([{ scroll_top: 120, pan_x: 500 }]);
  });

  it('rolls back an own optimistic echo before authoritative replay and settles its queue', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    const pending = command('Own text', 1);
    handler.applyWithOutbox(pending, { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    handler.applyRebaseAtomic(projectId, { command: pending, ownEcho: true, serverRevision: 2 }, [], []);
    expect(title()).toBe('Own text');
    expect(readOutbox(db, projectId).entries).toHaveLength(0);
    const revision = db.exec({ sql: 'SELECT revision FROM projects WHERE id = ?', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }) as { revision: number }[];
    expect(revision[0].revision).toBe(2);
    // The next edit captures the newly confirmed state, not the old baseline.
    const next = command('Next pending', 2);
    handler.applyWithOutbox(next, { commandId: next.commandId, commandJson: JSON.stringify(next), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    handler.applyRebaseAtomic(projectId, { command: command('After echo', 2), ownEcho: false, serverRevision: 3 }, [], [{ commandId: next.commandId }]);
    expect(title()).toBe('After echo');
  });

  it('restores deleted subtree IDs and authored dependencies before applying a remote edit', async () => {
    const { handler, db, projectId, nodeId, command, title } = await fixture();
    const childId = nextId();
    db.exec({ sql: 'INSERT INTO nodes(id, project_id, parent_id, title, body_text, position) VALUES(?, ?, ?, ?, ?, ?)', bind: [childId, projectId, nodeId, 'Child', 'Retained body', 1000] });
    const pending = createDeleteSubtreeWireCommand({ ...createDeleteSubtreeCommand({ commandId: nextId(), projectId, nodeId }), baseRevision: 1 });
    handler.applyWithOutbox(pending, { commandId: pending.commandId, commandJson: JSON.stringify(pending), commitAttemptId: 1, queuedAtISO: '2026-10-05T00:00:00Z' }, projectId);
    handler.applyRebaseAtomic(projectId, { command: command('Surviving parent', 1), ownEcho: false, serverRevision: 2 }, [], [{ commandId: pending.commandId }]);
    expect(title()).toBe('Surviving parent');
    const children = db.exec({ sql: 'SELECT id, parent_id, body_text FROM nodes WHERE id = ?', bind: [childId], rowMode: 'object', returnValue: 'resultRows' }) as { id: string; parent_id: string; body_text: string }[];
    expect(children).toEqual([{ id: childId, parent_id: nodeId, body_text: 'Retained body' }]);
  });

  it('rolls back all composite components and receipts when a later component rejects', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    // Local project: the shared fixture's cursor would trigger the group refusal.
    db.exec({ sql: 'DELETE FROM collaboration_cursor WHERE project_id = ?', bind: [projectId] });
    const first = command('Partial edit', 1);
    const second = Object.freeze({ ...command('Invalid target', 2), nodeId: nextId() });
    const result = handler.applyBatch([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'ProductCommandRejected', commandId: second.commandId, code: 'NODE_NOT_FOUND' });
    expect(title()).toBe('Before');
    const receipts = db.exec({ sql: 'SELECT command_id FROM product_command_receipt WHERE command_id = ?', bind: [first.commandId], rowMode: 'object', returnValue: 'resultRows' }) as unknown[];
    expect(receipts).toHaveLength(0);
    expect(handler.apply(first).type).toBe('ProductCommandApplied');
  });

  it('refuses a whole group on a synced project without applying any component', async () => {
    const { handler, db, projectId, command, title } = await fixture();
    const first = command('Grouped one', 1);
    const second = command('Grouped two', 2);
    const result = handler.applyBatch([first, second]);
    expect(result).toEqual([{ type: 'ProductCommandRejected', protocolVersion: first.protocolVersion, commandId: first.commandId, projectId, code: 'SHARED_ATOMIC_GROUP_UNAVAILABLE' }]);
    expect(title()).toBe('Before');
    const receipts = db.exec({ sql: 'SELECT command_id FROM product_command_receipt WHERE command_id IN (?, ?)', bind: [first.commandId, second.commandId], rowMode: 'object', returnValue: 'resultRows' }) as unknown[];
    expect(receipts).toHaveLength(0);
  });
});



describe('outbox metadata corruption remains recoverable', () => {
  it.each(['commandId', 'projectId', 'attempt', 'date'] as const)('quarantines invalid %s metadata and reports it on repeated reads', async (invalid) => {
    const handler = await initWorkerDatabase();
    const db = getDatabase()!;
    initializeCollaborationSchema(db);
    const projectId = nextId();
    handler.apply(createCreateProjectCommand(createDomainCreateProject({ commandId: nextId(), projectId, name: 'Metadata' })));
    const command = createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: nextId(), projectId, baseRevision: 1, nodeId: nextId(), title: 'Recoverable authored text' }));
    const rowId = invalid === 'commandId' ? nextId() : command.commandId;
    const payload = invalid === 'projectId' ? { ...command, projectId: nextId() } : command;
    db.exec({ sql: 'INSERT INTO collaboration_outbox(project_id, command_id, command_json, commit_attempt_id, queued_at_iso) VALUES(?, ?, ?, ?, ?)', bind: [projectId, rowId, JSON.stringify(payload), invalid === 'attempt' ? 0 : 1, invalid === 'date' ? 'invalid timestamp' : '2026-10-05T00:00:00Z'] });
    const first = readOutbox(db, projectId);
    expect(first.entries).toHaveLength(0);
    expect(first.corrupt).toContain(rowId);
    const second = readOutbox(db, projectId);
    expect(second.entries).toHaveLength(0);
    expect(second.corrupt).toContain(rowId);
    const quarantined = db.exec({ sql: 'SELECT raw_json FROM collaboration_outbox_quarantine WHERE project_id = ? AND command_id = ?', bind: [projectId, rowId], rowMode: 'object', returnValue: 'resultRows' }) as { raw_json: string }[];
    expect(JSON.parse(quarantined[0].raw_json).title).toBe('Recoverable authored text');
  });
});

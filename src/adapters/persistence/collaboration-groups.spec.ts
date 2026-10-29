/**
 * Story 27.2 on shared projects: a composite gesture's members commit with
 * their outbox entries in ONE transaction, and a rebase re-applies or refuses
 * the whole gesture, never part of it.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import { initializeCollaborationSchema, readOutbox } from './collaboration-outbox';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand, createDeleteSubtreeWireCommand, createSetNodeTitleWireCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { createSetNodeTitleCommand } from '../../domain/tree/set-node-title.command';
import { createDeleteSubtreeCommand } from '../../domain/tree/delete-subtree.command';

async function fixture() {
  const handler = await initWorkerDatabase();
  const db = getDatabase()!;
  initializeCollaborationSchema(db);
  const projectId = createUuidV7();
  handler.apply(createCreateProjectCommand(createDomainCreateProject({ commandId: createUuidV7(), projectId, name: 'Groups' })));
  const a = createUuidV7(); const b = createUuidV7();
  db.exec({ sql: 'INSERT INTO nodes(id, project_id, title, position) VALUES(?, ?, ?, 1000), (?, ?, ?, 2000)', bind: [a, projectId, 'A before', b, projectId, 'B before'] });
  const title = (id: string) => (db.exec({ sql: 'SELECT title FROM nodes WHERE id = ?', bind: [id], rowMode: 'object', returnValue: 'resultRows' }) as { title: string }[])[0]?.title;
  const revision = () => Number((db.exec({ sql: 'SELECT revision FROM projects WHERE id = ?', bind: [projectId], rowMode: 'object', returnValue: 'resultRows' }) as { revision: number }[])[0].revision);
  const setTitle = (nodeId: string, text: string, baseRevision: number) => createSetNodeTitleWireCommand(createSetNodeTitleCommand({ commandId: createUuidV7(), projectId, nodeId, title: text, baseRevision }));
  const member = (command: ReturnType<typeof setTitle>) => ({ command, commandJson: JSON.stringify(command), commitAttemptId: 1, queuedAtISO: '2026-10-12T00:00:00Z' });
  db.exec({ sql: 'INSERT INTO collaboration_cursor(project_id, cursor) VALUES(?, 1)', bind: [projectId] });
  return { handler, db, projectId, a, b, title, revision, setTitle, member };
}

describe('shared composite gestures (Story 27.2)', () => {
  it('commits every member and its tagged outbox entry together, in gesture order', async () => {
    const { handler, db, projectId, a, b, title, revision, setTitle, member } = await fixture();
    const base = revision();
    const first = setTitle(a, 'A grouped', base); const second = setTitle(b, 'B grouped', base + 1);
    const results = handler.applyGroupWithOutbox(projectId, [member(first), member(second)], first.commandId);
    expect(results.map((r) => r.type)).toEqual(['ProductCommandApplied', 'ProductCommandApplied']);
    expect([title(a), title(b)]).toEqual(['A grouped', 'B grouped']);
    expect(readOutbox(db, projectId).entries.map((e) => [e.commandId, e.groupId, e.groupIndex])).toEqual([
      [first.commandId, first.commandId, 0], [second.commandId, first.commandId, 1],
    ]);
  });

  it('a refused member commits nothing: no change, no outbox entry, no revision', async () => {
    const { handler, db, projectId, a, title, revision, setTitle, member } = await fixture();
    const base = revision();
    const first = setTitle(a, 'A grouped', base); const missing = setTitle(createUuidV7(), 'Nowhere', base + 1);
    const results = handler.applyGroupWithOutbox(projectId, [member(first), member(missing)], first.commandId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'ProductCommandRejected', commandId: missing.commandId });
    expect(title(a)).toBe('A before');
    expect(revision()).toBe(base);
    expect(readOutbox(db, projectId).entries).toHaveLength(0);
  });

  it('a rebase refuses the whole gesture when one member no longer applies', async () => {
    const { handler, db, projectId, a, b, title, revision, setTitle, member } = await fixture();
    const base = revision();
    const first = setTitle(a, 'A grouped', base); const second = setTitle(b, 'B grouped', base + 1);
    handler.applyGroupWithOutbox(projectId, [member(first), member(second)], first.commandId);
    // A teammate deleted B first; member two cannot re-apply, so member one must not either.
    const remote = createDeleteSubtreeWireCommand({ ...createDeleteSubtreeCommand({ commandId: createUuidV7(), projectId, nodeId: b }), baseRevision: base });
    const survivors = readOutbox(db, projectId).entries.map((e) => ({ ...e, commitAttemptId: e.commitAttemptId + 1 }));
    handler.applyRebaseAtomic(projectId, { command: remote, ownEcho: false, serverRevision: 2 }, survivors, []);
    expect(title(a)).toBe('A before');
    expect(title(b)).toBeUndefined();
    const after = readOutbox(db, projectId);
    expect(after.entries).toHaveLength(0);
    expect(after.rejected?.map((r) => [r.commandId, r.reason]).sort()).toEqual([
      [first.commandId, 'ATOMIC_GROUP_REJECTED'], [second.commandId, 'NODE_NOT_FOUND'],
    ].sort());
  });

  it('a rebase re-applies a surviving gesture whole and keeps its group tags', async () => {
    const { handler, db, projectId, a, b, title, revision, setTitle, member } = await fixture();
    const base = revision();
    const other = createUuidV7();
    db.exec({ sql: 'INSERT INTO nodes(id, project_id, title, position) VALUES(?, ?, ?, 3000)', bind: [other, projectId, 'Other'] });
    const first = setTitle(a, 'A grouped', base); const second = setTitle(b, 'B grouped', base + 1);
    handler.applyGroupWithOutbox(projectId, [member(first), member(second)], first.commandId);
    const remote = setTitle(other, 'Teammate', base);
    const survivors = readOutbox(db, projectId).entries.map((e) => ({ ...e, commitAttemptId: e.commitAttemptId + 1 }));
    handler.applyRebaseAtomic(projectId, { command: remote, ownEcho: false, serverRevision: 2 }, survivors, []);
    expect([title(a), title(b), title(other)]).toEqual(['A grouped', 'B grouped', 'Teammate']);
    expect(readOutbox(db, projectId).entries.map((e) => [e.groupId, e.groupIndex, e.commitAttemptId])).toEqual([
      [first.commandId, 0, 2], [first.commandId, 1, 2],
    ]);
  });
});

describe('a shared project on the plain local path', () => {
  it('refuses an edit with no outbox entry (local-only build, or not yet connected) and writes nothing', async () => {
    const { handler, db, projectId, a, title, revision, setTitle } = await fixture();
    const base = revision();
    const result = handler.applyLocal(setTitle(a, 'A offline', base));
    expect(result).toMatchObject({ type: 'ProductCommandRejected', code: 'SHARED_PROJECT_NOT_CONNECTED' });
    expect(title(a)).toBe('A before');
    expect(revision()).toBe(base);
    expect(readOutbox(db, projectId).entries).toHaveLength(0);
  });

  it('still edits a local project', async () => {
    const { handler, db, projectId, a, title, revision, setTitle } = await fixture();
    db.exec({ sql: 'DELETE FROM collaboration_cursor WHERE project_id = ?', bind: [projectId] });
    expect(handler.applyLocal(setTitle(a, 'A local', revision())).type).toBe('ProductCommandApplied');
    expect(title(a)).toBe('A local');
  });
});

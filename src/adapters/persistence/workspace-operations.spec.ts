/**
 * Workspace registry operations (Epic 17).
 *
 * Uses the real worker database (the vitest fallback path opens SQLite WASM
 * in-process), so these exercise the same SQL the app runs — not a mock.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase, queryProjects, resetWorkerDatabase } from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  ensureDefaultWorkspace,
  readActiveWorkspaceId,
  queryWorkspaceRegistry,
  createWorkspaceOp,
  renameWorkspaceOp,
  deleteWorkspaceOp,
  moveProjectToWorkspaceOp,
  setActiveWorkspaceOp,
} from './workspace-operations';

async function db() {
  await initWorkerDatabase();
  const handle = getDatabase();
  if (!handle) throw new Error('expected an open database');
  return handle;
}

async function makeProject(name: string): Promise<string> {
  await initWorkerDatabase();
  const handler = await initWorkerDatabase();
  const projectId = createUuidV7();
  const result = handler.apply(
    createCreateProjectCommand(
      createDomainCreateProject({ commandId: createUuidV7(), projectId, name }),
    ),
  );
  expect(result.type).toBe('ProductCommandApplied');
  return projectId;
}

describe('ensureDefaultWorkspace', () => {
  it('guarantees a workspace exists and is idempotent', async () => {
    const handle = await db();
    const first = ensureDefaultWorkspace(handle);
    const second = ensureDefaultWorkspace(handle);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('leaves no project without a workspace', async () => {
    const handle = await db();
    await makeProject('Backfill target');
    // Simulate a project that predates workspaces.
    handle.exec('UPDATE projects SET workspace_id = NULL');
    ensureDefaultWorkspace(handle);

    const orphans = handle.exec({
      sql: 'SELECT COUNT(*) AS n FROM projects WHERE workspace_id IS NULL',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[];
    expect(Number(orphans[0].n)).toBe(0);
  });

  it('re-homes projects pointing at a workspace that no longer exists', async () => {
    const handle = await db();
    const projectId = await makeProject('Stranded');

    // A dangling workspace_id is unreachable on a database created from the
    // baseline DDL — the FK refuses it, which is the constraint working. It
    // IS reachable on a MIGRATED database, where `ALTER TABLE projects ADD
    // COLUMN workspace_id TEXT` adds the column with no REFERENCES clause.
    // Dropping FK enforcement for the write reproduces that state exactly,
    // then the repair runs under normal enforcement.
    handle.exec('PRAGMA foreign_keys = OFF');
    handle.exec({
      sql: 'UPDATE projects SET workspace_id = ? WHERE id = ?',
      bind: ['does-not-exist', projectId],
    });
    handle.exec('PRAGMA foreign_keys = ON');

    const active = ensureDefaultWorkspace(handle);
    const row = handle.exec({
      sql: 'SELECT workspace_id FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, unknown>;
    expect(String(row.workspace_id)).toBe(active);
  });
});

describe('createWorkspaceOp', () => {
  it('creates a workspace, makes it active, and reports it in the registry', async () => {
    const handle = await db();
    const workspaceId = createUuidV7();
    const result = createWorkspaceOp(handle, { workspaceId, name: '  Client — Northwind  ' });

    expect(result.type).toBe('WorkspaceMutationApplied');
    if (result.type !== 'WorkspaceMutationApplied') return;
    expect(result.registry.activeWorkspaceId).toBe(workspaceId);

    const created = result.registry.workspaces.find((w) => w.id === workspaceId);
    expect(created?.name).toBe('Client — Northwind');
    expect(created?.projectCount).toBe(0);
  });

  it('refuses a blank name without mutating', async () => {
    const handle = await db();
    const before = queryWorkspaceRegistry(handle).workspaces.length;
    const result = createWorkspaceOp(handle, { workspaceId: createUuidV7(), name: '   ' });

    expect(result.type).toBe('WorkspaceMutationRejected');
    if (result.type !== 'WorkspaceMutationRejected') return;
    expect(result.code).toBe('INVALID_WORKSPACE_NAME');
    expect(queryWorkspaceRegistry(handle).workspaces.length).toBe(before);
  });
});

describe('project scoping', () => {
  it('a new project is born into the active workspace', async () => {
    const handle = await db();
    const workspaceId = createUuidV7();
    createWorkspaceOp(handle, { workspaceId, name: 'Scoped' });

    const projectId = await makeProject('Born here');
    const row = handle.exec({
      sql: 'SELECT workspace_id FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, unknown>;
    expect(String(row.workspace_id)).toBe(workspaceId);
  });

  it('queryProjects lists only the active workspace, and null lists every project', async () => {
    const handle = await db();

    const wsA = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: wsA, name: 'A' });
    const inA = await makeProject('Project in A');

    const wsB = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: wsB, name: 'B' });
    const inB = await makeProject('Project in B');

    // Active is now B.
    const scoped = queryProjects().map((p) => p.id);
    expect(scoped).toContain(inB);
    expect(scoped).not.toContain(inA);

    const all = queryProjects(null).map((p) => p.id);
    expect(all).toContain(inA);
    expect(all).toContain(inB);
  });
});

describe('moveProjectToWorkspaceOp', () => {
  it('re-homes a project without bumping its revision', async () => {
    const handle = await db();
    const wsA = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: wsA, name: 'Origin' });
    const projectId = await makeProject('Movable');

    const before = handle.exec({
      sql: 'SELECT revision FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, unknown>;

    const wsB = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: wsB, name: 'Destination' });

    const result = moveProjectToWorkspaceOp(handle, { projectId, workspaceId: wsB });
    expect(result.type).toBe('WorkspaceMutationApplied');

    const after = handle.exec({
      sql: 'SELECT workspace_id, revision FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, unknown>;

    expect(String(after.workspace_id)).toBe(wsB);
    expect(Number(after.revision)).toBe(Number(before.revision));
  });

  it('rejects an unknown destination workspace', async () => {
    const handle = await db();
    const projectId = await makeProject('Immovable');
    const result = moveProjectToWorkspaceOp(handle, {
      projectId,
      workspaceId: 'no-such-workspace',
    });
    expect(result.type).toBe('WorkspaceMutationRejected');
    if (result.type !== 'WorkspaceMutationRejected') return;
    expect(result.code).toBe('WORKSPACE_NOT_FOUND');
  });
});

describe('deleteWorkspaceOp', () => {
  it('refuses while the workspace still holds projects, and touches nothing', async () => {
    const handle = await db();
    const workspaceId = createUuidV7();
    createWorkspaceOp(handle, { workspaceId, name: 'Occupied' });
    const projectId = await makeProject('Still here');

    const result = deleteWorkspaceOp(handle, { workspaceId });
    expect(result.type).toBe('WorkspaceMutationRejected');
    if (result.type !== 'WorkspaceMutationRejected') return;
    expect(result.code).toBe('WORKSPACE_NOT_EMPTY');
    expect(result.projectCount).toBe(1);

    // The project — and the workspace — must both survive a refused delete.
    const survivors = handle.exec({
      sql: 'SELECT COUNT(*) AS n FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[];
    expect(Number(survivors[0].n)).toBe(1);
    expect(
      queryWorkspaceRegistry(handle).workspaces.some((w) => w.id === workspaceId),
    ).toBe(true);
  });

  it('deletes an empty workspace and repoints the active pointer at a survivor', async () => {
    const handle = await db();
    const keep = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: keep, name: 'Keeper' });

    const doomed = createUuidV7();
    createWorkspaceOp(handle, { workspaceId: doomed, name: 'Doomed' });
    expect(readActiveWorkspaceId(handle)).toBe(doomed);

    const result = deleteWorkspaceOp(handle, { workspaceId: doomed });
    expect(result.type).toBe('WorkspaceMutationApplied');
    if (result.type !== 'WorkspaceMutationApplied') return;

    expect(result.registry.workspaces.some((w) => w.id === doomed)).toBe(false);
    expect(result.registry.activeWorkspaceId).not.toBe(doomed);
    expect(
      result.registry.workspaces.some((w) => w.id === result.registry.activeWorkspaceId),
    ).toBe(true);
  });

  it('refuses to delete the last remaining workspace', async () => {
    const handle = await db();
    // Collapse to exactly one workspace, with no projects anywhere.
    handle.exec('DELETE FROM projects');
    const registry = queryWorkspaceRegistry(handle);
    for (const ws of registry.workspaces.slice(1)) {
      handle.exec({ sql: 'DELETE FROM workspaces WHERE id = ?', bind: [ws.id] });
    }
    const only = queryWorkspaceRegistry(handle);
    expect(only.workspaces).toHaveLength(1);

    const result = deleteWorkspaceOp(handle, { workspaceId: only.workspaces[0].id });
    expect(result.type).toBe('WorkspaceMutationRejected');
    if (result.type !== 'WorkspaceMutationRejected') return;
    expect(result.code).toBe('LAST_WORKSPACE');
  });
});

describe('renameWorkspaceOp / setActiveWorkspaceOp', () => {
  it('renames without touching project membership', async () => {
    const handle = await db();
    const workspaceId = createUuidV7();
    createWorkspaceOp(handle, { workspaceId, name: 'Before' });
    const projectId = await makeProject('Unaffected');

    const result = renameWorkspaceOp(handle, { workspaceId, name: 'After' });
    expect(result.type).toBe('WorkspaceMutationApplied');
    if (result.type !== 'WorkspaceMutationApplied') return;

    const renamed = result.registry.workspaces.find((w) => w.id === workspaceId);
    expect(renamed?.name).toBe('After');
    expect(renamed?.projectCount).toBe(1);

    const row = handle.exec({
      sql: 'SELECT workspace_id FROM projects WHERE id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, unknown>;
    expect(String(row.workspace_id)).toBe(workspaceId);
  });

  it('rejects switching to an unknown workspace', async () => {
    const handle = await db();
    const result = setActiveWorkspaceOp(handle, { workspaceId: 'nope' });
    expect(result.type).toBe('WorkspaceMutationRejected');
    if (result.type !== 'WorkspaceMutationRejected') return;
    expect(result.code).toBe('WORKSPACE_NOT_FOUND');
  });
});

describe('resetWorkerDatabase schema parity (Story 21.12 AC 5)', () => {
  it('initializes a legacy projects table before creating its workspace index', async () => {
    const handle = await db();
    const handler = await initWorkerDatabase();
    const projectId = await makeProject('Legacy project');
    handle.exec('BEGIN');
    try {
      handle.exec('DROP INDEX projects_by_workspace');
      handle.exec('ALTER TABLE projects DROP COLUMN workspace_id');
      expect(() => handler.initializeSchema()).not.toThrow();
      ensureDefaultWorkspace(handle);
      const registry = queryWorkspaceRegistry(handle);
      expect(registry.workspaces.some((workspace) => queryProjects(workspace.id).some((project) => project.id === projectId))).toBe(true);
      expect(handle.exec({ sql: "SELECT name FROM sqlite_master WHERE name = 'projects_by_workspace'", returnValue: 'resultRows' })).toHaveLength(1);
    } finally {
      handle.exec('ROLLBACK');
    }
  });

  it('restores projects.workspace_id and a resolvable active workspace after a reset', async () => {
    const handle = await db();
    await makeProject('Pre-reset project');

    resetWorkerDatabase();

    // The column exists and the active workspace resolves to a real
    // workspace — the same invariants the open path guarantees.
    const cols = handle.exec({
      sql: 'PRAGMA table_info(projects)',
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[];
    expect(cols.map((c) => String(c.name))).toContain('workspace_id');

    const active = readActiveWorkspaceId(handle);
    expect(active).not.toBeNull();
    const registry = queryWorkspaceRegistry(handle);
    expect(registry.workspaces.some((w) => w.id === active)).toBe(true);

    // The workspace-scoped project query that used to throw now runs clean.
    const projects = queryProjects(active);
    expect(projects).toEqual([]);
  });

  it('a reset that fails mid-sequence rolls back and preserves the pre-reset data (Story 25.2 AC 25.2-4)', async () => {
    const handle = await db();
    await initWorkerDatabase();
    const projectId = await makeProject('Survivor');
    handle.exec({
      sql: "INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)",
      bind: ['019ffe00-0000-7000-8000-0000000000c1', projectId, 'Keep me', 1000, 'Feature'],
    });

    // The reset deletes `nodes` before the forecast tables. Dropping a later
    // table makes the DELETE sequence throw partway through; without the
    // transaction the already-deleted nodes would be lost.
    handle.exec('DROP TABLE forecast_scenarios');

    expect(() => resetWorkerDatabase()).toThrow();

    // The pre-reset project and its node survived.
    const projects = queryProjects(null);
    expect(projects.some((p) => p.id === projectId)).toBe(true);
    const rows = handle.exec({
      sql: 'SELECT id FROM nodes WHERE project_id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });
});

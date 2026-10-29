import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, queryProjects, getDatabase } from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  createCreateProjectCommand,
  createDeleteProjectWireCommand,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { createDeleteProjectCommand as createDomainDeleteProject } from '../../domain/project/delete-project.command';

const PROJECT_ID = '019ffe00-0000-7000-8000-000000000001';
const DELETE_CMD_ID = '019ffe00-0000-7000-8000-000000000002';

describe('ProductCommandHandler DeleteProject (Story 5.7 Task 4)', () => {
  it('replays the stored result on a duplicate commandId instead of PROJECT_NOT_FOUND', async () => {
    const handler = await initWorkerDatabase();

    const createCmd = createCreateProjectCommand(
      createDomainCreateProject({
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        name: 'Alpha',
      }),
    );
    const created = handler.apply(createCmd);
    expect(created.type).toBe('ProductCommandApplied');

    const deleteCmd = createDeleteProjectWireCommand(
      createDomainDeleteProject({
        commandId: DELETE_CMD_ID,
        projectId: PROJECT_ID,
        baseRevision: 1,
      }),
    );

    const first = handler.apply(deleteCmd);
    expect(first.type).toBe('ProductCommandApplied');
    if (first.type !== 'ProductCommandApplied') return;
    expect(first.disposition).toBe('NewCommit');

    const replay = handler.apply(deleteCmd);
    expect(replay.type).toBe('ProductCommandApplied');
    if (replay.type !== 'ProductCommandApplied') return;
    expect(replay.disposition).toBe('StoredResultReturned');
  });

  it('cascades deletion across owned rows and reflects it in the project list', async () => {
    const handler = await initWorkerDatabase();
    const db = getDatabase();

    const projectId = '019ffe00-0000-7000-8000-000000000011';
    const createCmd = createCreateProjectCommand(
      createDomainCreateProject({
        commandId: createUuidV7(),
        projectId,
        name: 'Beta',
      }),
    );
    expect(handler.apply(createCmd).type).toBe('ProductCommandApplied');

    // Create a node under the project directly through SQL to prove cascade
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position) VALUES (?, ?, NULL, ?, ?)',
      bind: ['019ffe00-0000-7000-8000-000000000012', projectId, 'Node', 1],
    });

    const beforeRows = db?.exec({
      sql: 'SELECT COUNT(*) AS c FROM nodes WHERE project_id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(Number(beforeRows?.[0]?.c ?? 0)).toBe(1);

    const deleteCmd = createDeleteProjectWireCommand(
      createDomainDeleteProject({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
      }),
    );
    expect(handler.apply(deleteCmd).type).toBe('ProductCommandApplied');

    const nodeRows = db?.exec({
      sql: 'SELECT COUNT(*) AS c FROM nodes WHERE project_id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(Number(nodeRows?.[0]?.c ?? 0)).toBe(0);

    expect(queryProjects().some((p) => p.id === projectId)).toBe(false);
  });

  describe('MoveNode and SetNodeType hierarchy enforcement', () => {
    it('rejects MoveNode with HIERARCHY_CONFLICT when moving higher rank under lower rank', async () => {
      const handler = await initWorkerDatabase();
      const db = getDatabase();

      const projId = '019ffe00-0000-7000-8000-000000000021';
      const featureId = '019ffe00-0000-7000-8000-000000000022';
      const visionId = '019ffe00-0000-7000-8000-000000000023';

      handler.apply(
        createCreateProjectCommand(
          createDomainCreateProject({
            commandId: createUuidV7(),
            projectId: projId,
            name: 'Hierarchy Project',
          }),
        ),
      );

      // Insert Feature and Vision nodes at root level
      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
        bind: [featureId, projId, 'Feature Root', 1000, 'Feature'],
      });
      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
        bind: [visionId, projId, 'Vision Root', 2000, 'Vision'],
      });

      // Attempt to move Vision under Feature
      const moveRes = handler.apply({
        type: 'MoveNode',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: projId,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: visionId,
        newParentId: featureId,
        newPosition: '1000',
      });

      expect(moveRes.type).toBe('ProductCommandRejected');
      if (moveRes.type === 'ProductCommandRejected') {
        expect(moveRes.code).toBe('HIERARCHY_CONFLICT');
      }

      // Verify project revision did NOT increment
      const projRow = db?.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [projId],
        rowMode: 'object',
        returnValue: 'resultRows',
      });
      expect(Number(projRow?.[0]?.revision)).toBe(1);

      // Verify node parent did NOT change
      const nodeRow = db?.exec({
        sql: 'SELECT parent_id FROM nodes WHERE id = ?',
        bind: [visionId],
        rowMode: 'object',
        returnValue: 'resultRows',
      });
      expect(nodeRow?.[0]?.parent_id).toBeNull();
    });

    it('allows MoveNode for valid same-rank and downward relationships', async () => {
      const handler = await initWorkerDatabase();
      const db = getDatabase();

      const projId = '019ffe00-0000-7000-8000-000000000031';
      const vision1Id = '019ffe00-0000-7000-8000-000000000032';
      const vision2Id = '019ffe00-0000-7000-8000-000000000033';

      handler.apply(
        createCreateProjectCommand(
          createDomainCreateProject({
            commandId: createUuidV7(),
            projectId: projId,
            name: 'Vision Nesting',
          }),
        ),
      );

      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
        bind: [vision1Id, projId, 'Vision 1', 1000, 'Vision'],
      });
      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
        bind: [vision2Id, projId, 'Vision 2', 2000, 'Vision'],
      });

      // Move Vision 2 under Vision 1
      const moveRes = handler.apply({
        type: 'MoveNode',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: projId,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: vision2Id,
        newParentId: vision1Id,
        newPosition: '4294967296',
      });

      expect(moveRes.type).toBe('ProductCommandApplied');

      const nodeRow = db?.exec({
        sql: 'SELECT parent_id FROM nodes WHERE id = ?',
        bind: [vision2Id],
        rowMode: 'object',
        returnValue: 'resultRows',
      });
      expect(nodeRow?.[0]?.parent_id).toBe(vision1Id);
    });

    it('rejects SetNodeType when proposed type conflicts with parent or children', async () => {
      const handler = await initWorkerDatabase();
      const db = getDatabase();

      const projId = '019ffe00-0000-7000-8000-000000000041';
      const parentId = '019ffe00-0000-7000-8000-000000000042';
      const childId = '019ffe00-0000-7000-8000-000000000043';

      handler.apply(
        createCreateProjectCommand(
          createDomainCreateProject({
            commandId: createUuidV7(),
            projectId: projId,
            name: 'Type Check',
          }),
        ),
      );

      // Parent is Feature, Child is untyped
      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
        bind: [parentId, projId, 'Parent Feature', 1000, 'Feature'],
      });
      db?.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, ?, ?, ?, NULL)',
        bind: [childId, projId, parentId, 'Child Untyped', 1000],
      });

      // Attempt to set Child type to Vision (invalid under Feature)
      const setChildRes = handler.apply({
        type: 'SetNodeType',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: projId,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: childId,
        nodeType: 'Vision',
      });

      expect(setChildRes.type).toBe('ProductCommandRejected');
      if (setChildRes.type === 'ProductCommandRejected') {
        expect(setChildRes.code).toBe('HIERARCHY_CONFLICT');
      }

      // Valid set: set child type to AcceptanceCriterion
      const setChildValid = handler.apply({
        type: 'SetNodeType',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: projId,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: childId,
        nodeType: 'AcceptanceCriterion',
      });
      expect(setChildValid.type).toBe('ProductCommandApplied');

      // Now attempt to change Parent to AcceptanceCriterion when it has an AcceptanceCriterion child -> valid
      // But if child is Feature, parent as AC is invalid:
      db?.exec({
        sql: 'UPDATE nodes SET node_type = ? WHERE id = ?',
        bind: ['Feature', childId],
      });

      const setParentInvalid = handler.apply({
        type: 'SetNodeType',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: projId,
        baseRevision: 2,
        expectedRevision: 3,
        nodeId: parentId,
        nodeType: 'AcceptanceCriterion',
      });
      expect(setParentInvalid.type).toBe('ProductCommandRejected');
      if (setParentInvalid.type === 'ProductCommandRejected') {
        expect(setParentInvalid.code).toBe('HIERARCHY_CONFLICT');
      }
    });
  });
});

describe('ProductCommandHandler SetNodeStatus (outline status badging)', () => {
  async function seed() {
    const handler = await initWorkerDatabase();
    const db = getDatabase();
    const projId = createUuidV7();
    const nodeId = createUuidV7();
    handler.apply(
      createCreateProjectCommand(
        createDomainCreateProject({ commandId: createUuidV7(), projectId: projId, name: 'Status Project' }),
      ),
    );
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type) VALUES (?, ?, NULL, ?, ?, ?)',
      bind: [nodeId, projId, 'Feature', 1000, 'Feature'],
    });
    const statusCmd = (deliveryStatus: string, baseRevision: number) => ({
      type: 'SetNodeStatus' as const,
      protocolVersion: '1.0.0' as const,
      commandId: createUuidV7(),
      projectId: projId,
      baseRevision,
      expectedRevision: baseRevision + 1,
      nodeId,
      deliveryStatus: deliveryStatus as 'not_started' | 'in_progress' | 'delivered',
    });
    return { handler, db, projId, nodeId, statusCmd };
  }

  it('applies the status, advances the revision, and emits a NodeStatusSet change with the prior value', async () => {
    const { handler, db, nodeId, statusCmd } = await seed();

    const res = handler.apply(statusCmd('in_progress', 1));
    expect(res.type).toBe('ProductCommandApplied');
    if (res.type !== 'ProductCommandApplied') return;
    expect(res.targetRevision).toBe(2);
    expect(res.changeSet?.changes).toEqual([
      { type: 'NodeStatusSet', nodeId, deliveryStatus: 'in_progress', priorDeliveryStatus: 'not_started' },
    ]);

    const row = db?.exec({
      sql: 'SELECT delivery_status FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(row?.[0]?.delivery_status).toBe('in_progress');

    // A second transition carries the real prior value.
    const res2 = handler.apply(statusCmd('delivered', 2));
    expect(res2.type).toBe('ProductCommandApplied');
    if (res2.type !== 'ProductCommandApplied') return;
    expect(res2.changeSet?.changes).toEqual([
      { type: 'NodeStatusSet', nodeId, deliveryStatus: 'delivered', priorDeliveryStatus: 'in_progress' },
    ]);
  });

  it('rejects with REVISION_CONFLICT on a stale baseRevision without mutating', async () => {
    const { handler, db, nodeId, statusCmd } = await seed();

    const res = handler.apply(statusCmd('delivered', 5));
    expect(res.type).toBe('ProductCommandRejected');
    if (res.type === 'ProductCommandRejected') {
      expect(res.code).toBe('REVISION_CONFLICT');
    }

    const row = db?.exec({
      sql: 'SELECT delivery_status FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(row?.[0]?.delivery_status ?? null).toBeNull();
  });

  it('rejects with NODE_NOT_FOUND for an unknown node', async () => {
    const { handler, statusCmd } = await seed();
    const res = handler.apply({
      ...statusCmd('in_progress', 1),
      nodeId: createUuidV7(),
    });
    expect(res.type).toBe('ProductCommandRejected');
    if (res.type === 'ProductCommandRejected') {
      expect(res.code).toBe('NODE_NOT_FOUND');
    }
  });
});
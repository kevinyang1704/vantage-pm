/**
 * Node open questions & decisions specs (Story 16.1, E16-FR3, E16-AR1).
 *
 * Covers schema creation, granular command application with exactly-once
 * receipts, FK cascade on node deletion, position ordering in the read model,
 * and the portable snapshot round-trip.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, queryProjectNodes, queryPortableSnapshot, getDatabase } from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  createAddNodeQuestionCommand,
  createUpdateNodeQuestionCommand,
  createResolveNodeQuestionCommand,
  createReorderNodeQuestionsCommand,
  createDeleteNodeQuestionCommand,
} from '../../domain/tree/node-question.commands';
import {
  createAddNodeQuestionWireCommand,
  createResolveNodeQuestionWireCommand,
  createUpdateNodeQuestionWireCommand,
  createReorderNodeQuestionsWireCommand,
  createDeleteNodeQuestionWireCommand,
} from '../../contracts/repository-commands';
import { PRODUCT_SCHEMA_VERSION } from './schema';

const Q1 = '019ffe00-0000-7000-8000-000000000103';
const Q2 = '019ffe00-0000-7000-8000-000000000104';

let seedCounter = 0;

async function seedProjectWithNode(): Promise<{
  handler: Awaited<ReturnType<typeof initWorkerDatabase>>;
  projectId: string;
  nodeId: string;
  q1: string;
  q2: string;
}> {
  const handler = await initWorkerDatabase();
  const db = getDatabase();
  seedCounter += 1;
  const projectId = `019ffe00-0000-7000-8000-${(0x1000000000 + seedCounter).toString(16).padStart(12, '0')}`;
  const nodeId = `019ffe00-0000-7000-8000-${(0x2000000000 + seedCounter).toString(16).padStart(12, '0')}`;
  const q1 = `019ffe00-0000-7000-8000-${(0x3000000000 + seedCounter).toString(16).padStart(12, '0')}`;
  const q2 = `019ffe00-0000-7000-8000-${(0x4000000000 + seedCounter).toString(16).padStart(12, '0')}`;
  handler.apply(
    createCreateProjectCommand(
      createDomainCreateProject({
        commandId: createUuidV7(),
        projectId,
        name: 'Questions Project',
      }),
    ),
  );
  db?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position) VALUES (?, ?, NULL, ?, ?)',
    bind: [nodeId, projectId, 'Feature Node', 1000],
  });
  return { handler, projectId, nodeId, q1, q2 };
}

describe('Story 16.1 node open questions', () => {
  it('the node_open_questions table exists with the by-node index, at the current schema version', async () => {
    await initWorkerDatabase();
    const db = getDatabase();
    // Bumped 5 -> 8 by Epic 17 (workspaces), then 8 -> 9 by outline status
    // badging (nodes.delivery_status), then 9 -> 10 by Epic 18 (forecast
    // plan), 10 -> 12 by Epic 20 (blockers, scenarios), 12 -> 13 by
    // Epic 21 (forecast_plans.planning_level), 13 -> 14 by Epic 22
    // (forecast_plans.roster), and 14 -> 15 by Epic 22 Story 22.4
    // (forecast_plans.assignments). This constant had already drifted out of
    // step with the native schema before Epic 17 — the Rust
    // CURRENT_SCHEMA_VERSION was 7 while this one still read 5 — so it is
    // asserted here only to catch an accidental edit, and must be updated in
    // lockstep with src-tauri/src/db/schema.rs whenever a migration lands.
    expect(PRODUCT_SCHEMA_VERSION).toBe(21);

    const table = db?.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_open_questions'",
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(table).toHaveLength(1);

    const index = db?.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'node_open_questions_by_node'",
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(index).toHaveLength(1);
  });

  it('applies AddNodeQuestion and exposes questions pre-sorted by position in the read model', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();

    const add1 = createAddNodeQuestionWireCommand(
      createAddNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        questionId: q1,
        nodeId,
        questionText: 'Should we use SQLite or IndexedDB?',
        position: 1000n,
        createdAtISO: '2026-08-29T00:00:00.000Z',
      }),
    );
    const add2 = createAddNodeQuestionWireCommand(
      createAddNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        questionId: q2,
        nodeId,
        questionText: 'What is the migration path?',
        position: 2000n,
        createdAtISO: '2026-08-29T00:00:01.000Z',
      }),
    );

    const r1 = handler.apply(add1);
    expect(r1.type).toBe('ProductCommandApplied');
    const r2 = handler.apply(add2);
    expect(r2.type).toBe('ProductCommandApplied');

    const model = queryProjectNodes(projectId);
    const node = model.nodes.find((n) => n.id === nodeId);
    expect(node).toBeDefined();
    expect(node?.openQuestions.map((q) => q.id)).toEqual([q1, q2]);
    expect(node?.openQuestions[0].status).toBe('OPEN');
    expect(node?.openQuestions[0].decisionText).toBeNull();
  });

  it('replays a duplicate AddNodeQuestion commandId with StoredResultReturned', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    const cmd = createAddNodeQuestionWireCommand(
      createAddNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        questionId: q1,
        nodeId,
        questionText: 'Duplicate-safe question?',
        position: 1000n,
        createdAtISO: '2026-08-29T00:00:00.000Z',
      }),
    );

    const first = handler.apply(cmd);
    expect(first.type).toBe('ProductCommandApplied');
    if (first.type !== 'ProductCommandApplied') return;
    expect(first.disposition).toBe('NewCommit');

    const replay = handler.apply(cmd);
    expect(replay.type).toBe('ProductCommandApplied');
    if (replay.type !== 'ProductCommandApplied') return;
    expect(replay.disposition).toBe('StoredResultReturned');

    const model = queryProjectNodes(projectId);
    expect(model.nodes.find((n) => n.id === nodeId)?.openQuestions).toHaveLength(1);
  });

  it('resolves a question to DECIDED with decision text and resolvedAtISO without touching body_text', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    const db = getDatabase();

    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Open question?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );

    // Author a body text first to prove resolve never clobbers it.
    db?.exec({
      sql: 'UPDATE nodes SET body_text = ? WHERE id = ?',
      bind: ['## Brief\nAuthored prose.', nodeId],
    });

    const resolve = createResolveNodeQuestionWireCommand(
      createResolveNodeQuestionCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        questionId: q1,
        decisionText: 'Use SQLite with OPFS.',
        resolvedAtISO: '2026-08-29T01:00:00.000Z',
      }),
    );
    const result = handler.apply(resolve);
    expect(result.type).toBe('ProductCommandApplied');

    const model = queryProjectNodes(projectId);
    const q = model.nodes.find((n) => n.id === nodeId)?.openQuestions[0];
    expect(q?.status).toBe('DECIDED');
    expect(q?.decisionText).toBe('Use SQLite with OPFS.');
    expect(q?.resolvedAtISO).toBe('2026-08-29T01:00:00.000Z');

    const bodyRow = db?.exec({
      sql: 'SELECT body_text FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(String(bodyRow?.[0]?.body_text)).toBe('## Brief\nAuthored prose.');
  });

  it('reorders questions and records prior order in the change set', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'First?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          questionId: q2,
          nodeId,
          questionText: 'Second?',
          position: 2000n,
          createdAtISO: '2026-08-29T00:00:01.000Z',
        }),
      ),
    );

    const reorder = createReorderNodeQuestionsWireCommand(createReorderNodeQuestionsCommand({
      commandId: createUuidV7(),
      projectId,
      baseRevision: 3,
      nodeId,
      questionIds: [q2, q1],
    }));
    const result = handler.apply(reorder);
    expect(result.type).toBe('ProductCommandApplied');
    if (result.type !== 'ProductCommandApplied') return;
    expect(result.changeSet?.changes[0]).toMatchObject({
      type: 'NodeQuestionsReordered',
      questionIds: [q2, q1],
      priorQuestionIds: [q1, q2],
    });

    const model = queryProjectNodes(projectId);
    expect(model.nodes.find((n) => n.id === nodeId)?.openQuestions.map((q) => q.id)).toEqual([q2, q1]);
  });

  it('rejects ReorderNodeQuestions when the id set does not match the node', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Only question?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );

    const reorder = createReorderNodeQuestionsWireCommand(createReorderNodeQuestionsCommand({
      commandId: createUuidV7(),
      projectId,
      baseRevision: 2,
      nodeId,
      questionIds: [q1, q2],
    }));
    const result = handler.apply(reorder);
    expect(result.type).toBe('ProductCommandRejected');
  });

  it('deletes a question and carries the full snapshot in the change set for undo', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Doomed question?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );

    const del = createDeleteNodeQuestionWireCommand(createDeleteNodeQuestionCommand({
      commandId: createUuidV7(),
      projectId,
      baseRevision: 2,
      questionId: q1,
    }));
    const result = handler.apply(del);
    expect(result.type).toBe('ProductCommandApplied');
    if (result.type !== 'ProductCommandApplied') return;
    expect(result.changeSet?.changes[0]).toMatchObject({
      type: 'NodeQuestionDeleted',
      questionId: q1,
      nodeId,
      questionText: 'Doomed question?',
      status: 'OPEN',
    });

    const model = queryProjectNodes(projectId);
    expect(model.nodes.find((n) => n.id === nodeId)?.openQuestions).toHaveLength(0);
  });

  it('cascades question deletion when the owning node is deleted (FK ON DELETE CASCADE)', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    const db = getDatabase();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Cascade me?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );

    db?.exec({
      sql: 'DELETE FROM nodes WHERE id = ?',
      bind: [nodeId],
    });

    const orphanRows = db?.exec({
      sql: 'SELECT COUNT(*) AS c FROM node_open_questions WHERE project_id = ?',
      bind: [projectId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(Number(orphanRows?.[0]?.c ?? 0)).toBe(0);
  });

  it('rejects question commands against a missing node with NODE_NOT_FOUND', async () => {
    const { handler, projectId, q1 } = await seedProjectWithNode();
    const result = handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId: '019ffe00-0000-7000-8000-00000000ffff',
          questionText: 'Orphan?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );
    expect(result.type).toBe('ProductCommandRejected');
    if (result.type === 'ProductCommandRejected') {
      expect(result.code).toBe('NODE_NOT_FOUND');
    }
  });

  it('round-trips open questions through the portable snapshot losslessly', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Round-trip question?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );
    handler.apply(
      createResolveNodeQuestionWireCommand(
        createResolveNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          questionId: q1,
          decisionText: 'Round-trip decision.',
          resolvedAtISO: '2026-08-29T01:00:00.000Z',
        }),
      ),
    );

    const snapshot = queryPortableSnapshot(projectId);
    expect(snapshot.openQuestions).toHaveLength(1);
    expect(snapshot.openQuestions[0]).toMatchObject({
      id: q1,
      nodeId,
      questionText: 'Round-trip question?',
      status: 'DECIDED',
      decisionText: 'Round-trip decision.',
      resolvedAtISO: '2026-08-29T01:00:00.000Z',
    });
  });

  it('keeps UpdateNodeQuestion orthogonal to body text', async () => {
    const { handler, projectId, nodeId, q1, q2 } = await seedProjectWithNode();
    const db = getDatabase();
    handler.apply(
      createAddNodeQuestionWireCommand(
        createAddNodeQuestionCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          questionId: q1,
          nodeId,
          questionText: 'Original wording?',
          position: 1000n,
          createdAtISO: '2026-08-29T00:00:00.000Z',
        }),
      ),
    );
    db?.exec({
      sql: 'UPDATE nodes SET body_text = ? WHERE id = ?',
      bind: ['Body stays.', nodeId],
    });

    const update = createUpdateNodeQuestionWireCommand(createUpdateNodeQuestionCommand({
      commandId: createUuidV7(),
      projectId,
      baseRevision: 2,
      questionId: q1,
      questionText: 'Revised wording?',
    }));
    const result = handler.apply(update);
    expect(result.type).toBe('ProductCommandApplied');

    const model = queryProjectNodes(projectId);
    expect(model.nodes.find((n) => n.id === nodeId)?.openQuestions[0].questionText).toBe('Revised wording?');
    const bodyRow = db?.exec({
      sql: 'SELECT body_text FROM nodes WHERE id = ?',
      bind: [nodeId],
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(String(bodyRow?.[0]?.body_text)).toBe('Body stays.');
  });
});

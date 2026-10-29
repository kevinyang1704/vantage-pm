/**
 * Story 27.2 — old-vs-new single-move replay oracle (AC 27.2-1, 27.2-2, 27.2-3).
 *
 * The whole-list gestures are re-expressed as single-move commands. This suite
 * proves a recorded gesture produces the identical canonical *shape* whether
 * replayed with the old whole-list command or the new single-move one — so the
 * refactor is behaviour-preserving. Each run seeds unique ids (the worker DB is
 * shared across tests), and the comparison maps ids to their seeded index.
 * Anchors are read off the old command's resulting order, as a producer would.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from './repository.worker';
import {
  createSetForecastMembershipWireCommand,
  createReorderForecastFeaturesWireCommand,
  createSetForecastSequenceWireCommand,
  createSetForecastAssignmentsWireCommand,
  createMoveForecastFeatureWireCommand,
  createSetForecastAssignmentWireCommand,
  createAddForecastPersonWireCommand,
  createReorderPhasesWireCommand,
  createMovePhaseWireCommand,
  createAddNodeQuestionWireCommand,
  createReorderNodeQuestionsWireCommand,
  createMoveNodeQuestionWireCommand,
} from '../../contracts/repository-commands';
import {
  createSetForecastMembershipCommand,
  createReorderForecastFeaturesCommand,
  createSetForecastSequenceCommand,
  createSetForecastAssignmentsCommand,
  createMoveForecastFeatureCommand,
  createSetForecastAssignmentCommand,
  createAddForecastPersonCommand,
} from '../../domain/forecast';
import { createMovePhaseCommand } from '../../domain/phase/phase.commands';
import { createMoveNodeQuestionCommand, createReorderNodeQuestionsCommand, createAddNodeQuestionCommand } from '../../domain/tree/node-question.commands';
import { readForecastPlan } from './forecast-operations';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';

const PROTOCOL = '1.0.0' as const;
const GAP = 4_294_967_296;
let seq = 0;
function vid(): string {
  seq += 1;
  return `019ffb00-0000-7000-8000-${seq.toString(16).padStart(12, '0')}`;
}

type Handler = Awaited<ReturnType<typeof initWorkerDatabase>>;

/** Fresh project + four forecast scope features. Returns ids and an index map. */
async function seedForecast(): Promise<{ handler: Handler; projectId: string; ids: string[] }> {
  const handler = await initWorkerDatabase();
  const projectId = vid();
  handler.apply({
    type: 'CreateProject', protocolVersion: PROTOCOL, commandId: vid(), projectId,
    baseRevision: 0, expectedRevision: 1, name: 'Oracle',
  });
  const ids = [vid(), vid(), vid(), vid()];
  ids.forEach((id, i) => {
    getDatabase()!.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [id, projectId, `Item ${i}`, (i + 1) * GAP, 'Feature', 10],
    });
  });
  ids.forEach((featureId, i) => {
    handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: vid(), projectId, baseRevision: i + 1, featureId, included: true,
    })));
  });
  return { handler, projectId, ids };
}

/** Map a stored order/groups to the seeded indices, so runs compare by shape. */
function shape(projectId: string, ids: readonly string[]): { order: number[]; groups: number[][] } {
  const index = new Map(ids.map((id, i) => [id, i]));
  const plan = readForecastPlan(getDatabase()!, projectId)!;
  return {
    order: plan.selectedFeatureIds.map((id) => index.get(id)!),
    groups: plan.parallelGroups.map((g) => g.featureIds.map((id) => index.get(id)!)),
  };
}

/** D8(c) anchors for reproducing `target` when moving `movingId`. */
function anchorsFor(movingId: string, target: readonly string[]): {
  afterId: string | null; beforeId: string | null; intendedIndex: number;
} {
  const idx = target.indexOf(movingId);
  return {
    afterId: idx > 0 ? target[idx - 1] : null,
    beforeId: idx < target.length - 1 ? target[idx + 1] : null,
    intendedIndex: idx,
  };
}

describe('Story 27.2 single-move replay oracle', () => {
  it('a feature reorder matches the whole-list command (AC 27.2-1, 27.2-2)', async () => {
    const oldRun = await seedForecast();
    const oldTarget = [oldRun.ids[2], oldRun.ids[0], oldRun.ids[1], oldRun.ids[3]];
    expect(oldRun.handler.apply(createReorderForecastFeaturesWireCommand(
      createReorderForecastFeaturesCommand({ commandId: vid(), projectId: oldRun.projectId, baseRevision: 5, featureIds: oldTarget }),
    )).type).toBe('ProductCommandApplied');

    const newRun = await seedForecast();
    const movingId = newRun.ids[2];
    const newTarget = [newRun.ids[2], newRun.ids[0], newRun.ids[1], newRun.ids[3]];
    expect(newRun.handler.apply(createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({ commandId: vid(), projectId: newRun.projectId, baseRevision: 5, featureId: movingId, ...anchorsFor(movingId, newTarget) }),
    )).type).toBe('ProductCommandApplied');

    expect(shape(newRun.projectId, newRun.ids)).toEqual(shape(oldRun.projectId, oldRun.ids));
    expect(shape(newRun.projectId, newRun.ids).order).toEqual([2, 0, 1, 3]);
  });

  it('a "run together" group join matches the whole-list sequence result (AC 27.2-2, 27.2-3)', async () => {
    const oldRun = await seedForecast();
    expect(oldRun.handler.apply(createSetForecastSequenceWireCommand(createSetForecastSequenceCommand({
      commandId: vid(), projectId: oldRun.projectId,
      baseRevision: 5, featureIds: oldRun.ids, parallelGroups: [{ featureIds: [oldRun.ids[0], oldRun.ids[1]] }],
    }))).type).toBe('ProductCommandApplied');

    const newRun = await seedForecast();
    expect(newRun.handler.apply(createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({
        commandId: vid(), projectId: newRun.projectId, baseRevision: 5, featureId: newRun.ids[1],
        afterId: newRun.ids[0], beforeId: null, intendedIndex: 1, groupChange: { kind: 'join', partnerId: newRun.ids[0] },
      }),
    )).type).toBe('ProductCommandApplied');

    const newShape = shape(newRun.projectId, newRun.ids);
    expect(newShape).toEqual(shape(oldRun.projectId, oldRun.ids));
    expect(newShape.groups).toEqual([[0, 1]]);
  });

  it('a single assignment matches the whole-list assignment (AC 27.2-2)', async () => {
    const oldRun = await seedForecast();
    const personId = vid();
    oldRun.handler.apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({
      commandId: vid(), projectId: oldRun.projectId, baseRevision: 5, personId, name: 'Hera', weightUnits: 100,
    })));
    expect(oldRun.handler.apply(createSetForecastAssignmentsWireCommand(createSetForecastAssignmentsCommand({
      commandId: vid(), projectId: oldRun.projectId, baseRevision: 6, featureId: oldRun.ids[0], personIds: [personId],
    }))).type).toBe('ProductCommandApplied');
    const oldAssignments = readForecastPlan(getDatabase()!, oldRun.projectId)!.assignments;

    const newRun = await seedForecast();
    newRun.handler.apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({
      commandId: vid(), projectId: newRun.projectId, baseRevision: 5, personId, name: 'Hera', weightUnits: 100,
    })));
    expect(newRun.handler.apply(createSetForecastAssignmentWireCommand(createSetForecastAssignmentCommand({
      commandId: vid(), projectId: newRun.projectId, baseRevision: 6, featureId: newRun.ids[0], personId, assigned: true,
    }))).type).toBe('ProductCommandApplied');

    const newAssignments = readForecastPlan(getDatabase()!, newRun.projectId)!.assignments;
    // Both runs assign the same single person to their first scope member.
    expect(Object.keys(oldAssignments)).toEqual([oldRun.ids[0]]);
    expect(Object.keys(newAssignments)).toEqual([newRun.ids[0]]);
    expect(Object.values(newAssignments)).toEqual(Object.values(oldAssignments));
    expect(Object.values(newAssignments)).toEqual([[personId]]);
  });

  it('a phase move matches the whole-list reorder (AC 27.2-1, 27.2-2)', async () => {
    async function seedPhases(): Promise<{ handler: Handler; projectId: string; ids: string[] }> {
      const handler = await initWorkerDatabase();
      const projectId = vid();
      handler.apply({
        type: 'CreateProject', protocolVersion: PROTOCOL, commandId: vid(), projectId,
        baseRevision: 0, expectedRevision: 1, name: 'Phases',
      });
      const ids = [vid(), vid(), vid()];
      ids.forEach((phaseId, i) => {
        handler.apply({
          type: 'CreatePhase', protocolVersion: PROTOCOL, commandId: vid(), projectId,
          baseRevision: i + 1, expectedRevision: i + 2, phaseId, name: `Phase ${i}`,
          position: String((i + 1) * GAP),
        });
      });
      return { handler, projectId, ids };
    }
    const readShape = (projectId: string, ids: readonly string[]): number[] => {
      const index = new Map(ids.map((id, i) => [id, i]));
      const rows = getDatabase()!.exec({
        sql: 'SELECT id FROM phases WHERE project_id = ? ORDER BY position ASC, id ASC',
        bind: [projectId], rowMode: 'object', returnValue: 'resultRows',
      }) as unknown as { id: string }[];
      return rows.map((r) => index.get(r.id)!);
    };

    const oldRun = await seedPhases();
    const oldTarget = [oldRun.ids[2], oldRun.ids[0], oldRun.ids[1]];
    expect(oldRun.handler.apply(createReorderPhasesWireCommand({
      type: 'ReorderPhases', commandId: vid(), projectId: oldRun.projectId, baseRevision: 4,
      phases: oldTarget.map((phaseId, i) => ({ phaseId, position: BigInt((i + 1) * GAP) })),
    })).type).toBe('ProductCommandApplied');

    const newRun = await seedPhases();
    const newTarget = [newRun.ids[2], newRun.ids[0], newRun.ids[1]];
    expect(newRun.handler.apply(createMovePhaseWireCommand(createMovePhaseCommand({
      commandId: vid(), projectId: newRun.projectId, baseRevision: 4, phaseId: newRun.ids[2], ...anchorsFor(newRun.ids[2], newTarget),
    }))).type).toBe('ProductCommandApplied');

    expect(readShape(newRun.projectId, newRun.ids)).toEqual(readShape(oldRun.projectId, oldRun.ids));
    expect(readShape(newRun.projectId, newRun.ids)).toEqual([2, 0, 1]);
  });

  it('a group join is undoable via a single-move inverse (AC 27.2-3)', async () => {
    const { handler, projectId, ids } = await seedForecast();
    const result = handler.apply(createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({
        commandId: vid(), projectId, baseRevision: 5, featureId: ids[1],
        afterId: ids[0], beforeId: null, intendedIndex: 1, groupChange: { kind: 'join', partnerId: ids[0] },
      }),
    ));
    expect(result.type).toBe('ProductCommandApplied');
    const inverse = result.type === 'ProductCommandApplied' && result.changeSet
      ? computeInverseDescriptor(result.changeSet)
      : null;
    expect(inverse).toMatchObject({ type: 'MoveForecastFeature', featureId: ids[1], groupChange: { kind: 'leave' } });
    if (!inverse || inverse.type !== 'MoveForecastFeature') throw new Error('expected a single-move inverse');

    // Apply the inverse: the group dissolves and the order is restored.
    const undo = handler.apply(createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({
        commandId: vid(), projectId, baseRevision: 6,
        featureId: inverse.featureId, afterId: inverse.afterId, beforeId: inverse.beforeId,
        intendedIndex: inverse.intendedIndex, groupChange: inverse.groupChange,
      }),
    ));
    expect(undo.type).toBe('ProductCommandApplied');
    expect(shape(projectId, ids)).toEqual({ order: [0, 1, 2, 3], groups: [] });
  });

  it('a question move matches the whole-list reorder (AC 27.2-1, 27.2-2)', async () => {
    async function seedQuestions(): Promise<{ handler: Handler; projectId: string; nodeId: string; ids: string[] }> {
      const handler = await initWorkerDatabase();
      const projectId = vid();
      handler.apply({
        type: 'CreateProject', protocolVersion: PROTOCOL, commandId: vid(), projectId,
        baseRevision: 0, expectedRevision: 1, name: 'Questions',
      });
      const nodeId = vid();
      getDatabase()!.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        bind: [nodeId, projectId, 'Node', GAP, 'Feature', 10],
      });
      const ids = [vid(), vid(), vid()];
      ids.forEach((questionId, i) => {
        handler.apply(createAddNodeQuestionWireCommand(createAddNodeQuestionCommand({
          commandId: vid(), projectId, baseRevision: i + 1, nodeId, questionId,
          questionText: `Q${i}`, position: BigInt((i + 1) * GAP), createdAtISO: '2026-09-30T00:00:00Z',
        })));
      });
      return { handler, projectId, nodeId, ids };
    }
    const readShape = (nodeId: string, ids: readonly string[]): number[] => {
      const index = new Map(ids.map((id, i) => [id, i]));
      const rows = getDatabase()!.exec({
        sql: 'SELECT id FROM node_open_questions WHERE node_id = ? ORDER BY position ASC',
        bind: [nodeId], rowMode: 'object', returnValue: 'resultRows',
      }) as unknown as { id: string }[];
      return rows.map((r) => index.get(r.id)!);
    };

    const oldRun = await seedQuestions();
    const oldTarget = [oldRun.ids[2], oldRun.ids[0], oldRun.ids[1]];
    expect(oldRun.handler.apply(createReorderNodeQuestionsWireCommand(createReorderNodeQuestionsCommand({
      commandId: vid(), projectId: oldRun.projectId,
      baseRevision: 4, nodeId: oldRun.nodeId, questionIds: oldTarget,
    }))).type).toBe('ProductCommandApplied');

    const newRun = await seedQuestions();
    const newTarget = [newRun.ids[2], newRun.ids[0], newRun.ids[1]];
    expect(newRun.handler.apply(createMoveNodeQuestionWireCommand(createMoveNodeQuestionCommand({
      commandId: vid(), projectId: newRun.projectId, baseRevision: 4, nodeId: newRun.nodeId,
      questionId: newRun.ids[2], ...anchorsFor(newRun.ids[2], newTarget),
    }))).type).toBe('ProductCommandApplied');

    expect(readShape(newRun.nodeId, newRun.ids)).toEqual(readShape(oldRun.nodeId, oldRun.ids));
    expect(readShape(newRun.nodeId, newRun.ids)).toEqual([2, 0, 1]);
  });
});

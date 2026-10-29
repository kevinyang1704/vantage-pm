/**
 * Story 27.2 — forecast-sequence diff spec (AC 27.2-1, 27.2-2).
 *
 * Proves `diffForecastSequence` reproduces a target order/groups through the
 * real browser repository: apply each intent as a MoveForecastFeature and the
 * resulting plan equals the target. Also pins the trivial single-move cases the
 * UI gestures actually produce.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase } from '../../adapters/persistence/repository.worker';
import {
  createSetForecastMembershipWireCommand,
  createMoveForecastFeatureWireCommand,
} from '../../contracts/repository-commands';
import {
  createSetForecastMembershipCommand,
  createMoveForecastFeatureCommand,
} from '../../domain/forecast';
import { readForecastPlan } from '../../adapters/persistence/forecast-operations';
import { diffForecastSequence } from './forecast-sequence-diff';
import type { ForecastParallelGroup } from '../../domain/forecast/forecast-plan.entity';

const PROTOCOL = '1.0.0' as const;
const GAP = 4_294_967_296;
let seq = 0;
const vid = (): string => `019ffa00-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

type Handler = Awaited<ReturnType<typeof initWorkerDatabase>>;

async function seed(count = 4): Promise<{ handler: Handler; projectId: string; ids: string[] }> {
  const handler = await initWorkerDatabase();
  const projectId = vid();
  handler.apply({ type: 'CreateProject', protocolVersion: PROTOCOL, commandId: vid(), projectId, baseRevision: 0, expectedRevision: 1, name: 'Diff' });
  const ids = Array.from({ length: count }, () => vid());
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

/** Apply diff intents and return the resulting plan shape (indexes). */
function applyDiff(
  handler: Handler,
  projectId: string,
  ids: readonly string[],
  currentGroups: readonly ForecastParallelGroup[],
  nextIds: readonly string[],
  nextGroups: readonly ForecastParallelGroup[],
): { order: number[]; groups: number[][] } {
  const intents = diffForecastSequence(ids, currentGroups, nextIds, nextGroups);
  const index = new Map(ids.map((id, i) => [id, i]));
  let revision = currentRevision(projectId);
  for (const intent of intents) {
    const result = handler.apply(createMoveForecastFeatureWireCommand(
      createMoveForecastFeatureCommand({
        commandId: vid(), projectId, baseRevision: revision,
        featureId: intent.featureId, afterId: intent.afterId, beforeId: intent.beforeId,
        intendedIndex: intent.intendedIndex, groupChange: intent.groupChange,
      }),
    ));
    expect(result.type).toBe('ProductCommandApplied');
    revision += 1;
  }
  const plan = readForecastPlan(getDatabase()!, projectId)!;
  return {
    order: plan.selectedFeatureIds.map((id) => index.get(id)!),
    groups: plan.parallelGroups.map((g) => g.featureIds.map((id) => index.get(id)!)),
  };
}

/** The project's current revision (seed project + membership commands). */
function currentRevision(projectId: string): number {
  const row = getDatabase()!.exec({
    sql: 'SELECT revision FROM projects WHERE id = ?',
    bind: [projectId], rowMode: 'object', returnValue: 'resultRows',
  }) as unknown as { revision: number }[];
  return Number(row[0].revision);
}

describe('Story 27.2 forecast-sequence diff', () => {
  it('a single row move emits exactly one intent', async () => {
    const { ids } = await seed();
    const nextIds = [ids[2], ids[0], ids[1], ids[3]];
    const intents = diffForecastSequence(ids, [], nextIds, []);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ featureId: ids[2], afterId: null, intendedIndex: 0 });
  });

  it('reproduces a reorder through the repository', async () => {
    const { handler, projectId, ids } = await seed();
    const nextIds = [ids[3], ids[2], ids[1], ids[0]];
    const shape = applyDiff(handler, projectId, ids, [], nextIds, []);
    expect(shape).toEqual({ order: [3, 2, 1, 0], groups: [] });
  });

  it('reproduces a whole-bucket move as several order moves', async () => {
    const { handler, projectId, ids } = await seed(5);
    // Move the block [ids[3], ids[4]] to the front.
    const nextIds = [ids[3], ids[4], ids[0], ids[1], ids[2]];
    const shape = applyDiff(handler, projectId, ids, [], nextIds, []);
    expect(shape).toEqual({ order: [3, 4, 0, 1, 2], groups: [] });
  });

  it('joins a group when two items become parallel', async () => {
    const { handler, projectId, ids } = await seed();
    const nextIds = [...ids];
    const nextGroups: ForecastParallelGroup[] = [Object.freeze({ featureIds: Object.freeze([ids[0], ids[1]]) })];
    const shape = applyDiff(handler, projectId, ids, [], nextIds, nextGroups);
    expect(shape).toEqual({ order: [0, 1, 2, 3], groups: [[0, 1]] });
  });

  it('leaves a group when an item is ungrouped', async () => {
    const { handler, projectId, ids } = await seed();
    const currentGroups: ForecastParallelGroup[] = [Object.freeze({ featureIds: Object.freeze([ids[0], ids[1]]) })];
    // Seed the group first.
    handler.apply(createMoveForecastFeatureWireCommand(createMoveForecastFeatureCommand({
      commandId: vid(), projectId, baseRevision: currentRevision(projectId), featureId: ids[1],
      afterId: ids[0], beforeId: null, intendedIndex: 1, groupChange: { kind: 'join', partnerId: ids[0] },
    })));
    const shape = applyDiff(handler, projectId, ids, currentGroups, [...ids], []);
    expect(shape).toEqual({ order: [0, 1, 2, 3], groups: [] });
  });

  it('inserts an item added by a preceding membership command (26.7 apply)', async () => {
    const { ids } = await seed();
    const added = '019ffa00-0000-7000-8000-00000000ffff';
    const nextIds = [added, ...ids];
    const intents = diffForecastSequence(ids, [], nextIds, []);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ featureId: added, afterId: null, intendedIndex: 0 });
  });

  it('returns no intents when nothing changed', async () => {
    const { ids } = await seed();
    expect(diffForecastSequence(ids, [], [...ids], [])).toEqual([]);
  });
});

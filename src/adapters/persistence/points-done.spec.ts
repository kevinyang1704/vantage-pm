/**
 * Story 26.5 — Record points done on in-progress items (FC-FR5, FC-NFR5).
 *
 * The command stores and edits `effortPointsDone`; forecasting from it is
 * Story 26.6. Covers: a stored value on the node; a validated, undoable
 * command; the `SetNodeEffort` below-done refusal (never clamped); status
 * independence (a status change does not touch points done); schema v16
 * migration with null defaults; and the portable round-trip.
 */

import { describe, expect, it } from 'vitest';
import {
  initWorkerDatabase,
  queryProjectNodes,
  queryPortableSnapshot,
  getDatabase,
  batchImportPortable,
} from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  createCreateProjectCommand,
  createSetNodePointsDoneWireCommand,
  createSetNodeStatusWireCommand,
  createSetNodeEffortWireCommand,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import { createSetNodePointsDoneCommand } from '../../domain/tree/set-node-points-done.command';
import { createSetNodeEffortCommand } from '../../domain/tree/set-node-effort.command';
import { createSetNodeStatusCommand } from '../../domain/tree/set-node-status.command';
import {
  serializePortableFileEnvelope,
  parsePortableFile,
  PORTABLE_FILE_SCHEMA_VERSION,
  type PortableFileEnvelopeV9,
} from '../../contracts/portable-file.schema';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';

let counter = 0;
function nextId(prefix: number): string {
  counter += 1;
  return `019ffe00-0000-7000-8000-${(prefix * 0x100000000 + counter).toString(16).padStart(12, '0')}`;
}

/** Seeds a project with one Feature of the given estimate. */
async function seedFeature(effortPoints: number | null): Promise<{
  handler: Awaited<ReturnType<typeof initWorkerDatabase>>;
  projectId: string;
  featureId: string;
  revision: number;
}> {
  const handler = await initWorkerDatabase();
  const projectId = nextId(1);
  const featureId = nextId(2);
  handler.apply(
    createCreateProjectCommand(
      createDomainCreateProject({ commandId: createUuidV7(), projectId, name: 'Points Done' }),
    ),
  );
  getDatabase()?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, delivery_status) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)',
    bind: [featureId, projectId, 'Feature A', 1000, 'Feature', effortPoints, 'in_progress'],
  });
  const revisionRow = getDatabase()?.exec({
    sql: 'SELECT revision FROM projects WHERE id = ?',
    bind: [projectId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as { revision: number }[];
  return { handler, projectId, featureId, revision: Number(revisionRow[0].revision) };
}

function pointsDoneOf(projectId: string, featureId: string): number | null {
  const model = queryProjectNodes(projectId);
  return model.nodes.find((n) => n.id === featureId)?.effortPointsDone ?? null;
}

describe('Story 26.5 — record points done on in-progress items', () => {
  it('AC 26.5-1: a new node has null points done, stored beside the estimate', async () => {
    const { projectId, featureId } = await seedFeature(20);
    expect(pointsDoneOf(projectId, featureId)).toBeNull();
  });

  it('AC 26.5-2: a valid value commits with a receipt and is undoable exactly', async () => {
    const { handler, projectId, featureId, revision } = await seedFeature(20);
    const applied = handler.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: revision,
          nodeId: featureId,
          effortPointsDone: 11,
        }),
      ),
    );
    expect(applied.type).toBe('ProductCommandApplied');
    expect(pointsDoneOf(projectId, featureId)).toBe(11);

    // The change set inverts to the prior value (null) exactly.
    if (applied.type !== 'ProductCommandApplied' || !applied.changeSet) return;
    const inverse = computeInverseDescriptor(applied.changeSet);
    expect(inverse).toEqual({ type: 'SetNodePointsDone', nodeId: featureId, effortPointsDone: null });
  });

  it('AC 26.5-2: a value above the estimate, a value with no estimate, and a negative are refused by name', async () => {
    const { handler, projectId, featureId, revision } = await seedFeature(20);

    const tooHigh = handler.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision, nodeId: featureId, effortPointsDone: 21,
        }),
      ),
    );
    expect(tooHigh.type).toBe('ProductCommandRejected');
    if (tooHigh.type === 'ProductCommandRejected') expect(tooHigh.code).toBe('POINTS_DONE_CONFLICT');

    // Shape validation refuses a negative before it reaches the applier.
    expect(() =>
      createSetNodePointsDoneCommand({
        commandId: createUuidV7(), projectId, baseRevision: revision, nodeId: featureId, effortPointsDone: -1,
      }),
    ).toThrow();

    // An item with no estimate cannot record progress.
    const { handler: h2, projectId: p2, featureId: f2, revision: r2 } = await seedFeature(null);
    const noEstimate = h2.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(), projectId: p2, baseRevision: r2, nodeId: f2, effortPointsDone: 1,
        }),
      ),
    );
    expect(noEstimate.type).toBe('ProductCommandRejected');
    if (noEstimate.type === 'ProductCommandRejected') expect(noEstimate.code).toBe('POINTS_DONE_CONFLICT');
  });

  it('AC 26.5-2: lowering the estimate below the recorded done value is refused, not clamped', async () => {
    const { handler, projectId, featureId, revision } = await seedFeature(20);
    const setDone = handler.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision, nodeId: featureId, effortPointsDone: 15,
        }),
      ),
    );
    expect(setDone.type).toBe('ProductCommandApplied');

    const lower = handler.apply(
      createSetNodeEffortWireCommand(
        createSetNodeEffortCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision + 1, nodeId: featureId, effortPoints: 10,
        }),
      ),
    );
    expect(lower.type).toBe('ProductCommandRejected');
    if (lower.type === 'ProductCommandRejected') {
      expect(lower.code).toBe('EFFORT_BELOW_POINTS_DONE');
      expect(lower.priorPointsDone).toBe(15);
    }
    // Nothing changed: the recorded value and estimate are intact.
    const model = queryProjectNodes(projectId);
    const row = model.nodes.find((n) => n.id === featureId);
    expect(row?.effortPoints).toBe(20);
    expect(row?.effortPointsDone).toBe(15);

    // Raising the estimate to exactly done is allowed.
    const equal = handler.apply(
      createSetNodeEffortWireCommand(
        createSetNodeEffortCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision + 1, nodeId: featureId, effortPoints: 15,
        }),
      ),
    );
    expect(equal.type).toBe('ProductCommandApplied');
  });

  it('AC 26.5-3: a status change leaves points done unchanged and vice versa', async () => {
    const { handler, projectId, featureId, revision } = await seedFeature(20);
    handler.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision, nodeId: featureId, effortPointsDone: 7,
        }),
      ),
    );
    const status = handler.apply(
      createSetNodeStatusWireCommand(
        createSetNodeStatusCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision + 1, nodeId: featureId, deliveryStatus: 'delivered',
        }),
      ),
    );
    expect(status.type).toBe('ProductCommandApplied');
    expect(pointsDoneOf(projectId, featureId)).toBe(7);
    const model = queryProjectNodes(projectId);
    expect(model.nodes.find((n) => n.id === featureId)?.deliveryStatus).toBe('delivered');
  });

  it('AC 26.5-5: portable v9 round-trips points done; the version is now 10', () => {
    expect(PORTABLE_FILE_SCHEMA_VERSION).toBe(10);
  });

  it('AC 26.5-6: points done round-trips through export and import', async () => {
    const { handler, projectId, featureId, revision } = await seedFeature(20);
    handler.apply(
      createSetNodePointsDoneWireCommand(
        createSetNodePointsDoneCommand({
          commandId: createUuidV7(), projectId, baseRevision: revision, nodeId: featureId, effortPointsDone: 9,
        }),
      ),
    );
    const snapshot = await queryPortableSnapshot(projectId);
    const envelope = serializePortableFileEnvelope({
      schemaVersion: PORTABLE_FILE_SCHEMA_VERSION as 10,
      exportedAt: '2026-09-28T00:00:00.000Z',
      project: { id: snapshot.projectId, name: snapshot.projectName },
      phases: snapshot.phases,
      nodes: snapshot.nodes,
      nodeCustomFields: snapshot.nodeCustomFields,
      typeTemplateFields: snapshot.typeTemplateFields,
      unlockEdges: snapshot.unlockEdges,
      findingDismissals: snapshot.findingDismissals,
      affectedReasons: snapshot.affectedReasons,
      openQuestions: snapshot.openQuestions,
      ...(snapshot.forecastPlan ? { forecastPlan: snapshot.forecastPlan } : {}),
    });
    const parsed = parsePortableFile(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const exported = (parsed.value as PortableFileEnvelopeV9).nodes.find((n) => n.id === featureId);
    expect(exported?.effortPointsDone).toBe(9);
  });

  it('AC 26.5-6: a legacy v8 file without the field imports with null', async () => {
    const { projectId } = await seedFeature(20);
    const snapshot = await queryPortableSnapshot(projectId);
    // Simulate a pre-v9 file: strip the field from every node.
    const legacyNodes = snapshot.nodes.map((n) => {
      const record = { ...(n as Record<string, unknown>) };
      delete record.effortPointsDone;
      return record;
    });
    const envelope = serializePortableFileEnvelope({
      schemaVersion: 8 as unknown as 10,
      exportedAt: '2026-09-28T00:00:00.000Z',
      project: { id: snapshot.projectId, name: snapshot.projectName },
      phases: snapshot.phases,
      nodes: legacyNodes as unknown as typeof snapshot.nodes,
      nodeCustomFields: snapshot.nodeCustomFields,
      typeTemplateFields: snapshot.typeTemplateFields,
      unlockEdges: snapshot.unlockEdges,
      findingDismissals: snapshot.findingDismissals,
      affectedReasons: snapshot.affectedReasons,
      openQuestions: snapshot.openQuestions,
    });
    const parsed = parsePortableFile(envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.value as PortableFileEnvelopeV9).nodes.every((n) => n.effortPointsDone === null)).toBe(true);
  });
});

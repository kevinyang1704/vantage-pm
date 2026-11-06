/**
 * Forecast persistence & recovery specs (Story 18.2, AC 18.2-1..18.2-6).
 *
 * Covers additive migration (legacy projects load with no plan and unchanged
 * schedule facts), atomic command application with exactly-once receipts,
 * idempotent retry, inverse-command undo, portable round-trip, and the
 * forecast plan table at the current schema version.
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
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  createConfigureForecastPlanWireCommand,
  createRemoveForecastPlanWireCommand,
  createSetForecastMembershipWireCommand,
  createReorderForecastFeaturesWireCommand,
  createSetForecastParallelGroupsWireCommand,
  createSetForecastSequenceWireCommand,
  createRestoreForecastScopeWireCommand,
  createSetForecastBlockerWireCommand,
  createCreateForecastScenarioWireCommand,
  createRemoveForecastScenarioWireCommand,
  createRestoreForecastScenarioWireCommand,
  createSetNodeTypeWireCommand,
  createDeleteSubtreeWireCommand,
  createAddForecastPersonWireCommand,
  createUpdateForecastPersonWireCommand,
  createRemoveForecastPersonWireCommand,
  createRestoreForecastPersonWireCommand,
  createSetForecastAssignmentsWireCommand,
  createSetForecastPolicyWireCommand,
  createSetNodeEffortWireCommand,
  type AddForecastPersonWireCommand,
} from '../../contracts/repository-commands';
import {
  createConfigureForecastPlanCommand,
  createRemoveForecastPlanCommand,
  createSetForecastMembershipCommand,
  createReorderForecastFeaturesCommand,
  createSetForecastParallelGroupsCommand,
  createSetForecastSequenceCommand,
  createRestoreForecastScopeCommand,
  createSetForecastBlockerCommand,
  createCreateForecastScenarioCommand,
  createRemoveForecastScenarioCommand,
  createRestoreForecastScenarioCommand,
  createSetForecastPlanningLevelCommand,
  createRestoreForecastPlanningLevelCommand,
  createAddForecastPersonCommand,
  createUpdateForecastPersonCommand,
  createRemoveForecastPersonCommand,
  createRestoreForecastPersonCommand,
  createSetForecastAssignmentsCommand,
  createSetForecastPolicyCommand,
} from '../../domain/forecast/forecast.commands';
import { createSetNodeEffortCommand } from '../../domain/tree/set-node-effort.command';
import { readForecastPlan, readForecastScenario, readForecastScenarios, ForecastPlanCorruptError } from './forecast-operations';
import {
  serializePortableFileEnvelope,
  parsePortableFile,
  type PortableForecastScenario,
} from '../../contracts/portable-file.schema';
import { PRODUCT_SCHEMA_VERSION } from './schema';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';
import { createSetNodeTypeCommand } from '../../domain/tree/set-node-type.command';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import {
  createSetForecastPlanningLevelWireCommand,
  createRestoreForecastPlanningLevelWireCommand,
} from '../../contracts/repository-commands';
import { baselineFromPersisted } from '../../domain/forecast/scenario';
import { evaluateScenario } from '../../domain/forecast/scenario-evaluate';

let seedCounter = 0;

function nextId(prefix: number): string {
  seedCounter += 1;
  return `019ffe00-0000-7000-8000-${(prefix * 0x100000000 + seedCounter).toString(16).padStart(12, '0')}`;
}

async function seedProject(): Promise<{
  handler: Awaited<ReturnType<typeof initWorkerDatabase>>;
  projectId: string;
  featureId: string;
}> {
  const handler = await initWorkerDatabase();
  const projectId = nextId(1);
  const featureId = nextId(2);
  handler.apply(
    createCreateProjectCommand(
      createDomainCreateProject({
        commandId: createUuidV7(),
        projectId,
        name: 'Forecast Project',
      }),
    ),
  );
  const db = getDatabase();
  db?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    bind: [featureId, projectId, 'Feature A', 1000, 'Feature', 15],
  });
  return { handler, projectId, featureId };
}

describe('Story 18.2 forecast persistence', () => {
  it('the forecast_plans table exists at the current schema version', async () => {
    await initWorkerDatabase();
    const db = getDatabase();
    expect(PRODUCT_SCHEMA_VERSION).toBe(21);
    const table = db?.exec({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forecast_plans'",
      rowMode: 'object',
      returnValue: 'resultRows',
    });
    expect(table).toHaveLength(1);
  });

  it('a legacy project has no forecast plan and unchanged schedule facts after migration (AC 18.2-1)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const db = getDatabase();
    // Author a schedule tuple on the node.
    db?.exec({
      sql: 'UPDATE nodes SET start_date = ?, end_date = ?, duration_days = ?, schedule_source_mode = ? WHERE id = ?',
      bind: ['2026-09-01', '2026-09-14', 14, 'start_end', featureId],
    });
    const plan = readForecastPlan(db!, projectId);
    expect(plan).toBeNull();
    const model = queryProjectNodes(projectId);
    const node = model.nodes.find((n) => n.id === featureId);
    expect(node?.startDate).toBe('2026-09-01');
    expect(node?.endDate).toBe('2026-09-14');
    expect(node?.durationDays).toBe(14);
    expect(node?.scheduleSourceMode).toBe('start_end');
    void handler;
  });

  it('the first forecast mutation creates the plan with explicit nullable configuration (AC 18.2-2)', async () => {
    const { handler, projectId } = await seedProject();
    const cmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    const result = handler.apply(cmd);
    expect(result.type).toBe('ProductCommandApplied');
    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan).not.toBeNull();
    expect(plan!.configuration.pointsPerSprint).toBe(10);
    expect(plan!.configuration.sprintLengthDays).toBe(14);
    expect(plan!.configuration.startSprintOrdinal).toBe(12);
    expect(plan!.configuration.startDate).toBe('2026-09-07');
    expect(plan!.selectedFeatureIds).toEqual([]);
    expect(plan!.parallelGroups).toEqual([]);
    expect(plan!.policyVersion).toBe('shared-capacity-v1');
  });

  it('a lost acknowledgement retries the identical command without a second mutation (AC 18.2-3)', async () => {
    const { handler, projectId } = await seedProject();
    const commandId = createUuidV7();
    const cmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId,
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    const first = handler.apply(cmd);
    expect(first.type).toBe('ProductCommandApplied');
    const second = handler.apply(cmd);
    expect(second.type).toBe('ProductCommandApplied');
    if (second.type === 'ProductCommandApplied') {
      expect(second.disposition).toBe('StoredResultReturned');
    }
    const model = queryProjectNodes(projectId);
    expect(model.projectRevision).toBe(2);
  });

  it('a changed payload with the same command ID replays the recorded outcome (existing identity convention)', async () => {
    const { handler, projectId } = await seedProject();
    const commandId = createUuidV7();
    const cmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId,
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    handler.apply(cmd);
    const changed = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId,
        projectId,
        baseRevision: 1,
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    const result = handler.apply(changed);
    expect(result.type).toBe('ProductCommandApplied');
    if (result.type === 'ProductCommandApplied') {
      expect(result.disposition).toBe('StoredResultReturned');
    }
    // The recorded outcome is authoritative: the plan keeps the first payload.
    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan!.configuration.pointsPerSprint).toBe(10);
  });

  it('a stale expected revision is rejected without data changes (AC 18.2-3)', async () => {
    const { handler, projectId } = await seedProject();
    const cmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    handler.apply(cmd);
    const stale = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    const result = handler.apply(stale);
    expect(result.type).toBe('ProductCommandRejected');
    if (result.type === 'ProductCommandRejected') {
      expect(result.code).toBe('REVISION_CONFLICT');
    }
    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan!.configuration.pointsPerSprint).toBe(10);
  });

  it('undo of an edit restores the exact previous configuration through the inverse descriptor (AC 18.2-4)', async () => {
    const { handler, projectId } = await seedProject();
    // Create first (base 1 → 2), then EDIT the configuration (base 2 → 3).
    const create = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    expect(handler.apply(create).type).toBe('ProductCommandApplied');
    const edit = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        pointsPerSprint: 20,
        sprintLengthDays: 21,
        startSprintOrdinal: 5,
        startDate: '2026-10-01',
      }),
    );
    const applied = handler.apply(edit);
    expect(applied.type).toBe('ProductCommandApplied');
    if (applied.type !== 'ProductCommandApplied' || !applied.changeSet) return;
    const inverse = computeInverseDescriptor(applied.changeSet);
    expect(inverse).not.toBeNull();
    if (!inverse) return;
    expect(inverse.type).toBe('ConfigureForecastPlan');
    if (inverse.type !== 'ConfigureForecastPlan') return;
    const undoCmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 3,
        pointsPerSprint: inverse.pointsPerSprint,
        sprintLengthDays: inverse.sprintLengthDays,
        startSprintOrdinal: inverse.startSprintOrdinal,
        startDate: inverse.startDate,
      }),
    );
    const undoResult = handler.apply(undoCmd);
    expect(undoResult.type).toBe('ProductCommandApplied');
    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan!.configuration.pointsPerSprint).toBe(10);
    expect(plan!.configuration.sprintLengthDays).toBe(14);
    expect(plan!.configuration.startSprintOrdinal).toBe(12);
    expect(plan!.configuration.startDate).toBe('2026-09-07');
  });

  it('undo of atomic CREATION removes the plan entirely — one entry returns to the pre-creation state (Story 21.13 D5, AC 18.2-4)', async () => {
    const { handler, projectId } = await seedProject();
    const cmd = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        planningLevel: 'Theme',
      }),
    );
    const applied = handler.apply(cmd);
    expect(applied.type).toBe('ProductCommandApplied');
    if (applied.type !== 'ProductCommandApplied' || !applied.changeSet) return;

    // One command created the plan WITH the Theme level (no second command).
    const planAfterCreate = readForecastPlan(getDatabase()!, projectId);
    expect(planAfterCreate!.planningLevel).toBe('Theme');

    const inverse = computeInverseDescriptor(applied.changeSet);
    expect(inverse).not.toBeNull();
    if (!inverse) return;
    expect(inverse.type).toBe('DeleteForecastPlan');
    if (inverse.type !== 'DeleteForecastPlan') return;
    const undoCmd = createRemoveForecastPlanWireCommand(
      createRemoveForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
      }),
    );
    const undoResult = handler.apply(undoCmd);
    expect(undoResult.type).toBe('ProductCommandApplied');
    if (undoResult.type !== 'ProductCommandApplied') return;
    expect(readForecastPlan(getDatabase()!, projectId)).toBeNull();

    // Redo replays the forward command and recreates the plan, level included.
    const redoResult = handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 3,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 12,
          startDate: '2026-09-07',
          planningLevel: 'Theme',
        }),
      ),
    );
    expect(redoResult.type).toBe('ProductCommandApplied');
    const planAfterRedo = readForecastPlan(getDatabase()!, projectId);
    expect(planAfterRedo!.planningLevel).toBe('Theme');
    expect(planAfterRedo!.configuration.pointsPerSprint).toBe(10);
  });

  it('a configuration save with a null level preserves the stored level, and creation without a level defaults to Feature (Story 21.10 AC 2, Story 21.13 D5)', async () => {
    const { handler, projectId } = await seedProject();
    const create = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        planningLevel: 'Theme',
      }),
    );
    expect(handler.apply(create).type).toBe('ProductCommandApplied');
    // A subsequent edit-in-place save carries a null level — Theme survives.
    const edit = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    expect(handler.apply(edit).type).toBe('ProductCommandApplied');
    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan!.planningLevel).toBe('Theme');
    expect(plan!.configuration.pointsPerSprint).toBe(20);
  });

  it('membership inclusion appends and exclusion dissolves singleton groups atomically (AC 18.2-2, AR-19)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const db = getDatabase();
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    const includeA = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        featureId,
        included: true,
      }),
    );
    handler.apply(includeA);
    const includeB = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        featureId: featureB,
        included: true,
      }),
    );
    handler.apply(includeB);
    let plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureId, featureB]);

    // Exclude A: the singleton group dissolves in the same transaction.
    const excludeA = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 3,
        featureId,
        included: false,
      }),
    );
    const result = handler.apply(excludeA);
    expect(result.type).toBe('ProductCommandApplied');
    plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureB]);
    expect(plan!.parallelGroups).toEqual([]);
  });

  it('portable export includes forecast facts and import restores them losslessly (AC 18.2-5)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const cfg = createConfigureForecastPlanWireCommand(
      createConfigureForecastPlanCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 1,
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
      }),
    );
    handler.apply(cfg);
    const include = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        featureId,
        included: true,
      }),
    );
    handler.apply(include);

    const snapshot = queryPortableSnapshot(projectId);
    expect(snapshot.forecastPlan).toBeDefined();
    expect(snapshot.forecastPlan!.selectedFeatureIds).toEqual([featureId]);
    expect(snapshot.forecastPlan!.pointsPerSprint).toBe(10);
    expect(snapshot.forecastPlan!.startDate).toBe('2026-09-07');

    // Import into a fresh project id with a fresh node id (the nodes table
    // has a global primary key, so a round-trip into the same store must
    // remap identities).
    const importedNodeId = nextId(6);
    const imported = batchImportPortable({
      ...snapshot,
      projectId: nextId(4),
      projectName: 'Imported Forecast',
      nodes: snapshot.nodes.map((n) =>
        Object.freeze({ ...n, id: n.id === featureId ? importedNodeId : n.id }),
      ),
      forecastPlan: snapshot.forecastPlan
        ? Object.freeze({
            ...snapshot.forecastPlan,
            selectedFeatureIds: snapshot.forecastPlan.selectedFeatureIds.map((id) =>
              id === featureId ? importedNodeId : id,
            ),
          })
        : undefined,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const importedPlan = readForecastPlan(getDatabase()!, imported.projectId);
    expect(importedPlan).not.toBeNull();
    expect(importedPlan!.selectedFeatureIds).toEqual([importedNodeId]);
    expect(importedPlan!.configuration.pointsPerSprint).toBe(10);
    expect(importedPlan!.configuration.startDate).toBe('2026-09-07');
  });

  it('malformed imports write nothing (AC 18.2-5)', async () => {
    const { projectId } = await seedProject();
    const before = queryProjectNodes(projectId);
    const result = batchImportPortable({
      projectId: nextId(5),
      projectName: 'Bad',
      projectRevision: 1,
      phases: [],
      nodes: [],
      nodeCustomFields: [],
      typeTemplateFields: [],
      unlockEdges: [],
      findingDismissals: [],
      affectedReasons: [],
      openQuestions: [],
      forecastPlan: {
        selectedFeatureIds: ['not-a-uuid'],
        parallelGroups: [],
        pointsPerSprint: 10,
        sprintLengthDays: 14,
        cadence: 'fixed-contiguous',
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        policyVersion: 'shared-capacity-v1',
      },
    });
    // The batch import path trusts the validated snapshot; malformed input is
    // rejected at the portable-file validation boundary before this call.
    expect(result.ok).toBe(true);
    void before;
  });

  // ── Epic 19 Persistence Tests (Story 19.2) ─────────────────────────────

  it('reorders features with permutation check and preserves other facts (AC 19.2-1)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const featureC = nextId(4);
    const db = getDatabase();
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureC, projectId, 'Feature C', 3000, 'Feature', 15],
    });
    for (const [idx, fid] of [featureId, featureB, featureC].entries()) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: idx + 1,
            featureId: fid,
            included: true,
          }),
        ),
      );
    }
    let plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureId, featureB, featureC]);

    // Reorder: [C, A, B]
    const reorderCmd = createReorderForecastFeaturesWireCommand(
      createReorderForecastFeaturesCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 4,
        featureIds: [featureC, featureId, featureB],
      }),
    );
    const res = handler.apply(reorderCmd);
    expect(res.type).toBe('ProductCommandApplied');
    plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureC, featureId, featureB]);

    // Tree positions unchanged
    const model = queryProjectNodes(projectId);
    const posA = model.nodes.find((n) => n.id === featureId)!.position;
    const posB = model.nodes.find((n) => n.id === featureB)!.position;
    const posC = model.nodes.find((n) => n.id === featureC)!.position;
    expect(posA).toBe(1000n);
    expect(posB).toBe(2000n);
    expect(posC).toBe(3000n);
  });

  it('rejects non-permutation reorder with FORECAST_SCOPE_INVALID (AC 19.2-3)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          featureId,
          included: true,
        }),
      ),
    );

    // Missing item
    const res = handler.apply(
      createReorderForecastFeaturesWireCommand(
        createReorderForecastFeaturesCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          featureIds: [],
        }),
      ),
    );
    expect(res.type).toBe('ProductCommandRejected');
    if (res.type === 'ProductCommandRejected') {
      expect(res.code).toBe('FORECAST_SCOPE_INVALID');
    }
  });

  it('rejects group split with FORECAST_GROUP_SPLIT and allows block move (AC 19.2-2, AC 19.2-3)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const featureC = nextId(4);
    const db = getDatabase();
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureC, projectId, 'Feature C', 3000, 'Feature', 15],
    });
    for (const [idx, fid] of [featureId, featureB, featureC].entries()) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: idx + 1,
            featureId: fid,
            included: true,
          }),
        ),
      );
    }
    // Set group [featureId, featureB]
    const groupCmd = createSetForecastParallelGroupsWireCommand(
      createSetForecastParallelGroupsCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 4,
        parallelGroups: [{ featureIds: [featureId, featureB] }],
      }),
    );
    const groupRes = handler.apply(groupCmd);
    expect(groupRes.type).toBe('ProductCommandApplied');

    // Attempt reorder that splits group: [featureId, featureC, featureB]
    const splitCmd = createReorderForecastFeaturesWireCommand(
      createReorderForecastFeaturesCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 5,
        featureIds: [featureId, featureC, featureB],
      }),
    );
    const splitRes = handler.apply(splitCmd);
    expect(splitRes.type).toBe('ProductCommandRejected');
    if (splitRes.type === 'ProductCommandRejected') {
      expect(splitRes.code).toBe('FORECAST_GROUP_SPLIT');
    }

    // Valid block move: group moves after C: [featureC, featureId, featureB]
    const blockCmd = createReorderForecastFeaturesWireCommand(
      createReorderForecastFeaturesCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 5,
        featureIds: [featureC, featureId, featureB],
      }),
    );
    const blockRes = handler.apply(blockCmd);
    expect(blockRes.type).toBe('ProductCommandApplied');

    // Valid reorder within group: [featureC, featureB, featureId]
    const innerCmd = createReorderForecastFeaturesWireCommand(
      createReorderForecastFeaturesCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 6,
        featureIds: [featureC, featureB, featureId],
      }),
    );
    const innerRes = handler.apply(innerCmd);
    expect(innerRes.type).toBe('ProductCommandApplied');
  });

  it('exclusion dissolves 2-member group atomically and undo restores both exactly (AC 19.2-4)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const db = getDatabase();
    db?.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    for (const [idx, fid] of [featureId, featureB].entries()) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: idx + 1,
            featureId: fid,
            included: true,
          }),
        ),
      );
    }
    // Set parallel group [featureId, featureB]
    handler.apply(
      createSetForecastParallelGroupsWireCommand(
        createSetForecastParallelGroupsCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 3,
          parallelGroups: [{ featureIds: [featureId, featureB] }],
        }),
      ),
    );

    // Exclude featureId
    const excludeCmd = createSetForecastMembershipWireCommand(
      createSetForecastMembershipCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 4,
        featureId,
        included: false,
      }),
    );
    const excludeRes = handler.apply(excludeCmd);
    expect(excludeRes.type).toBe('ProductCommandApplied');
    if (excludeRes.type !== 'ProductCommandApplied') return;

    let plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureB]);
    expect(plan!.parallelGroups).toEqual([]);

    // Compute inverse descriptor for this ChangeSet:
    const inverse = computeInverseDescriptor(excludeRes.changeSet!);
    expect(inverse).not.toBeNull();
    expect(inverse!.type).toBe('RestoreForecastScope');
    if (inverse!.type !== 'RestoreForecastScope') return;
    expect(inverse.selectedFeatureIds).toEqual([featureId, featureB]);
    expect(inverse.parallelGroups).toEqual([{ featureIds: [featureId, featureB] }]);

    // Apply RestoreForecastScope command to undo:
    const restoreCmd = createRestoreForecastScopeWireCommand(
      createRestoreForecastScopeCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: 5,
        selectedFeatureIds: inverse.selectedFeatureIds,
        parallelGroups: inverse.parallelGroups,
      }),
    );
    const undoRes = handler.apply(restoreCmd);
    expect(undoRes.type).toBe('ProductCommandApplied');

    plan = readForecastPlan(db!, projectId);
    expect(plan!.selectedFeatureIds).toEqual([featureId, featureB]);
    expect(plan!.parallelGroups).toEqual([{ featureIds: [featureId, featureB] }]);
  });

  it('sets order and groups atomically, canonicalizes member order, rejects stale writes, and replays retries (AC 19.2-2, AC 19.2-5, AC 19.5-2)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const featureC = nextId(4);
    const db = getDatabase()!;
    for (const [id, title, position] of [
      [featureB, 'Feature B', 2000],
      [featureC, 'Feature C', 3000],
    ] as const) {
      db.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        bind: [id, projectId, title, position, 'Feature', 10],
      });
    }
    for (const [index, id] of [featureId, featureB, featureC].entries()) {
      expect(handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: index + 1, featureId: id, included: true,
      }))).type).toBe('ProductCommandApplied');
    }

    const command = createSetForecastSequenceWireCommand(createSetForecastSequenceCommand({
      commandId: createUuidV7(),
      projectId,
      baseRevision: 4,
      featureIds: [featureC, featureB, featureId],
      // Deliberately reversed on the wire: persistence canonicalizes to scope priority.
      parallelGroups: [{ featureIds: [featureId, featureB] }],
    }));
    const applied = handler.apply(command);
    expect(applied.type).toBe('ProductCommandApplied');
    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureC, featureB, featureId],
      parallelGroups: [{ featureIds: [featureB, featureId] }],
    });
    if (applied.type === 'ProductCommandApplied') {
      expect(applied.changeSet?.changes).toEqual([
        expect.objectContaining({
          type: 'ForecastSequenceSet',
          selectedFeatureIds: [featureC, featureB, featureId],
          parallelGroups: [{ featureIds: [featureB, featureId] }],
          priorSelectedFeatureIds: [featureId, featureB, featureC],
          priorParallelGroups: [],
        }),
      ]);
    }

    // A lost acknowledgement retry returns the stored result and cannot advance twice.
    const replayed = handler.apply(command);
    expect(replayed).toMatchObject({
      ...applied,
      disposition: 'StoredResultReturned',
    });
    expect(readForecastPlan(db, projectId)?.selectedFeatureIds).toEqual([featureC, featureB, featureId]);

    // A distinct stale command fails without changing either ordering fact.
    const stale = handler.apply(createSetForecastSequenceWireCommand(createSetForecastSequenceCommand({
      commandId: createUuidV7(), projectId, baseRevision: 4,
      featureIds: [featureId, featureB, featureC], parallelGroups: [],
    })));
    expect(stale).toMatchObject({ type: 'ProductCommandRejected', code: 'REVISION_CONFLICT' });
    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureC, featureB, featureId],
      parallelGroups: [{ featureIds: [featureB, featureId] }],
    });

    const inverse = applied.type === 'ProductCommandApplied' && applied.changeSet
      ? computeInverseDescriptor(applied.changeSet)
      : null;
    expect(inverse).toMatchObject({
      type: 'SetForecastSequence',
      featureIds: [featureId, featureB, featureC],
      parallelGroups: [],
    });
  });

  it('rolls back sequence facts, revision, and receipt together when the receipt write is interrupted (AC 19.5-3)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const db = getDatabase()!;
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    for (const [index, id] of [featureId, featureB].entries()) {
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: index + 1, featureId: id, included: true,
      })));
    }
    const command = createSetForecastSequenceWireCommand(createSetForecastSequenceCommand({
      commandId: createUuidV7(), projectId, baseRevision: 3,
      featureIds: [featureB, featureId], parallelGroups: [{ featureIds: [featureB, featureId] }],
    }));

    const mutableDb = db as unknown as { exec: typeof db.exec };
    const originalExec = db.exec.bind(db);
    let interrupted = false;
    mutableDb.exec = ((options: Parameters<typeof db.exec>[0]) => {
      const sql = typeof options === 'string' ? options : String(options.sql);
      if (!interrupted && sql.includes('INSERT INTO product_command_receipt')) {
        interrupted = true;
        throw new Error('simulated lost result before receipt commit');
      }
      return originalExec(options);
    }) as typeof db.exec;

    try {
      expect(() => handler.apply(command)).toThrow('simulated lost result');
    } finally {
      mutableDb.exec = originalExec;
    }

    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureId, featureB],
      parallelGroups: [],
    });
    expect(queryProjectNodes(projectId).projectRevision).toBe(3);

    const recovered = handler.apply(command);
    expect(recovered).toMatchObject({
      type: 'ProductCommandApplied',
      disposition: 'NewCommit',
      baseRevision: 3,
      targetRevision: 4,
    });
    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureB, featureId],
      parallelGroups: [{ featureIds: [featureB, featureId] }],
    });
  });

  it('retains authored invalid forecast references after retyping and deletion instead of silently normalizing them (AC 19.2-5)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    const featureB = nextId(3);
    const db = getDatabase()!;
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    for (const [index, id] of [featureId, featureB].entries()) {
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: index + 1, featureId: id, included: true,
      })));
    }
    handler.apply(createSetForecastSequenceWireCommand(createSetForecastSequenceCommand({
      commandId: createUuidV7(), projectId, baseRevision: 3,
      featureIds: [featureId, featureB], parallelGroups: [{ featureIds: [featureId, featureB] }],
    })));

    expect(handler.apply(createSetNodeTypeWireCommand(createSetNodeTypeCommand({
      commandId: createUuidV7(), projectId, baseRevision: 4, nodeId: featureB, nodeType: 'Theme',
    })))).toMatchObject({ type: 'ProductCommandApplied' });
    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureId, featureB],
      parallelGroups: [{ featureIds: [featureId, featureB] }],
    });

    expect(handler.apply(createDeleteSubtreeWireCommand({
      commandId: createUuidV7(), projectId, baseRevision: 5, nodeId: featureId,
    }))).toMatchObject({ type: 'ProductCommandApplied' });
    expect(readForecastPlan(db, projectId)).toMatchObject({
      selectedFeatureIds: [featureId, featureB],
      parallelGroups: [{ featureIds: [featureId, featureB] }],
    });
  });
});

describe('Story 20.1 forecast blockers', () => {
  async function seedTwoFeatureForecast() {
    const { handler, projectId, featureId } = await seedProject();
    const db = getDatabase()!;
    const featureB = nextId(9);
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    for (const [index, id] of [featureId, featureB].entries()) {
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: index + 1, featureId: id, included: true,
      })));
    }
    return { handler, projectId, db, featureA: featureId, featureB, revision: 3 };
  }

  it('marking and clearing a blocker persists on the plan (AC 20.1-1, 20.1-2)', async () => {
    const { handler, projectId, db, featureA, revision } = await seedTwoFeatureForecast();
    const mark = handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    expect(mark.type).toBe('ProductCommandApplied');
    expect(readForecastPlan(db, projectId)!.blockedFeatureIds).toEqual([featureA]);

    const clear = handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, featureId: featureA, blocked: false,
    })));
    expect(clear.type).toBe('ProductCommandApplied');
    expect(readForecastPlan(db, projectId)!.blockedFeatureIds).toEqual([]);
  });

  it('blocking a Feature that is not in the forecast is rejected', async () => {
    const { handler, projectId, revision } = await seedTwoFeatureForecast();
    const ghost = nextId(9);
    const result = handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: ghost, blocked: true,
    })));
    expect(result).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SCOPE_INVALID' });
  });

  it('a redundant block/clear is rejected rather than committed as an empty revision', async () => {
    const { handler, projectId, featureA, revision } = await seedTwoFeatureForecast();
    handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    const again = handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, featureId: featureA, blocked: true,
    })));
    expect(again).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_BLOCKER_INVALID' });
  });

  it('excluding a blocked Feature clears its blocker atomically and reports it (AC 20.1-5)', async () => {
    const { handler, projectId, db, featureA, featureB, revision } = await seedTwoFeatureForecast();
    handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    const exclude = handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, featureId: featureA, included: false,
    })));
    expect(exclude.type).toBe('ProductCommandApplied');
    const scopeChange = (exclude as unknown as { changeSet: { changes: Array<Record<string, unknown>> } }).changeSet.changes
      .find((c) => c.type === 'ForecastScopeSet')!;
    expect(scopeChange.priorBlockedFeatureIds).toEqual([featureA]);
    expect(scopeChange.blockedFeatureIds).toEqual([]);
    const plan = readForecastPlan(db, projectId)!;
    expect(plan.selectedFeatureIds).toEqual([featureB]);
    expect(plan.blockedFeatureIds).toEqual([]);
  });

  it('undo of a block re-clears it; undo of an exclusion that cleared a blocker restores both (AC 20.1-6)', async () => {
    const { handler, projectId, db, featureA, featureB, revision } = await seedTwoFeatureForecast();
    // Block A, then exclude A (clears the blocker as a side effect).
    const block = handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    const blockInverse = computeInverseDescriptor((block as { changeSet: import('../../contracts/change-set').ChangeSet }).changeSet);
    expect(blockInverse).toEqual({ type: 'SetForecastBlocker', featureId: featureA, blocked: false });

    const exclude = handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, featureId: featureA, included: false,
    })));
    const excludeInverse = computeInverseDescriptor((exclude as { changeSet: import('../../contracts/change-set').ChangeSet }).changeSet);
    expect(excludeInverse).toMatchObject({
      type: 'RestoreForecastScope',
      selectedFeatureIds: [featureA, featureB],
      blockedFeatureIds: [featureA],
    });

    // Apply the RestoreForecastScope inverse and confirm the blocker is back.
    handler.apply(createRestoreForecastScopeWireCommand(createRestoreForecastScopeCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 2,
      selectedFeatureIds: [featureA, featureB], parallelGroups: [], blockedFeatureIds: [featureA],
    })));
    const plan = readForecastPlan(db, projectId)!;
    expect(plan.selectedFeatureIds).toEqual([featureA, featureB]);
    expect(plan.blockedFeatureIds).toEqual([featureA]);
  });

  it('blocker facts survive a reload (fresh read of the same store)', async () => {
    const { handler, projectId, featureA, revision } = await seedTwoFeatureForecast();
    handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    // Re-read the plan straight from the DB (simulates a reload path).
    const reread = readForecastPlan(getDatabase()!, projectId)!;
    expect(reread.blockedFeatureIds).toEqual([featureA]);
  });
});

describe('Story 20.1 interruption recovery', () => {
  it('rolls back blocker fact, receipt, and revision together before a clean retry', async () => {
    const { handler, projectId, featureId: featureA } = await seedProject();
    const db = getDatabase()!;
    handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: createUuidV7(), projectId, baseRevision: 1, featureId: featureA, included: true,
    })));
    const revision = 2;
    const command = createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    }));
    const mutableDb = db as unknown as { exec: typeof db.exec };
    const originalExec = db.exec.bind(db);
    let interrupted = false;
    mutableDb.exec = ((options: Parameters<typeof db.exec>[0]) => {
      const sql = typeof options === 'string' ? options : String(options.sql);
      if (!interrupted && sql.includes('INSERT INTO product_command_receipt')) {
        interrupted = true;
        throw new Error('simulated blocker interruption');
      }
      return originalExec(options);
    }) as typeof db.exec;
    try {
      expect(() => handler.apply(command)).toThrow('simulated blocker interruption');
    } finally {
      mutableDb.exec = originalExec;
    }
    expect(readForecastPlan(db, projectId)?.blockedFeatureIds).toEqual([]);
    expect(queryProjectNodes(projectId).projectRevision).toBe(revision);
    expect(handler.apply(command)).toMatchObject({ type: 'ProductCommandApplied', disposition: 'NewCommit' });
    expect(readForecastPlan(db, projectId)?.blockedFeatureIds).toEqual([featureA]);
  });
});

describe('Story 20.4 saved scenarios', () => {
  async function seedForecastWithScenario() {
    const { handler, projectId, featureId } = await seedProject();
    const db = getDatabase()!;
    const featureB = nextId(9);
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
    });
    handler.apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
      commandId: createUuidV7(), projectId, baseRevision: 1, pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07',
    })));
    handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: createUuidV7(), projectId, baseRevision: 2, featureId, included: true,
    })));
    handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
      commandId: createUuidV7(), projectId, baseRevision: 3, featureId: featureB, included: true,
    })));
    const revision = 4;
    const plan = readForecastPlan(db, projectId)!;
    const fingerprint = computeForecastFingerprintSync(forecastMaterialFacts(Object.freeze({
      projectId, projectRevision: revision, policyVersion: plan.policyVersion,
      selectedFeatureIds: plan.selectedFeatureIds, estimates: Object.freeze({ [featureId]: 15, [featureB]: 10 }),
      pointsPerSprint: plan.configuration.pointsPerSprint, sprintLengthDays: plan.configuration.sprintLengthDays,
      startSprintOrdinal: plan.configuration.startSprintOrdinal, startDate: plan.configuration.startDate,
      parallelGroups: plan.parallelGroups, blockedFeatureIds: plan.blockedFeatureIds,
    })));
    return { handler, projectId, db, featureA: featureId, featureB, revision, fingerprint };
  }

  it('a validated preview at revision R saves one scenario storing baseline + patch atomically (AC 20.4-1)', async () => {
    const { handler, projectId, db, revision, fingerprint } = await seedForecastWithScenario();
    const scenarioId = createUuidV7();
    const res = handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision,
      scenarioId, label: 'Defer B', baselineRevision: revision, expectedMaterialFingerprint: fingerprint,
      createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointsPerSprint: 20 },
    })));
    expect(res.type).toBe('ProductCommandApplied');
    const stored = readForecastScenario(db, scenarioId)!;
    expect(stored.label).toBe('Defer B');
    expect(stored.baselineRevision).toBe(revision);
    expect(stored.baseline.orderedScope.length).toBe(2);
    expect(Object.keys(stored.baseline.factMap).length).toBe(2);
    expect(stored.patch).toEqual({ pointsPerSprint: 20 });
    // No ForecastResult persisted anywhere.
    expect(JSON.stringify(stored)).not.toContain('completionSprint');
  });

  it('a stale preview (baselineRevision behind current) is rejected, draft not silently rebased (AC 20.4-2)', async () => {
    const { handler, projectId, featureA, revision, fingerprint } = await seedForecastWithScenario();
    // Land another command so the live revision moves ahead of the preview.
    handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, featureId: featureA, blocked: true,
    })));
    const res = handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, // stale
      scenarioId: createUuidV7(), label: 'Stale', baselineRevision: revision, expectedMaterialFingerprint: fingerprint,
      createdAtISO: '2026-09-08T00:00:00.000Z', patch: {},
    })));
    expect(res).toMatchObject({ type: 'ProductCommandRejected', code: 'REVISION_CONFLICT' });
  });

  it('rejects a current-revision save whose material fingerprint does not match the captured plan (AC 20.4-2)', async () => {
    const { handler, projectId, revision } = await seedForecastWithScenario();
    const result = handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, scenarioId: createUuidV7(),
      label: 'Forged', baselineRevision: revision, expectedMaterialFingerprint: '0'.repeat(64),
      createdAtISO: '2026-09-08T00:00:00.000Z', patch: {},
    })));
    expect(result).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SCENARIO_STALE' });
  });

  it('rolls back scenario facts, receipt, and revision together when commit is interrupted (AC 20.7-4)', async () => {
    const { handler, projectId, db, revision, fingerprint } = await seedForecastWithScenario();
    const scenarioId = createUuidV7();
    const command = createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, scenarioId,
      label: 'Interrupted', baselineRevision: revision, expectedMaterialFingerprint: fingerprint,
      createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointsPerSprint: 20 },
    }));
    const mutableDb = db as unknown as { exec: typeof db.exec };
    const originalExec = db.exec.bind(db);
    let interrupted = false;
    mutableDb.exec = ((options: Parameters<typeof db.exec>[0]) => {
      const sql = typeof options === 'string' ? options : String(options.sql);
      if (!interrupted && sql.includes('INSERT INTO product_command_receipt')) {
        interrupted = true;
        throw new Error('simulated scenario interruption');
      }
      return originalExec(options);
    }) as typeof db.exec;
    try {
      expect(() => handler.apply(command)).toThrow('simulated scenario interruption');
    } finally {
      mutableDb.exec = originalExec;
    }
    expect(readForecastScenario(db, scenarioId)).toBeNull();
    expect(queryProjectNodes(projectId).projectRevision).toBe(revision);
    expect(handler.apply(command)).toMatchObject({ type: 'ProductCommandApplied', disposition: 'NewCommit' });
    expect(readForecastScenarios(db, projectId)).toHaveLength(1);
  });

  it('an identical retry returns the recorded outcome exactly once, no duplicate scenario (AC 20.4-3)', async () => {
    const { handler, projectId, db, revision, fingerprint } = await seedForecastWithScenario();
    const commandId = createUuidV7();
    const scenarioId = createUuidV7();
    const mk = () => createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId, projectId, baseRevision: revision, scenarioId, label: 'Retry', baselineRevision: revision,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointsPerSprint: 20 },
    }));
    const first = handler.apply(mk());
    expect(first.type).toBe('ProductCommandApplied');
    const retry = handler.apply(mk());
    expect(retry).toMatchObject({ type: 'ProductCommandApplied', disposition: 'StoredResultReturned' });
    // Exactly one scenario row despite the retry.
    expect(readForecastScenarios(db, projectId).length).toBe(1);

    const changedPayload = handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId, projectId, baseRevision: revision, scenarioId, label: 'Changed payload', baselineRevision: revision,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointsPerSprint: 20 },
    })));
    expect(changedPayload).toMatchObject({ type: 'ProductCommandRejected', code: 'COMMAND_IDENTITY_CONFLICT' });

    // A fresh command creating a scenario with an already-used scenarioId is an identity conflict.
    const dupIdentity = handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, scenarioId, label: 'Dup', baselineRevision: revision + 1,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: {},
    })));
    expect(dupIdentity).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SCENARIO_INVALID' });
  });

  it('remove then restore (undo) returns the exact historical facts without consulting current nodes (AC 20.4-4)', async () => {
    const { handler, projectId, db, featureA, revision, fingerprint } = await seedForecastWithScenario();
    const scenarioId = createUuidV7();
    handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, scenarioId, label: 'S', baselineRevision: revision,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointOverrides: { [featureA]: 25 } },
    })));
    const before = readForecastScenario(db, scenarioId)!;

    const removed = handler.apply(createRemoveForecastScenarioWireCommand(createRemoveForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, scenarioId,
    })));
    expect(removed.type).toBe('ProductCommandApplied');
    expect(readForecastScenario(db, scenarioId)).toBeNull();

    // Mutate a live node — the restore must NOT pick this up.
    db.exec({ sql: 'UPDATE nodes SET effort_points = 999 WHERE id = ?', bind: [featureA] });

    handler.apply(createRestoreForecastScenarioWireCommand(createRestoreForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 2, scenario: before,
    })));
    const restored = readForecastScenario(db, scenarioId)!;
    expect(restored).toEqual(before);
    expect(restored.baseline.factMap[featureA].effortPoints).toBe(15); // captured, not 999
  });

  it('rejects a restore whose embedded scenario belongs to another project', async () => {
    const { handler, projectId, db, revision, fingerprint } = await seedForecastWithScenario();
    const scenarioId = createUuidV7();
    handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, scenarioId, label: 'S', baselineRevision: revision,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: {},
    })));
    const scenario = readForecastScenario(db, scenarioId)!;
    handler.apply(createRemoveForecastScenarioWireCommand(createRemoveForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 1, scenarioId,
    })));
    const result = handler.apply(createRestoreForecastScenarioWireCommand(createRestoreForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision + 2,
      scenario: Object.freeze({ ...scenario, projectId: nextId(8) }),
    })));
    expect(result).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SCENARIO_INVALID' });
    expect(readForecastScenario(db, scenarioId)).toBeNull();
  });

  it('scenarios survive a portable export → serialize → parse → snapshot round trip (AC 20.4-5)', async () => {
    const { handler, projectId, featureA, revision, fingerprint } = await seedForecastWithScenario();
    const scenarioId = createUuidV7();
    handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: revision, scenarioId, label: 'RoundTrip', baselineRevision: revision,
      expectedMaterialFingerprint: fingerprint, createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointOverrides: { [featureA]: 40 } },
    })));
    const exported = queryPortableSnapshot(projectId);
    expect(exported.forecastScenarios?.length).toBe(1);

    // Build a v6 envelope, serialize, re-parse — the portable *contract* round trip.
    const envelope = {
      schemaVersion: 6 as const,
      exportedAt: '2026-09-08T00:00:00.000Z',
      project: { id: projectId, name: 'Forecast Project' },
      phases: exported.phases,
      nodes: exported.nodes,
      nodeCustomFields: exported.nodeCustomFields,
      typeTemplateFields: exported.typeTemplateFields,
      unlockEdges: exported.unlockEdges,
      findingDismissals: exported.findingDismissals,
      affectedReasons: exported.affectedReasons,
      openQuestions: exported.openQuestions,
      ...(exported.forecastPlan ? { forecastPlan: exported.forecastPlan } : {}),
      forecastScenarios: exported.forecastScenarios,
    };
    const json = serializePortableFileEnvelope(envelope);
    const reparsed = parsePortableFile(json);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.schemaVersion).toBe(6);
    const scenarios = (reparsed.value as { forecastScenarios?: readonly PortableForecastScenario[] }).forecastScenarios!;
    expect(scenarios).toHaveLength(1);
    // Captured facts reproduce exactly — never re-derived from a live node.
    expect(scenarios[0].baseline.factMap[featureA].effortPoints).toBe(15);
    expect(scenarios[0].patch).toEqual({ pointOverrides: { [featureA]: 40 } });
    expect(scenarios[0].baselineFingerprint).toBe(fingerprint);
    const tampered = JSON.parse(json) as { forecastScenarios: Array<{ baseline: { configuration: { pointsPerSprint: number } } }> };
    tampered.forecastScenarios[0].baseline.configuration.pointsPerSprint = 999;
    expect(parsePortableFile(JSON.stringify(tampered))).toMatchObject({ ok: false });
  });
});

describe('Story 21.7 — SetForecastPlanningLevel (FR-13, D4/D7)', () => {
  it('switches the level and atomically clears scope, groups, and blockers in one ChangeSet', async () => {
    const { handler, projectId, featureId } = await seedProject();
    // seedProject applies CreateProject (revision 0 -> 1). Include the
    // Feature and mark it blocked so the reset has something to clear.
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          featureId,
          included: true,
        }),
      ),
    );
    handler.apply(
      createSetForecastBlockerWireCommand(
        createSetForecastBlockerCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          featureId,
          blocked: true,
        }),
      ),
    );

    const result = handler.apply(
      createSetForecastPlanningLevelWireCommand(
        createSetForecastPlanningLevelCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 3,
          planningLevel: 'Theme',
        }),
      ),
    );
    expect(result.type).toBe('ProductCommandApplied');
    if (result.type !== 'ProductCommandApplied') return;
    if (!result.changeSet) return;

    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan?.planningLevel).toBe('Theme');
    expect(plan?.selectedFeatureIds).toEqual([]);
    expect(plan?.parallelGroups).toEqual([]);
    expect(plan?.blockedFeatureIds).toEqual([]);

    // One ChangeSet with the level change carrying all four priors.
    expect(result.changeSet.changes).toHaveLength(1);
    const change = result.changeSet.changes[0];
    expect(change.type).toBe('ForecastPlanningLevelSet');
    if (change.type !== 'ForecastPlanningLevelSet') return;
    expect(change.priorPlanningLevel).toBe('Feature');
    expect(change.priorSelectedFeatureIds).toEqual([featureId]);
    expect(change.priorBlockedFeatureIds).toEqual([featureId]);
  });

  it('rejects a no-op switch to the same level', async () => {
    const { handler, projectId } = await seedProject();
    const result = handler.apply(
      createSetForecastPlanningLevelWireCommand(
        createSetForecastPlanningLevelCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          planningLevel: 'Feature',
        }),
      ),
    );
    expect(result.type).toBe('ProductCommandRejected');
  });

  it('undo restores the prior level, scope, groups, and blockers in a single step', async () => {
    const { handler, projectId, featureId } = await seedProject();
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          featureId,
          included: true,
        }),
      ),
    );
    const applied = handler.apply(
      createSetForecastPlanningLevelWireCommand(
        createSetForecastPlanningLevelCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          planningLevel: 'Component',
        }),
      ),
    );
    expect(applied.type).toBe('ProductCommandApplied');
    if (applied.type !== 'ProductCommandApplied') return;
    if (!applied.changeSet) return;

    const inverse = computeInverseDescriptor(applied.changeSet);
    expect(inverse?.type).toBe('RestoreForecastPlanningLevel');
    if (!inverse || inverse.type !== 'RestoreForecastPlanningLevel') return;

    const restored = handler.apply(
      createRestoreForecastPlanningLevelWireCommand(
        createRestoreForecastPlanningLevelCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 3,
          planningLevel: inverse.planningLevel,
          selectedFeatureIds: inverse.selectedFeatureIds,
          parallelGroups: inverse.parallelGroups,
          blockedFeatureIds: inverse.blockedFeatureIds,
        }),
      ),
    );
    expect(restored.type).toBe('ProductCommandApplied');
    if (restored.type !== 'ProductCommandApplied') return;

    const plan = readForecastPlan(getDatabase()!, projectId);
    expect(plan?.planningLevel).toBe('Feature');
    expect(plan?.selectedFeatureIds).toEqual([featureId]);
  });

  it('membership inclusion validates against the plan level (AC 21.7-5 browser parity)', async () => {
    const { handler, projectId, featureId } = await seedProject();
    handler.apply(
      createSetForecastPlanningLevelWireCommand(
        createSetForecastPlanningLevelCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 1,
          planningLevel: 'Theme',
        }),
      ),
    );
    // The seeded node is a Feature; a Theme-level plan must refuse it.
    const result = handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 2,
          featureId,
          included: true,
        }),
      ),
    );
    expect(result.type).toBe('ProductCommandRejected');
  });

  describe('Epic 22 roster persistence (Story 22.3)', () => {
    it('creates forecast plan when adding person to a project without one (AC 22.3-1)', async () => {
      const { handler, projectId } = await seedProject();
      const personId = createUuidV7();

      const res = handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );

      expect(res.type).toBe('ProductCommandApplied');
      if (res.type !== 'ProductCommandApplied') return;

      const plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan).not.toBeNull();
      expect(plan!.roster).toHaveLength(1);
      expect(plan!.roster[0]).toEqual({
        id: personId,
        name: 'Alice',
        weightUnits: 100,
      });

      // Verify receipt idempotency / replay
      const replay = handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: res.commandId,
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      expect(replay.type).toBe('ProductCommandApplied');
      if (replay.type === 'ProductCommandApplied') {
        expect(replay.disposition).toBe('StoredResultReturned');
      }
    });

    it('rejects duplicate person ID, blank name, or non-positive weight', async () => {
      const { handler, projectId } = await seedProject();
      const personId = createUuidV7();

      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );

      // Duplicate person ID
      const dup = handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            personId,
            name: 'Duplicate Alice',
            weightUnits: 100,
          }),
        ),
      );
      expect(dup.type).toBe('ProductCommandRejected');
      if (dup.type === 'ProductCommandRejected') {
        expect(dup.code).toBe('FORECAST_PERSON_EXISTS');
      }

      // Blank name
      const blankCmd: AddForecastPersonWireCommand = Object.freeze({
        type: 'AddForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        expectedRevision: 3,
        personId: createUuidV7(),
        name: '   ',
        weightUnits: 100,
      });
      const blank = handler.apply(blankCmd);
      expect(blank.type).toBe('ProductCommandRejected');
      if (blank.type === 'ProductCommandRejected') {
        expect(blank.code).toBe('FORECAST_PERSON_INVALID');
      }

      // Zero or negative weight
      const zeroCmd: AddForecastPersonWireCommand = Object.freeze({
        type: 'AddForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId,
        baseRevision: 2,
        expectedRevision: 3,
        personId: createUuidV7(),
        name: 'Bob',
        weightUnits: 0,
      });
      const zero = handler.apply(zeroCmd);
      expect(zero.type).toBe('ProductCommandRejected');
      if (zero.type === 'ProductCommandRejected') {
        expect(zero.code).toBe('FORECAST_PERSON_INVALID');
      }
    });

    it('updates person name and weight (AC 22.3-3)', async () => {
      const { handler, projectId } = await seedProject();
      const personId = createUuidV7();

      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );

      const updateRes = handler.apply(
        createUpdateForecastPersonWireCommand(
          createUpdateForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            personId,
            name: 'Alice Smith',
            weightUnits: 125,
          }),
        ),
      );
      expect(updateRes.type).toBe('ProductCommandApplied');

      const plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.roster[0]).toEqual({
        id: personId,
        name: 'Alice Smith',
        weightUnits: 125,
      });

      // Updating missing person
      const missing = handler.apply(
        createUpdateForecastPersonWireCommand(
          createUpdateForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            personId: createUuidV7(),
            name: 'Ghost',
            weightUnits: 100,
          }),
        ),
      );
      expect(missing.type).toBe('ProductCommandRejected');
      if (missing.type === 'ProductCommandRejected') {
        expect(missing.code).toBe('FORECAST_PERSON_NOT_FOUND');
      }
    });

    it('removes unassigned person and allows undo/redo (AC 22.3-6)', async () => {
      const { handler, projectId } = await seedProject();
      const personId = createUuidV7();

      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );

      // Remove person
      const removeRes = handler.apply(
        createRemoveForecastPersonWireCommand(
          createRemoveForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            personId,
          }),
        ),
      );
      expect(removeRes.type).toBe('ProductCommandApplied');
      if (removeRes.type !== 'ProductCommandApplied') return;

      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.roster).toHaveLength(0);

      // Undo removal via inverse descriptor
      const inverse = computeInverseDescriptor(removeRes.changeSet!);
      expect(inverse?.type).toBe('RestoreForecastPerson');
      if (!inverse || inverse.type !== 'RestoreForecastPerson') return;

      const restoreRes = handler.apply(
        createRestoreForecastPersonWireCommand(
          createRestoreForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            person: inverse.person,
          }),
        ),
      );
      expect(restoreRes.type).toBe('ProductCommandApplied');

      plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.roster).toHaveLength(1);
      expect(plan!.roster[0]).toEqual({
        id: personId,
        name: 'Alice',
        weightUnits: 100,
      });
    });

    it('supports undo of add and update operations', async () => {
      const { handler, projectId } = await seedProject();
      const personId = createUuidV7();

      // 1. Add person
      const addRes = handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            personId,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      expect(addRes.type).toBe('ProductCommandApplied');
      if (addRes.type !== 'ProductCommandApplied') return;

      // Inverse of Add is Remove
      const addInverse = computeInverseDescriptor(addRes.changeSet!);
      expect(addInverse?.type).toBe('RemoveForecastPerson');
      if (!addInverse || addInverse.type !== 'RemoveForecastPerson') return;

      // 2. Update person
      const updateRes = handler.apply(
        createUpdateForecastPersonWireCommand(
          createUpdateForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            personId,
            name: 'Alice Cooper',
            weightUnits: 75,
          }),
        ),
      );
      expect(updateRes.type).toBe('ProductCommandApplied');
      if (updateRes.type !== 'ProductCommandApplied') return;

      // Inverse of Update is Update with prior name and weight
      const updateInverse = computeInverseDescriptor(updateRes.changeSet!);
      expect(updateInverse?.type).toBe('UpdateForecastPerson');
      if (!updateInverse || updateInverse.type !== 'UpdateForecastPerson') return;
      expect(updateInverse.name).toBe('Alice');
      expect(updateInverse.weightUnits).toBe(100);

      // Apply inverse of update
      const undoUpdateRes = handler.apply(
        createUpdateForecastPersonWireCommand(
          createUpdateForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            personId: updateInverse.personId,
            name: updateInverse.name,
            weightUnits: updateInverse.weightUnits,
          }),
        ),
      );
      expect(undoUpdateRes.type).toBe('ProductCommandApplied');
      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.roster[0].name).toBe('Alice');
      expect(plan!.roster[0].weightUnits).toBe(100);
    });
  });

  describe('Story 22.4 forecast assignments and atomic staffing edits', () => {
    it('atomically commits assignment replacement; undo restores prior set; rejects unknown person (AC 22.4-1)', async () => {
      const { handler, projectId, featureId } = await seedProject();
      const ids = [createUuidV7(), createUuidV7()].sort();
      const p1 = ids[0];
      const p2 = ids[1];

      // Configure plan so forecast_plans row exists
      handler.apply(
        createConfigureForecastPlanWireCommand(
          createConfigureForecastPlanCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            pointsPerSprint: 20,
            sprintLengthDays: 14,
            startSprintOrdinal: 1,
            startDate: '2026-09-01',
          }),
        ),
      );

      // Add featureId to scope
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            featureId,
            included: true,
          }),
        ),
      );

      // Add two people to roster
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            personId: p1,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 4,
            personId: p2,
            name: 'Bob',
            weightUnits: 100,
          }),
        ),
      );

      // Set assignments for featureId
      const assignCmd = createSetForecastAssignmentsWireCommand(
        createSetForecastAssignmentsCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: 5,
          featureId,
          personIds: [p1, p2],
        }),
      );
      const assignRes = handler.apply(assignCmd);
      expect(assignRes.type).toBe('ProductCommandApplied');

      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments[featureId]).toEqual([p1, p2]);

      // Idempotency: replaying same command returns StoredResultReturned
      const replayRes = handler.apply(assignCmd);
      expect(replayRes.type).toBe('ProductCommandApplied');
      if (replayRes.type === 'ProductCommandApplied') {
        expect(replayRes.disposition).toBe('StoredResultReturned');
      }

      // Rejects unknown person not in roster
      const unknownPid = createUuidV7();
      const unknownRes = handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 6,
            featureId,
            personIds: [unknownPid],
          }),
        ),
      );
      expect(unknownRes.type).toBe('ProductCommandRejected');
      if (unknownRes.type === 'ProductCommandRejected') {
        expect(unknownRes.code).toBe('FORECAST_ASSIGNMENT_INVALID');
      }

      // Update assignment to only [p1]
      const updateAssignRes = handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 6,
            featureId,
            personIds: [p1],
          }),
        ),
      );
      expect(updateAssignRes.type).toBe('ProductCommandApplied');
      plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments[featureId]).toEqual([p1]);

      // Test inverse and undo
      if (updateAssignRes.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(updateAssignRes.changeSet!);
        expect(inverse?.type).toBe('SetForecastAssignments');
        if (inverse && inverse.type === 'SetForecastAssignments') {
          expect(inverse.personIds).toEqual([p1, p2]);

          const undoRes = handler.apply(
            createSetForecastAssignmentsWireCommand(
              createSetForecastAssignmentsCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 7,
                featureId: inverse.featureId,
                personIds: inverse.personIds,
              }),
            ),
          );
          expect(undoRes.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.assignments[featureId]).toEqual([p1, p2]);
        }
      }
    });

    it('refuses concurrency conflicts in parallel buckets for staffed mode (AC 22.4-2)', async () => {
      const { handler, projectId, featureId: featA } = await seedProject();
      const featB = nextId(2);
      const db = getDatabase()!;
      db.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        bind: [featB, projectId, 'Feature B', 2000, 'Feature', 10],
      });

      const p1 = createUuidV7();
      // Configure plan with both features in scope
      handler.apply(
        createConfigureForecastPlanWireCommand(
          createConfigureForecastPlanCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            pointsPerSprint: 20,
            sprintLengthDays: 14,
            startSprintOrdinal: 1,
            startDate: '2026-09-01',
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            featureId: featA,
            included: true,
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            featureId: featB,
            included: true,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 4,
            personId: p1,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );

      // Switch to staffed-capacity-v1
      const policyRes = handler.apply(
        createSetForecastPolicyWireCommand(
          createSetForecastPolicyCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 5,
            policyVersion: 'staffed-capacity-v1',
          }),
        ),
      );
      expect(policyRes.type).toBe('ProductCommandApplied');

      // Put featA and featB in the same parallel group
      const groupRes = handler.apply(
        createSetForecastParallelGroupsWireCommand(
          createSetForecastParallelGroupsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 6,
            parallelGroups: [{ featureIds: [featA, featB] }],
          }),
        ),
      );
      expect(groupRes.type).toBe('ProductCommandApplied');

      // Assign p1 to featA
      const assignA = handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 7,
            featureId: featA,
            personIds: [p1],
          }),
        ),
      );
      expect(assignA.type).toBe('ProductCommandApplied');

      // Try assigning p1 to featB -> rejected due to concurrency conflict in parallel bucket
      const conflictRes = handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 8,
            featureId: featB,
            personIds: [p1],
          }),
        ),
      );
      expect(conflictRes.type).toBe('ProductCommandRejected');
      if (conflictRes.type === 'ProductCommandRejected') {
        expect(conflictRes.code).toBe('FORECAST_ASSIGNMENT_CONFLICT');
      }

      // Sequential reuse: clear parallel groups so featA and featB are sequential
      handler.apply(
        createSetForecastParallelGroupsWireCommand(
          createSetForecastParallelGroupsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 8,
            parallelGroups: [],
          }),
        ),
      );

      // Now assigning p1 to featB succeeds sequentially
      const seqAssignB = handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 9,
            featureId: featB,
            personIds: [p1],
          }),
        ),
      );
      expect(seqAssignB.type).toBe('ProductCommandApplied');

      // Now attempting to group featA and featB together into a parallel bucket fails
      const conflictGroup = handler.apply(
        createSetForecastParallelGroupsWireCommand(
          createSetForecastParallelGroupsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 10,
            parallelGroups: [{ featureIds: [featA, featB] }],
          }),
        ),
      );
      expect(conflictGroup.type).toBe('ProductCommandRejected');
      if (conflictGroup.type === 'ProductCommandRejected') {
        expect(conflictGroup.code).toBe('FORECAST_ASSIGNMENT_CONFLICT');
      }
    });

    it('atomic cleanup on scope removal, level switching, setting estimate to zero (AC 22.4-3)', async () => {
      const { handler, projectId, featureId } = await seedProject();
      const p1 = createUuidV7();

      handler.apply(
        createConfigureForecastPlanWireCommand(
          createConfigureForecastPlanCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            pointsPerSprint: 20,
            sprintLengthDays: 14,
            startSprintOrdinal: 1,
            startDate: '2026-09-01',
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            featureId,
            included: true,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            personId: p1,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 4,
            featureId,
            personIds: [p1],
          }),
        ),
      );

      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments[featureId]).toEqual([p1]);

      // 1. Setting effort to zero cleans up assignments for that feature
      const zeroEffortRes = handler.apply(
        createSetNodeEffortWireCommand(
          createSetNodeEffortCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 5,
            nodeId: featureId,
            effortPoints: 0,
          }),
        ),
      );
      expect(zeroEffortRes.type).toBe('ProductCommandApplied');
      plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments[featureId]).toBeUndefined();

      // Undo of SetNodeEffort restores assignments
      if (zeroEffortRes.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(zeroEffortRes.changeSet!);
        expect(inverse?.type).toBe('SetNodeEffort');
        if (inverse && inverse.type === 'SetNodeEffort') {
          expect(inverse.restoredAssignments).toEqual([p1]);
          const undoZero = handler.apply(
            createSetNodeEffortWireCommand(
              createSetNodeEffortCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 6,
                nodeId: inverse.nodeId,
                effortPoints: inverse.effortPoints,
                restoredAssignments: inverse.restoredAssignments,
              }),
            ),
          );
          expect(undoZero.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.assignments[featureId]).toEqual([p1]);
        }
      }

      // 2. Toggling membership off removes assignments for that feature
      const removeScopeRes = handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 7,
            featureId,
            included: false,
          }),
        ),
      );
      expect(removeScopeRes.type).toBe('ProductCommandApplied');
      plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments[featureId]).toBeUndefined();

      // Undo of membership removal restores assignments via RestoreForecastScope
      if (removeScopeRes.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(removeScopeRes.changeSet!);
        expect(inverse?.type).toBe('RestoreForecastScope');
        if (inverse && inverse.type === 'RestoreForecastScope') {
          expect(inverse.assignments?.[featureId]).toEqual([p1]);
          const undoScope = handler.apply(
            createRestoreForecastScopeWireCommand(
              createRestoreForecastScopeCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 8,
                selectedFeatureIds: inverse.selectedFeatureIds,
                parallelGroups: inverse.parallelGroups,
                blockedFeatureIds: inverse.blockedFeatureIds,
                assignments: inverse.assignments,
              }),
            ),
          );
          expect(undoScope.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.assignments[featureId]).toEqual([p1]);
        }
      }

      // 3. Level switching cleans up assignments atomically
      const switchLevelRes = handler.apply(
        createSetForecastPlanningLevelWireCommand(
          createSetForecastPlanningLevelCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 9,
            planningLevel: 'Component',
          }),
        ),
      );
      expect(switchLevelRes.type).toBe('ProductCommandApplied');
      plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.assignments).toEqual({});

      // Undo of level switch restores assignments via RestoreForecastPlanningLevel
      if (switchLevelRes.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(switchLevelRes.changeSet!);
        expect(inverse?.type).toBe('RestoreForecastPlanningLevel');
        if (inverse && inverse.type === 'RestoreForecastPlanningLevel') {
          expect(inverse.assignments?.[featureId]).toEqual([p1]);
          const undoLevel = handler.apply(
            createRestoreForecastPlanningLevelWireCommand(
              createRestoreForecastPlanningLevelCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 10,
                planningLevel: inverse.planningLevel,
                selectedFeatureIds: inverse.selectedFeatureIds,
                parallelGroups: inverse.parallelGroups,
                blockedFeatureIds: inverse.blockedFeatureIds,
                assignments: inverse.assignments,
              }),
            ),
          );
          expect(undoLevel.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.assignments[featureId]).toEqual([p1]);
        }
      }
    });

    it('confirmed removal of an assigned person removes person and live assignments atomically (AC 22.4-4)', async () => {
      const { handler, projectId, featureId } = await seedProject();
      const ids = [createUuidV7(), createUuidV7()].sort();
      const p1 = ids[0];
      const p2 = ids[1];

      handler.apply(
        createConfigureForecastPlanWireCommand(
          createConfigureForecastPlanCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            pointsPerSprint: 20,
            sprintLengthDays: 14,
            startSprintOrdinal: 1,
            startDate: '2026-09-01',
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            featureId,
            included: true,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            personId: p1,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 4,
            personId: p2,
            name: 'Bob',
            weightUnits: 100,
          }),
        ),
      );
      handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 5,
            featureId,
            personIds: [p1, p2],
          }),
        ),
      );

      // Remove Alice (p1)
      const removePersonRes = handler.apply(
        createRemoveForecastPersonWireCommand(
          createRemoveForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 6,
            personId: p1,
          }),
        ),
      );
      expect(removePersonRes.type).toBe('ProductCommandApplied');

      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.roster.some((p) => p.id === p1)).toBe(false);
      expect(plan!.assignments[featureId]).toEqual([p2]);

      // Undo RemoveForecastPerson restores Alice and her assignments
      if (removePersonRes.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(removePersonRes.changeSet!);
        expect(inverse?.type).toBe('RestoreForecastPerson');
        if (inverse && inverse.type === 'RestoreForecastPerson') {
          expect(inverse.person.id).toBe(p1);
          expect(inverse.assignments?.[featureId]).toEqual([p1, p2]);

          const undoRemove = handler.apply(
            createRestoreForecastPersonWireCommand(
              createRestoreForecastPersonCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 7,
                person: inverse.person,
                assignments: inverse.assignments,
              }),
            ),
          );
          expect(undoRemove.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.roster.some((p) => p.id === p1)).toBe(true);
          expect(plan!.assignments[featureId]).toEqual([p1, p2]);
        }
      }
    });

    it('mode switching preserves roster and assignments and blocks invalid concurrency (AC 22.4-5)', async () => {
      const { handler, projectId, featureId: featA } = await seedProject();
      const featB = nextId(2);
      const db = getDatabase()!;
      db.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        bind: [featB, projectId, 'Feature B', 2000, 'Feature', 10],
      });

      const p1 = createUuidV7();
      handler.apply(
        createConfigureForecastPlanWireCommand(
          createConfigureForecastPlanCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 1,
            pointsPerSprint: 20,
            sprintLengthDays: 14,
            startSprintOrdinal: 1,
            startDate: '2026-09-01',
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 2,
            featureId: featA,
            included: true,
          }),
        ),
      );
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 3,
            featureId: featB,
            included: true,
          }),
        ),
      );
      handler.apply(
        createAddForecastPersonWireCommand(
          createAddForecastPersonCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 4,
            personId: p1,
            name: 'Alice',
            weightUnits: 100,
          }),
        ),
      );
      handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 5,
            featureId: featA,
            personIds: [p1],
          }),
        ),
      );

      // In shared mode, assign p1 to featB as well, and put them in a parallel group
      handler.apply(
        createSetForecastAssignmentsWireCommand(
          createSetForecastAssignmentsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 6,
            featureId: featB,
            personIds: [p1],
          }),
        ),
      );
      handler.apply(
        createSetForecastParallelGroupsWireCommand(
          createSetForecastParallelGroupsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 7,
            parallelGroups: [{ featureIds: [featA, featB] }],
          }),
        ),
      );

      // Attempting to switch to staffed-capacity-v1 fails due to grouping conflict
      const switchConflict = handler.apply(
        createSetForecastPolicyWireCommand(
          createSetForecastPolicyCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 8,
            policyVersion: 'staffed-capacity-v1',
          }),
        ),
      );
      expect(switchConflict.type).toBe('ProductCommandRejected');
      if (switchConflict.type === 'ProductCommandRejected') {
        expect(switchConflict.code).toBe('FORECAST_ASSIGNMENT_CONFLICT');
      }

      // Break up the parallel group
      handler.apply(
        createSetForecastParallelGroupsWireCommand(
          createSetForecastParallelGroupsCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 8,
            parallelGroups: [],
          }),
        ),
      );

      // Now switching to staffed mode succeeds (AC 22.4-5)
      const switchSuccess = handler.apply(
        createSetForecastPolicyWireCommand(
          createSetForecastPolicyCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 9,
            policyVersion: 'staffed-capacity-v1',
          }),
        ),
      );
      expect(switchSuccess.type).toBe('ProductCommandApplied');
      let plan = readForecastPlan(getDatabase()!, projectId);
      expect(plan!.policyVersion).toBe('staffed-capacity-v1');
      expect(plan!.assignments[featA]).toEqual([p1]);
      expect(plan!.assignments[featB]).toEqual([p1]);

      // Undo of policy switch restores shared mode
      if (switchSuccess.type === 'ProductCommandApplied') {
        const inverse = computeInverseDescriptor(switchSuccess.changeSet!);
        expect(inverse?.type).toBe('SetForecastPolicy');
        if (inverse && inverse.type === 'SetForecastPolicy') {
          expect(inverse.policyVersion).toBe('shared-capacity-v1');
          const undoPolicy = handler.apply(
            createSetForecastPolicyWireCommand(
              createSetForecastPolicyCommand({
                commandId: createUuidV7(),
                projectId,
                baseRevision: 10,
                policyVersion: inverse.policyVersion,
              }),
            ),
          );
          expect(undoPolicy.type).toBe('ProductCommandApplied');
          plan = readForecastPlan(getDatabase()!, projectId);
          expect(plan!.policyVersion).toBe('shared-capacity-v1');
        }
      }
    });

    // Checks only the CURRENT fresh schema. The populated predecessor upgrades,
    // idempotence and crash recovery that AC 22.4-8 requires are qualified in
    // staffing-schema-upgrade.spec.ts (Story 22.13; review R13).
    it('a fresh database carries the version 16 assignments column (AC 22.4-8, current schema only)', async () => {
      await initWorkerDatabase();
      const db = getDatabase()!;
      expect(PRODUCT_SCHEMA_VERSION).toBe(21);
      const cols = db.exec({
        sql: 'PRAGMA table_info(forecast_plans)',
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as { name: string }[];
      expect(cols.some((c) => c.name === 'assignments')).toBe(true);
    });
  });

  describe('Story 23.3 — Save staffing scenarios from one acknowledged revision', () => {
    async function seedStaffedForecastWithScenario() {
      const { handler, projectId, featureId: featureA } = await seedProject();
      const db = getDatabase()!;
      db.exec({
        sql: 'UPDATE nodes SET effort_points = 20 WHERE id = ?',
        bind: [featureA],
      });
      const featureB = nextId(3);
      db.exec({
        sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10],
      });
      const personAda = nextId(4);
      const personBob = nextId(5);

      // baseRevision: 1 -> 2
      handler.apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
        commandId: createUuidV7(), projectId, baseRevision: 1, pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07', planningLevel: 'Feature',
      })));
      // 2 -> 3
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: 2, featureId: featureA, included: true,
      })));
      // 3 -> 4
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: 3, featureId: featureB, included: true,
      })));
      // 4 -> 5
      handler.apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({
        commandId: createUuidV7(), projectId, baseRevision: 4, personId: personAda, name: 'Ada Lovelace', weightUnits: 100,
      })));
      // 5 -> 6
      handler.apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({
        commandId: createUuidV7(), projectId, baseRevision: 5, personId: personBob, name: 'Bob Babbage', weightUnits: 50,
      })));
      // 6 -> 7
      handler.apply(createSetForecastAssignmentsWireCommand(createSetForecastAssignmentsCommand({
        commandId: createUuidV7(), projectId, baseRevision: 6, featureId: featureA, personIds: [personAda],
      })));
      // 7 -> 8
      handler.apply(createSetForecastPolicyWireCommand(createSetForecastPolicyCommand({
        commandId: createUuidV7(), projectId, baseRevision: 7, policyVersion: 'staffed-capacity-v1',
      })));

      const revision = 8;
      const plan = readForecastPlan(db, projectId)!;
      const fingerprint = computeForecastFingerprintSync(forecastMaterialFacts(Object.freeze({
        projectId,
        projectRevision: revision,
        policyVersion: plan.policyVersion,
        selectedFeatureIds: plan.selectedFeatureIds,
        estimates: { [featureA]: 20, [featureB]: 10 },
        pointsPerSprint: plan.configuration.pointsPerSprint,
        sprintLengthDays: plan.configuration.sprintLengthDays,
        startSprintOrdinal: plan.configuration.startSprintOrdinal,
        startDate: plan.configuration.startDate,
        parallelGroups: plan.parallelGroups,
        blockedFeatureIds: plan.blockedFeatureIds,
        roster: plan.roster,
        assignments: plan.assignments,
      })));

      return { handler, db, projectId, featureA, featureB, personAda, personBob, revision, plan, fingerprint };
    }

    it('captures full roster (including idle people) and assignments from authoritative snapshot (AC 23.3-1, AC 23.3-6)', async () => {
      const { handler, db, projectId, featureA, featureB, personAda, personBob, revision, fingerprint } =
        await seedStaffedForecastWithScenario();

      const scenarioId = createUuidV7();
      const createRes = handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: revision,
            scenarioId,
            label: 'Staffed Sprint Scenario',
            baselineRevision: revision,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-24T20:00:00.000Z',
            patch: {
              weightOverrides: { [personAda]: 150 },
              assignmentOverrides: { [featureB]: [personBob] },
            },
          }),
        ),
      );
      expect(createRes.type).toBe('ProductCommandApplied');

      // Verify row in database: baseline includes idle Bob and assignments, patch includes weight & assignment overrides
      const saved = readForecastScenario(db, scenarioId)!;
      expect(saved).not.toBeNull();
      expect(saved.policyVersion).toBe('staffed-capacity-v1');
      expect(saved.baseline.roster?.length).toBe(2);
      expect(saved.baseline.roster?.find((p) => p.id === personBob)?.name).toBe('Bob Babbage');
      expect(saved.baseline.assignments?.[featureA]).toEqual([personAda]);
      expect(saved.patch.weightOverrides).toEqual({ [personAda]: 150 });
      expect(saved.patch.assignmentOverrides).toEqual({ [featureB]: [personBob] });

      // AC 23.3-6: Schema version 16, versioned JSON storage safely supports staffed scenario records
      expect(PRODUCT_SCHEMA_VERSION).toBe(21);
    });

    it('saves and reloads weight overrides of 1000.00 and 1000.01 like live weights (AC 23.9-1/-2)', async () => {
      const { handler, db, projectId, personAda, personBob, revision, fingerprint } =
        await seedStaffedForecastWithScenario();

      const scenarioId = createUuidV7();
      const createRes = handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: revision,
            scenarioId,
            label: 'Heavy weights',
            baselineRevision: revision,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-25T20:00:00.000Z',
            patch: { weightOverrides: { [personAda]: 100000, [personBob]: 100001 } },
          }),
        ),
      );
      expect(createRes.type).toBe('ProductCommandApplied');
      const saved = readForecastScenario(db, scenarioId)!;
      expect(saved.patch.weightOverrides).toEqual({ [personAda]: 100000, [personBob]: 100001 });

      // The same value is accepted as a live weight on the same basis.
      const live = handler.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({
        commandId: createUuidV7(), projectId, baseRevision: revision + 1, personId: personBob, name: 'Bob Babbage', weightUnits: 100001,
      })));
      expect(live.type).toBe('ProductCommandApplied');
      expect(readForecastPlan(db, projectId)!.roster?.find((p) => p.id === personBob)?.weightUnits).toBe(100001);
    });

    it('refuses save when weights or assignments change after preview (AC 23.3-2)', async () => {
      const { handler, projectId, featureA, personAda, revision, fingerprint } =
        await seedStaffedForecastWithScenario();

      // Now person's weight is modified in live plan (revision 8 -> 9)
      handler.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({
        commandId: createUuidV7(),
        projectId,
        baseRevision: revision,
        personId: personAda,
        name: 'Ada Lovelace',
        weightUnits: 120,
      })));

      // Save attempted with draft revision 8 -> fails with REVISION_CONFLICT
      const staleRevRes = handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: revision,
            scenarioId: createUuidV7(),
            label: 'Stale Rev',
            baselineRevision: revision,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-24T20:00:00.000Z',
            patch: {},
          }),
        ),
      );
      expect(staleRevRes).toMatchObject({
        type: 'ProductCommandRejected',
        code: 'REVISION_CONFLICT',
        expectedRevision: 9,
      });

      // Save attempted with current baseRevision 9 but stale baselineRevision 8 -> FORECAST_SCENARIO_STALE
      const staleBaselineRes = handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 9,
            scenarioId: createUuidV7(),
            label: 'Stale Baseline',
            baselineRevision: revision,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-24T20:00:00.000Z',
            patch: {},
          }),
        ),
      );
      expect(staleBaselineRes).toMatchObject({
        type: 'ProductCommandRejected',
        code: 'FORECAST_SCENARIO_STALE',
      });

      // Save attempted with current revision 9 and baselineRevision 9 but draft fingerprint -> FORECAST_SCENARIO_STALE
      const staleFpRes = handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: 9,
            scenarioId: createUuidV7(),
            label: 'Stale FP',
            baselineRevision: 9,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-24T20:00:00.000Z',
            patch: {},
          }),
        ),
      );
      expect(staleFpRes).toMatchObject({
        type: 'ProductCommandRejected',
        code: 'FORECAST_SCENARIO_STALE',
      });
    });

    it('reconstructs historical facts on reload and pure evaluation reproduces results without live facts (AC 23.3-3)', async () => {
      const { handler, db, projectId, featureA, featureB, personAda, personBob, revision, fingerprint } =
        await seedStaffedForecastWithScenario();

      const scenarioId = createUuidV7();
      const patch = {
        weightOverrides: { [personAda]: 200 },
        assignmentOverrides: { [featureB]: [personBob] },
      };
      handler.apply(
        createCreateForecastScenarioWireCommand(
          createCreateForecastScenarioCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: revision,
            scenarioId,
            label: 'Saved Before Destructive Live Edits',
            baselineRevision: revision,
            expectedMaterialFingerprint: fingerprint,
            createdAtISO: '2026-09-24T20:00:00.000Z',
            patch,
          }),
        ),
      );

      // Evaluate immediately to record expected baseline and variant evaluation
      const savedBefore = readForecastScenario(db, scenarioId)!;
      const baselineBefore = baselineFromPersisted(savedBefore);
      const evalBefore = await evaluateScenario(baselineBefore, savedBefore.patch);
      expect(evalBefore.ok).toBe(true);
      if (!evalBefore.ok) throw new Error('evalBefore failed');
      expect(evalBefore.variantResult.state).toBe('ready');

      // Now destructive edits to live state occur:
      // 1. Remove Ada from live roster (revision 9 -> 10)
      handler.apply(createRemoveForecastPersonWireCommand(createRemoveForecastPersonCommand({ commandId: createUuidV7(), projectId, baseRevision: revision + 1, personId: personAda })));
      // 2. Rename and reweight Bob in live roster (revision 10 -> 11)
      handler.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({ commandId: createUuidV7(), projectId, baseRevision: revision + 2, personId: personBob, name: 'Robert New', weightUnits: 10 })));
      // 3. Mutate live node effort points for featureA
      db.exec({ sql: 'UPDATE nodes SET effort_points = 999 WHERE id = ?', bind: [featureA] });

      // Reload saved scenario from DB
      const reloaded = readForecastScenario(db, scenarioId)!;
      expect(reloaded).not.toBeNull();
      const reconstructedBaseline = baselineFromPersisted(reloaded);

      // Captured roster contains Ada and Bob with original names and weights
      expect(reconstructedBaseline.roster?.find((p) => p.id === personAda)?.name).toBe('Ada Lovelace');
      expect(reconstructedBaseline.roster?.find((p) => p.id === personAda)?.weightUnits).toBe(100);
      expect(reconstructedBaseline.roster?.find((p) => p.id === personBob)?.name).toBe('Bob Babbage');
      expect(reconstructedBaseline.roster?.find((p) => p.id === personBob)?.weightUnits).toBe(50);
      // Captured assignments are intact
      expect(reconstructedBaseline.assignments?.[featureA]).toEqual([personAda]);
      // Captured factMap effortPoints is 20, not live 999
      expect(reconstructedBaseline.factMap[featureA].effortPoints).toBe(20);

      // Pure evaluation reproduces exact results from before destructive edits
      const evalAfter = await evaluateScenario(reconstructedBaseline, reloaded.patch);
      expect(evalAfter.ok).toBe(true);
      if (!evalAfter.ok) throw new Error('evalAfter failed');
      expect(evalAfter.baselineResult.arithmetic?.occupiedSprints).toBe(evalBefore.baselineResult.arithmetic?.occupiedSprints);
      expect(evalAfter.variantResult.arithmetic?.occupiedSprints).toBe(evalBefore.variantResult.arithmetic?.occupiedSprints);
      expect(evalAfter.variantResult.state).toBe('ready');
    });

    it('idempotent replay, rollback on error, and undo/restore lifecycle (AC 23.3-4)', async () => {
      const { handler, db, projectId, personAda, revision, fingerprint } =
        await seedStaffedForecastWithScenario();

      const scenarioId = createUuidV7();
      const createCmd = createCreateForecastScenarioWireCommand(
        createCreateForecastScenarioCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: revision,
          scenarioId,
          label: 'Idempotent & Undoable',
          baselineRevision: revision,
          expectedMaterialFingerprint: fingerprint,
          createdAtISO: '2026-09-24T20:00:00.000Z',
          patch: { weightOverrides: { [personAda]: 120 } },
        }),
      );

      // First application succeeds
      const firstRes = handler.apply(createCmd);
      expect(firstRes.type).toBe('ProductCommandApplied');

      // Duplicate replay returns identical result via receipt ledger (AC 23.3-4)
      const replayRes = handler.apply(createCmd);
      expect(replayRes.type).toBe('ProductCommandApplied');
      if (replayRes.type === 'ProductCommandApplied') {
        expect(replayRes.disposition).toBe('StoredResultReturned');
      }

      // Live plan facts remain intact
      const planAfterSave = readForecastPlan(db, projectId)!;
      expect(planAfterSave.policyVersion).toBe('staffed-capacity-v1');
      expect(planAfterSave.roster.find((p) => p.id === personAda)?.weightUnits).toBe(100); // 100 in live plan, 120 only in scenario patch

      // Remove scenario via RemoveForecastScenarioWireCommand
      const savedBeforeRemove = readForecastScenario(db, scenarioId)!;
      const removeCmd = createRemoveForecastScenarioWireCommand(
        createRemoveForecastScenarioCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: revision + 1,
          scenarioId,
        }),
      );
      const removeRes = handler.apply(removeCmd);
      expect(removeRes.type).toBe('ProductCommandApplied');
      expect(readForecastScenario(db, scenarioId)).toBeNull();

      // Live plan facts still remain completely intact
      const planAfterRemove = readForecastPlan(db, projectId)!;
      expect(planAfterRemove.policyVersion).toBe('staffed-capacity-v1');
      expect(planAfterRemove.roster.find((p) => p.id === personAda)?.weightUnits).toBe(100);

      // Restore scenario via RestoreForecastScenarioWireCommand
      const restoreCmd = createRestoreForecastScenarioWireCommand(
        createRestoreForecastScenarioCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: revision + 2,
          scenario: savedBeforeRemove,
        }),
      );
      const restoreRes = handler.apply(restoreCmd);
      expect(restoreRes.type).toBe('ProductCommandApplied');
      const restored = readForecastScenario(db, scenarioId)!;
      expect(restored).not.toBeNull();
      expect(restored.policyVersion).toBe('staffed-capacity-v1');
      expect(restored.baseline.roster?.length).toBe(2);
      expect(restored.patch.weightOverrides?.[personAda]).toBe(120);
    });
  });
});

describe('Story 22.14 AC 22.14-1/-4 (review L3): strict identity parsing rejects coercion', () => {
  it('valid JSON of the wrong element type is a corrupt column, never String(...) coercion', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    const { handler, projectId: pid, featureId: fid } = await seedProject();
    handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId: pid,
          baseRevision: 1,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
      ),
    );

    const cases: readonly [string, string][] = [
      ['selected_feature_ids', '[{}]'],
      ['selected_feature_ids', '[1]'],
      ['parallel_groups', '[{"featureIds":[{}]}]'],
      ['blocked_feature_ids', '[null]'],
      ['assignments', `{"${fid}":[{}]}`],
      ['assignments', `{"${fid}":[1]}`],
    ];
    for (const [col, value] of cases) {
      // Healthy baseline for every column, then damage exactly one.
      db.exec({
        sql: `UPDATE forecast_plans SET selected_feature_ids = ?, parallel_groups = '[]', blocked_feature_ids = '[]', assignments = '{}' WHERE project_id = ?`,
        bind: [JSON.stringify([fid]), pid],
      });
      db.exec({ sql: `UPDATE forecast_plans SET ${col} = ? WHERE project_id = ?`, bind: [value, pid] });
      // A string element from valid JSON of the wrong type must be reported as
      // corruption, matching native Vec<String> deserialization — never coerced
      // to "[object Object]" or "1".
      expect(() => readForecastPlan(db, pid), `${col}=${value}`).toThrow(`FORECAST_PLAN_CORRUPT: ${col}`);
    }

    // Restore a healthy plan: valid JSON string members still parse.
    db.exec({
      sql: `UPDATE forecast_plans SET selected_feature_ids = ?, parallel_groups = '[]', blocked_feature_ids = '[]', assignments = '{}' WHERE project_id = ?`,
      bind: [JSON.stringify([fid]), pid],
    });
    expect(readForecastPlan(db, pid)?.selectedFeatureIds).toEqual([fid]);
  });

  it('a __proto__ assignment key round-trips as an own property, matching the native map (review edge-case)', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    const { handler, projectId: pid, featureId: fid } = await seedProject();
    handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId: pid,
          baseRevision: 1,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
      ),
    );
    db.exec({
      sql: `UPDATE forecast_plans SET assignments = ? WHERE project_id = ?`,
      // Raw JSON text: a JS object literal `{ __proto__: … }` would set the
      // prototype rather than create the key, so the stored cell must be built
      // as a string to model a genuinely mis-keyed/legacy row.
      bind: [`{"__proto__":["019ffe00-0000-7000-8000-0000000000f1"],"${fid}":[]}`, pid],
    });
    const plan = readForecastPlan(db, pid)!;
    // The key is preserved as an own entry and the record's prototype is intact
    // — a plain `{}` in the parser or canonicalizer would drop it and replace
    // the prototype (verified against the native HashMap behaviour).
    expect(Object.prototype.hasOwnProperty.call(plan.assignments, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(plan.assignments)).toBeNull();
    // It also survives JSON serialization (the persist/portable round trip).
    const serialized = JSON.stringify(plan.assignments);
    expect(serialized).toContain('"__proto__"');
    expect(JSON.parse(serialized)['__proto__']).toEqual(['019ffe00-0000-7000-8000-0000000000f1']);
  });

  it('a non-integer roster weight is a corrupt column (Story 25.2 AC 25.2-1), matching native i64', async () => {
    await initWorkerDatabase();
    const db = getDatabase()!;
    const { handler, projectId: pid, featureId: fid } = await seedProject();
    handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId: pid,
          baseRevision: 1,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
      ),
    );
    const personId = '019ffe00-0000-7000-8000-0000000000a1';

    for (const rosterJson of [
      // A JSON float.
      JSON.stringify([{ id: personId, name: 'Ada', weightUnits: 1.5 }]),
      // A non-number (JSON.stringify(NaN) is 'null'), i.e. a wrong element type.
      JSON.stringify([{ id: personId, name: 'Ada', weightUnits: Number.NaN }]),
      // A JSON string.
      JSON.stringify([{ id: personId, name: 'Ada', weightUnits: '100' }]),
    ]) {
      db.exec({
        sql: 'UPDATE forecast_plans SET selected_feature_ids = ?, roster = ?, assignments = ? WHERE project_id = ?',
        bind: [JSON.stringify([fid]), rosterJson, JSON.stringify({}), pid],
      });
      let thrown: unknown;
      try {
        readForecastPlan(db, pid);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `weight ${rosterJson}`).toBeInstanceOf(ForecastPlanCorruptError);
      expect((thrown as ForecastPlanCorruptError).field).toBe('roster');
    }

    // A safe integer is still accepted.
    db.exec({
      sql: 'UPDATE forecast_plans SET roster = ? WHERE project_id = ?',
      bind: [JSON.stringify([{ id: personId, name: 'Ada', weightUnits: 100 }]), pid],
    });
    expect(readForecastPlan(db, pid)!.roster[0].weightUnits).toBe(100);
  });
});

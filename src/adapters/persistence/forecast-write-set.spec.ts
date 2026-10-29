/**
 * Forecast allowed-write-set / no-silent-date-mutation evidence
 * (Story 18.7 AC2, NFR-3, AR-14 — Epic 18 review, 2026-09-06).
 *
 * Every Epic 18 command, plus undo, is compared by stable node identity: only
 * the declared forecast write set changes; authored schedule tuples
 * (startDate / endDate / durationDays / scheduleSourceMode) and effortPoints
 * remain byte-identical unless the explicit SetNodeEffort command changed them.
 *
 * Also covers the review follow-ups:
 *  - excluding a non-member is rejected, not a revision-bumping no-op (P24)
 *  - a mid-list exclusion / group change is non-invertible rather than a wrong
 *    inverse (P12)
 */

import { describe, expect, it } from 'vitest';
import {
  initWorkerDatabase,
  queryProjectNodes,
  getDatabase,
} from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  createCreateProjectCommand,
  createConfigureForecastPlanWireCommand,
  createSetForecastMembershipWireCommand,
  createReorderForecastFeaturesWireCommand,
  createSetForecastParallelGroupsWireCommand,
  createRestoreForecastScopeWireCommand,
  createSetForecastBlockerWireCommand,
  createCreateForecastScenarioWireCommand,
  createRemoveForecastScenarioWireCommand,
  createAddForecastPersonWireCommand,
  createUpdateForecastPersonWireCommand,
  createRemoveForecastPersonWireCommand,
  createSetForecastAssignmentsWireCommand,
  createSetForecastPolicyWireCommand,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  createConfigureForecastPlanCommand,
  createSetForecastMembershipCommand,
  createReorderForecastFeaturesCommand,
  createSetForecastParallelGroupsCommand,
  createRestoreForecastScopeCommand,
  createSetForecastBlockerCommand,
  createCreateForecastScenarioCommand,
  createRemoveForecastScenarioCommand,
  createAddForecastPersonCommand,
  createUpdateForecastPersonCommand,
  createRemoveForecastPersonCommand,
  createSetForecastAssignmentsCommand,
  createSetForecastPolicyCommand,
} from '../../domain/forecast/forecast.commands';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';
import type { ChangeSet } from '../../contracts/change-set';

let seed = 0;
function nextId(prefix: number): string {
  seed += 1;
  return `019ffe11-0000-7000-8000-${(prefix * 0x100000000 + seed).toString(16).padStart(12, '0')}`;
}

interface ScheduleTuple {
  startDate: string | null;
  endDate: string | null;
  durationDays: number | null;
  scheduleSourceMode: string | null;
  effortPoints: number | null;
}

function scheduleById(projectId: string): Map<string, ScheduleTuple> {
  const model = queryProjectNodes(projectId);
  return new Map(
    model.nodes.map((n) => [
      n.id,
      {
        startDate: n.startDate ?? null,
        endDate: n.endDate ?? null,
        durationDays: n.durationDays ?? null,
        scheduleSourceMode: n.scheduleSourceMode ?? null,
        effortPoints: n.effortPoints ?? null,
      },
    ]),
  );
}

async function seedScheduledProject(): Promise<{
  handler: Awaited<ReturnType<typeof initWorkerDatabase>>;
  projectId: string;
  featureA: string;
  featureB: string;
  featureC: string;
}> {
  const handler = await initWorkerDatabase();
  const projectId = nextId(1);
  handler.apply(
    createCreateProjectCommand(
      createDomainCreateProject({ commandId: createUuidV7(), projectId, name: 'Write-set Project' }),
    ),
  );
  const db = getDatabase();
  const featureA = nextId(2);
  const featureB = nextId(3);
  const featureC = nextId(4);
  db?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, start_date, end_date, duration_days, schedule_source_mode) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    bind: [featureA, projectId, 'Feature A', 1000, 'Feature', 15, '2026-01-01', '2026-03-31', 90, 'start_end'],
  });
  db?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, start_date, end_date, duration_days, schedule_source_mode) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    bind: [featureB, projectId, 'Feature B', 2000, 'Feature', 10, '2026-04-01', null, 30, 'start_duration'],
  });
  db?.exec({
    sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points, start_date, end_date, duration_days, schedule_source_mode) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    bind: [featureC, projectId, 'Feature C', 3000, 'Feature', 20, null, null, null, null],
  });
  return { handler, projectId, featureA, featureB, featureC };
}

describe('forecast commands never mutate authored schedule tuples (Story 18.7 AC2)', () => {
  it('ConfigureForecastPlan + include + exclude leave every schedule tuple byte-identical', async () => {
    const { handler, projectId, featureA, featureB } = await seedScheduledProject();
    const before = scheduleById(projectId);

    let rev = 1;
    handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 12,
          startDate: '2026-09-07',
        }),
      ),
    );
    rev += 1;
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: featureA, included: true }),
      ),
    );
    rev += 1;
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: featureB, included: true }),
      ),
    );
    rev += 1;
    handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: featureB, included: false }),
      ),
    );

    const after = scheduleById(projectId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, t] of before) {
      expect(after.get(id)).toEqual(t);
    }
  });

  it('ReorderForecastFeatures, SetForecastParallelGroups, RestoreForecastScope leave every schedule tuple byte-identical (Story 19.5)', async () => {
    const { handler, projectId, featureA, featureB, featureC } = await seedScheduledProject();
    const before = scheduleById(projectId);

    // Include all 3
    let rev = 1;
    for (const f of [featureA, featureB, featureC]) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: f, included: true }),
        ),
      );
      rev += 1;
    }

    // Reorder: [B, A, C]
    handler.apply(
      createReorderForecastFeaturesWireCommand(
        createReorderForecastFeaturesCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureIds: [featureB, featureA, featureC] }),
      ),
    );
    rev += 1;

    // Set parallel group [B, A]
    handler.apply(
      createSetForecastParallelGroupsWireCommand(
        createSetForecastParallelGroupsCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, parallelGroups: [{ featureIds: [featureB, featureA] }] }),
      ),
    );
    rev += 1;

    // Restore scope: [A, B], group [A, B]
    handler.apply(
      createRestoreForecastScopeWireCommand(
        createRestoreForecastScopeCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          selectedFeatureIds: [featureA, featureB],
          parallelGroups: [{ featureIds: [featureA, featureB] }],
        }),
      ),
    );

    const after = scheduleById(projectId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, t] of before) {
      expect(after.get(id)).toEqual(t);
    }
  });
});

describe('Epic 20: blocker + scenario commands never mutate authored schedules or unrelated facts (Story 20.7 AC3)', () => {
  it('SetForecastBlocker, CreateForecastScenario, RemoveForecastScenario leave every schedule tuple byte-identical', async () => {
    const { handler, projectId, featureA, featureB } = await seedScheduledProject();
    const before = scheduleById(projectId);

    let rev = 1;
    handler.apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
      commandId: createUuidV7(), projectId, baseRevision: rev, pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07',
    })));
    rev += 1;
    for (const f of [featureA, featureB]) {
      handler.apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({
        commandId: createUuidV7(), projectId, baseRevision: rev, featureId: f, included: true,
      })));
      rev += 1;
    }
    handler.apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({
      commandId: createUuidV7(), projectId, baseRevision: rev, featureId: featureA, blocked: true,
    })));
    rev += 1;
    const scenarioId = createUuidV7();
    handler.apply(createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: rev, scenarioId, label: 'S', baselineRevision: rev,
      expectedMaterialFingerprint: '0'.repeat(64), createdAtISO: '2026-09-08T00:00:00.000Z', patch: { pointsPerSprint: 20 },
    })));
    rev += 1;
    handler.apply(createRemoveForecastScenarioWireCommand(createRemoveForecastScenarioCommand({
      commandId: createUuidV7(), projectId, baseRevision: rev, scenarioId,
    })));

    const after = scheduleById(projectId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, t] of before) {
      expect(after.get(id)).toEqual(t);
    }
  });
});

describe('excluding a non-member is rejected, not a no-op commit (P24)', () => {
  it('returns FORECAST_SCOPE_INVALID and does not advance the revision', async () => {
    const { handler, projectId, featureC } = await seedScheduledProject();
    const revBefore = queryProjectNodes(projectId).projectRevision;
    const res = handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: revBefore, featureId: featureC, included: false }),
      ),
    );
    expect(res.type).toBe('ProductCommandRejected');
    if (res.type === 'ProductCommandRejected') expect(res.code).toBe('FORECAST_SCOPE_INVALID');
    expect(queryProjectNodes(projectId).projectRevision).toBe(revBefore);
  });
});

describe('scope undo is exact-or-absent, never a wrong inverse (P12)', () => {
  it('a pure single append is invertible via a membership exclude', async () => {
    const { handler, projectId, featureA } = await seedScheduledProject();
    const applied = handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: 1, featureId: featureA, included: true }),
      ),
    );
    if (applied.type !== 'ProductCommandApplied' || !applied.changeSet) throw new Error('expected applied');
    const inv = computeInverseDescriptor(applied.changeSet as ChangeSet);
    expect(inv?.type).toBe('SetForecastMembership');
    if (inv?.type === 'SetForecastMembership') {
      expect(inv.featureId).toBe(featureA);
      expect(inv.included).toBe(false);
    }
  });

  it('a mid-list exclusion is invertible via RestoreForecastScope (Epic 19)', async () => {
    const { handler, projectId, featureA, featureB, featureC } = await seedScheduledProject();
    let rev = 1;
    for (const f of [featureA, featureB, featureC]) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: f, included: true }),
        ),
      );
      rev += 1;
    }
    // Exclude the MIDDLE member — prior scope is [A, B, C], next is [A, C].
    const applied = handler.apply(
      createSetForecastMembershipWireCommand(
        createSetForecastMembershipCommand({ commandId: createUuidV7(), projectId, baseRevision: rev, featureId: featureB, included: false }),
      ),
    );
    if (applied.type !== 'ProductCommandApplied' || !applied.changeSet) throw new Error('expected applied');
    const inv = computeInverseDescriptor(applied.changeSet as ChangeSet);
    expect(inv).not.toBeNull();
    expect(inv?.type).toBe('RestoreForecastScope');
    if (inv?.type === 'RestoreForecastScope') {
      expect(inv.selectedFeatureIds).toEqual([featureA, featureB, featureC]);
      expect(inv.parallelGroups).toEqual([]);
    }
  });
});

describe('Epic 22: staffing commands never mutate authored schedules or unrelated facts (Story 22.9 AC 22.9-5)', () => {
  it('AddForecastPerson, UpdateForecastPerson, SetForecastAssignments, SetForecastPolicy, and RemoveForecastPerson leave schedules and other projects byte-identical', async () => {
    const { handler, projectId, featureA, featureB } = await seedScheduledProject();

    // Create a second project to verify other projects remain untouched
    const project2Id = nextId(2);
    handler.apply(
      createCreateProjectCommand(
        createDomainCreateProject({
          commandId: createUuidV7(),
          projectId: project2Id,
          name: 'Project Two',
        }),
      ),
    );
    const beforeProject2 = scheduleById(project2Id);
    const beforeProject1 = scheduleById(projectId);

    let rev = 1;
    handler.apply(
      createConfigureForecastPlanWireCommand(
        createConfigureForecastPlanCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          pointsPerSprint: 10,
          sprintLengthDays: 14,
          startSprintOrdinal: 1,
          startDate: '2026-09-07',
        }),
      ),
    );
    rev += 1;

    for (const f of [featureA, featureB]) {
      handler.apply(
        createSetForecastMembershipWireCommand(
          createSetForecastMembershipCommand({
            commandId: createUuidV7(),
            projectId,
            baseRevision: rev,
            featureId: f,
            included: true,
          }),
        ),
      );
      rev += 1;
    }

    // Add forecast person
    const personId = createUuidV7();
    handler.apply(
      createAddForecastPersonWireCommand(
        createAddForecastPersonCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          personId,
          name: 'Ada Lovelace',
          weightUnits: 100,
        }),
      ),
    );
    rev += 1;

    // Update forecast person
    handler.apply(
      createUpdateForecastPersonWireCommand(
        createUpdateForecastPersonCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          personId,
          name: 'Ada Lovelace, Countess',
          weightUnits: 150,
        }),
      ),
    );
    rev += 1;

    // Set assignments
    handler.apply(
      createSetForecastAssignmentsWireCommand(
        createSetForecastAssignmentsCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          featureId: featureA,
          personIds: [personId],
        }),
      ),
    );
    rev += 1;

    // Set policy to staffed
    handler.apply(
      createSetForecastPolicyWireCommand(
        createSetForecastPolicyCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          policyVersion: 'staffed-capacity-v1',
        }),
      ),
    );
    rev += 1;

    // Switch back to shared policy
    handler.apply(
      createSetForecastPolicyWireCommand(
        createSetForecastPolicyCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          policyVersion: 'shared-capacity-v1',
        }),
      ),
    );
    rev += 1;

    // Remove forecast person
    handler.apply(
      createRemoveForecastPersonWireCommand(
        createRemoveForecastPersonCommand({
          commandId: createUuidV7(),
          projectId,
          baseRevision: rev,
          personId,
        }),
      ),
    );

    // Verify all schedules on Project 1 are byte-identical
    const afterProject1 = scheduleById(projectId);
    expect([...afterProject1.keys()].sort()).toEqual([...beforeProject1.keys()].sort());
    for (const [id, t] of beforeProject1) {
      expect(afterProject1.get(id)).toEqual(t);
    }

    // Verify Project 2 was completely untouched
    const afterProject2 = scheduleById(project2Id);
    expect([...afterProject2.keys()].sort()).toEqual([...beforeProject2.keys()].sort());
    for (const [id, t] of beforeProject2) {
      expect(afterProject2.get(id)).toEqual(t);
    }
  });
});


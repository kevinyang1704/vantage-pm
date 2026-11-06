/**
 * Delivery Board sprint plan persistence: the SetForecastSprintPlan command,
 * its undo inverse, survival across other forecast writes, and the portable
 * round-trip.
 */

import { describe, expect, it } from 'vitest';
import { initWorkerDatabase, getDatabase, queryPortableSnapshot } from './repository.worker';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import {
  createCreateProjectCommand,
  createConfigureForecastPlanWireCommand,
  createSetForecastBlockerWireCommand,
  createSetForecastMembershipWireCommand,
  createSetForecastSprintPlanWireCommand,
  validateProductCommand,
} from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  createConfigureForecastPlanCommand,
  createSetForecastBlockerCommand,
  createSetForecastMembershipCommand,
  createSetForecastSprintPlanCommand,
} from '../../domain/forecast/forecast.commands';
import { readForecastPlan } from './forecast-operations';
import { computeInverseDescriptor } from '../../domain/undo/inverse-command.policy';
import { parsePortableFile, serializePortableFileEnvelope } from '../../contracts/portable-file.schema';
import type { ForecastSprintPlan } from '../../domain/forecast/forecast-plan.entity';

let counter = 0;
function id(prefix: number): string {
  counter += 1;
  return `019ffe10-0000-7000-8000-${(prefix * 0x100000000 + counter).toString(16).padStart(12, '0')}`;
}

async function seed() {
  const handler = await initWorkerDatabase();
  const projectId = id(1);
  const a = id(2);
  const b = id(2);
  handler.apply(createCreateProjectCommand(createDomainCreateProject({ commandId: createUuidV7(), projectId, name: 'Sprints' })));
  const db = getDatabase()!;
  for (const [nodeId, title, position] of [[a, 'A', 1000], [b, 'B', 2000]] as const) {
    db.exec({
      sql: 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      bind: [nodeId, projectId, title, position, 'Feature', 5],
    });
  }
  let revision = 1;
  const apply = (command: Parameters<typeof handler.apply>[0]) => {
    const result = handler.apply(command);
    if (result.type === 'ProductCommandApplied') revision = result.targetRevision;
    return result;
  };
  const base = () => ({ commandId: createUuidV7(), projectId, baseRevision: revision });
  apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
    ...base(), pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-11-02',
  })));
  for (const featureId of [a, b]) {
    apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({ ...base(), featureId, included: true })));
  }
  const setSprintPlan = (sprintPlan: ForecastSprintPlan) =>
    apply(createSetForecastSprintPlanWireCommand(createSetForecastSprintPlanCommand({ ...base(), sprintPlan })));
  return { db, projectId, a, b, apply, base, setSprintPlan };
}

describe('SetForecastSprintPlan', () => {
  it('stores the sprint plan, reports the prior value, and rejects a no-op', async () => {
    const { db, projectId, a, setSprintPlan } = await seed();
    const plan: ForecastSprintPlan = { placements: [{ itemId: a, sprint: 2 }], capacities: { '3': 4 } };
    const result = setSprintPlan(plan);
    expect(result.type).toBe('ProductCommandApplied');
    if (result.type !== 'ProductCommandApplied') return;
    expect(result.changeSet?.changes[0]).toEqual({
      type: 'ForecastSprintPlanSet',
      sprintPlan: plan,
      priorSprintPlan: { placements: [], capacities: {} },
    });
    expect(readForecastPlan(db, projectId)?.sprintPlan).toEqual(plan);
    const inverse = computeInverseDescriptor(result.changeSet!);
    expect(inverse).toEqual({ type: 'SetForecastSprintPlan', sprintPlan: { placements: [], capacities: {} } });

    const again = setSprintPlan(plan);
    expect(again).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SPRINT_PLAN_INVALID' });
  });

  it('keeps the sprint plan when other forecast facts change', async () => {
    const { db, projectId, a, b, apply, base, setSprintPlan } = await seed();
    const plan: ForecastSprintPlan = { placements: [{ itemId: b, sprint: 1 }], capacities: {} };
    setSprintPlan(plan);
    apply(createSetForecastBlockerWireCommand(createSetForecastBlockerCommand({ ...base(), featureId: a, blocked: true })));
    apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
      ...base(), pointsPerSprint: 12, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-11-02',
    })));
    expect(readForecastPlan(db, projectId)?.sprintPlan).toEqual(plan);
  });

  it('validates the wire value', () => {
    const bad = {
      type: 'SetForecastSprintPlan',
      protocolVersion: '1.0.0',
      commandId: createUuidV7(),
      projectId: createUuidV7(),
      baseRevision: 1,
      expectedRevision: 2,
      sprintPlan: { placements: [{ itemId: 'not-an-id', sprint: 1 }], capacities: {} },
    };
    expect(() => validateProductCommand(bad)).toThrow();
  });

  it('travels with an exported project file', async () => {
    const { projectId, a, setSprintPlan } = await seed();
    const plan: ForecastSprintPlan = { placements: [{ itemId: a, sprint: 3 }], capacities: { '2': 0 } };
    setSprintPlan(plan);
    const snapshot = queryPortableSnapshot(projectId);
    expect(snapshot?.forecastPlan?.sprintPlan).toEqual(plan);
    const envelope = {
      schemaVersion: 10 as const,
      exportedAt: '2026-11-05T00:00:00.000Z',
      project: { id: projectId, name: 'Sprints' },
      phases: snapshot!.phases,
      nodes: snapshot!.nodes,
      nodeCustomFields: snapshot!.nodeCustomFields,
      typeTemplateFields: snapshot!.typeTemplateFields,
      unlockEdges: snapshot!.unlockEdges,
      findingDismissals: snapshot!.findingDismissals,
      affectedReasons: snapshot!.affectedReasons,
      openQuestions: snapshot!.openQuestions,
      forecastPlan: snapshot!.forecastPlan,
    };
    const parsed = parsePortableFile(serializePortableFileEnvelope(envelope));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.value as { forecastPlan?: { sprintPlan?: unknown } }).forecastPlan?.sprintPlan).toEqual(plan);
    const older = parsePortableFile(serializePortableFileEnvelope({ ...envelope, schemaVersion: 9 } as never));
    expect(older.ok).toBe(false);

    // A leftover placement for an item outside the plan is skipped, not fatal.
    const stray = {
      ...envelope,
      forecastPlan: {
        ...envelope.forecastPlan!,
        sprintPlan: { placements: [...plan.placements, { itemId: '019ffe10-0000-7000-8000-0000ffffffff', sprint: 2 }], capacities: plan.capacities },
      },
    };
    const lenient = parsePortableFile(serializePortableFileEnvelope(stray));
    expect(lenient.ok).toBe(true);
    if (lenient.ok) {
      expect((lenient.value as { forecastPlan?: { sprintPlan?: unknown } }).forecastPlan?.sprintPlan).toEqual(plan);
    }
  });
});

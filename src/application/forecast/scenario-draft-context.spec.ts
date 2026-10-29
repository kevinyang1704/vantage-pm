/**
 * Captured scenario drafts against the real browser repository (Story 23.7,
 * AC 23.7-1, -2, -3 and -7; review R2).
 *
 * Before the repair the editor rebuilt its baseline from live props on every
 * render and the save substituted the live revision and fingerprint, so a
 * live edit made while a draft was open was silently adopted by the saved
 * scenario. These tests capture from the repository's acknowledged snapshot
 * (`queryAnalysisSnapshot`), mutate the live plan through production
 * commands, and save through the production command handler.
 */

import { describe, expect, it } from 'vitest';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import {
  createAddForecastPersonWireCommand,
  createConfigureForecastPlanWireCommand,
  createCreateForecastScenarioWireCommand,
  createRemoveForecastPersonWireCommand,
  createSetForecastAssignmentsWireCommand,
  createSetForecastMembershipWireCommand,
  createSetForecastParallelGroupsWireCommand,
  createSetForecastPolicyWireCommand,
  createUpdateForecastPersonWireCommand,
} from '../../contracts/repository-commands';
import {
  createAddForecastPersonCommand,
  createConfigureForecastPlanCommand,
  createCreateForecastScenarioCommand,
  createRemoveForecastPersonCommand,
  createSetForecastAssignmentsCommand,
  createSetForecastMembershipCommand,
  createSetForecastParallelGroupsCommand,
  createSetForecastPolicyCommand,
  createUpdateForecastPersonCommand,
} from '../../domain/forecast/forecast.commands';
import { getDatabase, initWorkerDatabase, queryAnalysisSnapshot } from '../../adapters/persistence/repository.worker';
import { readForecastPlan, readForecastScenario } from '../../adapters/persistence/forecast-operations';
import { baselineFromPersisted, type ForecastScenarioPatch } from '../../domain/forecast/scenario';
import { evaluateScenario } from '../../domain/forecast/scenario-evaluate';
import { normalizeForecastInputs } from '../../domain/forecast/forecast-normalization';
import { calculateForecast } from '../../domain/forecast/whole-set.policy';
import { captureScenarioDraftContext, draftScenarioRecord, type ScenarioDraftContext } from './scenario-draft-context';
import {
  buildDraftPatch,
  describeBaselineChanges,
  EMPTY_DRAFT_FIELDS,
  revalidateDraft,
  type ScenarioDraftFields,
} from '../../adapters/ui/forecast/scenario-draft';

let seed = 0;
const id = (prefix: number) => `019ffe23-0007-7000-8000-${(prefix * 0x1000000 + ++seed).toString(16).padStart(12, '0')}`;

/** Example S1 through production commands; Beta optionally left unassigned. */
async function seedS1(options: { assignBeta?: boolean } = {}) {
  const handler = await initWorkerDatabase();
  const projectId = id(1);
  const alpha = id(2);
  const beta = id(3);
  const ada = id(4);
  const ben = id(5);
  handler.apply(createCreateProjectCommand(createDomainCreateProject({ commandId: createUuidV7(), projectId, name: 'S1' })));
  const db = getDatabase()!;
  const insert = 'INSERT INTO nodes(id, project_id, parent_id, title, position, node_type, effort_points) VALUES (?, ?, NULL, ?, ?, ?, ?)';
  db.exec({ sql: insert, bind: [alpha, projectId, 'Feature Alpha', 1000, 'Feature', 30] });
  db.exec({ sql: insert, bind: [beta, projectId, 'Feature Beta', 2000, 'Feature', 10] });

  let revision = 1;
  const apply = (command: Parameters<typeof handler.apply>[0]) => {
    const result = handler.apply(command);
    expect(result.type, JSON.stringify(result)).toBe('ProductCommandApplied');
    revision += 1;
  };
  const base = () => ({ commandId: createUuidV7(), projectId, baseRevision: revision });
  apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
    ...base(), pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 12, startDate: '2026-09-07', planningLevel: 'Feature',
  })));
  apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({ ...base(), featureId: alpha, included: true })));
  apply(createSetForecastMembershipWireCommand(createSetForecastMembershipCommand({ ...base(), featureId: beta, included: true })));
  apply(createSetForecastParallelGroupsWireCommand(createSetForecastParallelGroupsCommand({ ...base(), parallelGroups: [{ featureIds: [alpha, beta] }] })));
  apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({ ...base(), personId: ada, name: 'Ada', weightUnits: 300 })));
  apply(createAddForecastPersonWireCommand(createAddForecastPersonCommand({ ...base(), personId: ben, name: 'Ben', weightUnits: 100 })));
  apply(createSetForecastAssignmentsWireCommand(createSetForecastAssignmentsCommand({ ...base(), featureId: alpha, personIds: [ben] })));
  if (options.assignBeta !== false) {
    apply(createSetForecastAssignmentsWireCommand(createSetForecastAssignmentsCommand({ ...base(), featureId: beta, personIds: [ada] })));
  }
  apply(createSetForecastPolicyWireCommand(createSetForecastPolicyCommand({ ...base(), policyVersion: 'staffed-capacity-v1' })));

  return { handler, projectId, alpha, beta, ada, ben, apply, base, revision: () => revision };
}

function capture(projectId: string): ScenarioDraftContext {
  return captureScenarioDraftContext(queryAnalysisSnapshot(projectId), createUuidV7());
}

function saveCommand(context: ScenarioDraftContext, patch: ForecastScenarioPatch, baseRevision = context.baselineRevision) {
  const scenarioId = createUuidV7();
  return {
    scenarioId,
    command: createCreateForecastScenarioWireCommand(createCreateForecastScenarioCommand({
      commandId: createUuidV7(),
      projectId: context.projectId,
      baseRevision,
      scenarioId,
      label: 'Draft',
      baselineRevision: context.baselineRevision,
      expectedMaterialFingerprint: context.materialFingerprint,
      createdAtISO: '2026-09-25T00:00:00.000Z',
      patch,
    })),
  };
}

describe('AC 23.7-1 — one immutable, complete capture from the acknowledged snapshot', () => {
  it('captures configuration, groups, level, policy, roster, assignments and titles, frozen', async () => {
    const s1 = await seedS1();
    const context = capture(s1.projectId);

    expect(context.baselineRevision).toBe(s1.revision());
    expect(context.policyVersion).toBe('staffed-capacity-v1');
    expect(context.baseline.configuration).toMatchObject({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 12, startDate: '2026-09-07' });
    expect(context.baseline.orderedScope).toEqual([s1.alpha, s1.beta]);
    expect(context.baseline.parallelGroups).toEqual([{ featureIds: [s1.alpha, s1.beta] }]);
    expect(context.baseline.roster).toEqual([
      { id: s1.ada, name: 'Ada', weightUnits: 300 },
      { id: s1.ben, name: 'Ben', weightUnits: 100 },
    ]);
    expect(context.baseline.assignments).toEqual({ [s1.alpha]: [s1.ben], [s1.beta]: [s1.ada] });
    expect(context.items.map((i) => [i.title, i.effortPoints, i.included])).toEqual([
      ['Feature Alpha', 30, true],
      ['Feature Beta', 10, true],
    ]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.baseline)).toBe(true);
    expect(Object.isFrozen(context.baseline.roster)).toBe(true);
  });

  it('later live roster, weight, assignment, points and configuration edits do not reach the capture or its preview', async () => {
    const s1 = await seedS1();
    const context = capture(s1.projectId);
    const before = JSON.stringify(context);
    const swap: ForecastScenarioPatch = { assignmentOverrides: { [s1.alpha]: [s1.ada], [s1.beta]: [s1.ben] } };
    const previewBefore = await evaluateScenario(context.baseline, swap);

    s1.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({ ...s1.base(), personId: s1.ada, name: 'Ada', weightUnits: 900 })));
    s1.apply(createConfigureForecastPlanWireCommand(createConfigureForecastPlanCommand({
      ...s1.base(), pointsPerSprint: 5, sprintLengthDays: 7, startSprintOrdinal: 1, startDate: '2027-01-04', planningLevel: 'Feature',
    })));
    s1.apply(createSetForecastAssignmentsWireCommand(createSetForecastAssignmentsCommand({ ...s1.base(), featureId: s1.alpha, personIds: [] })));
    getDatabase()!.exec({ sql: 'UPDATE nodes SET effort_points = 99, title = ? WHERE id = ?', bind: ['Renamed', s1.alpha] });

    expect(JSON.stringify(context)).toBe(before);
    const previewAfter = await evaluateScenario(context.baseline, swap);
    expect(previewAfter).toEqual(previewBefore);
    expect(previewAfter.ok && previewAfter.variantResult.arithmetic?.completionSprint).toBe(13);
    expect(previewAfter.ok && previewAfter.baselineResult.arithmetic?.completionSprint).toBe(17);
  });

  it('an incomplete live forecast still captures its real configuration, never a default', async () => {
    const s1 = await seedS1({ assignBeta: false });
    const snapshot = queryAnalysisSnapshot(s1.projectId);
    const live = await calculateForecast(normalizeForecastInputs(snapshot, snapshot.forecastPlan!).inputs);
    expect(live.state).toBe('incomplete');
    expect(live.arithmetic).toBeNull();

    const context = captureScenarioDraftContext(snapshot, createUuidV7());
    expect(context.baseline.configuration).toMatchObject({ pointsPerSprint: 20, sprintLengthDays: 14, startSprintOrdinal: 12, startDate: '2026-09-07' });

    // A draft that staffs the missing item saves against that capture.
    const patch: ForecastScenarioPatch = { assignmentOverrides: { [s1.beta]: [s1.ada] } };
    const preview = await evaluateScenario(context.baseline, patch);
    expect(preview.ok && preview.variantResult.arithmetic?.completionSprint).toBe(17);
    const { command, scenarioId } = saveCommand(context, patch);
    expect(s1.handler.apply(command).type).toBe('ProductCommandApplied');
    expect(readForecastScenario(getDatabase()!, scenarioId)?.baseline.configuration.pointsPerSprint).toBe(20);
  });
});

describe('AC 23.7-2 — a save after a live mutation is refused as stale, never rebased', () => {
  it('rejects with the captured expectations whether or not the queue rebases the base revision', async () => {
    const s1 = await seedS1();
    const context = capture(s1.projectId);
    s1.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({ ...s1.base(), personId: s1.ada, name: 'Ada', weightUnits: 200 })));
    const patch = { assignmentOverrides: { [s1.alpha]: [s1.ada], [s1.beta]: [s1.ben] } };

    // As dispatched: the captured base revision is behind the live one.
    const asSent = s1.handler.apply(saveCommand(context, patch).command);
    expect(asSent).toMatchObject({ type: 'ProductCommandRejected', code: 'REVISION_CONFLICT' });
    // As the command queue rebases it: the captured baseline revision still refuses.
    const rebased = s1.handler.apply(saveCommand(context, patch, s1.revision()).command);
    expect(rebased).toMatchObject({ type: 'ProductCommandRejected', code: 'FORECAST_SCENARIO_STALE' });
    expect(getDatabase()!.selectValue('SELECT COUNT(*) FROM forecast_scenarios WHERE project_id = ?', [s1.projectId])).toBe(0);
  });
});

describe('AC 23.7-3 — refresh captures once and revalidates preserved overrides', () => {
  it('names a removed person and a changed weight, and never drops the override silently', async () => {
    const s1 = await seedS1();
    const first = capture(s1.projectId);
    const fields: ScenarioDraftFields = {
      ...EMPTY_DRAFT_FIELDS,
      label: 'Keep me',
      weightOverrides: { [s1.ben]: '2.5' },
      assignmentOverrides: { [s1.alpha]: [s1.ada, s1.ben] },
    };

    // Live: Ben leaves (his assignment goes with him), Ada's weight changes.
    s1.apply(createRemoveForecastPersonWireCommand(createRemoveForecastPersonCommand({ ...s1.base(), personId: s1.ben })));
    s1.apply(createUpdateForecastPersonWireCommand(createUpdateForecastPersonCommand({ ...s1.base(), personId: s1.ada, name: 'Ada', weightUnits: 200 })));
    const refreshed = capture(s1.projectId);

    expect(describeBaselineChanges(first, refreshed)).toEqual([
      'Weight — Ada: 3.00 → 2.00',
      'Roster: removed Ben',
      'Assignment — Feature Alpha: Ben → unassigned',
    ]);

    const labels = {
      person: (pid: string) => first.baseline.roster!.find((p) => p.id === pid)?.name ?? pid,
      item: (iid: string) => first.items.find((i) => i.id === iid)?.title ?? iid,
    };
    const errors = revalidateDraft(fields, refreshed, labels);
    expect(errors.map((e) => e.message)).toEqual([
      `Weight override for Ben: this person is no longer on the roster at revision ${refreshed.baselineRevision}. Remove the override to continue.`,
      `Assignment override for Feature Alpha: Ben is no longer on the roster at revision ${refreshed.baselineRevision}. Remove the override to continue.`,
    ]);
    // The label is kept; resolving is an explicit per-override action.
    const resolved = errors.reduce<ScenarioDraftFields>((f, e) => e.resolve(f), fields);
    expect(resolved.label).toBe('Keep me');
    expect(resolved.weightOverrides).toEqual({});
    expect(resolved.assignmentOverrides).toEqual({});
    expect(revalidateDraft(resolved, refreshed, labels)).toEqual([]);
  });
});

describe('AC 23.7-7 — a saved draft reproduces its preview and changes no live facts', () => {
  it('the saved baseline is the captured one, evaluates identically, and the live plan is untouched', async () => {
    const s1 = await seedS1();
    const context = capture(s1.projectId);
    const { patch } = buildDraftPatch(
      { ...EMPTY_DRAFT_FIELDS, weightOverrides: { [s1.ben]: '1000.01' }, assignmentOverrides: { [s1.alpha]: [s1.ada], [s1.beta]: [s1.ben] } },
      context,
    );
    const preview = await evaluateScenario(context.baseline, patch);
    // The worker evaluates the draft record exactly as it would the saved one.
    expect(await evaluateScenario(baselineFromPersisted(draftScenarioRecord(context, patch)), patch)).toEqual(preview);

    const planBefore = readForecastPlan(getDatabase()!, s1.projectId);
    const { command, scenarioId } = saveCommand(context, patch);
    expect(s1.handler.apply(command).type).toBe('ProductCommandApplied');

    const saved = readForecastScenario(getDatabase()!, scenarioId)!;
    expect(saved.baselineRevision).toBe(context.baselineRevision);
    expect(saved.baselineFingerprint).toBe(context.materialFingerprint);
    const reproduced = await evaluateScenario(baselineFromPersisted(saved), saved.patch);
    expect(reproduced.ok && preview.ok).toBe(true);
    if (!reproduced.ok || !preview.ok) return;
    expect(reproduced.baselineResult.arithmetic).toEqual(preview.baselineResult.arithmetic);
    expect(reproduced.variantResult.arithmetic).toEqual(preview.variantResult.arithmetic);
    expect(reproduced.variantResult.allocation).toEqual(preview.variantResult.allocation);
    expect(readForecastPlan(getDatabase()!, s1.projectId)).toEqual(planBefore);
  });
});

/**
 * A corrupt stored forecast plan is surfaced on the native path exactly as on
 * the browser path, never read as an empty plan or roster.
 *
 * The native reader (`query_project_snapshot` in src-tauri) used to parse the
 * roster and assignments cells with `unwrap_or_default()`: a damaged or
 * mis-keyed cell became an empty roster and a staffed project silently lost
 * its staffing in analysis. It now omits the plan and sends
 * `forecastPlanError: "FORECAST_PLAN_CORRUPT: <column>"` (Rust tests in
 * runtime.rs pin that serialized shape). These tests drive the production
 * TypeScript adapter with that shape and compare it with what the browser
 * worker produces for the same damaged cell.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { queryNativeAnalysisSnapshot, queryNativePortableSnapshot } from './tauri-repository.client';
import type { NativeProjectSnapshot } from './native-read-model';
import {
  batchImportPortable,
  getDatabase,
  initWorkerDatabase,
  queryAnalysisSnapshot,
  queryPortableSnapshot,
} from './repository.worker';
import { AnalysisEngine } from '../../application/analysis/analysis-engine';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const PROJECT_ID = '019ffe50-0000-7000-8000-000000000001';
const THEME = '019ffe50-0000-7000-8000-0000000000a1';
const FEATURE = '019ffe50-0000-7000-8000-0000000000a2';

/** What the Rust reader now serializes for a project whose roster cell is corrupt. */
function nativeSnapshotWithCorruptPlan(column: string): NativeProjectSnapshot {
  const node = (id: string, parentId: string | null, nodeType: 'Theme' | 'Feature', position: number) => ({
    id, parentId, title: `${nodeType} ${id.slice(-2)}`, bodyText: null, position, nodeType,
    startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false,
    effortPoints: nodeType === 'Feature' ? 5 : null, strategicWeight: null, phaseId: null, deliveryStatus: 'not_started',
  });
  return {
    projectId: PROJECT_ID,
    projectName: 'Corrupt plan',
    revision: 3,
    nodes: [node(THEME, null, 'Theme', 1), node(FEATURE, THEME, 'Feature', 1)],
    phases: [],
    unlockEdges: [],
    customFields: [],
    dismissals: [],
    affectedReasons: [],
    forecastPlanError: `FORECAST_PLAN_CORRUPT: ${column}`,
  };
}

describe('native adapter: a corrupt stored plan is surfaced, not emptied', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('carries the marker into analysis, with no plan and the rest of the graph intact', async () => {
    vi.mocked(invoke).mockResolvedValue(nativeSnapshotWithCorruptPlan('roster'));
    const snapshot = await queryNativeAnalysisSnapshot(PROJECT_ID);

    expect(snapshot.forecastPlanError).toBe('FORECAST_PLAN_CORRUPT: roster');
    expect(snapshot.forecastPlan).toBeUndefined();
    expect(snapshot.nodes.map((n) => n.id)).toEqual([THEME, FEATURE]);

    // Coherence analysis still runs on the snapshot (it is not taken down).
    const result = new AnalysisEngine().initialize(snapshot);
    expect(result.type).toBe('AnalysisResult');
    expect(result.projectRevision).toBe(3);
  });

  it('refuses a portable export rather than silently dropping the stored plan', async () => {
    vi.mocked(invoke).mockResolvedValue(nativeSnapshotWithCorruptPlan('assignments'));
    await expect(queryNativePortableSnapshot(PROJECT_ID)).rejects.toThrow('FORECAST_PLAN_CORRUPT: assignments');
  });

  it('a healthy native snapshot carries no marker', async () => {
    const { forecastPlanError: _omit, ...healthy } = nativeSnapshotWithCorruptPlan('roster');
    vi.mocked(invoke).mockResolvedValue(healthy);
    const snapshot = await queryNativeAnalysisSnapshot(PROJECT_ID);
    expect('forecastPlanError' in snapshot).toBe(false);
  });
});

describe('parity with the browser worker for the same damaged cell', () => {
  it('both paths produce the same marker and omit the plan', async () => {
    await initWorkerDatabase();
    // A real staffed plan in the browser store, then its roster cell damaged.
    const imported = batchImportPortable({
      projectId: PROJECT_ID,
      projectName: 'Corrupt plan',
      projectRevision: 3,
      phases: [],
      nodes: [
        { id: THEME, parentId: null, title: 'Theme a1', bodyText: null, position: '1', nodeType: 'Theme', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: null, strategicWeight: null, phaseId: null },
        { id: FEATURE, parentId: THEME, title: 'Feature a2', bodyText: null, position: '1', nodeType: 'Feature', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: 5, strategicWeight: null, phaseId: null },
      ],
      nodeCustomFields: [],
      typeTemplateFields: [],
      unlockEdges: [],
      findingDismissals: [],
      affectedReasons: [],
      openQuestions: [],
      forecastPlan: {
        selectedFeatureIds: [FEATURE], parallelGroups: [], pointsPerSprint: 10, sprintLengthDays: 14,
        cadence: 'fixed-contiguous', startSprintOrdinal: 1, startDate: '2026-09-07', policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature', roster: [{ id: '019ffe50-0000-7000-8000-0000000000f1', name: 'Ada', weightUnits: 100 }],
        assignments: { [FEATURE]: ['019ffe50-0000-7000-8000-0000000000f1'] },
      },
    } as never);
    expect(imported.ok).toBe(true);
    getDatabase()!.exec({
      sql: `UPDATE forecast_plans SET roster = ? WHERE project_id = ?`,
      bind: ['[{"personId":"019ffe50-0000-7000-8000-0000000000f1","name":"Ada","weightUnits":100}]', PROJECT_ID],
    });
    const browser = queryAnalysisSnapshot(PROJECT_ID);

    vi.mocked(invoke).mockResolvedValue(nativeSnapshotWithCorruptPlan('roster'));
    const native = await queryNativeAnalysisSnapshot(PROJECT_ID);

    expect(browser.forecastPlanError).toBe('FORECAST_PLAN_CORRUPT: roster');
    expect(native.forecastPlanError).toBe(browser.forecastPlanError);
    expect(browser.forecastPlan).toBeUndefined();
    expect(native.forecastPlan).toBeUndefined();
    // The browser export refuses too, so neither runtime exports a planless copy.
    expect(() => queryPortableSnapshot(PROJECT_ID)).toThrow('FORECAST_PLAN_CORRUPT: roster');
  });

  it('browser rejects forecast and effort commands with typed rejection and leaves DB untouched (AC 22.14-1, AC 22.14-2)', async () => {
    const handler = await initWorkerDatabase();
    const CMD_PROJECT_ID = '019ffe50-0000-7000-8000-000000000002';
    const CMD_THEME = '019ffe50-0000-7000-8000-0000000000b1';
    const CMD_FEATURE = '019ffe50-0000-7000-8000-0000000000b2';
    const imported = batchImportPortable({
      projectId: CMD_PROJECT_ID,
      projectName: 'Corrupt plan 2',
      projectRevision: 3,
      phases: [],
      nodes: [
        { id: CMD_THEME, parentId: null, title: 'Theme b1', bodyText: null, position: '1', nodeType: 'Theme', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: null, strategicWeight: null, phaseId: null },
        { id: CMD_FEATURE, parentId: CMD_THEME, title: 'Feature b2', bodyText: null, position: '1', nodeType: 'Feature', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: 5, strategicWeight: null, phaseId: null },
      ],
      nodeCustomFields: [],
      typeTemplateFields: [],
      unlockEdges: [],
      findingDismissals: [],
      affectedReasons: [],
      openQuestions: [],
      forecastPlan: {
        selectedFeatureIds: [CMD_FEATURE], parallelGroups: [], pointsPerSprint: 10, sprintLengthDays: 14,
        cadence: 'fixed-contiguous', startSprintOrdinal: 1, startDate: '2026-09-07', policyVersion: 'staffed-capacity-v1',
        planningLevel: 'Feature', roster: [{ id: '019ffe50-0000-7000-8000-0000000000f1', name: 'Ada', weightUnits: 100 }],
        assignments: { [CMD_FEATURE]: ['019ffe50-0000-7000-8000-0000000000f1'] },
      },
    } as never);
    expect(imported.ok).toBe(true);

    const db = getDatabase()!;
    const columns = ['selected_feature_ids', 'parallel_groups', 'blocked_feature_ids', 'roster', 'assignments'] as const;

    for (const col of columns) {
      // Corrupt this cell
      db.exec({
        sql: `UPDATE forecast_plans SET ${col} = ? WHERE project_id = ?`,
        bind: ['{bad-json', CMD_PROJECT_ID],
      });

      // 1. AddForecastPerson command
      const addPersonCmd = {
        type: 'AddForecastPerson' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000101',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        personId: '019ffe50-0000-7000-8000-0000000000f2',
        name: 'Bob',
        weightUnits: 100,
      };

      const res1 = handler.apply(addPersonCmd);
      expect(res1).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: addPersonCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // 2. SetForecastAssignments command
      const assignCmd = {
        type: 'SetForecastAssignments' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000102',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        featureId: CMD_FEATURE,
        personIds: ['019ffe50-0000-7000-8000-0000000000f1'],
      };
      const res2 = handler.apply(assignCmd);
      expect(res2).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: assignCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // 3. SetNodeEffort command (zero effort cleans up assignments)
      const effortCmd = {
        type: 'SetNodeEffort' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000103',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: CMD_FEATURE,
        effortPoints: 0,
      };
      const res3 = handler.apply(effortCmd);
      expect(res3).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: effortCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // 4. DeleteSubtree — story 22.14 explicitly includes node commands that
      // clean up assignments (review L1).
      const deleteCmd = {
        type: 'DeleteSubtree' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000104',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        nodeId: CMD_FEATURE,
      };
      const res4 = handler.apply(deleteCmd);
      expect(res4).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: deleteCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // 5. RemoveForecastScenario — plan-touching (review L1).
      const removeScenarioCmd = {
        type: 'RemoveForecastScenario' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000105',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        scenarioId: '019ffe50-0000-7000-8000-0000000000c1',
      };
      const res5 = handler.apply(removeScenarioCmd);
      expect(res5).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: removeScenarioCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // 6. RestoreForecastScenario — plan-touching (review L1).
      const restoreScenarioCmd = {
        type: 'RestoreForecastScenario' as const,
        protocolVersion: '1.0.0' as const,
        commandId: '019ffe50-0000-7000-8000-000000000106',
        projectId: CMD_PROJECT_ID,
        baseRevision: 1,
        expectedRevision: 2,
        scenario: {
          scenarioId: '019ffe50-0000-7000-8000-0000000000c1',
          projectId: CMD_PROJECT_ID,
          label: 'Restored',
          baselineRevision: 1,
          baselineFingerprint: 'f'.repeat(64),
          policyVersion: 'staffed-capacity-v1' as const,
          createdAtISO: '2026-09-26T00:00:00.000Z',
          baseline: { orderedScope: [CMD_FEATURE], parallelGroups: [], blockedFeatureIds: [], planningLevel: 'Feature' as const, factMap: {}, configuration: { pointsPerSprint: 10, sprintLengthDays: 14, cadence: 'fixed-contiguous' as const, startSprintOrdinal: 1, startDate: '2026-09-07' }, roster: [], assignments: {} },
          patch: {},
        },
      };
      const res6 = handler.apply(restoreScenarioCmd);
      expect(res6).toEqual({
        type: 'ProductCommandRejected',
        protocolVersion: '1.0.0',
        commandId: restoreScenarioCmd.commandId,
        code: 'FORECAST_PLAN_CORRUPT',
        column: col,
      });

      // Database state unchanged
      const projectRow = db.exec({
        sql: 'SELECT revision FROM projects WHERE id = ?',
        bind: [CMD_PROJECT_ID],
        rowMode: 'object',
        returnValue: 'resultRows',
      })[0] as { revision: number } | undefined;
      expect(projectRow?.revision).toBe(1);

      const receipts = db.exec({
        sql: 'SELECT COUNT(*) as c FROM product_command_receipt',
        rowMode: 'object',
        returnValue: 'resultRows',
      })[0] as { c: number } | undefined;
      expect(receipts?.c).toBe(0);

      // Story 22.14 AC 22.14-1: no scenario and no plan cell mutated — the
      // damaged cell is byte-identical after every refused command.
      const scenarios = db.exec({
        sql: 'SELECT COUNT(*) as c FROM forecast_scenarios',
        rowMode: 'object',
        returnValue: 'resultRows',
      })[0] as { c: number } | undefined;
      expect(scenarios?.c).toBe(0);
      const cellAfter = db.exec({
        sql: `SELECT ${col} FROM forecast_plans WHERE project_id = ?`,
        bind: [CMD_PROJECT_ID],
        rowMode: 'object',
        returnValue: 'resultRows',
      })[0] as Record<string, unknown> | undefined;
      expect(String(cellAfter?.[col])).toBe('{bad-json');

      // Restore healthy cell for next column test
      const validVal = col === 'assignments' ? '{}' : '[]';
      db.exec({
        sql: `UPDATE forecast_plans SET ${col} = ? WHERE project_id = ?`,
        bind: [validVal, CMD_PROJECT_ID],
      });
    }
  });
});

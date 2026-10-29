import { describe, expect, it } from 'vitest';
import { AnalysisEngine } from './analysis-engine';
import type { Node } from '../../domain/tree/node.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { createChangeSet } from '../../contracts/change-set';
import { createForecastPlan, createForecastConfiguration } from '../../domain/forecast/forecast-plan.entity';

function createMockNode(params: Partial<Node> & { id: string }): Node {
  return {
    id: params.id,
    projectId: 'proj-1',
    parentId: params.parentId ?? null,
    title: params.title ?? 'Test Node',
    bodyText: null,
    position: 1000n,
    nodeType: params.nodeType ?? 'Feature',
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    durationDays: params.durationDays ?? null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: params.effortPoints ?? null,
    effortPointsDone: null,
    strategicWeight: params.strategicWeight ?? null,
    phaseId: params.phaseId ?? null,
    deliveryStatus: params.deliveryStatus ?? 'not_started',
  };
}

describe('AnalysisEngine', () => {
  it.each(['Theme', 'Component'] as const)('preserves %s across sequence deltas and restores scope with level undo', async (level) => {
    const projectId = '019ffe00-0000-7000-8000-000000000001';
    const id = '019ffe00-0000-7000-8000-000000000002';
    const engine = new AnalysisEngine();
    engine.initialize({
      type: 'AnalysisSnapshot', projectId, projectRevision: 1,
      nodes: [{ ...createMockNode({ id, nodeType: level, effortPoints: 20 }), projectId }],
      phases: [], unlockEdges: [], dismissals: [],
      forecastPlan: createForecastPlan({ projectId, planningLevel: level, selectedFeatureIds: [id],
        configuration: createForecastConfiguration({ pointsPerSprint: 10, sprintLengthDays: 14, startSprintOrdinal: 1, startDate: '2026-09-07' }),
      }),
    });
    const apply = (revision: number, changes: import('../../contracts/change-set').NodeChange[]): void => {
      const changeSet = createChangeSet({ projectId, baseRevision: revision, targetRevision: revision + 1, changes });
      expect(engine.applyDelta({ type: 'AnalysisDelta', projectId, baseRevision: revision, targetRevision: revision + 1, changeSet }).type).toBe('AnalysisResult');
    };
    const calculate = (revision: number) => engine.computeForecast({ type: 'ForecastRequest', projectId, projectRevision: revision, policyVersion: 'shared-capacity-v1', requestToken: 'synthetic' });
    apply(1, [{ type: 'ForecastSequenceSet', selectedFeatureIds: [id], parallelGroups: [], priorSelectedFeatureIds: [id], priorParallelGroups: [] }]);
    expect((await calculate(2)).result?.arithmetic?.totalPoints).toBe(20);
    apply(2, [{ type: 'ForecastPlanningLevelSet', planningLevel: 'Feature', selectedFeatureIds: [], parallelGroups: [], blockedFeatureIds: [], priorPlanningLevel: level, priorSelectedFeatureIds: [id], priorParallelGroups: [], priorBlockedFeatureIds: [] }]);
    expect((await calculate(3)).result?.coverage.selectedCount).toBe(0);
    apply(3, [{ type: 'ForecastPlanningLevelSet', planningLevel: level, selectedFeatureIds: [id], parallelGroups: [], blockedFeatureIds: [id], priorPlanningLevel: 'Feature', priorSelectedFeatureIds: [], priorParallelGroups: [], priorBlockedFeatureIds: [] }]);
    const restored = (await calculate(4)).result;
    expect(restored?.arithmetic?.totalPoints).toBe(20);
    expect(restored?.issues.some((issue) => issue.code === 'CONDITIONAL_BLOCKER')).toBe(true);
  });

  it('initializes from snapshot and computes initial findings', () => {
    const engine = new AnalysisEngine();
    const nodes: Node[] = [
      createMockNode({ id: 'orphan-1', title: 'Orphan Feature', nodeType: 'Feature' }),
    ];
    const phases: Phase[] = [];
    const edges: UnlockEdge[] = [];

    const res = engine.initialize({
      type: 'AnalysisSnapshot',
      projectId: 'proj-1',
      projectRevision: 1,
      nodes,
      phases,
      unlockEdges: edges,
      dismissals: [],
    });

    expect(res.type).toBe('AnalysisResult');
    expect(res.projectRevision).toBe(1);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].kind).toBe('OrphanedFeature');
  });

  it('applies delta ChangeSets sequentially and returns updated findings', () => {
    const engine = new AnalysisEngine();
    const nodes: Node[] = [
      createMockNode({ id: 't1', title: 'Theme 1', nodeType: 'Theme' }),
      createMockNode({ id: 'f1', title: 'Feature 1', nodeType: 'Feature' }), // Initially orphan
    ];

    engine.initialize({
      type: 'AnalysisSnapshot',
      projectId: 'proj-1',
      projectRevision: 1,
      nodes,
      phases: [],
      unlockEdges: [],
      dismissals: [],
    });

    // Move f1 under t1
    const delta = {
      type: 'AnalysisDelta' as const,
      projectId: 'proj-1',
      baseRevision: 1,
      targetRevision: 2,
      changeSet: createChangeSet({
        projectId: 'proj-1',
        baseRevision: 1,
        targetRevision: 2,
        changes: [
          {
            type: 'NodeMoved',
            nodeId: 'f1',
            parentId: 't1',
            position: '1000',
            priorParentId: null,
            priorPosition: '1000',
          },
        ],
      }),
    };

    const res = engine.applyDelta(delta);
    expect(res.type).toBe('AnalysisResult');
    if (res.type === 'AnalysisResult') {
      expect(res.projectRevision).toBe(2);
      expect(res.findings).toHaveLength(0); // Orphan resolved!
    }
  });

  it('returns AnalysisResyncRequired on revision gap', () => {
    const engine = new AnalysisEngine();
    engine.initialize({
      type: 'AnalysisSnapshot',
      projectId: 'proj-1',
      projectRevision: 1,
      nodes: [],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    });

    const gapDelta = {
      type: 'AnalysisDelta' as const,
      projectId: 'proj-1',
      baseRevision: 3, // Gap! Current is 1
      targetRevision: 4,
      changeSet: createChangeSet({
        projectId: 'proj-1',
        baseRevision: 3,
        targetRevision: 4,
        changes: [],
      }),
    };

    const res = engine.applyDelta(gapDelta);
    expect(res.type).toBe('AnalysisResyncRequired');
  });

  it('preserves roster and assignments across deltas and applies staffing events correctly', async () => {
    const projectId = '019ffe00-0000-7000-8000-000000000010';
    const featureIdA = '019ffe00-0000-7000-8000-000000000011';
    const featureIdB = '019ffe00-0000-7000-8000-000000000012';
    const personIdAda = '019ffe00-0000-7000-8000-000000000013';
    const personIdBen = '019ffe00-0000-7000-8000-000000000014';

    const engine = new AnalysisEngine();
    engine.initialize({
      type: 'AnalysisSnapshot',
      projectId,
      projectRevision: 1,
      nodes: [
        { ...createMockNode({ id: featureIdA, effortPoints: 10 }), projectId },
        { ...createMockNode({ id: featureIdB, effortPoints: 30 }), projectId },
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
      forecastPlan: createForecastPlan({
        projectId,
        selectedFeatureIds: [featureIdA, featureIdB],
        parallelGroups: [{ featureIds: [featureIdA, featureIdB] }],
        configuration: createForecastConfiguration({
          pointsPerSprint: 20,
          sprintLengthDays: 14,
          startSprintOrdinal: 12,
          startDate: '2026-09-07',
        }),
        policyVersion: 'staffed-capacity-v1',
      }),
    });

    const apply = (revision: number, changes: import('../../contracts/change-set').NodeChange[]): void => {
      const changeSet = createChangeSet({ projectId, baseRevision: revision, targetRevision: revision + 1, changes });
      expect(engine.applyDelta({ type: 'AnalysisDelta', projectId, baseRevision: revision, targetRevision: revision + 1, changeSet }).type).toBe('AnalysisResult');
    };
    const compute = (revision: number) =>
      engine.computeForecast({
        type: 'ForecastRequest',
        projectId,
        projectRevision: revision,
        policyVersion: 'staffed-capacity-v1',
        requestToken: 'test-token',
      });

    // 1. Initial staffed forecast without roster is incomplete (MISSING_ROSTER)
    let res = await compute(1);
    expect(res.result?.state).toBe('incomplete');
    expect(res.result?.issues.some((i) => i.code === 'MISSING_ROSTER')).toBe(true);

    // 2. Add Ada and Ben to roster via ForecastPersonAdded deltas
    apply(1, [
      {
        type: 'ForecastPersonAdded',
        projectId,
        person: { id: personIdAda, name: 'Ada', weightUnits: 100 },
      },
    ]);
    apply(2, [
      {
        type: 'ForecastPersonAdded',
        projectId,
        person: { id: personIdBen, name: 'Ben', weightUnits: 100 },
      },
    ]);

    // 3. Now roster is present, but assignments are missing
    res = await compute(3);
    expect(res.result?.state).toBe('incomplete');
    expect(res.result?.issues.some((i) => i.code === 'MISSING_ASSIGNMENT')).toBe(true);

    // 4. Assign Ada to A and Ben to B via ForecastAssignmentsSet
    apply(3, [
      {
        type: 'ForecastAssignmentsSet',
        projectId,
        featureId: featureIdA,
        personIds: [personIdAda],
        priorPersonIds: [],
      },
    ]);
    apply(4, [
      {
        type: 'ForecastAssignmentsSet',
        projectId,
        featureId: featureIdB,
        personIds: [personIdBen],
        priorPersonIds: [],
      },
    ]);

    // 5. M3 staffed forecast is now ready: Sprint 14 / 2026-10-18
    res = await compute(5);
    expect(res.result?.state).toBe('ready');
    expect(res.result?.arithmetic?.completionSprint).toBe(14);
    expect(res.result?.arithmetic?.completionDate).toBe('2026-10-18');

    // 6. Apply ForecastConfigurationSet: roster and assignments must be preserved!
    apply(5, [
      {
        type: 'ForecastConfigurationSet',
        pointsPerSprint: 20,
        sprintLengthDays: 14,
        startSprintOrdinal: 12,
        startDate: '2026-09-07',
        priorPointsPerSprint: 20,
        priorSprintLengthDays: 14,
        priorStartSprintOrdinal: 12,
        priorStartDate: '2026-09-07',
      },
    ]);

    res = await compute(6);
    expect(res.result?.state).toBe('ready');
    expect(res.result?.arithmetic?.completionSprint).toBe(14);

    // 7. Switch to shared policy via ForecastPolicySet
    apply(6, [
      {
        type: 'ForecastPolicySet',
        projectId,
        policyVersion: 'shared-capacity-v1',
        priorPolicyVersion: 'staffed-capacity-v1',
      },
    ]);

    const sharedRes = await engine.computeForecast({
      type: 'ForecastRequest',
      projectId,
      projectRevision: 7,
      policyVersion: 'shared-capacity-v1',
      requestToken: 'test-token-shared',
    });
    expect(sharedRes.result?.state).toBe('ready');
    expect(sharedRes.policyVersion).toBe('shared-capacity-v1');

    // 8. Switch back to staffed: roster and assignments were preserved!
    apply(7, [
      {
        type: 'ForecastPolicySet',
        projectId,
        policyVersion: 'staffed-capacity-v1',
        priorPolicyVersion: 'shared-capacity-v1',
      },
    ]);

    res = await compute(8);
    expect(res.result?.state).toBe('ready');
    expect(res.result?.arithmetic?.completionSprint).toBe(14);
  });
});

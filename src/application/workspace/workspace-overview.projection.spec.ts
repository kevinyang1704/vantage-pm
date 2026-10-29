import { describe, expect, it } from 'vitest';
import { createNode } from '../../domain/tree/node.entity';
import { createPhase } from '../../domain/phase/phase.entity';
import { createUnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { ProjectAnalysisInput } from './workspace-overview.projection';
import {
  assembleWorkspaceOverview,
  groupFeaturesByTheme,
  projectWorkspaceProjectRow,
  projectWorkspaceOverview,
  SUPPORTED_PROJECT_COUNT,
} from './workspace-overview.projection';
import { attributeNodesToNearestTheme } from '../../domain/analysis/theme-attribution.policy';
import type { WorkspaceProjectRow } from '../../contracts/workspace-overview';
import type { DeliveryStatus } from '../../domain/tree/node.entity';

const P1 = '019ffe00-0000-7000-8000-000000000001';
const P2 = '019ffe00-0000-7000-8000-000000000002';
const V1 = '019ffe00-0000-7000-8000-000000000010';
const T1 = '019ffe00-0000-7000-8000-000000000020';
const T2 = '019ffe00-0000-7000-8000-000000000021';
const F1 = '019ffe00-0000-7000-8000-000000000030';
const F2 = '019ffe00-0000-7000-8000-000000000031';
const PH1 = '019ffe00-0000-7000-8000-000000000040';
const PH2 = '019ffe00-0000-7000-8000-000000000041';
const EDGE = '019ffe00-0000-7000-8000-000000000050';

function n(params: {
  id: string;
  projectId: string;
  parentId?: string | null;
  nodeType?: 'Vision' | 'Theme' | 'Component' | 'Feature' | 'AcceptanceCriterion' | null;
  title?: string;
  strategicWeight?: number | null;
  effortPoints?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  durationDays?: number | null;
  phaseId?: string | null;
  deliveryStatus?: DeliveryStatus;
  completed?: boolean;
  position?: bigint;
}) {
  return createNode({
    id: params.id,
    projectId: params.projectId,
    parentId: params.parentId ?? null,
    nodeType: params.nodeType ?? null,
    title: params.title ?? '',
    position: params.position ?? 1n,
    strategicWeight: params.strategicWeight ?? null,
    effortPoints: params.effortPoints ?? null,
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    durationDays: params.durationDays ?? null,
    phaseId: params.phaseId ?? null,
    deliveryStatus: params.deliveryStatus ?? 'not_started',
    completed: params.completed ?? false,
  });
}

function project1Input(): ProjectAnalysisInput {
  return {
    projectId: P1,
    projectName: 'Alpha',
    projectRevision: 7,
    nodes: [
      n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
      n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Theme A', strategicWeight: 60, effortPoints: 40, phaseId: PH1 }),
      n({ id: T2, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Theme B', strategicWeight: 40, effortPoints: 60 }),
      n({ id: F1, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'Feature 1', effortPoints: 20 }),
      n({ id: F2, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'Feature 2', effortPoints: 20 }),
    ],
    phases: [
      createPhase({ id: PH1, projectId: P1, name: 'Phase 1', position: 100n }),
      createPhase({ id: PH2, projectId: P1, name: 'Phase 2', position: 200n }),
    ],
    unlockEdges: [
      createUnlockEdge({ id: EDGE, projectId: P1, sourceNodeId: F1, targetNodeId: F2 }),
    ],
    dismissals: [],
  };
}

function project2Input(): ProjectAnalysisInput {
  return {
    projectId: P2,
    projectName: 'Beta',
    projectRevision: 2,
    nodes: [
      n({ id: '019ffe00-0000-7000-8000-000000000011', projectId: P2, nodeType: 'Theme', title: 'Solo Theme' }),
    ],
    phases: [],
    unlockEdges: [],
    dismissals: [],
  };
}

function makeProjectInput(index: number): ProjectAnalysisInput {
  const projectId = `119ffe00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const themeId = `119ffe00-0001-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const visionId = `119ffe00-0002-7000-8000-${index.toString(16).padStart(12, '0')}`;

  return {
    projectId,
    projectName: `Project ${index}`,
    projectRevision: index,
    nodes: [
      n({ id: visionId, projectId, nodeType: 'Vision', title: 'Vision' }),
      n({ id: themeId, projectId, parentId: visionId, nodeType: 'Theme', title: 'Theme' }),
    ],
    phases: [],
    unlockEdges: [],
    dismissals: [],
  };
}

describe('workspace-overview projection', () => {
  it('produces revision-vector entries sorted ascending by projectId', () => {
    const overview = projectWorkspaceOverview([project1Input(), project2Input()]);

    expect(overview.revisionVector.map((e) => e.projectId)).toEqual([P1, P2]);
    expect(overview.revisionVector[0].projectRevision).toBe(7);
    expect(overview.revisionVector[1].projectRevision).toBe(2);
  });

  it('maps every theme to a row with counts and shares', () => {
    const row = projectWorkspaceProjectRow(project1Input());

    expect(row.nodeCount).toBe(5);
    expect(row.phaseCount).toBe(2);
    expect(row.themes).toHaveLength(2);

    const themeA = row.themes.find((t) => t.themeId === T1)!;
    expect(themeA.featureCount).toBe(2);
    expect(themeA.strategyShare).not.toBeNull();
    expect(themeA.effortShare).not.toBeNull();
    expect(themeA.phase).not.toBeNull();
    expect(themeA.phase!.phaseName).toBe('Phase 1');
  });

  it('marks a theme flagged when its attribution bucket has findings', () => {
    const row = projectWorkspaceProjectRow(project1Input());

    expect(row.openFindingCount).toBeGreaterThanOrEqual(0);
    for (const theme of row.themes) {
      expect(theme.coherenceState === 'clear' || theme.coherenceState === 'flagged').toBe(true);
      expect(theme.openFindingCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports reduced coverage when weight is missing', () => {
    const input = project1Input();
    const reduced = {
      ...input,
      nodes: input.nodes.map((node) =>
        node.id === T1 ? createNode({ ...node, strategicWeight: null }) : node,
      ),
    };
    const row = projectWorkspaceProjectRow(reduced);

    expect(row.coverage.weightCoveragePercentage).toBeLessThan(100);
  });

  it('produces a theme row for a single-theme project and handles an empty workspace', () => {
    const row = projectWorkspaceProjectRow(project2Input());
    expect(row.themes).toHaveLength(1);
    expect(row.themes[0].themeName).toBe('Solo Theme');

    const empty = projectWorkspaceOverview([]);
    expect(empty.projects).toHaveLength(0);
    expect(empty.revisionVector).toHaveLength(0);
  });

  it('is byte-for-byte deterministic regardless of input order', () => {
    const a = projectWorkspaceOverview([project1Input(), project2Input()]);
    const shuffled = projectWorkspaceOverview([project2Input(), project1Input()]);

    expect(JSON.stringify(a)).toBe(JSON.stringify(shuffled));
  });

  it('reproduces identical output across 50 independent shuffled runs', () => {
    const baseline = JSON.stringify(projectWorkspaceOverview([project1Input(), project2Input()]));
    for (let i = 0; i < 50; i++) {
      const inputs = i % 2 === 0 ? [project1Input(), project2Input()] : [project2Input(), project1Input()];
      expect(JSON.stringify(projectWorkspaceOverview(inputs))).toBe(baseline);
    }
  });

  it('flags and truncates when the project count exceeds the supported limit (Story 5.6 AC4)', () => {
    const inputs: ProjectAnalysisInput[] = [];
    for (let i = 0; i < SUPPORTED_PROJECT_COUNT + 1; i++) {
      inputs.push(makeProjectInput(i));
    }

    const overview = projectWorkspaceOverview(inputs);

    expect(overview.limitWarning).not.toBeNull();
    expect(overview.limitWarning!.exceededProjectCount).toBe(true);
    expect(overview.projects).toHaveLength(SUPPORTED_PROJECT_COUNT);
    expect(overview.revisionVector).toHaveLength(SUPPORTED_PROJECT_COUNT);
  });

  it('assembled result matches regardless of entry order (assembleWorkspaceOverview)', () => {
    const rows: WorkspaceProjectRow[] = [projectWorkspaceProjectRow(project2Input()), projectWorkspaceProjectRow(project1Input())];

    const assembled = assembleWorkspaceOverview(rows);
    const purePath = projectWorkspaceOverview([project1Input(), project2Input()]);

    expect(JSON.stringify(assembled)).toBe(JSON.stringify(purePath));
  });
});

// ── Epic 24.1: delivery-status summaries ─────────────────────────────

describe('workspace-overview delivery-status projection (Story 24.1)', () => {
  it('counts only Features, once each, ignoring other types and completed flags (AC 24.1-1)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision', completed: true }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Theme A', completed: true }),
        n({ id: F1, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'F1', deliveryStatus: 'not_started', completed: true }),
        n({ id: F2, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'F2', deliveryStatus: 'in_progress' }),
        // An untyped node must contribute nothing.
        n({ id: '019ffe00-0000-7000-8000-000000000099', projectId: P1, parentId: T1, nodeType: null, title: 'untyped' }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    expect(row.featureCount).toBe(2);
    expect(row.statusCounts).toEqual({ notStarted: 1, inProgress: 1, delivered: 0 });
    // completed flags on the Feature and its parent do not change its status.
  });

  it('satisfies the 5-Feature oracle plus one delivered Feature in another theme (AC 24.1-7)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Oracle',
      projectRevision: 3,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Measurement at scale' }),
        n({ id: '019ffe00-0000-7000-8000-000000000030', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'A', deliveryStatus: 'not_started', position: 1n }),
        n({ id: '019ffe00-0000-7000-8000-000000000031', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'B', deliveryStatus: 'not_started', position: 2n }),
        n({ id: '019ffe00-0000-7000-8000-000000000032', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'C', deliveryStatus: 'in_progress', position: 3n }),
        n({ id: '019ffe00-0000-7000-8000-000000000033', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'D', deliveryStatus: 'in_progress', position: 4n }),
        n({ id: '019ffe00-0000-7000-8000-000000000034', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'E', deliveryStatus: 'delivered', position: 5n }),
        n({ id: T2, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Performance Transparency' }),
        n({ id: '019ffe00-0000-7000-8000-000000000035', projectId: P1, parentId: T2, nodeType: 'Feature', title: 'F', deliveryStatus: 'delivered', position: 1n }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    expect(row.featureCount).toBe(6);
    expect(row.statusCounts).toEqual({ notStarted: 2, inProgress: 2, delivered: 2 });

    const measurement = row.themes.find((t) => t.themeId === T1)!;
    expect(measurement.featureCount).toBe(5);
    expect(measurement.statusCounts).toEqual({ notStarted: 2, inProgress: 2, delivered: 1 });

    const performance = row.themes.find((t) => t.themeId === T2)!;
    expect(performance.featureCount).toBe(1);
    expect(performance.statusCounts).toEqual({ notStarted: 0, inProgress: 0, delivered: 1 });
  });

  it('attributes each Feature to at most one theme and reports unattributed project totals (AC 24.1-2)', () => {
    const orphanFeature = '019ffe00-0000-7000-8000-000000000036';
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Theme A' }),
        n({ id: F1, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'F1', deliveryStatus: 'delivered' }),
        // A Feature parented directly to the Vision has no Theme ancestor.
        n({ id: orphanFeature, projectId: P1, parentId: V1, nodeType: 'Feature', title: 'Orphan', deliveryStatus: 'in_progress' }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    expect(row.featureCount).toBe(2);
    expect(row.statusCounts).toEqual({ notStarted: 0, inProgress: 1, delivered: 1 });
    // Theme bucket sums equal the theme's feature count; project totals exceed
    // the displayed theme bucket sum by exactly the unattributed count.
    const themeTotal = row.themes.reduce((sum, t) => sum + t.featureCount, 0);
    expect(themeTotal).toBe(1);
    expect(row.unattributedFeatureCount).toBe(1);
  });

  it('lists each theme Feature once, in containment order, with stable ids (AC 24.1-1, 24.3-2)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Theme A' }),
        // Duplicate titles must still appear once each, keyed by node id.
        n({ id: '019ffe00-0000-7000-8000-000000000037', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'Same', deliveryStatus: 'not_started', position: 1n }),
        n({ id: '019ffe00-0000-7000-8000-000000000038', projectId: P1, parentId: T1, nodeType: 'Feature', title: 'Same', deliveryStatus: 'delivered', position: 2n }),
        // A nested Component's Feature still attributes to the same theme.
        n({ id: '019ffe00-0000-7000-8000-000000000039', projectId: P1, parentId: T1, nodeType: 'Component', title: 'Component', position: 3n }),
        n({ id: '019ffe00-0000-7000-8000-00000000003a', projectId: P1, parentId: '019ffe00-0000-7000-8000-000000000039', nodeType: 'Feature', title: 'Nested', deliveryStatus: 'in_progress', position: 1n }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.featureCount).toBe(3);
    expect(theme.features.map((f) => f.featureId)).toEqual([
      '019ffe00-0000-7000-8000-000000000037',
      '019ffe00-0000-7000-8000-000000000038',
      '019ffe00-0000-7000-8000-00000000003a',
    ]);
    // Two features share a title but are distinct rows.
    expect(theme.features.filter((f) => f.title === 'Same')).toHaveLength(2);
    // Detail status counts equal the theme buckets.
    const detailCounts = theme.features.reduce(
      (acc, f) => {
        if (f.deliveryStatus === 'delivered') acc.delivered += 1;
        else if (f.deliveryStatus === 'in_progress') acc.inProgress += 1;
        else acc.notStarted += 1;
        return acc;
      },
      { notStarted: 0, inProgress: 0, delivered: 0 },
    );
    expect(detailCounts).toEqual(theme.statusCounts);
  });

  it('never mutates authored phases, schedules or statuses (AC 24.1-6)', () => {
    const input = project1Input();
    const row = projectWorkspaceProjectRow(input);
    // The input nodes are untouched (pure projection).
    expect(input.nodes.find((node) => node.id === T1)!.strategicWeight).toBe(60);
    expect(input.phases).toHaveLength(2);
    expect(row.phaseCount).toBe(2);
    expect(row.themes.find((t) => t.themeId === T1)!.phase!.phaseName).toBe('Phase 1');
  });

  it('preserves empty/zero-Feature themes without a filled bucket (AC 24.1-3)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Empty Theme' }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.featureCount).toBe(0);
    expect(theme.statusCounts).toEqual({ notStarted: 0, inProgress: 0, delivered: 0 });
    expect(theme.features).toEqual([]);
    expect(row.featureCount).toBe(0);
  });

  it('is deterministic for the delivery-status extension regardless of input order', () => {
    const a = JSON.stringify(projectWorkspaceOverview([project1Input(), project2Input()]));
    const b = JSON.stringify(projectWorkspaceOverview([project2Input(), project1Input()]));
    expect(a).toBe(b);
  });
});

describe('workspace-overview timeline span projection (Story 24.2)', () => {
  it('uses a Theme\'s own authored span when it has no Features (AC 24.2-3)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({
          id: T1,
          projectId: P1,
          parentId: V1,
          nodeType: 'Theme',
          title: 'Scheduled Empty Theme',
          startDate: '2026-05-01',
          endDate: '2026-12-01',
        }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.featureCount).toBe(0);
    expect(theme.spanStartDate).toBe('2026-05-01');
    expect(theme.spanEndDate).toBe('2026-12-01');
  });

  it('prefers the Theme\'s own authored span over its descendants\' derived span', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({
          id: T1,
          projectId: P1,
          parentId: V1,
          nodeType: 'Theme',
          title: 'Authored Theme',
          startDate: '2026-01-01',
          endDate: '2026-02-01',
        }),
        n({
          id: F1,
          projectId: P1,
          parentId: T1,
          nodeType: 'Feature',
          title: 'F1',
          startDate: '2026-08-01',
          endDate: '2026-09-01',
        }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.spanStartDate).toBe('2026-01-01');
    expect(theme.spanEndDate).toBe('2026-02-01');
  });

  it('falls back to the derived descendant span when the Theme has no authored dates', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Derived Theme' }),
        n({
          id: F1,
          projectId: P1,
          parentId: T1,
          nodeType: 'Feature',
          title: 'F1',
          startDate: '2026-08-01',
          endDate: '2026-09-01',
        }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.spanStartDate).toBe('2026-08-01');
    expect(theme.spanEndDate).toBe('2026-09-01');
  });

  it('merges a one-sided authored Theme date with the derived span (does not drop a valid side)', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        // Only a start date authored on the theme; the end must come from the
        // derived descendant span rather than becoming null.
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Partial', startDate: '2026-05-01' }),
        n({
          id: F1,
          projectId: P1,
          parentId: T1,
          nodeType: 'Feature',
          title: 'F1',
          startDate: '2026-05-01',
          endDate: '2026-12-01',
        }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    expect(theme.spanStartDate).toBe('2026-05-01');
    expect(theme.spanEndDate).toBe('2026-12-01');
  });

  it('surfaces an invalid authored Theme schedule rather than masking it with a derived span', () => {
    const input: ProjectAnalysisInput = {
      projectId: P1,
      projectName: 'Alpha',
      projectRevision: 1,
      nodes: [
        n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
        // Reversed authored dates on the theme; a valid descendant span exists.
        n({ id: T1, projectId: P1, parentId: V1, nodeType: 'Theme', title: 'Reversed', startDate: '2026-12-01', endDate: '2026-05-01' }),
        n({
          id: F1,
          projectId: P1,
          parentId: T1,
          nodeType: 'Feature',
          title: 'F1',
          startDate: '2026-06-01',
          endDate: '2026-07-01',
        }),
      ],
      phases: [],
      unlockEdges: [],
      dismissals: [],
    };

    const row = projectWorkspaceProjectRow(input);
    const theme = row.themes.find((t) => t.themeId === T1)!;
    // The reversed pair is exposed so the lane can render an explicit invalid
    // state instead of a misleading derived span.
    expect(theme.spanStartDate).toBe('2026-12-01');
    expect(theme.spanEndDate).toBe('2026-05-01');
  });

  it('reconciles theme buckets with attribution even for an unreachable (cyclic) subtree', () => {
    const C1 = '019ffe00-0000-7000-8000-000000000061';
    const F9 = '019ffe00-0000-7000-8000-000000000062';
    // The full projection path rejects containment cycles upstream in
    // computeThemeRollup, so this guards the grouping helper directly: a
    // Feature unreachable from a synthetic root still lands in the bucket
    // attribution assigns it to.
    const nodes = [
      n({ id: V1, projectId: P1, nodeType: 'Vision', title: 'Vision' }),
      n({ id: T1, projectId: P1, parentId: C1, nodeType: 'Theme', title: 'Cyclic Theme' }),
      n({ id: C1, projectId: P1, parentId: T1, nodeType: 'Component', title: 'Cycle member' }),
      n({ id: F9, projectId: P1, parentId: T1, nodeType: 'Feature', title: 'F9', deliveryStatus: 'delivered' }),
    ];
    const attribution = attributeNodesToNearestTheme(nodes);
    const grouped = groupFeaturesByTheme(nodes, attribution);

    const bucket = grouped.get(T1) ?? [];
    expect(bucket.map((f) => f.featureId)).toEqual([F9]);
  });
});

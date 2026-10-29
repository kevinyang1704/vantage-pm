/**
 * Native/browser parity for the Epic 24 workspace overview projection
 * (AC 24.4-2, AC 24.1-7).
 *
 * The browser and native paths both feed `projectWorkspaceOverview` through the
 * same `ProjectAnalysisInput`. This test drives the *native* adapter path
 * (`queryNativeWorkspaceOverview`, which reads `NativeProjectSnapshot` via the
 * `invoke` bridge and maps it with `mapDomainNodes`) and asserts its output is
 * deep-equal to the browser path over the same fixture, so the two runtimes
 * cannot drift on counts, attribution, normalized dates or detail content.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { NativeProjectSnapshot } from './native-read-model';
import { projectWorkspaceOverview } from '../../application/workspace/workspace-overview.projection';
import { queryNativeWorkspaceOverview } from './tauri-repository.client';
import { createNode } from '../../domain/tree/node.entity';
import type { NodeType, DeliveryStatus } from '../../domain/tree/node.entity';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const P1 = '019ffea0-0000-7000-8000-000000000001';
const V1 = '019ffea0-0000-7000-8000-000000000010';
const T1 = '019ffea0-0001-7000-8000-000000000001';
const T2 = '019ffea0-0001-7000-8000-000000000002';
const F1 = '019ffea0-0011-7000-8000-000000000001';
const F2 = '019ffea0-0011-7000-8000-000000000002';
const F3 = '019ffea0-0011-7000-8000-000000000003';
const F4 = '019ffea0-0013-7000-8000-000000000001';

/**
 * The exact same authored facts expressed once. `snapshot` is the native DTO;
 * `browserInput` is the domain `ProjectAnalysisInput` the browser worker path
 * builds. Both must project identically.
 */
const nodes: readonly {
  id: string;
  parentId: string | null;
  title: string;
  nodeType: 'Vision' | 'Theme' | 'Feature';
  startDate: string | null;
  endDate: string | null;
  deliveryStatus: DeliveryStatus;
}[] = [
  { id: V1, parentId: null, title: 'Vision', nodeType: 'Vision', startDate: null, endDate: null, deliveryStatus: 'not_started' },
  { id: T1, parentId: V1, title: 'Measurement at scale', nodeType: 'Theme', startDate: null, endDate: null, deliveryStatus: 'not_started' },
  { id: T2, parentId: V1, title: 'Performance Transparency', nodeType: 'Theme', startDate: null, endDate: null, deliveryStatus: 'not_started' },
  { id: F1, parentId: T1, title: 'Experiment event collection', nodeType: 'Feature', startDate: '2026-05-01', endDate: '2026-07-01', deliveryStatus: 'delivered' },
  { id: F2, parentId: T1, title: 'Metric definitions', nodeType: 'Feature', startDate: '2026-06-01', endDate: '2026-09-01', deliveryStatus: 'in_progress' },
  { id: F3, parentId: T2, title: 'Experiment performance reporting', nodeType: 'Feature', startDate: '2026-09-05', endDate: '2026-09-30', deliveryStatus: 'delivered' },
  { id: F4, parentId: V1, title: 'Unparented feature', nodeType: 'Feature', startDate: null, endDate: null, deliveryStatus: 'in_progress' },
];

function buildNativeSnapshot(): NativeProjectSnapshot {
  return {
    projectId: P1,
    projectName: 'Epic 24 Canonical',
    revision: 2,
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      bodyText: null,
      position: 1,
      nodeType: n.nodeType,
      startDate: n.startDate,
      endDate: n.endDate,
      durationDays: null,
      scheduleSourceMode: n.startDate && n.endDate ? ('start_end' as const) : null,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
      deliveryStatus: n.deliveryStatus,
    })),
    phases: [],
    unlockEdges: [],
    customFields: [],
    dismissals: [],
    affectedReasons: [],
  };
}

describe('native/browser workspace overview parity (Epic 24, AC 24.4-2)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('produces identical projections from the native adapter and the browser projection core', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'repository_query_projects') {
        return [{ id: P1, name: 'Epic 24 Canonical', revision: 2 } as never];
      }
      if (command === 'repository_query_project_snapshot') {
        return buildNativeSnapshot() as never;
      }
      throw new Error(`unexpected native command: ${command}`);
    });

    const native = await queryNativeWorkspaceOverview();

    // The browser side is built with the real domain entity factory (the same
    // `createNode` the browser worker path uses when mapping an outline read
    // model), not a transcribed object literal, so this compares the native
    // mapper against the production projection core rather than against the
    // test author's copy of the fixture.
    const browser = projectWorkspaceOverview([
      {
        projectId: P1,
        projectName: 'Epic 24 Canonical',
        projectRevision: 2,
        nodes: nodes.map((n, i) =>
          createNode({
            id: n.id,
            projectId: P1,
            parentId: n.parentId,
            title: n.title,
            position: BigInt(i + 1),
            nodeType: n.nodeType,
            startDate: n.startDate,
            endDate: n.endDate,
            durationDays: null,
            scheduleSourceMode: n.startDate && n.endDate ? ('start_end' as const) : null,
            deliveryStatus: n.deliveryStatus,
          }),
        ),
        phases: [],
        unlockEdges: [],
        dismissals: [],
      },
    ]);

    // Counts, attribution, normalized dates and detail content must agree.
    expect(JSON.stringify(native)).toBe(JSON.stringify(browser));

    const row = native.projects[0];
    expect(row.featureCount).toBe(4);
    expect(row.statusCounts).toEqual({ notStarted: 0, inProgress: 2, delivered: 2 });
    expect(row.unattributedFeatureCount).toBe(1);
    expect(row.themes.find((t) => t.themeId === T1)!.features.map((f) => f.featureId)).toEqual([F1, F2]);
    expect(row.themes.find((t) => t.themeId === T2)!.features.map((f) => f.featureId)).toEqual([F3]);
    // Normalized theme spans agree between the two runtimes.
    expect(row.themes.find((t) => t.themeId === T1)!.spanStartDate).toBe('2026-05-01');
    expect(row.themes.find((t) => t.themeId === T1)!.spanEndDate).toBe('2026-09-01');
    expect(row.themes.find((t) => t.themeId === T2)!.spanStartDate).toBe('2026-09-05');
    expect(row.themes.find((t) => t.themeId === T2)!.spanEndDate).toBe('2026-09-30');
  });
});

/**
 * Story 5.5 NFR Performance Spec (AC1, NFR-8/NFR-16).
 * Asserts aggregate-only projection compute time and bounded output at
 * 1, 5, and 10 projects each at 5,000 nodes.
 */

import { describe, expect, it } from 'vitest';
import { createNode } from '../../src/domain/tree/node.entity';
import { createPhase } from '../../src/domain/phase/phase.entity';
import type { ProjectAnalysisInput } from '../../src/application/workspace/workspace-overview.projection';
import { projectWorkspaceOverview, groupFeaturesByTheme } from '../../src/application/workspace/workspace-overview.projection';
import { attributeNodesToNearestTheme } from '../../src/domain/analysis/theme-attribution.policy';
import { computeThemeRollup } from '../../src/domain/analysis/strategic-balance.policy';

function makeProjectInput(index: number): ProjectAnalysisInput {
  const projectId = `019ffe00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const visionId = `019ffe00-0001-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const themeId = `019ffe00-0002-7000-8000-${index.toString(16).padStart(12, '0')}`;

  const nodes = [
    createNode({
      id: visionId,
      projectId,
      nodeType: 'Vision',
      title: 'Vision',
      position: 1n,
    }),
    createNode({
      id: themeId,
      projectId,
      parentId: visionId,
      nodeType: 'Theme',
      title: 'Theme',
      position: 1n,
    }),
  ];

  for (let i = 0; i < 4998; i++) {
    nodes.push(
      createNode({
        id: `019ffe00-0003-7000-8000-${(index * 10_000 + i).toString(16).padStart(12, '0')}`,
        projectId,
        parentId: i % 2 === 0 ? themeId : null,
        nodeType: 'Feature',
        title: `Feature ${i}`,
        position: BigInt(i + 1) * 4294967296n,
      }),
    );
  }

  return {
    projectId,
    projectName: `Project ${index}`,
    projectRevision: index,
    nodes,
    phases: [createPhase({ id: `019ffe00-0004-7000-8000-${index.toString(16).padStart(12, '0')}`, projectId, name: 'Phase', position: 1n })],
    unlockEdges: [],
    dismissals: [],
  };
}

/**
 * The pathological shape for the per-theme Feature grouping: many Themes, each
 * owning a handful of Features. The single-theme fixture above never exercises
 * the per-theme work, so it cannot guard against an O(themes x nodes) regression.
 */
function makeManyThemeInput(index: number, themeCount = 500, featuresPerTheme = 9): ProjectAnalysisInput {
  const projectId = `119ffe00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const visionId = `119ffe00-0001-7000-8000-${index.toString(16).padStart(12, '0')}`;
  const nodes = [
    createNode({ id: visionId, projectId, nodeType: 'Vision', title: 'Vision', position: 1n }),
  ];

  for (let t = 0; t < themeCount; t++) {
    const themeId = `119ffe00-0002-7000-8000-${(index * 1_000_000 + t).toString(16).padStart(12, '0')}`;
    nodes.push(
      createNode({
        id: themeId,
        projectId,
        parentId: visionId,
        nodeType: 'Theme',
        title: `Theme ${t}`,
        position: BigInt(t + 1) * 4294967296n,
      }),
    );
    for (let f = 0; f < featuresPerTheme; f++) {
      nodes.push(
        createNode({
          id: `119ffe00-0003-7000-8000-${(index * 10_000_000 + t * 100 + f).toString(16).padStart(12, '0')}`,
          projectId,
          parentId: themeId,
          nodeType: 'Feature',
          title: `Feature ${t}.${f}`,
          position: BigInt(f + 1) * 4294967296n,
        }),
      );
    }
  }

  return {
    projectId,
    projectName: `Many ${index}`,
    projectRevision: index,
    nodes,
    phases: [],
    unlockEdges: [],
    dismissals: [],
  };
}

describe('Story 5.5 Workspace Overview at Scale (NFR-8/NFR-16)', () => {
  for (const projectCount of [1, 5, 10] as const) {
    it(`projects ${projectCount} project(s) at 5,000 nodes within budget`, () => {
      const inputs = Array.from({ length: projectCount }, (_, i) => makeProjectInput(i));

      const start = performance.now();
      const overview = projectWorkspaceOverview(inputs);
      const duration = performance.now() - start;

      // Aggregate-only: output is bounded by projectCount x themeCount, never node count.
      expect(overview.projects).toHaveLength(projectCount);

      // Cold-start budget headroom: projection over the full workspace must
      // be a small fraction of the 3s budget.
      expect(duration).toBeLessThan(500);
    });
  }

  it('groups a many-theme project (500 themes x 9 features) without superlinear cost', () => {
    const inputs = Array.from({ length: 1 }, (_, i) => makeManyThemeInput(i));
    const nodes = inputs[0].nodes;
    expect(nodes.length).toBeGreaterThan(5_000);

    // The per-theme Feature grouping must be linear in node count, not
    // O(themes x nodes). This guards only the Epic 24 grouping change; the
    // pre-existing theme rollup cost is measured separately below and is not
    // given a new pass threshold here (AC 24.4-4).
    const start = performance.now();
    const grouped = groupFeaturesByTheme(nodes, attributeNodesToNearestTheme(nodes));
    const duration = performance.now() - start;

    expect(grouped.size).toBe(500);
    let total = 0;
    for (const bucket of grouped.values()) total += bucket.length;
    expect(total).toBe(4_500);
    expect(duration).toBeLessThan(200);
  });

  it('projects a many-theme workspace with correct per-theme counts', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => makeManyThemeInput(i));

    const overview = projectWorkspaceOverview(inputs);

    expect(overview.projects).toHaveLength(10);
    for (const project of overview.projects) {
      expect(project.themes).toHaveLength(500);
      const featureTotal = project.themes.reduce((sum, t) => sum + t.featureCount, 0);
      expect(featureTotal).toBe(4_500);
    }
  });

  it('computes a many-theme rollup without O(themes x nodes) index rebuilds (Story 25.3 AC 25.3-5)', () => {
    const input = makeManyThemeInput(0);
    // Sanity: hundreds of themes.
    expect(input.nodes.filter((n) => n.nodeType === 'Theme').length).toBe(500);

    const start = performance.now();
    const rollup = computeThemeRollup(input.nodes);
    const duration = performance.now() - start;

    expect(rollup).toHaveLength(500);
    // Before the index was hoisted this was ~180 ms for this shape.
    expect(duration).toBeLessThan(60);
  });

  it('emits a limit warning when project count exceeds the supported ceiling', () => {
    const inputs = Array.from({ length: 11 }, (_, i) => makeProjectInput(i));
    const overview = projectWorkspaceOverview(inputs);

    expect(overview.limitWarning).not.toBeNull();
    expect(overview.limitWarning!.exceededProjectCount).toBe(true);
    expect(overview.limitWarning!.observedProjectCount).toBe(11);
  });
});

/**
 * Scale performance benchmarks for Gantt projection (Story 7.8, NFR-10, NFR-11).
 *
 * Validates projection calculation time and scalability under high node volumes:
 *   - 500 nodes
 *   - 2,000 nodes
 *   - 5,000 nodes
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { projectGantt } from '../../src/application/gantt/gantt.projection';
import { resolveGanttVisibleScope } from '../../src/application/gantt/gantt-scope';
import type { Node } from '../../src/domain/tree/node.entity';

function generateBenchmarkTree(count: number): Node[] {
  const nodes: Node[] = [];
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  // 10% Themes, 40% Features, 50% Tasks
  const themeCount = Math.max(1, Math.floor(count * 0.1));
  const featureCount = Math.floor(count * 0.4);
  const taskCount = count - themeCount - featureCount;

  // Create Themes
  const themeIds: string[] = [];
  for (let i = 0; i < themeCount; i++) {
    const id = `018f6c40-0001-${String(i).padStart(4, '0')}-000000000000`;
    themeIds.push(id);
    nodes.push({
      id,
      projectId,
      parentId: null,
      title: `Theme ${i + 1}`,
      bodyText: null,
      position: BigInt((i + 1) * 1000),
      nodeType: 'Theme',
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: null,
      completed: false,
      effortPoints: null,
      effortPointsDone: null,
      strategicWeight: 10,
      phaseId: null,
      deliveryStatus: 'not_started',
    });
  }

  // Create Features
  const featureIds: string[] = [];
  for (let i = 0; i < featureCount; i++) {
    const id = `018f6c40-0002-${String(i).padStart(4, '0')}-000000000000`;
    featureIds.push(id);
    const parentId = themeIds[i % themeIds.length];
    nodes.push({
      id,
      projectId,
      parentId,
      title: `Feature ${i + 1}`,
      bodyText: null,
      position: BigInt((i + 1) * 1000),
      nodeType: 'Feature',
      startDate: '2026-06-01',
      endDate: '2026-07-31',
      durationDays: 61,
      scheduleSourceMode: 'start_end',
      completed: false,
      effortPoints: 5,
      effortPointsDone: null,
      strategicWeight: null,
      phaseId: null,
      deliveryStatus: 'not_started',
    });
  }

  // Create Tasks
  for (let i = 0; i < taskCount; i++) {
    const id = `018f6c40-0003-${String(i).padStart(4, '0')}-000000000000`;
    const parentId = featureIds[i % featureIds.length];
    nodes.push({
      id,
      projectId,
      parentId,
      title: `Task ${i + 1}`,
      bodyText: null,
      position: BigInt((i + 1) * 1000),
      nodeType: 'AcceptanceCriterion',
      startDate: '2026-06-15',
      endDate: '2026-06-30',
      durationDays: 16,
      scheduleSourceMode: 'start_end',
      completed: false,
      effortPoints: 2,
      effortPointsDone: null,
      strategicWeight: null,
      phaseId: null,
      deliveryStatus: 'not_started',
    });
  }

  return nodes;
}

describe('Gantt Scale Benchmarks (Story 7.8)', () => {
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  beforeAll(() => {
    // JIT Warmup
    const warmupNodes = generateBenchmarkTree(100);
    projectGantt({ projectId, projectRevision: 1, nodes: warmupNodes });
  });

  it('projects 500 nodes within budget', () => {
    const nodes = generateBenchmarkTree(500);

    const start = performance.now();
    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes,
    });
    const elapsed = performance.now() - start;

    expect(projection.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(150);
  });

  it('projects 2,000 nodes within budget', () => {
    const nodes = generateBenchmarkTree(2000);

    const start = performance.now();
    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes,
    });
    const elapsed = performance.now() - start;

    expect(projection.rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('projects 5,000 nodes within budget', () => {
    const nodes = generateBenchmarkTree(5000);

    const start = performance.now();
    const projection = projectGantt({
      projectId,
      projectRevision: 1,
      nodes,
    });
    const scope = resolveGanttVisibleScope({
      projection,
      window: {
        dateWindowStart: '2026-01-01',
        dateWindowEnd: '2026-12-31',
        granularity: 'month',
      },
    });
    const elapsed = performance.now() - start;

    expect(projection.rows.length).toBeGreaterThan(0);
    expect(scope.visibleRows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

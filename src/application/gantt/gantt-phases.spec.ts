import { describe, it, expect } from 'vitest';
import { resolveGanttPhases } from './gantt-phases';
import type { Phase } from '../../domain/phase/phase.entity';
import type { Node } from '../../domain/tree/node.entity';

function createMockNode(overrides: Partial<Node> & { id: string; projectId: string; position: bigint }): Node {
  return {
    parentId: null,
    title: `Node ${overrides.id}`,
    bodyText: null,
    nodeType: null,
    startDate: null,
    endDate: null,
    durationDays: null,
    scheduleSourceMode: null,
    completed: false,
    effortPoints: null,
    effortPointsDone: null,
    strategicWeight: null,
    phaseId: null,
    deliveryStatus: 'not_started',
    ...overrides,
  };
}

describe('resolveGanttPhases (Story 7.4)', () => {
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  const phase1: Phase = {
    id: 'phase-1',
    projectId,
    name: 'Phase 1: Foundation',
    position: 1000n,
  };

  const phase2: Phase = {
    id: 'phase-2',
    projectId,
    name: 'Phase 2: Scale',
    position: 2000n,
  };

  const node1 = createMockNode({
    id: 'node-1',
    projectId,
    position: 1000n,
    phaseId: 'phase-1',
    startDate: '2026-01-10',
    endDate: '2026-02-15',
    durationDays: 37,
    scheduleSourceMode: 'start_end',
  });

  const node2 = createMockNode({
    id: 'node-2',
    projectId,
    position: 2000n,
    phaseId: 'phase-1',
    startDate: '2026-02-01',
    endDate: '2026-03-20',
    durationDays: 48,
    scheduleSourceMode: 'start_end',
  });

  const node3 = createMockNode({
    id: 'node-3',
    projectId,
    position: 3000n,
    phaseId: 'phase-2',
    startDate: '2026-05-01',
    endDate: '2026-06-30',
    durationDays: 61,
    scheduleSourceMode: 'start_end',
  });

  it('aggregates earliest start and latest end dates for assigned phase nodes', () => {
    const bands = resolveGanttPhases({
      phases: [phase1, phase2],
      nodes: [node1, node2, node3],
      dateToX: (date) => (date === '2026-01-10' ? 10 : date === '2026-03-20' ? 80 : 150),
      windowStart: '2026-01-01',
      windowEnd: '2026-12-31',
    });

    expect(bands.length).toBe(2);
    // Phase 1 spans Jan 10 to Mar 20
    expect(bands[0].phaseId).toBe('phase-1');
    expect(bands[0].startDate).toBe('2026-01-10');
    expect(bands[0].endDate).toBe('2026-03-20');

    // Phase 2 spans May 01 to Jun 30
    expect(bands[1].phaseId).toBe('phase-2');
    expect(bands[1].startDate).toBe('2026-05-01');
    expect(bands[1].endDate).toBe('2026-06-30');
  });

  it('filters out phases that do not intersect the active date window', () => {
    const bands = resolveGanttPhases({
      phases: [phase1, phase2],
      nodes: [node1, node2, node3],
      dateToX: () => 50,
      windowStart: '2026-01-01',
      windowEnd: '2026-03-31', // Phase 2 (May-Jun) is outside!
    });

    expect(bands.length).toBe(1);
    expect(bands[0].phaseId).toBe('phase-1');
  });
});

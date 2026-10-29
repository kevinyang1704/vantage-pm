import { describe, it, expect } from 'vitest';
import { detectOverrideBoundaryViolations } from './override-boundary.policy';
import type { Node } from '../tree/node.entity';

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

describe('detectOverrideBoundaryViolations (Story 7.6)', () => {
  const projectId = '018f6c40-1111-7000-8000-000000000001';

  const themeWithOverride = createMockNode({
    id: 'theme-1',
    projectId,
    position: 1000n,
    title: 'Q3 Mobile Launch',
    startDate: '2026-07-01',
    endDate: '2026-09-30',
    durationDays: 92,
    scheduleSourceMode: 'start_end',
  });

  it('emits finding when descendant starts before ancestor start date', () => {
    const childEarly = createMockNode({
      id: 'feature-early',
      projectId,
      parentId: themeWithOverride.id,
      position: 1000n,
      title: 'Early Prep Feature',
      startDate: '2026-06-15', // Starts in June, before July 1!
      endDate: '2026-07-15',
      durationDays: 31,
      scheduleSourceMode: 'start_end',
    });

    const findings = detectOverrideBoundaryViolations([themeWithOverride, childEarly]);

    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe('ExplicitOverrideBoundaryViolation');
    expect(findings[0].ancestorNodeId).toBe('theme-1');
    expect(findings[0].descendantNodeId).toBe('feature-early');
    expect(findings[0].violatedBoundary).toBe('before_start');
  });

  it('emits finding when descendant ends after ancestor end date', () => {
    const childLate = createMockNode({
      id: 'feature-late',
      projectId,
      parentId: themeWithOverride.id,
      position: 1000n,
      title: 'Late Finish Feature',
      startDate: '2026-09-01',
      endDate: '2026-10-15', // Ends in October, after Sept 30!
      durationDays: 45,
      scheduleSourceMode: 'start_end',
    });

    const findings = detectOverrideBoundaryViolations([themeWithOverride, childLate]);

    expect(findings.length).toBe(1);
    expect(findings[0].violatedBoundary).toBe('after_end');
  });

  it('emits finding when descendant violates both bounds', () => {
    const childWide = createMockNode({
      id: 'feature-wide',
      projectId,
      parentId: themeWithOverride.id,
      position: 1000n,
      title: 'Overly Wide Feature',
      startDate: '2026-06-01',
      endDate: '2026-10-31',
      durationDays: 153,
      scheduleSourceMode: 'start_end',
    });

    const findings = detectOverrideBoundaryViolations([themeWithOverride, childWide]);

    expect(findings.length).toBe(1);
    expect(findings[0].violatedBoundary).toBe('both');
  });

  it('emits zero findings when ancestor has only partial draft dates (AC3)', () => {
    const partialTheme = createMockNode({
      id: 'theme-partial',
      projectId,
      position: 1000n,
      title: 'Open Ended Theme',
      startDate: '2026-07-01',
      endDate: null, // No end date set
    });

    const childInOctober = createMockNode({
      id: 'child-oct',
      projectId,
      parentId: partialTheme.id,
      position: 1000n,
      title: 'October Feature',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      durationDays: 31,
      scheduleSourceMode: 'start_end',
    });

    const findings = detectOverrideBoundaryViolations([partialTheme, childInOctober]);

    expect(findings.length).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { projectDocument } from './document.projection';
import { createNode, type Node } from '../../domain/tree/node.entity';
import { createPhase, type Phase } from '../../domain/phase/phase.entity';
import type { ViewScope } from '../../contracts/view-scope';

const P = '019ffe00-0000-7000-8000-000000000001';
const ROOT = '019ffe00-0000-7000-8000-000000000010';
const THEME = '019ffe00-0000-7000-8000-000000000020';
const FEATURE = '019ffe00-0000-7000-8000-000000000030';
const AC1 = '019ffe00-0000-7000-8000-000000000040';
const AC2 = '019ffe00-0000-7000-8000-000000000041';
const UNTYPED = '019ffe00-0000-7000-8000-000000000050';
const PHASE1 = '019ffe00-0000-7000-8000-000000000060';

function scope(orderedNodeIds: readonly string[]): ViewScope {
  return {
    kind: 'OutlineVisible',
    projectId: P,
    projectRevision: 7,
    zoomRootId: null,
    orderedNodeIds,
    excluded: [],
  };
}

describe('projectDocument (Story 8.2)', () => {
  const root = createNode({ id: ROOT, projectId: P, position: 0n, title: 'Vision Root', nodeType: 'Vision', bodyText: 'Our vision body.' });
  const theme = createNode({ id: THEME, projectId: P, parentId: ROOT, position: 0n, title: 'Theme Alpha', nodeType: 'Theme', phaseId: PHASE1 });
  const feature = createNode({
    id: FEATURE,
    projectId: P,
    parentId: THEME,
    position: 0n,
    title: 'Feature One',
    nodeType: 'Feature',
    bodyText: 'Feature body text.',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    durationDays: 31,
    scheduleSourceMode: 'start_end',
    completed: true,
  });
  const ac1 = createNode({ id: AC1, projectId: P, parentId: FEATURE, position: 0n, title: 'Criteria A', nodeType: 'AcceptanceCriterion', completed: true });
  const ac2 = createNode({ id: AC2, projectId: P, parentId: FEATURE, position: 1n, title: 'Criteria B', nodeType: 'AcceptanceCriterion', completed: false });
  const untyped = createNode({ id: UNTYPED, projectId: P, parentId: THEME, position: 1n, title: 'Undeclared Node' });
  const phase = createPhase({ id: PHASE1, projectId: P, name: 'Phase 1: Foundation', position: 0n });

  const nodes = [root, theme, feature, ac1, ac2, untyped];
  const phases: Phase[] = [phase];
  const allIds = nodes.map((n) => n.id);

  it('projects scope membership in containment + persisted sibling order with ACs folded in', () => {
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });

    // Vision, Theme, Feature, Untyped — in pre-order. ACs folded, not sections.
    expect(doc.sections.map((s) => s.nodeId)).toEqual([ROOT, THEME, FEATURE, UNTYPED]);
    expect(doc.sections[0].headingLevel).toBe(1);
    expect(doc.sections[1].headingLevel).toBe(2);
    expect(doc.sections[2].headingLevel).toBe(3);
  });

  it('carries computed figures through from domain functions, never recomputed', () => {
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });

    const feat = doc.sections.find((s) => s.nodeId === FEATURE)!;
    expect(feat.startDate).toBe('2026-01-01');
    expect(feat.endDate).toBe('2026-01-31');
    expect(feat.durationDays).toBe(31);
    // Acceptance ratio text comes from calculateAcceptanceRatio (2 total, 1 met)
    expect(feat.acceptanceRatioText).toBe('1 / 2 met');
    expect(feat.acceptanceCriteria.map((c) => c.nodeId)).toEqual([AC1, AC2]);
    expect(feat.acceptanceCriteria[0].completed).toBe(true);
    expect(feat.acceptanceCriteria[1].completed).toBe(false);

    // Phase inherited from Theme ancestor
    const themeNode = doc.sections.find((s) => s.nodeId === THEME)!;
    expect(themeNode.effectivePhaseName).toBe('Phase 1: Foundation');
    expect(themeNode.effectivePhaseSource).toBe('explicit');
    const featPhase = doc.sections.find((s) => s.nodeId === FEATURE)!;
    expect(featPhase.effectivePhaseName).toBe('Phase 1: Foundation');
    expect(featPhase.effectivePhaseSource).toBe('inherited');
  });

  it('renders untyped nodes with the NO TYPE tag verbatim', () => {
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    const un = doc.sections.find((s) => s.nodeId === UNTYPED)!;
    expect(un.typeTag).toBe('NO TYPE');
    expect(un.nodeType).toBeNull();
  });

  it('keeps body text verbatim and emits no placeholder for null body', () => {
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    const rootSection = doc.sections.find((s) => s.nodeId === ROOT)!;
    expect(rootSection.bodyText).toBe('Our vision body.');
    const themeSection = doc.sections.find((s) => s.nodeId === THEME)!;
    expect(themeSection.bodyText).toBeNull();
  });

  it('caps heading level at 6 for very deep nodes', () => {
    let parent = root;
    const deep: Node[] = [];
    for (let i = 0; i < 8; i++) {
      const n = createNode({
        id: `019ffe00-0000-7000-8000-${String(100 + i).padStart(12, '0')}`,
        projectId: P,
        parentId: parent.id,
        position: 0n,
        title: `Deep ${i}`,
      });
      deep.push(n);
      parent = n;
    }
    const all = [...nodes, ...deep];
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes: all,
      phases,
      scope: scope(all.map((n) => n.id)),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    for (const s of doc.sections) {
      expect(s.headingLevel).toBeLessThanOrEqual(6);
    }
    // The deepest node has depth 9 -> headingLevel capped at 6
    const last = doc.sections[doc.sections.length - 1];
    expect(last.depth).toBeGreaterThan(6);
    expect(last.headingLevel).toBe(6);
  });

  it('is strictly deterministic across shuffled input order', () => {
    const runA = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    const shuffled = [untyped, ac2, feature, root, ac1, theme];
    const runB = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes: shuffled,
      phases,
      scope: scope(allIds),
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    expect(JSON.stringify(runA)).toBe(JSON.stringify(runB));
  });

  it('excludes out-of-scope nodes and reports exclusions verbatim from the scope', () => {
    // Gantt-shaped scope: feature excluded (undated) but present in scope? No —
    // here undatedCount reported by scope is 1 and the node is simply absent.
    const ganttScope: ViewScope = {
      kind: 'GanttVisible',
      projectId: P,
      projectRevision: 7,
      window: { dateWindowStart: '2026-01-01', dateWindowEnd: '2026-01-31', granularity: 'month' },
      orderedNodeIds: [ROOT, THEME, FEATURE],
      undatedCount: 1,
      outOfWindowCount: 2,
      collapsedCount: 0,
    };
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: ganttScope,
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    // Untyped node is out of scope (absent from orderedNodeIds)
    expect(doc.sections.some((s) => s.nodeId === UNTYPED)).toBe(false);
    expect(doc.sections.some((s) => s.nodeId === ROOT)).toBe(true);
    expect(doc.exclusions.undatedCount).toBe(1);
    expect(doc.exclusions.outOfWindowCount).toBe(2);
    expect(doc.exclusions.totalProjectNodes).toBe(nodes.length);
  });

  it('treats an in-scope node whose parent is out-of-scope as a root (never silently dropped)', () => {
    // Only the Theme is in scope; its parent (Vision root) is not.
    const themedScope: ViewScope = {
      kind: 'OutlineVisible',
      projectId: P,
      projectRevision: 7,
      zoomRootId: THEME,
      orderedNodeIds: [THEME, FEATURE, UNTYPED],
      excluded: [],
    };
    const doc = projectDocument({
      projectId: P,
      projectRevision: 7,
      projectName: 'Sample',
      nodes,
      phases,
      scope: themedScope,
      generatedAt: '2026-08-16T00:00:00Z',
      locale: 'en-US',
    });
    expect(doc.sections.map((s) => s.nodeId)).toEqual([THEME, FEATURE, UNTYPED]);
    // The orphaned Theme is still emitted as a section (never silently dropped),
    // and its children appear under it regardless of the out-of-scope grandparent.
    expect(doc.sections[0].depth).toBe(0);
    expect(doc.sections[1].parentId).toBe(THEME);
  });
});

import { describe, it, expect } from 'vitest';
import { listThemesInOrdinalOrder, resolveFocusedThemeId } from './theme-focus-resolution.policy';
import type { Node } from '../tree/node.entity';

function createMockNode(partial: Partial<Node> & { id: string }): Node {
  return {
    id: partial.id,
    projectId: partial.projectId ?? 'proj-1',
    parentId: partial.parentId ?? null,
    position: partial.position ?? 1000n,
    title: partial.title ?? 'Test Node',
    bodyText: partial.bodyText ?? null,
    nodeType: partial.nodeType ?? null,
    startDate: partial.startDate ?? null,
    endDate: partial.endDate ?? null,
    durationDays: partial.durationDays ?? null,
    scheduleSourceMode: partial.scheduleSourceMode ?? null,
    completed: partial.completed ?? false,
    effortPoints: partial.effortPoints ?? null,
    effortPointsDone: null,
    strategicWeight: partial.strategicWeight ?? null,
    phaseId: partial.phaseId ?? null,
    deliveryStatus: partial.deliveryStatus ?? 'not_started',
  };
}

describe('theme-focus-resolution.policy', () => {
  it('lists themes sorted by position then UUID', () => {
    const t1 = createMockNode({ id: 'theme-b', nodeType: 'Theme', position: 2000n });
    const t2 = createMockNode({ id: 'theme-a', nodeType: 'Theme', position: 1000n });
    const t3 = createMockNode({ id: 'theme-c', nodeType: 'Theme', position: 2000n });
    const nonTheme = createMockNode({ id: 'feature-1', nodeType: 'Feature', position: 500n });

    const ordered = listThemesInOrdinalOrder([t1, nonTheme, t2, t3]);
    expect(ordered.map((t) => t.id)).toEqual(['theme-a', 'theme-b', 'theme-c']);
  });

  it('resolves focused theme prioritizing nearest theme ancestor of current node', () => {
    const themeA = createMockNode({ id: 't-a', nodeType: 'Theme', position: 1000n });
    const themeB = createMockNode({ id: 't-b', nodeType: 'Theme', position: 2000n });
    const childOfA = createMockNode({ id: 'c-a', parentId: 't-a', nodeType: 'Feature', position: 1000n });

    const focused = resolveFocusedThemeId({
      nodes: [themeA, themeB, childOfA],
      currentFocusedNodeId: 'c-a',
      persistedFocusedThemeId: 't-b',
    });

    expect(focused).toBe('t-a');
  });

  it('falls back to persisted focused theme if current node has no theme ancestor', () => {
    const themeA = createMockNode({ id: 't-a', nodeType: 'Theme', position: 1000n });
    const themeB = createMockNode({ id: 't-b', nodeType: 'Theme', position: 2000n });
    const orphan = createMockNode({ id: 'orphan-1', parentId: null, nodeType: 'Feature', position: 500n });

    const focused = resolveFocusedThemeId({
      nodes: [themeA, themeB, orphan],
      currentFocusedNodeId: 'orphan-1',
      persistedFocusedThemeId: 't-b',
    });

    expect(focused).toBe('t-b');
  });

  it('falls back to first ordinal theme when no current node or persisted theme', () => {
    const themeA = createMockNode({ id: 't-a', nodeType: 'Theme', position: 2000n });
    const themeB = createMockNode({ id: 't-b', nodeType: 'Theme', position: 1000n });

    const focused = resolveFocusedThemeId({
      nodes: [themeA, themeB],
      currentFocusedNodeId: null,
      persistedFocusedThemeId: null,
    });

    expect(focused).toBe('t-b');
  });

  it('returns null if project has zero themes', () => {
    const feature1 = createMockNode({ id: 'f-1', nodeType: 'Feature', position: 1000n });
    const focused = resolveFocusedThemeId({
      nodes: [feature1],
      currentFocusedNodeId: 'f-1',
      persistedFocusedThemeId: null,
    });

    expect(focused).toBeNull();
  });
});

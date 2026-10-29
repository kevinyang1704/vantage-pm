/**
 * Theme focus resolution policy (Story 6.4 Task 1).
 *
 * Deterministic theme focus priority chain:
 * 1. Nearest Theme ancestor of the currently focused node (via attributeNodeToNearestTheme).
 * 2. Persisted focusedThemeId from view state if that Theme exists in the project.
 * 3. First Theme in ordinal order (persisted position, tie-broken by id).
 * 4. null if no themes exist in the project.
 *
 * Pure: no React, no I/O.
 */

import type { Node } from '../tree/node.entity';
import { attributeNodeToNearestTheme } from '../analysis/theme-attribution.policy';

export function listThemesInOrdinalOrder(nodes: readonly Node[]): readonly Node[] {
  return nodes
    .filter((n) => n.nodeType === 'Theme')
    .slice()
    .sort((a, b) => {
      if (a.position < b.position) return -1;
      if (a.position > b.position) return 1;
      return a.id.localeCompare(b.id);
    });
}

export function resolveFocusedThemeId(params: {
  nodes: readonly Node[];
  currentFocusedNodeId?: string | null;
  persistedFocusedThemeId?: string | null;
}): string | null {
  const { nodes, currentFocusedNodeId, persistedFocusedThemeId } = params;

  // 1. Current focused node's nearest Theme ancestor
  if (currentFocusedNodeId) {
    const nearestThemeId = attributeNodeToNearestTheme(nodes, currentFocusedNodeId);
    if (nearestThemeId && nodes.some((n) => n.id === nearestThemeId && n.nodeType === 'Theme')) {
      return nearestThemeId;
    }
  }

  // 2. Persisted focusedThemeId
  if (persistedFocusedThemeId) {
    const persistedTheme = nodes.find((n) => n.id === persistedFocusedThemeId && n.nodeType === 'Theme');
    if (persistedTheme) {
      return persistedTheme.id;
    }
  }

  // 3. First Theme in ordinal order
  const ordinalThemes = listThemesInOrdinalOrder(nodes);
  if (ordinalThemes.length > 0) {
    return ordinalThemes[0].id;
  }

  // 4. No themes
  return null;
}

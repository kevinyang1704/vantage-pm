/**
 * Deterministic action ranking policy (Story 2.7 Task 6, SYS-015).
 *
 * Ranks action declarations given a normalized query.
 * Pure and framework-free.
 */

import type { ActionDeclaration } from '../../application/actions/action';

export interface RankedAction {
  readonly action: ActionDeclaration;
  readonly score: number;
}

export function rankActions(
  actions: readonly ActionDeclaration[],
  query: string,
): readonly RankedAction[] {
  const normalizedQuery = query.trim().toLowerCase();

  const scored = actions
    .filter((a) => a.paletteVisibility === 'listed')
    .map((action) => {
      const label = action.label.toLowerCase();
      let score = 0;

      if (!normalizedQuery) {
        score = 1; // All show on empty query
      } else if (label === normalizedQuery) {
        score = 1000;
      } else if (label.startsWith(normalizedQuery)) {
        score = 500;
      } else if (label.includes(` ${normalizedQuery}`) || label.includes(normalizedQuery)) {
        score = 250;
      } else {
        // Keyword match
        for (const kw of action.keywords) {
          const lkw = kw.toLowerCase();
          if (lkw === normalizedQuery) {
            score = Math.max(score, 400);
          } else if (lkw.startsWith(normalizedQuery)) {
            score = Math.max(score, 200);
          } else if (lkw.includes(normalizedQuery)) {
            score = Math.max(score, 100);
          }
        }
      }

      return { action, score };
    })
    .filter((item) => item.score > 0);

  // Deterministic total ordering: score DESC, label ASC, id ASC
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const labelCompare = a.action.label.localeCompare(b.action.label);
    if (labelCompare !== 0) return labelCompare;
    return a.action.id.localeCompare(b.action.id);
  });

  return Object.freeze(scored);
}

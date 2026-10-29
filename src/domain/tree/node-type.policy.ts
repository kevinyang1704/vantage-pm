/**
 * Node type policy (Story 3.1, AD-16).
 *
 * Defines canonical node types, type display formatting, and fuzzy matching
 * for inline type assignment.
 */

import type { NodeType } from './node.entity';

export const CANONICAL_NODE_TYPES: readonly NodeType[] = Object.freeze([
  'Vision',
  'Theme',
  'Component',
  'Feature',
]);

export const ALL_KNOWN_NODE_TYPES: readonly NodeType[] = Object.freeze([
  'Vision',
  'Theme',
  'Component',
  'Feature',
  'AcceptanceCriterion',
]);

export const NODE_TYPE_OPTIONS = CANONICAL_NODE_TYPES;

export function matchNodeTypeFuzzy(query: string, type: NodeType): boolean {
  const matches = matchNodeTypes(query);
  return matches.some((m) => m.type === type);
}

export function isValidNodeType(type: unknown): type is NodeType {
  return typeof type === 'string' && ALL_KNOWN_NODE_TYPES.includes(type as NodeType);
}

export function formatNodeTypeTag(type: NodeType | null): string {
  if (!type) return 'NO TYPE';
  switch (type) {
    case 'Vision':
      return 'VISION';
    case 'Theme':
      return 'THEME';
    case 'Component':
      return 'COMPONENT';
    case 'Feature':
      return 'FEATURE';
    case 'AcceptanceCriterion':
      return 'AC';
  }
}

export interface NodeTypeMatchResult {
  readonly type: NodeType;
  readonly label: string;
  readonly score: number;
}

/**
 * Fuzzy matches an input string against canonical node types.
 * Returns matches sorted by descending score.
 */
export function matchNodeTypes(input: string): readonly NodeTypeMatchResult[] {
  const query = input.trim().toLowerCase();
  if (!query) {
    return Object.freeze(
      CANONICAL_NODE_TYPES.map((type) =>
        Object.freeze({
          type,
          label: formatNodeTypeLabel(type),
          score: 1,
        }),
      ),
    );
  }

  const results: NodeTypeMatchResult[] = [];

  for (const type of CANONICAL_NODE_TYPES) {
    const label = formatNodeTypeLabel(type);
    const lower = label.toLowerCase();
    const typeLower = type.toLowerCase();

    let score = 0;
    if (lower === query || typeLower === query) {
      score = 100;
    } else if (lower.startsWith(query) || typeLower.startsWith(query)) {
      score = 80;
    } else if (type === 'AcceptanceCriterion' && (query === 'ac' || query === 'crit' || query === 'criterion')) {
      score = 90;
    } else if (lower.includes(query) || typeLower.includes(query)) {
      score = 50;
    } else {
      // Subsequence match
      let qi = 0;
      for (let i = 0; i < lower.length && qi < query.length; i++) {
        if (lower[i] === query[qi]) {
          qi++;
        }
      }
      if (qi === query.length) {
        score = 20;
      }
    }

    if (score > 0) {
      results.push(Object.freeze({ type, label, score }));
    }
  }

  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return Object.freeze(results);
}

export function formatNodeTypeLabel(type: NodeType): string {
  switch (type) {
    case 'Vision':
      return 'Vision';
    case 'Theme':
      return 'Theme';
    case 'Component':
      return 'Component';
    case 'Feature':
      return 'Feature';
    case 'AcceptanceCriterion':
      return 'Acceptance Criterion';
  }
}

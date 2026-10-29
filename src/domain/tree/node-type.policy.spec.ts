import { describe, it, expect } from 'vitest';
import {
  CANONICAL_NODE_TYPES,
  isValidNodeType,
  formatNodeTypeTag,
  formatNodeTypeLabel,
  matchNodeTypes,
} from './node-type.policy';

describe('node-type.policy', () => {
  it('validates canonical node types correctly', () => {
    expect(CANONICAL_NODE_TYPES).toEqual(['Vision', 'Theme', 'Component', 'Feature']);
    expect(isValidNodeType('Vision')).toBe(true);
    expect(isValidNodeType('Theme')).toBe(true);
    expect(isValidNodeType('Component')).toBe(true);
    expect(isValidNodeType('Feature')).toBe(true);
    expect(isValidNodeType('AcceptanceCriterion')).toBe(true);
    expect(isValidNodeType('InvalidType')).toBe(false);
    expect(isValidNodeType(null)).toBe(false);
    expect(isValidNodeType(123)).toBe(false);
  });

  it('formats node type tags and labels', () => {
    expect(formatNodeTypeTag(null)).toBe('NO TYPE');
    expect(formatNodeTypeTag('Vision')).toBe('VISION');
    expect(formatNodeTypeTag('Theme')).toBe('THEME');
    expect(formatNodeTypeTag('Component')).toBe('COMPONENT');
    expect(formatNodeTypeTag('Feature')).toBe('FEATURE');
    expect(formatNodeTypeTag('AcceptanceCriterion')).toBe('AC');

    expect(formatNodeTypeLabel('Vision')).toBe('Vision');
    expect(formatNodeTypeLabel('Theme')).toBe('Theme');
    expect(formatNodeTypeLabel('Component')).toBe('Component');
    expect(formatNodeTypeLabel('Feature')).toBe('Feature');
    expect(formatNodeTypeLabel('AcceptanceCriterion')).toBe('Acceptance Criterion');
  });

  it('fuzzy matches node types with queries', () => {
    const emptyMatches = matchNodeTypes('');
    expect(emptyMatches).toHaveLength(4);

    const featMatches = matchNodeTypes('feat');
    expect(featMatches[0].type).toBe('Feature');

    const compMatches = matchNodeTypes('comp');
    expect(compMatches[0].type).toBe('Component');

    const visMatches = matchNodeTypes('vis');
    expect(visMatches[0].type).toBe('Vision');

    const themeMatches = matchNodeTypes('th');
    expect(themeMatches[0].type).toBe('Theme');

    const noMatches = matchNodeTypes('xyz123');
    expect(noMatches).toHaveLength(0);
  });
});

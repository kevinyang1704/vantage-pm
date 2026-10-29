import { describe, it, expect } from 'vitest';
import type { NodeType } from './node.entity';
import {
  nodeTypeRank,
  canParentNodeType,
  formatHierarchyInversionReason,
  validateTypedNeighborhood,
  HIERARCHY_RANKS,
} from './node-hierarchy.policy';

describe('node-hierarchy policy', () => {
  describe('nodeTypeRank', () => {
    it('maps canonical types to strict order 0 -> 1 -> 2 -> 3 -> 4', () => {
      expect(nodeTypeRank('Vision')).toBe(0);
      expect(nodeTypeRank('Theme')).toBe(1);
      expect(nodeTypeRank('Component')).toBe(2);
      expect(nodeTypeRank('Feature')).toBe(3);
      expect(nodeTypeRank('AcceptanceCriterion')).toBe(4);
    });
  });

  describe('canParentNodeType matrix', () => {
    const validPairs: [NodeType, NodeType][] = [
      // Equal rank
      ['Vision', 'Vision'],
      ['Theme', 'Theme'],
      ['Component', 'Component'],
      ['Feature', 'Feature'],
      ['AcceptanceCriterion', 'AcceptanceCriterion'],
      // Downward edges
      ['Vision', 'Theme'],
      ['Vision', 'Component'],
      ['Vision', 'Feature'],
      ['Vision', 'AcceptanceCriterion'],
      ['Theme', 'Component'],
      ['Theme', 'Feature'],
      ['Theme', 'AcceptanceCriterion'],
      ['Component', 'Feature'],
      ['Component', 'AcceptanceCriterion'],
      ['Feature', 'AcceptanceCriterion'],
    ];

    it.each(validPairs)('allows valid typed edge: %s -> %s', (parent, child) => {
      expect(canParentNodeType(parent, child)).toBe(true);
    });

    const invalidPairs: [NodeType, NodeType][] = [
      ['Theme', 'Vision'],
      ['Component', 'Vision'],
      ['Component', 'Theme'],
      ['Feature', 'Vision'],
      ['Feature', 'Theme'],
      ['Feature', 'Component'],
      ['AcceptanceCriterion', 'Vision'],
      ['AcceptanceCriterion', 'Theme'],
      ['AcceptanceCriterion', 'Component'],
      ['AcceptanceCriterion', 'Feature'],
    ];

    it.each(invalidPairs)('rejects inverted typed edge: %s -> %s', (parent, child) => {
      expect(canParentNodeType(parent, child)).toBe(false);
    });

    it('is permissive when parent is untyped (null)', () => {
      const allTypes: NodeType[] = ['Vision', 'Theme', 'Component', 'Feature', 'AcceptanceCriterion'];
      for (const child of allTypes) {
        expect(canParentNodeType(null, child)).toBe(true);
      }
    });

    it('is permissive when child is untyped (null)', () => {
      const allTypes: NodeType[] = ['Vision', 'Theme', 'Component', 'Feature', 'AcceptanceCriterion'];
      for (const parent of allTypes) {
        expect(canParentNodeType(parent, null)).toBe(true);
      }
    });

    it('is permissive when both parent and child are untyped (null)', () => {
      expect(canParentNodeType(null, null)).toBe(true);
    });
  });

  describe('formatHierarchyInversionReason', () => {
    it('produces human-readable explanation', () => {
      expect(formatHierarchyInversionReason('Feature', 'Vision')).toBe(
        'A Feature cannot contain a Vision.',
      );
      expect(formatHierarchyInversionReason('Theme', 'Vision')).toBe(
        'A Theme cannot contain a Vision.',
      );
      expect(formatHierarchyInversionReason('AcceptanceCriterion', 'Feature')).toBe(
        'A Acceptance Criterion cannot contain a Feature.',
      );
    });
  });

  describe('validateTypedNeighborhood', () => {
    it('accepts setting type to null (untyped)', () => {
      const result = validateTypedNeighborhood({
        parentType: 'Feature',
        proposedType: null,
        childTypes: ['Vision', 'Theme'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid proposed type matching parent and children', () => {
      const result = validateTypedNeighborhood({
        parentType: 'Vision',
        proposedType: 'Theme',
        childTypes: ['Feature', 'AcceptanceCriterion', null],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects proposed type when it inverts parent relationship', () => {
      const result = validateTypedNeighborhood({
        parentType: 'Feature',
        proposedType: 'Vision',
        childTypes: ['AcceptanceCriterion'],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('A Feature cannot contain a Vision.');
    });

    it('rejects proposed type when it inverts child relationship', () => {
      const result = validateTypedNeighborhood({
        parentType: 'Vision',
        proposedType: 'Feature',
        childTypes: ['Theme'],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('A Feature cannot contain a Theme.');
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveField,
  type FieldInheritanceValue,
  type MinimalTreeNode,
} from './field-inheritance.policy';

describe('field-inheritance.policy', () => {
  const nodes: MinimalTreeNode[] = [
    { id: '1', parentId: null, title: 'Vision' },
    { id: '2', parentId: '1', title: 'Theme A' },
    { id: '3', parentId: '2', title: 'Feature 1' },
    { id: '4', parentId: '3', title: 'Task 1' },
    { id: '5', parentId: '1', title: 'Theme B' },
  ];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  it('resolves explicit value on the node itself', () => {
    const values: Record<string, FieldInheritanceValue<string>> = {
      '3': { kind: 'explicit', value: 'Phase 1' },
    };
    const res = resolveEffectiveField(nodeMap, '3', (id) => values[id] ?? { kind: 'inherit' });
    expect(res.effectiveValue).toBe('Phase 1');
    expect(res.source).toBe('explicit');
    expect(res.sourceNodeId).toBe('3');
  });

  it('inherits value from direct ancestor', () => {
    const values: Record<string, FieldInheritanceValue<string>> = {
      '2': { kind: 'explicit', value: 'Phase 1' },
    };
    const res = resolveEffectiveField(nodeMap, '3', (id) => values[id] ?? { kind: 'inherit' });
    expect(res.effectiveValue).toBe('Phase 1');
    expect(res.source).toBe('inherited');
    expect(res.sourceNodeId).toBe('2');
    expect(res.sourceNodeTitle).toBe('Theme A');
  });

  it('inherits value from multi-level ancestor', () => {
    const values: Record<string, FieldInheritanceValue<string>> = {
      '1': { kind: 'explicit', value: 'Phase Alpha' },
    };
    const res = resolveEffectiveField(nodeMap, '4', (id) => values[id] ?? { kind: 'inherit' });
    expect(res.effectiveValue).toBe('Phase Alpha');
    expect(res.source).toBe('inherited');
    expect(res.sourceNodeId).toBe('1');
  });

  it('stops at nearest ancestor override', () => {
    const values: Record<string, FieldInheritanceValue<string>> = {
      '1': { kind: 'explicit', value: 'Phase Global' },
      '2': { kind: 'explicit', value: 'Phase Local' },
    };
    const res = resolveEffectiveField(nodeMap, '4', (id) => values[id] ?? { kind: 'inherit' });
    expect(res.effectiveValue).toBe('Phase Local');
    expect(res.source).toBe('inherited');
    expect(res.sourceNodeId).toBe('2');
  });

  it('respects explicit none and stops inheritance', () => {
    const values: Record<string, FieldInheritanceValue<string>> = {
      '1': { kind: 'explicit', value: 'Phase Global' },
      '2': { kind: 'none' },
    };
    const res = resolveEffectiveField(nodeMap, '4', (id) => values[id] ?? { kind: 'inherit' });
    expect(res.effectiveValue).toBe(null);
    expect(res.source).toBe('none');
  });

  it('returns none if no ancestor has a value', () => {
    const res = resolveEffectiveField(nodeMap, '5', () => ({ kind: 'inherit' }));
    expect(res.effectiveValue).toBe(null);
    expect(res.source).toBe('none');
    expect(res.sourceNodeId).toBe(null);
  });
});

import { describe, it, expect } from 'vitest';
import { rankActions } from './action-ranking.policy';
import type { ActionDeclaration } from '../../application/actions/action';

describe('Action ranking policy (Story 2.7)', () => {
  const actions: ActionDeclaration[] = [
    {
      id: 'node.duplicate-subtree',
      label: 'Duplicate Subtree',
      keywords: ['copy', 'clone', 'branch'],
      requirement: ['FR-13'],
      scope: 'subtree',
      binding: { key: 'd', ctrlOrMeta: true },
      paletteVisibility: 'listed',
      focusPolicy: 'ReturnToInvoker',
      isAvailable: () => ({ kind: 'Available' }),
      run: () => {},
    },
    {
      id: 'node.delete-subtree',
      label: 'Delete Subtree',
      keywords: ['remove', 'trash'],
      requirement: ['FR-13'],
      scope: 'subtree',
      binding: { key: 'Backspace', ctrlOrMeta: true, shift: true },
      paletteVisibility: 'listed',
      focusPolicy: 'ReturnToInvoker',
      isAvailable: () => ({ kind: 'Available' }),
      run: () => {},
    },
    {
      id: 'search.jump-to-node',
      label: 'Jump to Node',
      keywords: ['find', 'search', 'goto'],
      requirement: ['FR-12'],
      scope: 'workspace',
      binding: { key: '/', ctrlOrMeta: true },
      paletteVisibility: 'listed',
      focusPolicy: 'ReturnToInvoker',
      isAvailable: () => ({ kind: 'Available' }),
      run: () => {},
    },
  ];

  it('ranks exact match at the top', () => {
    const results = rankActions(actions, 'Duplicate Subtree');
    expect(results[0].action.id).toBe('node.duplicate-subtree');
    expect(results[0].score).toBe(1000);
  });

  it('ranks prefix matches before substring/keyword matches', () => {
    const results = rankActions(actions, 'Dup');
    expect(results[0].action.id).toBe('node.duplicate-subtree');
    expect(results[0].score).toBe(500);
  });

  it('matches on keywords', () => {
    const results = rankActions(actions, 'clone');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].action.id).toBe('node.duplicate-subtree');
  });

  it('provides deterministic sorting for tie-breaks', () => {
    const results1 = rankActions(actions, '');
    const results2 = rankActions(actions, '');
    expect(results1.map((r) => r.action.id)).toEqual(results2.map((r) => r.action.id));
  });
});

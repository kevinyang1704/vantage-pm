import { describe, it, expect } from 'vitest';
import {
  resolveStructuralMove,
  isMoveAcyclic,
  isMoveWithinProject,
} from './move-node.policy';
import { createNode, type Node } from './node.entity';

const PROJ_ID = '019ffe00-0000-7000-8000-000000000001';
const OTHER_PROJ_ID = '019ffe00-0000-7000-8000-000000000002';

const NODE_1 = '019ffe00-0001-7000-8000-000000000001';
const NODE_2 = '019ffe00-0001-7000-8000-000000000002';
const NODE_3 = '019ffe00-0001-7000-8000-000000000003';
const NODE_4 = '019ffe00-0001-7000-8000-000000000004';

describe('move-node policy', () => {
  const nodes: Node[] = [
    createNode({
      id: NODE_1,
      projectId: PROJ_ID,
      parentId: null,
      title: 'Vision',
      position: 1000n,
    }),
    createNode({
      id: NODE_2,
      projectId: PROJ_ID,
      parentId: null,
      title: 'Theme 1',
      position: 2000n,
    }),
    createNode({
      id: NODE_3,
      projectId: PROJ_ID,
      parentId: NODE_2,
      title: 'Feature 1',
      position: 1000n,
    }),
    createNode({
      id: NODE_4,
      projectId: PROJ_ID,
      parentId: NODE_2,
      title: 'Feature 2',
      position: 2000n,
    }),
  ];

  describe('Indent (Tab)', () => {
    it('constrains first root node (no preceding sibling)', () => {
      const res = resolveStructuralMove(nodes, NODE_1, 'Indent');
      expect(res.kind).toBe('Constrained');
      if (res.kind === 'Constrained') {
        expect(res.constraint).toBe('NoPrecedingSiblingToNestUnder');
      }
    });

    it('indents second root under first root as last child', () => {
      const res = resolveStructuralMove(nodes, NODE_2, 'Indent');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBe(NODE_1);
        expect(res.newPosition).toBe(4294967296n);
      }
    });

    it('indents feature 2 under feature 1', () => {
      const res = resolveStructuralMove(nodes, NODE_4, 'Indent');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBe(NODE_3);
      }
    });

    it('rejects indenting Vision under Feature (hierarchy conflict)', () => {
      const typedNodes: Node[] = [
        createNode({
          id: NODE_1,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Feature 1',
          nodeType: 'Feature',
          position: 1000n,
        }),
        createNode({
          id: NODE_2,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Vision 1',
          nodeType: 'Vision',
          position: 2000n,
        }),
      ];
      const res = resolveStructuralMove(typedNodes, NODE_2, 'Indent');
      expect(res.kind).toBe('Constrained');
      if (res.kind === 'Constrained') {
        expect(res.constraint).toBe('HierarchyConflict');
      }
    });

    it('allows indenting Vision under Vision (equal rank)', () => {
      const typedNodes: Node[] = [
        createNode({
          id: NODE_1,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Vision 1',
          nodeType: 'Vision',
          position: 1000n,
        }),
        createNode({
          id: NODE_2,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Vision 2',
          nodeType: 'Vision',
          position: 2000n,
        }),
      ];
      const res = resolveStructuralMove(typedNodes, NODE_2, 'Indent');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBe(NODE_1);
      }
    });

    it('allows indenting Theme under Theme (equal rank)', () => {
      const typedNodes: Node[] = [
        createNode({
          id: NODE_1,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Theme 1',
          nodeType: 'Theme',
          position: 1000n,
        }),
        createNode({
          id: NODE_2,
          projectId: PROJ_ID,
          parentId: null,
          title: 'Theme 2',
          nodeType: 'Theme',
          position: 2000n,
        }),
      ];
      const res = resolveStructuralMove(typedNodes, NODE_2, 'Indent');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBe(NODE_1);
      }
    });
  });

  describe('Outdent (Shift+Tab)', () => {
    it('constrains root node already at top level', () => {
      const res = resolveStructuralMove(nodes, NODE_1, 'Outdent');
      expect(res.kind).toBe('Constrained');
      if (res.kind === 'Constrained') {
        expect(res.constraint).toBe('AlreadyAtTopLevel');
      }
    });

    it('outdents child node to become sibling after its parent', () => {
      const res = resolveStructuralMove(nodes, NODE_3, 'Outdent');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBeNull();
        expect(res.newPosition > 2000n).toBe(true);
      }
    });
  });

  describe('MoveUp / MoveDown (Alt+Shift+Up/Down)', () => {
    it('constrains first sibling from moving up', () => {
      const res = resolveStructuralMove(nodes, NODE_1, 'MoveUp');
      expect(res.kind).toBe('Constrained');
      if (res.kind === 'Constrained') {
        expect(res.constraint).toBe('AlreadyFirstAmongSiblings');
      }
    });

    it('moves second sibling up before first sibling', () => {
      const res = resolveStructuralMove(nodes, NODE_2, 'MoveUp');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBeNull();
        expect(res.newPosition < 1000n).toBe(true);
      }
    });

    it('constrains last sibling from moving down', () => {
      const res = resolveStructuralMove(nodes, NODE_4, 'MoveDown');
      expect(res.kind).toBe('Constrained');
      if (res.kind === 'Constrained') {
        expect(res.constraint).toBe('AlreadyLastAmongSiblings');
      }
    });

    it('moves sibling down', () => {
      const res = resolveStructuralMove(nodes, NODE_3, 'MoveDown');
      expect(res.kind).toBe('Move');
      if (res.kind === 'Move') {
        expect(res.newParentId).toBe(NODE_2);
        expect(res.newPosition > 2000n).toBe(true);
      }
    });
  });

  describe('Acyclicity and project scoping checks', () => {
    it('allows moving to null or unrelated parent', () => {
      expect(isMoveAcyclic(nodes, NODE_2, null)).toBe(true);
      expect(isMoveAcyclic(nodes, NODE_3, NODE_1)).toBe(true);
    });

    it('rejects moving node under itself or its descendant', () => {
      expect(isMoveAcyclic(nodes, NODE_2, NODE_2)).toBe(false);
      expect(isMoveAcyclic(nodes, NODE_2, NODE_3)).toBe(false);
      expect(isMoveAcyclic(nodes, NODE_2, NODE_4)).toBe(false);
    });

    it('validates project scoping', () => {
      expect(isMoveWithinProject(nodes, NODE_3, NODE_1)).toBe(true);
      const foreignNode = createNode({
        id: '019ffe00-0009-7000-8000-000000000001',
        projectId: OTHER_PROJ_ID,
        parentId: null,
        position: 100n,
      });
      expect(isMoveWithinProject([...nodes, foreignNode], NODE_3, foreignNode.id)).toBe(false);
    });
  });
});

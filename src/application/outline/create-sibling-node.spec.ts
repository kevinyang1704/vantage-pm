import { describe, expect, it } from 'vitest';
import { computeSiblingInsertion } from './create-sibling-node';

const P = '019ffe00-0000-7000-8000-000000000001';
const R1 = '019ffe00-0000-7000-8000-000000000010';
const R2 = '019ffe00-0000-7000-8000-000000000020';
const R3 = '019ffe00-0000-7000-8000-000000000030';
const NEW = '019ffe00-0000-7000-8000-000000000040';

function node(id: string, parentId: string | null, position: bigint) {
  return { id, parentId, position };
}

describe('create-sibling-node (Story 6.3 Task 1)', () => {
  it('creates at gap-start for an empty root (no reference)', () => {
    const res = computeSiblingInsertion({ nodes: [], referenceNodeId: null, newId: NEW });
    expect(res.nodeId).toBe(NEW);
    expect(res.parentId).toBeNull();
    expect(res.position).toBe(4294967296n); // positionForAppend(null) = SIBLING_POSITION_GAP
    expect(res.title).toBe('');
  });

  it('inserts a root-level sibling between the reference and its next sibling', () => {
    const nodes = [
      node(R1, null, 100n),
      node(R2, null, 300n),
      node(R3, null, 500n),
    ];
    const res = computeSiblingInsertion({ nodes, referenceNodeId: R2, newId: NEW });
    expect(res.parentId).toBeNull();
    // position between 300 and 500 = 400
    expect(res.position).toBe(400n);
  });

  it('appends after the last sibling when no next sibling exists', () => {
    const nodes = [node(R1, null, 100n), node(R2, null, 300n)];
    const res = computeSiblingInsertion({ nodes, referenceNodeId: R2, newId: NEW });
    expect(res.parentId).toBeNull();
    // positionForAppend(300) = 300 + gap
    expect(res.position).toBe(300n + 4294967296n);
  });

  it('carries the reference node parentId for a nested sibling', () => {
    const nodes = [node(R1, null, 100n), node(R2, R1, 100n), node(R3, R1, 300n)];
    const res = computeSiblingInsertion({ nodes, referenceNodeId: R2, newId: NEW });
    expect(res.parentId).toBe(R1);
    expect(res.position).toBe(200n); // between 100 and 300
  });

  describe("the new sibling takes the reference node's type", () => {
    it('a sibling of a Feature is a Feature, so it reaches the Forecast at Feature level', () => {
      const nodes = [{ ...node(R1, null, 100n), nodeType: 'Feature' as const }];
      const res = computeSiblingInsertion({ nodes, referenceNodeId: R1, newId: NEW });
      expect(res.nodeType).toBe('Feature');
    });

    it('a sibling of an acceptance criterion is an acceptance criterion', () => {
      const nodes = [{ ...node(R1, null, 100n), nodeType: 'AcceptanceCriterion' as const }];
      expect(computeSiblingInsertion({ nodes, referenceNodeId: R1, newId: NEW }).nodeType).toBe('AcceptanceCriterion');
    });

    it('does not copy container types (Enter then Tab adds a child under them)', () => {
      for (const nodeType of ['Vision', 'Theme', 'Component'] as const) {
        const nodes = [{ ...node(R1, null, 100n), nodeType }];
        expect(computeSiblingInsertion({ nodes, referenceNodeId: R1, newId: NEW }).nodeType).toBeNull();
      }
    });

    it('stays untyped next to an untyped node, with no reference, or when types are not supplied', () => {
      expect(computeSiblingInsertion({ nodes: [{ ...node(R1, null, 100n), nodeType: null }], referenceNodeId: R1, newId: NEW }).nodeType).toBeNull();
      expect(computeSiblingInsertion({ nodes: [], referenceNodeId: null, newId: NEW }).nodeType).toBeNull();
      expect(computeSiblingInsertion({ nodes: [node(R1, null, 100n)], referenceNodeId: R1, newId: NEW }).nodeType).toBeNull();
    });
  });
});

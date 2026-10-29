import { describe, it, expect } from 'vitest';
import { createOutlineReadModel } from './outline-read-model';
import { projectVisibleOutline } from './outline-visible.projection';
import { resolveFocusTarget } from './outline-focus';

describe('outline-visible.projection', () => {
  it('projects nodes in depth-first pre-order with sibling gap positions', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'n2', parentId: null, title: 'Theme 2', position: 200n, typeTag: null },
      { id: 'n1', parentId: null, title: 'Theme 1', position: 100n, typeTag: null },
      { id: 'n1-2', parentId: 'n1', title: 'Feature 1.2', position: 20n, typeTag: null },
      { id: 'n1-1', parentId: 'n1', title: 'Feature 1.1', position: 10n, typeTag: null },
    ]);

    const result = projectVisibleOutline(model, new Set());
    expect(result.projectRevision).toBe(1);
    expect(result.rows).toHaveLength(4);

    expect(result.rows.map((r) => r.nodeId)).toEqual(['n1', 'n1-1', 'n1-2', 'n2']);
    expect(result.rows[0].depth).toBe(0);
    expect(result.rows[0].posInSet).toBe(1);
    expect(result.rows[0].setSize).toBe(2);
    expect(result.rows[0].hasChildren).toBe(true);
    expect(result.rows[0].isExpanded).toBe(true);

    expect(result.rows[1].depth).toBe(1);
    expect(result.rows[1].posInSet).toBe(1);
    expect(result.rows[1].setSize).toBe(2);

    expect(result.rows[2].depth).toBe(1);
    expect(result.rows[2].posInSet).toBe(2);
    expect(result.rows[2].setSize).toBe(2);

    expect(result.rows[3].depth).toBe(0);
    expect(result.rows[3].posInSet).toBe(2);
    expect(result.rows[3].setSize).toBe(2);
  });

  it('excludes descendants of collapsed nodes but retains the collapsed node', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'n1', parentId: null, title: 'Theme 1', position: 100n, typeTag: null },
      { id: 'n1-1', parentId: 'n1', title: 'Feature 1.1', position: 10n, typeTag: null },
      { id: 'n2', parentId: null, title: 'Theme 2', position: 200n, typeTag: null },
    ]);

    const result = projectVisibleOutline(model, new Set(['n1']));
    expect(result.rows.map((r) => r.nodeId)).toEqual(['n1', 'n2']);
    expect(result.rows[0].hasChildren).toBe(true);
    expect(result.rows[0].isExpanded).toBe(false);
  });

  it('carries deliveryStatus through, defaulting an unspecified node to not_started', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'n1', parentId: null, title: 'Started', position: 100n, typeTag: null, deliveryStatus: 'in_progress' },
      { id: 'n2', parentId: null, title: 'Done', position: 200n, typeTag: null, deliveryStatus: 'delivered' },
      { id: 'n3', parentId: null, title: 'Unspecified', position: 300n, typeTag: null },
    ]);

    const result = projectVisibleOutline(model, new Set());
    expect(result.rows.map((r) => r.deliveryStatus)).toEqual([
      'in_progress',
      'delivered',
      'not_started',
    ]);
  });

  it('breaks position ties deterministically using UUID ascending', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'b-id', parentId: null, title: 'B', position: 100n, typeTag: null },
      { id: 'a-id', parentId: null, title: 'A', position: 100n, typeTag: null },
    ]);

    const result = projectVisibleOutline(model, new Set());
    expect(result.rows.map((r) => r.nodeId)).toEqual(['a-id', 'b-id']);
  });

  it('handles orphaned nodes defensively as root level', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'orphan', parentId: 'missing-parent', title: 'Orphan', position: 100n, typeTag: null },
    ]);

    const result = projectVisibleOutline(model, new Set());
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].nodeId).toBe('orphan');
    expect(result.rows[0].depth).toBe(0);
  });
});

describe('outline-focus', () => {
  it('returns NotInProject when target node does not exist', () => {
    const model = createOutlineReadModel('p1', 1, []);
    const res = resolveFocusTarget(model, new Set(), 'missing');
    expect(res.kind).toBe('NotInProject');
  });

  it('resolves ancestors to expand for a deeply nested node', () => {
    const model = createOutlineReadModel('p1', 1, [
      { id: 'root', parentId: null, title: 'Root', position: 100n, typeTag: null },
      { id: 'mid', parentId: 'root', title: 'Mid', position: 100n, typeTag: null },
      { id: 'leaf', parentId: 'mid', title: 'Leaf', position: 100n, typeTag: null },
    ]);

    const collapsed = new Set(['root', 'mid']);
    const res = resolveFocusTarget(model, collapsed, 'leaf');
    expect(res.kind).toBe('Resolved');
    if (res.kind === 'Resolved') {
      expect(res.ancestorsExpanded).toEqual(['mid', 'root']);
      expect(res.collapsedAfterExpand.has('root')).toBe(false);
      expect(res.collapsedAfterExpand.has('mid')).toBe(false);
    }
  });
});

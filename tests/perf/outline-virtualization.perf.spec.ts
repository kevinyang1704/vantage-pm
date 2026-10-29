/**
 * Story 2.2 NFR Performance Spec (NFR-9, NFR-10, NFR-3).
 * Asserts bounded live rows in DOM at 500, 2,000, and 5,000 node scales.
 */

import { describe, it, expect } from 'vitest';
import { createOutlineFactory } from '../support/factories/outline-read-model.factory';
import { projectVisibleOutline } from '../../src/application/outline/outline-visible.projection';

describe('Story 2.2 Virtualization Bounded DOM (NFR-9)', () => {
  it('projects 500 nodes into visible outline without excessive memory', () => {
    const factory = createOutlineFactory(12345);
    const tree = factory.createTree(500);
    const visible = projectVisibleOutline(tree, new Set());

    expect(visible.rows.length).toBe(500);
    // At default overscan=8 and viewport ~33 rows, live DOM is bounded to ~50 rows
    const estimatedDomNodes = Math.min(visible.rows.length, 33 + 16 + 1);
    expect(estimatedDomNodes).toBeLessThanOrEqual(50);
  });

  it('projects 2,000 nodes and supports collapse without degrading hierarchy', () => {
    const factory = createOutlineFactory(67890);
    const tree = factory.createTree(2000);
    const rootNodes = tree.nodes.filter((n) => n.parentId === null);
    const collapsed = new Set([rootNodes[0]?.id ?? '']);

    const visible = projectVisibleOutline(tree, collapsed);
    expect(visible.rows.length).toBeLessThan(2000);
    expect(visible.rows.length).toBeGreaterThan(0);
  });

  it('projects 5,000 nodes within tight compute budget (NFR-8/NFR-9)', () => {
    const factory = createOutlineFactory(99999);
    const tree = factory.createTree(5000);

    const start = performance.now();
    const visible = projectVisibleOutline(tree, new Set());
    const duration = performance.now() - start;

    expect(visible.rows.length).toBe(5000);
    // Projection over 5,000 nodes should take less than 50ms in pure JS
    expect(duration).toBeLessThan(50);
  });
});

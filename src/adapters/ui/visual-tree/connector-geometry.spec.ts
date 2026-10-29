import { describe, expect, it } from 'vitest';
import {
  MIN_RAIL_WIDTH,
  computeChildDrop,
  computeContainmentRail,
  computeTrunkStub,
  type NodeBox,
} from './connector-geometry';

function box(id: string, x: number, y: number, width = 208, height = 98): NodeBox {
  return Object.freeze({ nodeId: id, x, y, width, height });
}

describe('connector geometry (Story 6.2 Task 3)', () => {
  it('rail spans exactly first-to-last child centre for a 5-child fixture', () => {
    const parent = box('p', 0, 0, 400, 76);
    const children = [
      box('c1', 40, 300),
      box('c2', 280, 300),
      box('c3', 520, 300),
      box('c4', 760, 300),
      box('c5', 1000, 300),
    ];
    const rail = computeContainmentRail(parent, children);

    expect(rail.xStart).toBeCloseTo(40 + 208 / 2, 3); // c1 centre
    expect(rail.xEnd).toBeCloseTo(1000 + 208 / 2, 3); // c5 centre
    expect(rail.path).toBe(`M ${rail.xStart},${rail.y} H ${rail.xEnd}`);
    // Not centred on the parent
    expect(rail.xStart).not.toBeCloseTo(parent.x + parent.width / 2, 3);
  });

  it('rail Y sits at the vertical midpoint of the layer gap', () => {
    const parent = box('p', 0, 0, 400, 76);
    const children = [box('c1', 100, 300)];
    const rail = computeContainmentRail(parent, children);

    const gapTop = parent.y + parent.height; // 76
    const minChildTop = 300;
    expect(rail.y).toBeCloseTo(gapTop + (minChildTop - gapTop) / 2, 3); // 188
  });

  it('child drop runs from rail Y to the child top edge at its centre-x', () => {
    const rail = computeContainmentRail(box('p', 0, 0), [box('c', 100, 300)]);
    const drop = computeChildDrop(rail, box('c', 100, 300));

    expect(drop.junction.x).toBeCloseTo(100 + 208 / 2, 3);
    expect(drop.junction.y).toBeCloseTo(rail.y, 3);
    expect(drop.path).toBe(`M ${drop.junction.x},${rail.y} V 300`);
  });

  it('trunk stub runs from trunk bottom edge to rail Y', () => {
    const trunk = box('t', 0, 0, 400, 76);
    const rail = computeContainmentRail(trunk, [box('c', 100, 300)]);
    const stub = computeTrunkStub(trunk, rail);

    expect(stub.path).toBe(`M ${trunk.x + trunk.width / 2},${trunk.y + trunk.height} V ${rail.y}`);
    expect(stub.junction.x).toBeCloseTo(trunk.x + trunk.width / 2, 3);
    expect(stub.junction.y).toBeCloseTo(rail.y, 3);
  });

  it('is invariant to node metrics — no node-property input exists in the types', () => {
    // NodeBox has only nodeId/x/y/width/height: differing effort/weight/duration
    // cannot even be passed as inputs (compile-time guarantee). Runtime check:
    // identical geometry for identical boxes regardless of what the caller knows.
    const a = computeContainmentRail(box('p', 0, 0, 400, 76), [box('c', 100, 300), box('c2', 308, 300)]);
    const b = computeContainmentRail(box('p', 0, 0, 400, 76), [box('c', 100, 300), box('c2', 308, 300)]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('single-child rail stays visible with a non-zero path centered on the child (E10-FR4)', () => {
    const rail = computeContainmentRail(box('p', 0, 0), [box('c', 100, 300)]);
    const childCentreX = 100 + 208 / 2;
    // Non-zero, documented minimum width centered on the child centre.
    expect(rail.xEnd - rail.xStart).toBeCloseTo(MIN_RAIL_WIDTH, 3);
    expect((rail.xStart + rail.xEnd) / 2).toBeCloseTo(childCentreX, 3);
    // The path is a real horizontal segment, never a degenerate point.
    expect(rail.path).toBe(`M ${rail.xStart},${rail.y} H ${rail.xEnd}`);
    expect(rail.path.length).toBeGreaterThan(0);
  });

  it('child drop and trunk stub carry distinct kinds for the same owner (UAT key-collision regression)', () => {
    // A node that is both a child of a parent and itself a parent produces two
    // drops with the same ownerId. The kind discriminator is what keeps React
    // keys (`drop-{ownerId}-{kind}`) unique — the UAT `drop-`/`junction-`
    // duplicate-key collision.
    const rail = computeContainmentRail(box('p', 0, 0), [box('m', 100, 300)]);
    const childDrop = computeChildDrop(rail, box('m', 100, 300));
    const trunkStub = computeTrunkStub(box('m', 100, 300), rail);

    expect(childDrop.ownerId).toBe(trunkStub.ownerId); // same node in both roles
    expect(childDrop.kind).toBe('child');
    expect(trunkStub.kind).toBe('stub');
    expect(childDrop.kind).not.toBe(trunkStub.kind);
    // Key-space uniqueness guarantee the connectors rely on:
    expect(`drop-${childDrop.ownerId}-${childDrop.kind}`).not.toBe(`drop-${trunkStub.ownerId}-${trunkStub.kind}`);
  });
});
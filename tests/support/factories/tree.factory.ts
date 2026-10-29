import { Faker, base, en } from '@faker-js/faker';
import type { Node } from '../../../src/domain/tree/node.entity';
import { createNode } from '../../../src/domain/tree/node.entity';

export interface TreeFactory {
  createTree(totalNodes: number, overrides?: { projectId?: string }): readonly Node[];
  cleanup: () => void;
}

const SIBLING_GAP = 4294967296n;

export function createTreeFactory(seed: number): TreeFactory {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);

  return {
    createTree(totalNodes: number, overrides = {}): readonly Node[] {
      const projectId = overrides.projectId ?? '019ffe00-0000-7000-8000-000000000001';
      const nodes: Node[] = [];

      if (totalNodes <= 0) return Object.freeze([]);

      const rootCount = Math.max(1, Math.min(10, Math.ceil(totalNodes / 50)));
      const rootIds: string[] = [];

      for (let r = 0; r < rootCount && nodes.length < totalNodes; r++) {
        const rootId = `019ffe00-0000-7000-8000-${r.toString(16).padStart(12, '0')}`;
        rootIds.push(rootId);
        nodes.push(
          createNode({
            id: rootId,
            projectId,
            parentId: null,
            title: `Theme ${r + 1}: ${faker.commerce.department()}`,
            position: BigInt(r + 1) * SIBLING_GAP,
          }),
        );
      }

      let currentParentPool = [...rootIds];
      let nextParentPool: string[] = [];
      let depth = 1;
      let siblingCount = 0;
      let currentParentIdx = 0;

      while (nodes.length < totalNodes && currentParentPool.length > 0 && depth < 4) {
        const parentId = currentParentPool[currentParentIdx];
        const nodeId = `019ffe00-${depth.toString(16).padStart(4, '0')}-7000-8000-${nodes.length.toString(16).padStart(12, '0')}`;
        nextParentPool.push(nodeId);

        nodes.push(
          createNode({
            id: nodeId,
            projectId,
            parentId,
            title: `${depth === 1 ? 'Feature' : 'Task'} ${nodes.length}: ${faker.hacker.phrase()}`,
            position: BigInt(siblingCount + 1) * SIBLING_GAP,
          }),
        );

        siblingCount++;
        currentParentIdx++;

        if (currentParentIdx >= currentParentPool.length) {
          currentParentIdx = 0;
          if (siblingCount >= 10 || nodes.length >= totalNodes) {
            currentParentPool = nextParentPool;
            nextParentPool = [];
            siblingCount = 0;
            depth++;
          }
        }
      }

      return Object.freeze(nodes);
    },

    cleanup(): void {},
  };
}

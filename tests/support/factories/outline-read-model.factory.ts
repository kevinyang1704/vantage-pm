import { Faker, base, en } from '@faker-js/faker';
import {
  createOutlineReadModel,
  type OutlineNodeReadModel,
  type OutlineReadModel,
} from '../../../src/application/outline/outline-read-model';

export interface OutlineFactory {
  createTree(totalNodes: number, overrides?: { projectId?: string; revision?: number }): OutlineReadModel;
  cleanup: () => void;
}

const SIBLING_GAP = 4294967296n; // 2^32 gap

/**
 * Creates an isolated, repeatable OutlineReadModel factory.
 * Each Playwright/Vitest test receives its own seeded instance.
 */
export function createOutlineFactory(seed: number): OutlineFactory {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);

  return {
    createTree(totalNodes: number, overrides = {}): OutlineReadModel {
      const projectId = overrides.projectId ?? faker.string.uuid();
      const projectRevision = overrides.revision ?? 1;
      const nodes: (Pick<OutlineNodeReadModel, 'id' | 'parentId' | 'title' | 'position'> & Partial<OutlineNodeReadModel>)[] = [];

      if (totalNodes <= 0) {
        return createOutlineReadModel(projectId, projectRevision, []);
      }

      // Generate a structured forest with depth 0..3 (Vision -> Theme -> Feature -> AC)
      // Root themes
      const rootCount = Math.max(1, Math.min(10, Math.ceil(totalNodes / 50)));
      const rootIds: string[] = [];

      for (let r = 0; r < rootCount && nodes.length < totalNodes; r++) {
        const rootId = `019ffe00-0000-7000-8000-${r.toString(16).padStart(12, '0')}`;
        rootIds.push(rootId);
        nodes.push({
          id: rootId,
          parentId: null,
          title: `Theme ${r + 1}: ${faker.commerce.department()}`,
          position: BigInt(r + 1) * SIBLING_GAP,
          typeTag: 'theme',
          nodeType: 'Theme',
        });
      }

      // Breadth-first generation: every node yields BRANCHING children before
      // the next parent is used, and each child joins the next level's pool.
      // Deterministic and always produces exactly `totalNodes` nodes.
      let currentPool: (string | null)[] = [...rootIds];
      let nextPool: string[] = [];
      let depth = 1;
      const BRANCHING = 4;

      while (nodes.length < totalNodes && currentPool.length > 0) {
        for (const parentId of currentPool) {
          for (let c = 0; c < BRANCHING && nodes.length < totalNodes; c++) {
            const nodeId = `019ffe00-${depth.toString(16).padStart(4, '0')}-7000-8000-${nodes.length.toString(16).padStart(12, '0')}`;
            nextPool.push(nodeId);

            nodes.push({
              id: nodeId,
              parentId: parentId as string,
              title: `${depth === 1 ? 'Feature' : 'Task'} ${nodes.length}: ${faker.hacker.phrase()}`,
              position: BigInt(c + 1) * SIBLING_GAP,
              typeTag: depth === 1 ? 'feature' : null,
              nodeType: depth === 1 ? 'Feature' : null,
            });
          }
          if (nodes.length >= totalNodes) break;
        }

        currentPool = nextPool;
        nextPool = [];
        depth++;
      }

      return createOutlineReadModel(projectId, projectRevision, nodes);
    },

    cleanup(): void {},
  };
}

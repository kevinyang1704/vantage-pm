import { Faker, base, en } from '@faker-js/faker';
import type { Node } from '../../../src/domain/tree/node.entity';
import { createNode } from '../../../src/domain/tree/node.entity';

export interface NodeFactory {
  create(overrides?: Partial<Node>): Node;
  cleanup: () => void;
}

let nodeSeq = 0;

export function createNodeFactory(seed: number): NodeFactory {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);

  return {
    create(overrides = {}): Node {
      nodeSeq++;
      const id =
        overrides.id ??
        `019ffe00-0000-7000-8000-${nodeSeq.toString(16).padStart(12, '0')}`;
      const projectId =
        overrides.projectId ?? '019ffe00-0000-7000-8000-000000000001';

      return createNode({
        id,
        projectId,
        parentId: overrides.parentId ?? null,
        title: overrides.title ?? faker.hacker.phrase(),
        bodyText: overrides.bodyText ?? null,
        position: overrides.position ?? BigInt(nodeSeq) * 4294967296n,
      });
    },

    cleanup(): void {
      nodeSeq = 0;
    },
  };
}

import { test as base } from '@playwright/test';

import { createProjectFactory, type ProjectFactory } from '../factories/project.factory';

export type Cleanup = () => Promise<void> | void;

export type CleanupRegistry = {
  add: (cleanup: Cleanup) => void;
};

type ProjectFixtures = {
  cleanup: CleanupRegistry;
  projectFactory: ProjectFactory;
};

function stableSeed(parts: string[]): number {
  let hash = 2_166_136_261;

  for (const character of parts.join('\u0000')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

export const projectTest = base.extend<ProjectFixtures>({
  cleanup: async ({}, use) => {
    const cleanups: Cleanup[] = [];

    await use({
      add(cleanup) {
        cleanups.push(cleanup);
      },
    });

    const failures: unknown[] = [];

    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more test cleanup operations failed');
    }
  },

  projectFactory: async ({}, use, testInfo) => {
    const factory = createProjectFactory(stableSeed(testInfo.titlePath));

    try {
      await use(factory);
    } finally {
      factory.cleanup();
    }
  },
});

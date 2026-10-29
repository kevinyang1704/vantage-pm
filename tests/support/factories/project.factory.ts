import { Faker, base, en } from '@faker-js/faker';

export type ProjectSeed = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFactory = {
  create: (overrides?: Partial<ProjectSeed>) => ProjectSeed;
  cleanup: () => void;
};

/**
 * Creates an isolated, repeatable factory. Each Playwright test receives its own
 * seeded instance, so generated values remain stable without sharing mutable
 * Faker state across tests.
 */
export function createProjectFactory(seed: number): ProjectFactory {
  const faker = new Faker({ locale: [en, base] });
  const createdProjects: ProjectSeed[] = [];
  faker.seed(seed);

  return {
    create(overrides: Partial<ProjectSeed> = {}): ProjectSeed {
      const createdAt = faker.date.recent({ days: 30 }).toISOString();
      const project = {
        id: faker.string.uuid(),
        name: `${faker.word.adjective()} ${faker.word.noun()} project`,
        description: faker.lorem.sentence(),
        createdAt,
        updatedAt: createdAt,
        ...overrides,
      };

      createdProjects.push(project);
      return project;
    },

    cleanup(): void {
      createdProjects.length = 0;
    },
  };
}

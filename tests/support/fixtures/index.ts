import { mergeTests } from '@playwright/test';

import { projectTest } from './custom.fixture';
import { networkMonitorTest } from './network-error-monitor.fixture';
import { unexpectedRequestDenylistFixture } from './unexpected-request-denylist.fixture';
import { todayFixture } from './today.fixture';
import { forecastViewTest } from './forecast-view.fixture';

export const test = mergeTests(projectTest, networkMonitorTest, unexpectedRequestDenylistFixture, todayFixture, forecastViewTest);

export { expect } from '@playwright/test';
export type { Cleanup, CleanupRegistry } from './custom.fixture';
export type { ProjectFactory, ProjectSeed } from '../factories/project.factory';

// Epic 27: two-context collaboration fixtures (owner + joiner) that admit
// exactly the configured service origin. Used only by tests/collab/.
export { collaborationTest, COLLAB_APP_URL, COLLAB_SERVICE_URL } from './collaboration.fixture';

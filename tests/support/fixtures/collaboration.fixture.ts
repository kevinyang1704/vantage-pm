/**
 * Collaboration fixtures (Epic 27, 27.10 evidence).
 *
 * Two isolated browser contexts — an owner and a joiner, with separate
 * storage, credentials and IndexedDB — against a real local pmapp-server and
 * a collaboration-flag build. Each page may reach exactly two origins: the app
 * itself and the one configured collaboration service (the flag-on CSP admits
 * nothing else). Any other cross-origin request, and any unexpected HTTP
 * 4xx/5xx, fails the test, matching the product fixtures' guarantees.
 */

import { test as base, type Browser, type Page, type TestInfo } from '@playwright/test';

export const COLLAB_APP_URL = process.env.PMAPP_COLLAB_APP_URL ?? 'http://127.0.0.1:5297';
export const COLLAB_SERVICE_URL = process.env.PMAPP_COLLAB_SERVICE_URL ?? 'http://127.0.0.1:8797';

type Guarded = { page: Page; finish: (testInfo: TestInfo) => Promise<void> };

async function guardedPage(browser: Browser, role: string): Promise<Guarded> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const violations: string[] = [];
  const failures: string[] = [];
  const allowed = new Set([new URL(COLLAB_APP_URL).origin, new URL(COLLAB_SERVICE_URL).origin]);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:') || page.url() === 'about:blank') return;
    const origin = new URL(url).origin;
    if (!allowed.has(origin)) violations.push(`${role}: ${request.method()} ${url}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${role}: ${response.request().method()} ${response.status()} ${response.url()}`);
  });
  return {
    page,
    finish: async (testInfo) => {
      await context.close();
      if (violations.length) throw new Error(`Unexpected cross-origin requests:\n${violations.join('\n')}`);
      const passed = testInfo.status === undefined || testInfo.status === testInfo.expectedStatus;
      // A scenario may declare exact expected failures, e.g. a removed member's
      // next authenticated request: annotation
      // { type: 'expectHttpError', description: '<role>: <METHOD> <status> <url substring>' }.
      const expected = testInfo.annotations.filter((a) => a.type === 'expectHttpError').map((a) => a.description ?? '');
      const unexpected = failures.filter((f) => !expected.some((e) => e.length > 0 && f.includes(e)));
      if (unexpected.length && passed) throw new Error(`Unexpected HTTP errors:\n${unexpected.join('\n')}`);
    },
  };
}

export type CollaborationFixtures = {
  ownerPage: Page;
  joinerPage: Page;
};

export const collaborationTest = base.extend<CollaborationFixtures>({
  ownerPage: async ({ browser }, use, testInfo) => {
    const guarded = await guardedPage(browser, 'owner');
    await use(guarded.page);
    await guarded.finish(testInfo);
  },
  joinerPage: async ({ browser }, use, testInfo) => {
    const guarded = await guardedPage(browser, 'joiner');
    await use(guarded.page);
    await guarded.finish(testInfo);
  },
});

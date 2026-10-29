/**
 * Unexpected-request denylist Playwright fixture (Story 1.5 Task 7, AC5).
 * Fails the test if any network request targets a non-same-origin destination.
 *
 * V1 has no backend, no remote fonts, no telemetry, no authored-data transport
 * (AD-15). Any cross-origin request during a product-app test run is a violation.
 *
 * Merge this into tests/support/fixtures/index.ts alongside the existing
 * networkErrorMonitor fixture.
 */

import { test as base } from '@playwright/test';

export type UnexpectedRequestDenylistFixture = {
  /** No extra API — the fixture auto-fails on cross-origin requests. */
};

export const unexpectedRequestDenylistFixture = base.extend<UnexpectedRequestDenylistFixture>({
  page: async ({ page }, use) => {
    const violations: string[] = [];

    page.on('request', (request) => {
      // Allow requests during initial navigation (page.url() is about:blank)
      if (page.url() === 'about:blank') {
        return;
      }

      const requestOrigin = new URL(request.url()).origin;
      const pageOrigin = new URL(page.url()).origin;

      // Allow same-origin requests and blob:/data: URLs
      if (request.url().startsWith('blob:') || request.url().startsWith('data:')) {
        return;
      }

      if (requestOrigin !== pageOrigin) {
        violations.push(
          `Cross-origin request: ${request.method} ${request.url()} (origin: ${requestOrigin}, page: ${pageOrigin})`,
        );
      }
    });

    await use(page);

    if (violations.length > 0) {
      throw new Error(
        `Unexpected cross-origin requests detected (AD-15 violation):\n${violations.join('\n')}`,
      );
    }
  },
});

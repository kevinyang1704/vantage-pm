import { test as base, type Response } from '@playwright/test';

type NetworkFailure = {
  method: string;
  status: number;
  url: string;
};

type NetworkMonitorFixture = {
  networkErrorMonitor: void;
};

export const networkMonitorTest = base.extend<NetworkMonitorFixture>({
  networkErrorMonitor: [
    async ({ page }, use, testInfo) => {
      const failures = new Map<string, NetworkFailure>();
      const monitorResponse = (response: Response): void => {
        const status = response.status();

        if (status < 400) return;

        const failure = {
          method: response.request().method(),
          status,
          url: response.url(),
        };
        failures.set(`${failure.method}:${failure.status}:${failure.url}`, failure);
      };

      page.on('response', monitorResponse);

      try {
        await use();
      } finally {
        page.off('response', monitorResponse);
      }

      if (failures.size === 0) return;

      const payload = [...failures.values()];
      await testInfo.attach('network-errors', {
        body: JSON.stringify(payload, null, 2),
        contentType: 'application/json',
      });

      const optedOut = testInfo.annotations.some(
        ({ type }) => type === 'skipNetworkMonitoring',
      );
      const testOtherwisePassed =
        testInfo.status === undefined || testInfo.status === testInfo.expectedStatus;

      if (!optedOut && testOtherwisePassed) {
        const summary = payload
          .map(({ method, status, url }) => `${method} ${status} ${url}`)
          .join('\n');
        throw new Error(`Unexpected HTTP errors detected:\n${summary}`);
      }
    },
    { auto: true },
  ],
});

export const SERVICE_WORKER_TEST_ONLY = 'service-worker.test-only' as const;

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', () => {
  void self.clients.claim();
});

self.addEventListener('message', (event) => {
  const data = event.data as Record<string, unknown>;
  if (data.type === 'PING') {
    event.source?.postMessage({ type: 'PONG', controllerChanged: true });
  }
});
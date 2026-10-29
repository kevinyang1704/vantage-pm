/**
 * Dedicated Layout Web Worker (Story 6.1 Task 5, AD-6).
 *
 * Stateless per request: each LayoutSnapshotRequest carries the complete
 * VisualTreeProjection, so there is no worker-owned state that can desync
 * from a base revision — no ResyncRequired/delta machinery needed (unlike
 * the stateful analysis worker).
 */

import { computeLayout } from '../../application/visual-tree/layout-engine';
import type {
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from '../../contracts/layout-protocol';

self.onmessage = (event: MessageEvent<LayoutWorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.type !== 'LayoutSnapshot') return;

  try {
    // The engine is a synchronous deterministic layerer; no await needed.
    const result = computeLayout(msg);
    self.postMessage(result as LayoutWorkerResponse);
  } catch (err) {
    self.postMessage({
      type: 'LayoutFailed',
      projectId: msg.visualTree.projectId,
      themeId: msg.visualTree.themeId,
      reason: err instanceof Error ? err.message : String(err),
    } satisfies LayoutWorkerResponse);
  }
};
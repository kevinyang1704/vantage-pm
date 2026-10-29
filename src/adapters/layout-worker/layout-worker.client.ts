/**
 * Layout Worker Client (Story 6.1 Task 5, AD-6).
 *
 * Main-thread adapter with client-side "latest request wins" filtering:
 * a stale LayoutResultResponse (older projectRevision/themeId) arriving after
 * a newer request was issued is silently discarded, mirroring the
 * analysis-worker client's actual supersession behavior.
 */

import { computeLayout } from '../../application/visual-tree/layout-engine';
import type {
  LayoutSnapshotRequest,
  LayoutResultResponse,
  LayoutWorkerResponse,
} from '../../contracts/layout-protocol';
import type { VisualTreeProjection } from '../../contracts/visual-tree';

export type LayoutResultCallback = (res: Extract<LayoutWorkerResponse, { type: 'LayoutResult' }>) => void;

/** Key used by the latest-request-wins filter (AC3). Exported for unit testing. */
export function layoutRequestKey(projectId: string, themeId: string, projectRevision: number): string {
  return `${projectId}:${themeId}:${projectRevision}`;
}

/**
 * Latest-request-wins filter (AC3): a result whose key does not match the most
 * recent request is stale and must be silently discarded. Pure, unit-testable.
 */
export function isLayoutResultCurrent(
  latestRequestKey: string | null,
  result: LayoutResultResponse,
): boolean {
  return layoutRequestKey(result.projectId, result.themeId, result.projectRevision) === latestRequestKey;
}

export class LayoutWorkerClient {
  #worker: Worker | null = null;
  #latestRequestKey: string | null = null;
  #onResultCallback: LayoutResultCallback | null = null;

  constructor() {
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.#worker = new Worker(
          new URL('./layout.worker.ts', import.meta.url),
          { type: 'module' },
        );
        this.#worker.onmessage = (e: MessageEvent<LayoutWorkerResponse>) => {
          this.#handleMessage(e.data);
        };
      } catch {
        this.#worker = null; // fall back to synchronous engine
      }
    }
  }

  onResult(callback: LayoutResultCallback): void {
    this.#onResultCallback = callback;
  }

  requestLayout(visualTree: VisualTreeProjection): void {
    this.#latestRequestKey = layoutRequestKey(visualTree.projectId, visualTree.themeId, visualTree.projectRevision);
    const req: LayoutSnapshotRequest = { type: 'LayoutSnapshot', visualTree };

    if (this.#worker) {
      this.#worker.postMessage(req);
    } else {
      // The engine is synchronous (deterministic layerer); route the result
      // through the same latest-request-wins filter.
      this.#handleMessage(computeLayout(req));
    }
  }

  #handleMessage(msg: LayoutWorkerResponse): void {
    if (msg.type === 'LayoutResult') {
      if (!isLayoutResultCurrent(this.#latestRequestKey, msg)) return; // AC3: silently discard stale response
      this.#onResultCallback?.(msg);
    }
  }

  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
  }
}
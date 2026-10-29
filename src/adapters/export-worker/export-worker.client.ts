/**
 * Export Worker Client (Story 8.3 Task 4, Story 8.4 Task 4, Story 8.5 Task 5, Epic 12 Story 12.2).
 *
 * Main-thread adapter with "latest request wins" supersession: a stale
 * generation result arriving after a newer export request was issued is
 * silently discarded before it ever reaches the save step (AC2 — no stale/
 * superseded generation is published). Each request gets its own response,
 * correlated by requestId.
 *
 * Story 12.2: Bounded and actionable worker failures:
 * - Listens on `onerror` and `onmessageerror` to reject pending requests with clear detail
 *   and terminate the failed worker.
 * - Enforces a bounded 10-second timeout (NFR-7 / E12-NFR2). If the worker produces no response
 *   before the timeout expires, the pending request rejects with a timeout error and the worker
 *   is terminated.
 * - Stale responses arriving after a newer request are discarded.
 * - Preserves synchronous fallback in environments without Worker (e.g., Vitest).
 */

import { renderGanttPptx } from './gantt-pptx.renderer';
import { renderDocx } from './document-docx.renderer';
import { buildGanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';
import type { ExportWorkerRequest, ExportWorkerResponse } from '../../contracts/export-protocol';

export type ExportResultCallback = (res: Extract<ExportWorkerResponse, { type: 'ExportGanttPptxResult' | 'ExportDocxResult' }>) => void;
export type ExportFailureCallback = (res: Extract<ExportWorkerResponse, { type: 'ExportWorkerFailed' }>) => void;

export const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;

/** Key used by the latest-request-wins filter. Exported for unit testing. */
export function exportRequestKey(projectId: string, projectRevision: number, kind: string): string {
  return `${projectId}:${kind}:${projectRevision}`;
}

/**
 * Latest-request-wins filter: a result whose key does not match the most recent
 * request is stale and must be silently discarded. Pure, unit-testable.
 */
export function isExportResultCurrent(
  latestRequestKey: string | null,
  result: { projectId: string; projectRevision: number; format: string },
): boolean {
  return exportRequestKey(result.projectId, result.projectRevision, result.format) === latestRequestKey;
}

export interface ExportWorkerClientOptions {
  readonly timeoutMs?: number;
  readonly workerFactory?: () => Worker;
}

export class ExportWorkerClient {
  #worker: Worker | null = null;
  #latestRequestKey: string | null = null;
  #timeoutMs: number;
  #workerFactory: (() => Worker) | null = null;
  #activeTimer: ReturnType<typeof setTimeout> | null = null;
  #fallbackCallback: ((msg: ExportWorkerResponse) => void) | null = null;

  constructor(options?: ExportWorkerClientOptions) {
    this.#timeoutMs = options?.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
    if (options?.workerFactory) {
      this.#workerFactory = options.workerFactory;
    }
    this.#ensureWorker();
  }

  #ensureWorker(): Worker | null {
    if (this.#worker) return this.#worker;
    if (this.#workerFactory) {
      try {
        this.#worker = this.#workerFactory();
        return this.#worker;
      } catch {
        this.#worker = null;
        return null;
      }
    }
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.#worker = new Worker(
          new URL('./export.worker.ts', import.meta.url),
          { type: 'module' },
        );
        return this.#worker;
      } catch {
        this.#worker = null; // fall back to synchronous render
        return null;
      }
    }
    return null;
  }

  onMessage(callback: (msg: ExportWorkerResponse) => void): void {
    if (this.#worker) {
      this.#worker.onmessage = (e: MessageEvent<ExportWorkerResponse>) => callback(e.data);
    } else {
      this.#fallbackCallback = callback;
    }
  }

  /**
   * Request a generation. Returns a Promise<ExportWorkerResponse> correlated by
   * requestId. Stale results (older key) are discarded via isExportResultCurrent.
   */
  request(req: ExportWorkerRequest, timeoutOverrideMs?: number): Promise<ExportWorkerResponse> {
    const key = exportRequestKey(req.projectId, req.projectRevision, req.format);
    this.#latestRequestKey = key;
    const timeoutMs = timeoutOverrideMs ?? this.#timeoutMs;

    return new Promise<ExportWorkerResponse>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (this.#activeTimer !== null) {
          clearTimeout(this.#activeTimer);
          this.#activeTimer = null;
        }
      };

      const handleSuccess = (msg: ExportWorkerResponse) => {
        if (settled) return;
        if (msg.type === 'ExportWorkerFailed') {
          settled = true;
          cleanup();
          reject(new Error(msg.reason));
          return;
        }
        if (!isExportResultCurrent(this.#latestRequestKey, msg)) return; // stale — discard
        settled = true;
        cleanup();
        resolve(msg);
      };

      const handleFailure = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.terminate();
        reject(err);
      };

      this.#activeTimer = setTimeout(() => {
        handleFailure(new Error(`Export generation timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      const worker = this.#ensureWorker();
      if (worker) {
        worker.onmessage = (e: MessageEvent<ExportWorkerResponse>) => handleSuccess(e.data);
        worker.onerror = (e: ErrorEvent) => {
          handleFailure(new Error(e.message || 'Export worker encountered an unhandled error.'));
        };
        worker.onmessageerror = () => {
          handleFailure(new Error('Export worker failed to deserialize message payload.'));
        };
        worker.postMessage(req);
      } else {
        // Synchronous fallback path (Vitest / no-Worker env)
        void (async () => {
          try {
            if (req.type === 'ExportGanttPptx') {
              const plan = buildGanttPptxSlidePlan(req.planInput);
              const bytes = await renderGanttPptx(plan);
              const resp: ExportWorkerResponse = {
                type: 'ExportGanttPptxResult',
                requestId: req.requestId,
                format: 'pptx',
                projectId: req.projectId,
                projectRevision: req.projectRevision,
                bytes,
              };
              handleSuccess(resp);
            } else {
              const bytes = await renderDocx(req.projection, { generatedAtISO: req.projection.generatedAt });
              const resp: ExportWorkerResponse = {
                type: 'ExportDocxResult',
                requestId: req.requestId,
                format: 'docx',
                projectId: req.projectId,
                projectRevision: req.projectRevision,
                bytes,
              };
              handleSuccess(resp);
            }
          } catch (err) {
            handleFailure(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      }
    });
  }

  terminate(): void {
    if (this.#activeTimer !== null) {
      clearTimeout(this.#activeTimer);
      this.#activeTimer = null;
    }
    this.#worker?.terminate();
    this.#worker = null;
  }
}

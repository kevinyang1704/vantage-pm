/**
 * Export worker protocol (Story 8.3 Task 4, Story 8.4 Task 4, AD-12).
 *
 * Stateless per request: each request carries a complete, already-resolved
 * plan (or projection), so there is no worker-owned state that can desync —
 * no snapshot/delta/resync machinery needed, matching the layout.worker.ts
 * precedent rather than the stateful analysis.worker.ts.
 *
 * Both PPTX (Story 8.3) and DOCX (Story 8.4) generation flow through the same
 * worker, discriminated by `format`.
 */

import type { GanttPptxSlidePlanInput } from '../application/gantt/gantt-pptx.projection';
import type { DocumentProjection } from '../contracts/document';

export type ExportFormat = 'pptx' | 'docx';

export interface ExportGanttPptxRequest {
  readonly type: 'ExportGanttPptx';
  readonly requestId: string; // UUIDv7, per this project's worker-message convention
  readonly format: 'pptx';
  readonly planInput: GanttPptxSlidePlanInput;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly filename: string;
  readonly mimeType: string;
}

export interface ExportDocxRequest {
  readonly type: 'ExportDocx';
  readonly requestId: string; // UUIDv7
  readonly format: 'docx';
  readonly projection: DocumentProjection;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly filename: string;
  readonly mimeType: string;
}

export type ExportWorkerRequest = ExportGanttPptxRequest | ExportDocxRequest;

export interface ExportGanttPptxResult {
  readonly type: 'ExportGanttPptxResult';
  readonly requestId: string;
  readonly format: 'pptx';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly bytes: ArrayBuffer; // transferable, never streamed in chunks
}

export interface ExportDocxResult {
  readonly type: 'ExportDocxResult';
  readonly requestId: string;
  readonly format: 'docx';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly bytes: ArrayBuffer;
}

export interface ExportWorkerFailed {
  readonly type: 'ExportWorkerFailed';
  readonly requestId: string;
  readonly format: ExportFormat;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly reason: string;
}

export type ExportWorkerResponse = ExportGanttPptxResult | ExportDocxResult | ExportWorkerFailed;

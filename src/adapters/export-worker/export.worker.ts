/**
 * Dedicated Export Web Worker (Story 8.3 Task 4, Story 8.4 Task 4, AD-12).
 *
 * Stateless per request: each request carries a complete, already-resolved plan
 * or projection, so there is no worker-owned state that can desync — no
 * snapshot/delta/resync machinery needed. One message is posted per request,
 * only after the complete byte buffer is assembled — never a partial/progress
 * message carrying incomplete bytes (the "no partial file" guarantee).
 */

import { renderGanttPptx } from './gantt-pptx.renderer';
import { renderDocx } from './document-docx.renderer';
import { buildGanttPptxSlidePlan } from '../../application/gantt/gantt-pptx.projection';
import type {
  ExportWorkerRequest,
  ExportWorkerResponse,
} from '../../contracts/export-protocol';

self.onmessage = async (event: MessageEvent<ExportWorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  try {
    if (msg.type === 'ExportGanttPptx') {
      const plan = buildGanttPptxSlidePlan(msg.planInput);
      const bytes = await renderGanttPptx(plan);
      const resp: ExportWorkerResponse = {
        type: 'ExportGanttPptxResult',
        requestId: msg.requestId,
        format: 'pptx',
        projectId: msg.projectId,
        projectRevision: msg.projectRevision,
        bytes,
      };
      self.postMessage(resp);
    } else if (msg.type === 'ExportDocx') {
      const bytes = await renderDocx(msg.projection, { generatedAtISO: msg.projection.generatedAt });
      const resp: ExportWorkerResponse = {
        type: 'ExportDocxResult',
        requestId: msg.requestId,
        format: 'docx',
        projectId: msg.projectId,
        projectRevision: msg.projectRevision,
        bytes,
      };
      self.postMessage(resp);
    }
  } catch (err) {
    const resp: ExportWorkerResponse = {
      type: 'ExportWorkerFailed',
      requestId: msg.requestId,
      format: msg.format,
      projectId: msg.projectId,
      projectRevision: msg.projectRevision,
      reason: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(resp);
  }
};

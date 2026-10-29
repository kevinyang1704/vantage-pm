/**
 * Export Gantt to PowerPoint use case (Story 8.3 Task 6, AD-12).
 *
 * Application-layer orchestration: accepts an already-resolved Story 8.1
 * GanttVisible scope plus in-memory phases/nodes/unlockEdges, assembles a
 * GanttPptxSlidePlanInput, requests bytes from the ExportWorkerClient, and
 * returns a standard typed Result. Never throws past this boundary.
 *
 * The injected clock supplies `generatedAt` as an ISO instant — generation code
 * itself never calls new Date()/Temporal.Now (FR-55, AD-12).
 */

import type { GanttVisibleScopeResult } from '../../contracts/gantt';
import type { Phase } from '../../domain/phase/phase.entity';
import type { Node } from '../../domain/tree/node.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { ExportWorkerClient } from '../../adapters/export-worker/export-worker.client';
import { PPTX_MIME } from '../../adapters/export-worker/gantt-pptx.renderer';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type AppResult<T, E = string> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export interface ExportGanttPptxUseCaseInput {
  readonly scope: GanttVisibleScopeResult;
  readonly phases: readonly Phase[];
  readonly nodes: readonly Node[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly projectName: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly generatedAt: string; // injected clock, ISO instant
  readonly client?: ExportWorkerClient;
}

export function buildGanttPptxFilename(projectName: string): string {
  const slug = projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  return `${slug}-gantt.pptx`;
}

export async function exportGanttPptx(
  input: ExportGanttPptxUseCaseInput,
): Promise<AppResult<{ bytes: ArrayBuffer; filename: string; mimeType: string }>> {
  try {
    const client = input.client ?? new ExportWorkerClient();
    const requestId = createUuidV7();
    const response = await client.request({
      type: 'ExportGanttPptx',
      requestId,
      format: 'pptx',
      planInput: {
        scope: input.scope,
        phases: input.phases,
        nodes: input.nodes,
        unlockEdges: input.unlockEdges,
        projectName: input.projectName,
        generatedAt: input.generatedAt,
      },
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      filename: buildGanttPptxFilename(input.projectName),
      mimeType: PPTX_MIME,
    });

    if (response.type === 'ExportGanttPptxResult') {
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          bytes: response.bytes as ArrayBuffer,
          filename: buildGanttPptxFilename(input.projectName),
          mimeType: PPTX_MIME,
        }),
      });
    }
    return Object.freeze({ ok: false as const, error: 'Unexpected worker response type.' });
  } catch (err) {
    return Object.freeze({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

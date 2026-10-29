/**
 * Export project to Word (DOCX) use case (Story 8.4 Task 4/6, Story 16.4, AD-12).
 *
 * Application-layer orchestration: accepts the resolved ViewScope plus
 * in-memory phases/nodes, builds the DocumentProjection via the pure
 * `projectDocument` builder, requests bytes from the ExportWorkerClient, and
 * returns a standard typed Result. Never throws past this boundary.
 *
 * Story 16.4 (E16-FR6): `exportFeatureOnePagerDocx` builds a standalone
 * Feature 1-Pager projection via `projectFeatureOnePager` and renders it
 * through the same worker.
 *
 * The injected clock supplies `generatedAt` as an ISO instant (FR-55, AD-12).
 */

import type { ViewScope } from '../../contracts/view-scope';
import type { Phase } from '../../domain/phase/phase.entity';
import type { Node } from '../../domain/tree/node.entity';
import type { NodeOpenQuestion } from '../../domain/tree/node-question.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import { projectDocument } from '../document/document.projection';
import { projectFeatureOnePager } from './project-document';
import { buildFeatureOnePagerFilename } from './export-filename';
import { ExportWorkerClient } from '../../adapters/export-worker/export-worker.client';
import { DOCX_MIME } from '../../adapters/export-worker/document-docx.renderer';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type AppResult<T, E = string> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export interface ExportDocumentDocxUseCaseInput {
  readonly scope: ViewScope; // resolved Story 8.1 scope (any variant)
  readonly phases: readonly Phase[];
  readonly nodes: readonly Node[];
  readonly projectName: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly generatedAt: string; // injected clock, ISO instant
  readonly locale: string;
  readonly client?: ExportWorkerClient;
}

export interface ExportFeatureOnePagerUseCaseInput {
  readonly featureNodeId: string;
  readonly phases: readonly Phase[];
  readonly nodes: readonly Node[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly openQuestionsByNode?: ReadonlyMap<string, readonly NodeOpenQuestion[]>;
  readonly projectName: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly generatedAt: string; // injected clock, ISO instant
  readonly locale: string;
  readonly client?: ExportWorkerClient;
}

export function buildDocumentDocxFilename(projectName: string): string {
  const slug = projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project';
  return `${slug}-project.docx`;
}

export async function exportDocumentDocx(
  input: ExportDocumentDocxUseCaseInput,
): Promise<AppResult<{ bytes: ArrayBuffer; filename: string; mimeType: string }>> {
  try {
    const projection = projectDocument({
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      projectName: input.projectName,
      nodes: input.nodes,
      phases: input.phases,
      scope: input.scope,
      generatedAt: input.generatedAt,
      locale: input.locale,
    });

    const client = input.client ?? new ExportWorkerClient();
    const requestId = createUuidV7();
    const response = await client.request({
      type: 'ExportDocx',
      requestId,
      format: 'docx',
      projection,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      filename: buildDocumentDocxFilename(input.projectName),
      mimeType: DOCX_MIME,
    });

    if (response.type === 'ExportDocxResult') {
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          bytes: response.bytes as ArrayBuffer,
          filename: buildDocumentDocxFilename(input.projectName),
          mimeType: DOCX_MIME,
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

/**
 * Export a standalone Feature 1-Pager to Word (Story 16.4, E16-FR6).
 * Builds the one-pager projection and renders it through the export worker.
 */
export async function exportFeatureOnePagerDocx(
  input: ExportFeatureOnePagerUseCaseInput,
): Promise<AppResult<{ bytes: ArrayBuffer; filename: string; mimeType: string }>> {
  try {
    const built = projectFeatureOnePager({
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      projectName: input.projectName,
      featureNodeId: input.featureNodeId,
      nodes: input.nodes,
      phases: input.phases,
      unlockEdges: input.unlockEdges,
      openQuestionsByNode: input.openQuestionsByNode,
      generatedAt: input.generatedAt,
      locale: input.locale,
    });
    if (!('projection' in built)) {
      return Object.freeze({ ok: false as const, error: built.error });
    }

    const client = input.client ?? new ExportWorkerClient();
    const requestId = createUuidV7();
    const filename = buildFeatureOnePagerFilename(built.featureTitle);
    const response = await client.request({
      type: 'ExportDocx',
      requestId,
      format: 'docx',
      projection: built.projection,
      projectId: input.projectId,
      projectRevision: input.projectRevision,
      filename,
      mimeType: DOCX_MIME,
    });

    if (response.type === 'ExportDocxResult') {
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          bytes: response.bytes as ArrayBuffer,
          filename,
          mimeType: DOCX_MIME,
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

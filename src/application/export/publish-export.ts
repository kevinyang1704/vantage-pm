/**
 * Export publication orchestration (Story 8.5 Task 8, AC3, AD-12).
 *
 * Publishes an already-generated package. Retrying a `PublicationFailed`
 * failure calls this again with the SAME GeneratedPackage — no regeneration,
 * no re-resolution.
 *
 * INVARIANT: this module and everything it imports never constructs or
 * dispatches a ProductCommand. Projection (8.1/8.2) is a pure read; generation
 * (8.3/8.4) formats that read; publication (this story) writes bytes to disk.
 * This is what makes "retry can never duplicate a model mutation" true by
 * construction, not discipline.
 */

import type { PublishResult } from '../../contracts/export-publish';
import { saveGeneratedFile } from '../../adapters/platform/save-generated-file';

export interface GeneratedPackage {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  readonly sourceProjectRevision: number;
}

export type SaveFilePort = (
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
) => Promise<PublishResult>;

/**
 * Publish an already-generated package. Retrying a PublicationFailed failure
 * calls this again with the SAME GeneratedPackage — no regeneration.
 */
export async function publishExport(
  pkg: GeneratedPackage,
  saveFile: SaveFilePort = saveGeneratedFile,
): Promise<PublishResult> {
  return saveFile(pkg.bytes, pkg.filename, pkg.mimeType);
}

/**
 * Detect whether the preview-time scope is stale against the live project
 * revision before ever invoking generation. Returns a ScopeStale failure if
 * they differ; otherwise returns ok:true to proceed.
 */
export function checkExportScopeFresh(
  previewedProjectRevision: number,
  currentProjectRevision: number,
): PublishResult | null {
  if (previewedProjectRevision !== currentProjectRevision) {
    return Object.freeze({
      ok: false as const,
      failure: Object.freeze({
        kind: 'ScopeStale',
        staleProjectRevision: previewedProjectRevision,
        currentProjectRevision,
      }),
    });
  }
  return null;
}

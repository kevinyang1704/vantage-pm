/**
 * Export-failure feedback (Story 8.5 Task 7, AC1).
 *
 * View-agnostic formatter mapping an `ExportFailure.kind` to a human-safe
 * `{ cause, resultingState }` pair, mirroring `command-feedback.ts`'s
 * `RejectionFeedback` / `formatCommandRejection` pattern. Every branch
 * preserves project input and queued edits (AC1).
 *
 * `SelectionCancelled` is deliberately neutral, non-alarming copy — a user
 * dismissing the save picker is a cancellation, not an error.
 */

import type { ExportFailure } from '../../contracts/export-publish';

export interface ExportFeedback {
  readonly cause: string;
  readonly resultingState: string;
}

export function formatExportFailure(failure: ExportFailure): ExportFeedback {
  switch (failure.kind) {
    case 'ScopeStale':
      return Object.freeze({
        cause: `The project changed (revision ${failure.staleProjectRevision} → ${failure.currentProjectRevision}) since this export was previewed.`,
        resultingState:
          'No file was generated and nothing was mutated. Re-open export to see the current scope.',
      });
    case 'GenerationFailed':
      return Object.freeze({
        cause: `Export generation failed: ${failure.detail}`,
        resultingState: 'No file was written; the project and your edits are unchanged.',
      });
    case 'SelectionCancelled':
      return Object.freeze({
        cause: 'The save dialog was closed without choosing a location.',
        resultingState: 'No file was written. You may retry at any time.',
      });
    case 'PublicationFailed':
      return Object.freeze({
        cause: `The generated document could not be saved: ${failure.detail}`,
        resultingState: 'Generation already succeeded. Retry will republish the same generated document.',
      });
  }
}

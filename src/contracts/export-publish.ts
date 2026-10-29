/**
 * Export publish contracts (Story 8.5, AD-12, AD-14, AD-15).
 *
 * The four failure stages named in epics.md Story 8.5 AC1 unified into one
 * typed surface. `ExportFailure.kind` is a stable machine discriminant, not
 * prose — the human `{ cause, resultingState }` pair is a separate formatter
 * (src/adapters/ui/export-feedback.ts), never inlined here.
 *
 * `SelectionCancelled` deliberately carries no detail — a user-dismissed save
 * picker is a legitimate cancellation, not an error.
 */

export type ExportFailure =
  | Readonly<{ kind: 'ScopeStale'; staleProjectRevision: number; currentProjectRevision: number }>
  | Readonly<{ kind: 'GenerationFailed'; detail: string }>
  | Readonly<{ kind: 'SelectionCancelled' }>
  | Readonly<{ kind: 'PublicationFailed'; detail: string }>;

export type SavedVia = 'FileSystemAccess' | 'DownloadFallback' | 'TauriSaveDialog';

export type PublishResult =
  | Readonly<{ ok: true; filename: string; savedVia: SavedVia }>
  | Readonly<{ ok: false; failure: ExportFailure }>;

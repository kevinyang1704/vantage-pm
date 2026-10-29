/**
 * Portable-file error contracts (Story 1.8 Task 3, AD-13).
 *
 * Discriminated union of import/export rejection causes.
 * Mirrors the pattern from portable-file.schema.ts's PortableFileRejection
 * but scoped to the application-layer import/export operations.
 */

/** Rejection causes for project export. */
export type ExportRejection =
  | Readonly<{ type: 'QueueNotSettled'; projectId: string; cause: string }>
  | Readonly<{ type: 'ProjectNotFound'; projectId: string }>
  | Readonly<{ type: 'SerializationFailed'; cause: string }>;

/** Rejection causes for project import. */
export type ImportRejection =
  | Readonly<{ type: 'MalformedFile'; cause: string }>
  | Readonly<{ type: 'ValidationFailed'; cause: string }>
  | Readonly<{ type: 'DuplicateProjectId'; projectId: string }>
  | Readonly<{ type: 'DispatchFailed'; cause: string }>;

/**
 * Pick-and-import portable project use case (Epic 15 side-nav hierarchy).
 *
 * Single implementation of the desktop portable-import flow behind the
 * side-nav Import action. The task contract is "reuse the existing
 * portable-project import flow; do not invent a second import path" — this
 * module is that one path.
 *
 * Flow:
 *  1. Open the native file dialog for *.pmapp.json / *.json (via ports).
 *  2. Read the file bytes through the narrow native read command
 *     (E9-NFR8: no broad fs — the read port is the only file access).
 *  3. Validate the entire file before any mutation (AD-13).
 *  4. Atomically import the validated candidate (E13 Task 4).
 *  5. Refresh the project list through the listProjects port so the side
 *     shelf shows the imported project immediately — no reload.
 *
 * Ports keep Tauri (and any future picker) out of the application layer.
 */

import type { PortableProjectSnapshot } from '../../contracts/portable-file.schema';
import { importProject, type ImportRejection } from './import-project';

/** Result of a pick-and-import attempt. */
export type PickAndImportResult =
  | Readonly<{ kind: 'imported'; projectName: string; revision: number }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'rejected'; error: ImportRejection }>
  | Readonly<{ kind: 'failed'; cause: string }>;

/** Human-readable description of an import rejection. */
export function describeImportRejection(error: ImportRejection): string {
  switch (error.type) {
    case 'MalformedJson': return `This is not a valid portable project file (${error.cause}).`;
    case 'UnsupportedNewerSchema': return `This file was created by a newer Vantage build (schema ${error.found}). Update the app to import it.`;
    case 'UnknownFieldsAtCurrentVersion': return `This file contains fields this build does not recognize (${error.fields.join(', ')}).`;
    case 'MissingRequiredField': return `This file is missing a required field (${error.field}).`;
    case 'InvalidProjectId': return `The file's project identifier is invalid.`;
    case 'InvalidProjectName': return `The file's project name is invalid.`;
    case 'ActiveContentDetected': return `The file contains content that is not allowed (${error.field}).`;
    case 'LimitExceeded': return `The file is too large to import.`;
    case 'DuplicateProjectId': return `A project with this identifier already exists in the workspace.`;
    default: return 'The file could not be imported.';
  }
}

/** File-picking ports — implemented by the platform adapter (Tauri). */
export interface PortableFilePickerPort {
  /** Opens the native file dialog. Resolves `null` when the user cancels. */
  openFilePicker(): Promise<string | null>;
  /** Reads the chosen file's bytes as a string (narrow native command). */
  readFile(path: string): Promise<string>;
}

/** Ports the pick-and-import use case needs from the composition root. */
export interface PickAndImportPorts {
  /** Atomically imports the validated candidate (batchImportPortable). */
  importCandidate: (
    candidate: PortableProjectSnapshot,
  ) => Promise<{ ok: boolean; cause?: string }>;
  /** Verifies the imported project exists (queryProjects → match by id). */
  verifyImported: (projectId: string) => Promise<{ name: string; revision: number } | null>;
  /** Refreshes the composition-root project list after a successful import. */
  listProjects: () => Promise<readonly { id: string; name: string; revision: number }[]>;
  /** Applies the refreshed project list to composition-root state. */
  applyProjects: (projects: readonly { id: string; name: string; revision: number }[]) => void;
}

/**
 * Run the shared pick-and-import flow.
 *
 * Returns an outcome for the caller to announce; the flow itself performs
 * the file dialog, validation, atomic import, and project-list refresh.
 */
export async function pickAndImportPortableProject(
  picker: PortableFilePickerPort,
  ports: PickAndImportPorts,
): Promise<PickAndImportResult> {
  try {
    const path = await picker.openFilePicker();
    if (path === null) {
      return Object.freeze({ kind: 'cancelled' });
    }

    const raw = await picker.readFile(path);

    // Full validation before any mutation (AD-13); legacy v1 files upgrade.
    const imported = importProject(raw, () => false);
    if (!imported.ok) {
      return Object.freeze({ kind: 'rejected', error: imported.error });
    }

    const outcome = await ports.importCandidate(imported.candidate);
    if (!outcome.ok) {
      return Object.freeze({
        kind: 'failed',
        cause: outcome.cause ?? 'the project already exists in this workspace.',
      });
    }

    // Refresh the shelf immediately — no reload required.
    const projects = await ports.listProjects();
    ports.applyProjects(projects);

    const verified = await ports.verifyImported(imported.candidate.projectId);
    if (verified) {
      return Object.freeze({ kind: 'imported', projectName: verified.name, revision: verified.revision });
    }
    return Object.freeze({ kind: 'imported', projectName: imported.candidate.projectName, revision: 0 });
  } catch (error) {
    return Object.freeze({
      kind: 'failed',
      cause: error instanceof Error ? error.message : 'Import failed',
    });
  }
}

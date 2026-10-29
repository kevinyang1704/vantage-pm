/**
 * In-memory workspace summary cache (Story 5.1 Task 5, AD-2).
 *
 * Memoizes per-project workspace rows keyed by (projectId, projectRevision).
 * Never persisted to SQLite, never in the portable file. A revision
 * mismatch forces a recompute even if invalidate() was missed.
 */

import type { WorkspaceProjectRow } from '../../contracts/workspace-overview';

export class WorkspaceSummaryCache {
  #entries = new Map<string, { revision: number; row: WorkspaceProjectRow }>();

  get(projectId: string, revision: number): WorkspaceProjectRow | undefined {
    const entry = this.#entries.get(projectId);
    if (!entry) return undefined;
    if (entry.revision !== revision) return undefined;
    return entry.row;
  }

  set(projectId: string, revision: number, row: WorkspaceProjectRow): void {
    this.#entries.set(projectId, { revision, row });
  }

  invalidate(projectId: string): void {
    this.#entries.delete(projectId);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

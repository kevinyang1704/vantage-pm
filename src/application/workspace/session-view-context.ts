/**
 * Session view context (Story 5.4 Task 1, AD-5 tier 3).
 *
 * In-memory-only per-(projectId, viewId) session record. Never persisted
 * to SQLite, never in the portable file.
 */

import type { ViewId } from '../../contracts/view-state';

export type SessionViewContext = Readonly<{
  focusedNodeId: string | null;
  focusReturnNodeId: string | null;
}>;

export function sessionViewContextKey(projectId: string, viewId: ViewId): string {
  return `${projectId}:${viewId}`;
}

export function createDefaultSessionViewContext(): SessionViewContext {
  return Object.freeze({ focusedNodeId: null, focusReturnNodeId: null });
}

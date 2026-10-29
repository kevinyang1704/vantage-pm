/**
 * Inward-owned InteractionStatePort (Story 2.5 Task 2, AD-5).
 */

import type {
  ViewId,
  ViewStatePatch,
  ViewStateSnapshot,
} from '../../contracts/view-state';

export type PutViewStateResult =
  | Readonly<{ kind: 'Applied'; snapshot: ViewStateSnapshot }>
  | Readonly<{ kind: 'StaleBase'; snapshot: ViewStateSnapshot }>
  | Readonly<{ kind: 'Failed'; code: string; cause: string; snapshot: ViewStateSnapshot | null }>;

export interface InteractionStatePort {
  getViewState(projectId: string, viewId: ViewId): Promise<ViewStateSnapshot>;
  putViewState(
    projectId: string,
    viewId: ViewId,
    baseViewStateRevision: number,
    patch: ViewStatePatch,
  ): Promise<PutViewStateResult>;
}

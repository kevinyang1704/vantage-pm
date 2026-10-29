/**
 * ViewState contracts (Story 2.5 Task 1, AD-5).
 *
 * Defines the types for interaction preferences (collapse set, zoom root,
 * scroll, focused theme, date window, granularity) on the isolated view-state lane.
 * These never enter domain ChangeSets, undo/redo, or portable files.
 */

import { assertUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';

export type ViewId = 'outline' | 'visual' | 'gantt';
export const VIEW_IDS: readonly ViewId[] = Object.freeze(['outline', 'visual', 'gantt']);

export type ViewStateFields = Readonly<{
  collapsedNodeIds: readonly string[];
  zoomRootId: string | null;
  scrollTop: number;
  focusedThemeId: string | null;
  dateWindowStart: string | null;
  dateWindowEnd: string | null;
  granularity: 'week' | 'month' | 'quarter' | null;
  /** Visual-tree viewport pan offset (E10-FR12, E10-AR9). */
  panX: number;
  /** Visual-tree viewport pan offset (E10-FR12, E10-AR9). */
  panY: number;
  /** Visual-tree viewport scale (E10-FR12, E10-AR9). */
  scale: number;
  /** Side-navigation collapsed presentation, per project + view (E15-FR5, E15-AR2). */
  navCollapsed: boolean;
}>;

export type ViewStatePatch = Readonly<Partial<ViewStateFields>>;

export type ViewStateSnapshot = Readonly<{
  projectId: string;
  viewId: ViewId;
  viewStateRevision: number;
  fields: ViewStateFields;
}>;

export function createDefaultViewStateFields(): ViewStateFields {
  return Object.freeze({
    collapsedNodeIds: Object.freeze([]),
    zoomRootId: null,
    scrollTop: 0,
    focusedThemeId: null,
    dateWindowStart: null,
    dateWindowEnd: null,
    granularity: null,
    panX: 0,
    panY: 0,
    scale: 1,
    navCollapsed: false,
  });
}

export function createViewStateSnapshot(params: {
  projectId: string;
  viewId: ViewId;
  viewStateRevision: number;
  fields?: Partial<ViewStateFields>;
}): ViewStateSnapshot {
  assertUuidV7(params.projectId, 'ViewStateSnapshot.projectId');
  const defaults = createDefaultViewStateFields();
  const merged: ViewStateFields = Object.freeze({
    ...defaults,
    ...params.fields,
    collapsedNodeIds: Object.freeze(params.fields?.collapsedNodeIds ?? defaults.collapsedNodeIds),
  });

  return Object.freeze({
    projectId: params.projectId,
    viewId: params.viewId,
    viewStateRevision: params.viewStateRevision,
    fields: merged,
  });
}

export function applyViewStatePatch(
  current: ViewStateFields,
  patch: ViewStatePatch,
): ViewStateFields {
  return Object.freeze({
    collapsedNodeIds:
      patch.collapsedNodeIds !== undefined
        ? Object.freeze([...patch.collapsedNodeIds])
        : current.collapsedNodeIds,
    zoomRootId: patch.zoomRootId !== undefined ? patch.zoomRootId : current.zoomRootId,
    scrollTop: patch.scrollTop !== undefined ? patch.scrollTop : current.scrollTop,
    focusedThemeId:
      patch.focusedThemeId !== undefined ? patch.focusedThemeId : current.focusedThemeId,
    dateWindowStart:
      patch.dateWindowStart !== undefined ? patch.dateWindowStart : current.dateWindowStart,
    dateWindowEnd:
      patch.dateWindowEnd !== undefined ? patch.dateWindowEnd : current.dateWindowEnd,
    granularity: patch.granularity !== undefined ? patch.granularity : current.granularity,
    panX: patch.panX !== undefined ? patch.panX : current.panX,
    panY: patch.panY !== undefined ? patch.panY : current.panY,
    scale: patch.scale !== undefined ? patch.scale : current.scale,
    navCollapsed: patch.navCollapsed !== undefined ? patch.navCollapsed : current.navCollapsed,
  });
}

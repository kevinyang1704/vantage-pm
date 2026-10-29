/**
 * Layout worker protocol (Story 6.1 Task 5, AD-6).
 *
 * Disposable-geometry-only: LayoutResultResponse carries coordinates and
 * never any field capable of expressing sibling order, position, or parentId.
 */

import type { VisualTreeProjection } from './visual-tree';

export interface LayoutSnapshotRequest {
  readonly type: 'LayoutSnapshot';
  readonly visualTree: VisualTreeProjection;
}

export interface NodeGeometry {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EdgeGeometry {
  readonly edgeId: string;
  readonly points: readonly Readonly<{ x: number; y: number }>[];
}

export interface LayoutResultResponse {
  readonly type: 'LayoutResult';
  readonly projectId: string;
  readonly projectRevision: number;
  readonly themeId: string;
  readonly nodeGeometry: readonly NodeGeometry[];
  readonly edgeGeometry: readonly EdgeGeometry[]; // only for edges with both endpoints in-subtree
  readonly computedDurationMs: number;
}

export interface LayoutFailedResponse {
  readonly type: 'LayoutFailed';
  readonly projectId: string;
  readonly themeId: string;
  readonly reason: string;
}

export type LayoutWorkerRequest = LayoutSnapshotRequest;
export type LayoutWorkerResponse = LayoutResultResponse | LayoutFailedResponse;
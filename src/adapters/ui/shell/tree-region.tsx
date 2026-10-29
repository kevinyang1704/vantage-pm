/**
 * TreeRegion — the outline tree area with four discriminated states.
 *
 * States:
 *   loading — aria-busy, reserved geometry, written state (no spinner, no motion)
 *   empty   — names the absence, offers one resolving action
 *   ready   — renders children (Story 2.2 supplies the virtualized list)
 *   error   — cause + resulting state, input never discarded (NFR-19)
 *
 * The region reserves its geometry in every state (fixed flex child, explicit min-height).
 */

import type { ReactNode } from 'react';
import './tree-region.css';

export type TreeRegionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly onCreateFirstNode: () => void }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly cause: string; readonly resultingState: string };

export interface TreeRegionProps {
  readonly state: TreeRegionState;
  readonly children?: ReactNode;
}

export function TreeRegion({ state, children }: TreeRegionProps): React.ReactElement {
  switch (state.kind) {
    case 'loading':
      return (
        <div className="pm-tree-region-state pm-tree-region--loading">
          <span className="pm-tree-region-message">
            Loading outline
          </span>
        </div>
      );

    case 'empty':
      return (
        <div className="pm-tree-region-state pm-tree-region--empty">
          <p className="pm-tree-region-message">
            No nodes yet. An empty project is a normal starting point.
          </p>
          <button
            className="pm-tree-region-action"
            type="button"
            onClick={state.onCreateFirstNode}
          >
            Create first node
          </button>
        </div>
      );

    case 'error':
      return (
        <div className="pm-tree-region-state pm-tree-region--error">
          <p className="pm-tree-region-message">
            Failed to load outline: {state.cause}
          </p>
          <p className="pm-tree-region-resulting-state">
            State: {state.resultingState}
          </p>
        </div>
      );

    case 'ready':
      return (
        <div className="pm-tree-region-state pm-tree-region--ready">
          {children}
        </div>
      );
  }
}

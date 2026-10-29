/**
 * Outline fixture seeding surface (Story 2.2 Task 6, .test-only).
 * Excluded from production bundle via tree-shaking and checked by check-production-bundle.mjs.
 */

import type { OutlineNodeReadModel, OutlineReadModel } from '../application/outline/outline-read-model';

export type OutlineFixtureSeedFn = (nodes: readonly OutlineNodeReadModel[]) => void;

interface OutlineFixtureGlobal {
  seed: (nodes: readonly OutlineNodeReadModel[]) => void;
  registerListener: (listener: OutlineFixtureSeedFn) => () => void;
}

declare global {
  interface Window {
    __PMAPP_OUTLINE_FIXTURE__?: OutlineFixtureGlobal;
  }
}

let activeListener: OutlineFixtureSeedFn | null = null;

if (typeof window !== 'undefined') {
  window.__PMAPP_OUTLINE_FIXTURE__ = {
    seed(nodes: readonly OutlineNodeReadModel[]) {
      if (activeListener) {
        activeListener(nodes);
      }
    },
    registerListener(listener: OutlineFixtureSeedFn) {
      activeListener = listener;
      return () => {
        if (activeListener === listener) {
          activeListener = null;
        }
      };
    },
  };
}

export function registerOutlineFixtureListener(listener: OutlineFixtureSeedFn): () => void {
  activeListener = listener;
  return () => {
    if (activeListener === listener) {
      activeListener = null;
    }
  };
}

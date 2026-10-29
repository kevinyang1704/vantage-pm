/**
 * CollaborationMount (Story 27.10 AC 27.10-3, AD-20).
 *
 * A tiny, always-imported stub whose ONLY job is to load the collaboration UI
 * lazily when the build flag is on. With the flag off the dynamic import is in a
 * dead branch Rollup eliminates, so the production bundle contains no
 * collaboration chunk at all; with the flag on it is a separate chunk loaded on
 * demand.
 *
 * `__PMAPP_COLLABORATION__` is a build-time constant (see `vite.config.ts`);
 * reading it here (not via a helper) lets the bundler fold the branch.
 */

import { useEffect, useState } from 'react';
import type { CollaborationLayerProps } from './collaboration-layer';

declare const __PMAPP_COLLABORATION__: boolean | undefined;

const ENABLED =
  typeof __PMAPP_COLLABORATION__ !== 'undefined' && __PMAPP_COLLABORATION__ === true;

type LayerComponent = React.ComponentType<CollaborationLayerProps>;

export function CollaborationMount(props: CollaborationLayerProps): React.ReactElement | null {
  const [Layer, setLayer] = useState<LayerComponent | null>(null);

  useEffect(() => {
    if (!ENABLED) return;
    let cancelled = false;
    void import('./collaboration-layer').then((mod) => {
      if (!cancelled) setLayer(() => mod.CollaborationLayer);
    });
    return () => { cancelled = true; };
  }, []);

  if (!ENABLED || !Layer) return null;
  return <Layer {...props} />;
}

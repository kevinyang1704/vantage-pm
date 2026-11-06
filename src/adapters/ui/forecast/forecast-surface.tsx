/**
 * Forecast surface switch.
 *
 * Delivery Board is the default; the detailed ForecastWorkspace remains the
 * List view. The choice persists in browser storage and can be overridden for
 * manual/test entry with `?forecastView=board|list`.
 */

import { useCallback, useState } from 'react';
import type { ForecastWorkspaceProps } from './forecast-workspace';
import { ForecastWorkspace } from './forecast-workspace';
import { DeliveryBoard } from './delivery-board';
import {
  readForecastViewPreference,
  writeForecastViewPreference,
  type ForecastView,
} from './forecast-view-preference';

export interface ForecastSurfaceProps extends ForecastWorkspaceProps {
  /**
   * Nearest Theme/Component title for a scope member. Used only by the
   * delivery milestone labels; absence falls back to feature titles.
   */
  readonly groupTitle?: (id: string) => string | null;
  /** Unlock edges between nodes: a dependency on the Delivery Board. */
  readonly unlockEdges?: readonly Readonly<{ sourceNodeId: string; targetNodeId: string }>[];
  /** Save the Delivery Board's sprint plan; `addFeatureId` joins the plan first. */
  readonly onSetSprintPlan?: (
    sprintPlan: import('../../../domain/forecast/forecast-plan.entity').ForecastSprintPlan,
    addFeatureId?: string,
  ) => Promise<boolean>;
}

export function ForecastSurface(props: ForecastSurfaceProps): React.ReactElement {
  const [view, setView] = useState<ForecastView>(() => readForecastViewPreference());

  const switchTo = useCallback((next: ForecastView) => {
    writeForecastViewPreference(next);
    setView(next);
  }, []);

  if (view === 'list') {
    const { unlockEdges: _unlockEdges, onSetSprintPlan: _onSetSprintPlan, ...workspaceProps } = props;
    return <ForecastWorkspace {...workspaceProps} onSwitchView={() => switchTo('board')} />;
  }

  return <DeliveryBoard {...props} onSwitchView={() => switchTo('list')} />;
}

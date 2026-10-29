/**
 * Person busy/idle lanes (Epic 26, Story 26.3, FC-FR3, FC-NFR4).
 *
 * Renders the pure `LanesView` (forecast-lanes.ts) on the 26.2 sprint axis:
 * one lane per person with busy segments (one solid block per item, labelled
 * with the item name) and dashed idle segments. At most 12 lanes show at once
 * with accessible paging (AC 26.3-4). Colour is never the only signal: every
 * segment carries a title and the lane carries a full sentence.
 */

import type { ReducedRatio } from '../../../domain/forecast/forecast-canonical';
import { LANE_PAGE_SIZE, type LanesView } from '../../../application/forecast/forecast-lanes';
import type { TimelineAxis } from '../../../application/forecast/forecast-timeline';

function ratioValue(r: ReducedRatio): number {
  return r.numerator / r.denominator;
}

export interface PersonLanesProps {
  readonly view: LanesView;
  readonly axis: TimelineAxis | null;
  readonly page: number;
  readonly onPage: (page: number) => void;
  /** Live title of a feature id, for the busy-segment text. */
  readonly nameForFeature: (id: string) => string;
}

export function PersonLanes({ view, axis, page, onPage, nameForFeature }: PersonLanesProps): React.ReactElement | null {
  if (!axis || view.lanes.length === 0) return null;
  const span = Math.max(axis.spanSprints, 1);
  const pageCount = Math.max(Math.ceil(view.lanes.length / LANE_PAGE_SIZE), 1);
  const start = page * LANE_PAGE_SIZE;
  const shown = view.lanes.slice(start, start + LANE_PAGE_SIZE);
  const idlePoints = Math.round(ratioValue(view.totalIdlePoints));

  return (
    <section className="pm-forecast__lanes" aria-label="Who is busy when" role="group">
      <div className="pm-forecast__lanes-head">
        <span className="pm-forecast__lanes-title">
          Who is busy when{view.mode === 'whole-team' ? ' · Whole team' : ''}
        </span>
        <span className="pm-forecast__lanes-idle-summary">
          Dashed gaps are idle capacity: ≈ {idlePoints} pts
        </span>
        {pageCount > 1 && (
          <span className="pm-forecast__lanes-pager">
            <button
              type="button"
              className="pm-forecast__button pm-forecast__button--small"
              onClick={() => onPage(Math.max(page - 1, 0))}
              disabled={page === 0}
            >
              Previous lanes
            </button>
            <span aria-live="polite" className="pm-forecast__lanes-page-label">
              Lanes {start + 1}–{Math.min(start + LANE_PAGE_SIZE, view.lanes.length)} of {view.lanes.length}
            </span>
            <button
              type="button"
              className="pm-forecast__button pm-forecast__button--small"
              onClick={() => onPage(Math.min(page + 1, pageCount - 1))}
              disabled={page >= pageCount - 1}
            >
              Next lanes
            </button>
          </span>
        )}
      </div>
      <ul className="pm-forecast__lanes-list">
        {shown.map((lane) => (
          <li key={lane.personId} className="pm-forecast__lane">
            <span className="pm-forecast__lane-name">{lane.name}</span>
            <span className="pm-forecast__lane-track" role="img" aria-label={lane.text}>
              {lane.segments.map((segment, idx) => {
                const left = (ratioValue(segment.startOffset) / span) * 100;
                const width = ((ratioValue(segment.finishOffset) - ratioValue(segment.startOffset)) / span) * 100;
                return (
                  <span
                    key={`${segment.kind}-${segment.featureId ?? 'idle'}-${idx}`}
                    className={`pm-forecast__lane-segment pm-forecast__lane-segment--${segment.kind}`}
                    style={{ left: `${left}%`, width: `${Math.max(width, 0)}%` }}
                  />
                );
              })}
            </span>
            <span className="pm-forecast__lane-busy-names" aria-hidden="true">
              {lane.entirelyIdle
                ? 'Idle'
                : lane.segments
                    .filter((s) => s.kind === 'busy' && s.featureId)
                    .map((s) => nameForFeature(s.featureId!))
                    .join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

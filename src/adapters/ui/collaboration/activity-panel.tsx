/**
 * ActivityPanel — recent confirmed changes, newest first (Story 27.8, TC-FR7, TC-UX2).
 *
 * Plain-language descriptions from confirmed commands only. Filter by person
 * and page. Bounded rows (23.11/25.1) are the caller's concern; this renders a
 * supplied page.
 */

import { relativeTime } from '../../../domain/collaboration/attribution';
import './activity-panel.css';

export interface ActivityRowView {
  readonly serverRevision: number;
  readonly actorId: string;
  readonly actorName: string;
  readonly description: string;
  readonly confirmedAtISO: string;
}

export interface ActivityPanelProps {
  readonly rows: readonly ActivityRowView[];
  readonly nowISO: string;
  readonly filterActorId: string | null;
  readonly people: readonly Readonly<{ actorId: string; actorName: string }>[];
  readonly hasMore: boolean;
  readonly onFilterChange: (actorId: string | null) => void;
  readonly onLoadMore: () => void;
}

export function ActivityPanel(props: ActivityPanelProps): React.ReactElement {
  return (
    <section className="pm-activity" aria-labelledby="pm-activity-title">
      <div className="pm-activity__header">
        <h2 id="pm-activity-title" className="pm-activity__title">Activity</h2>
        <label className="pm-activity__filter">
          <span className="pm-activity__filter-label">Filter</span>
          <select
            value={props.filterActorId ?? ''}
            onChange={(e) => props.onFilterChange(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Everyone</option>
            {props.people.map((person) => (
              <option key={person.actorId} value={person.actorId}>{person.actorName}</option>
            ))}
          </select>
        </label>
      </div>
      {props.rows.length === 0 ? (
        <p className="pm-activity__empty">No changes yet.</p>
      ) : (
        <ul className="pm-activity__list">
          {props.rows.map((row) => (
            <li key={row.serverRevision} className="pm-activity__row">
              <span className="pm-activity__desc">{row.description}</span>
              <time className="pm-activity__time" dateTime={row.confirmedAtISO}>
                {relativeTime(row.confirmedAtISO, props.nowISO)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {props.hasMore ? (
        <button type="button" className="pm-activity__more" onClick={props.onLoadMore}>Load older</button>
      ) : null}
    </section>
  );
}

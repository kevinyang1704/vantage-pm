/**
 * Theme timeline (Story 24.2, DO-FR4/DO-FR5, DO-UX3).
 *
 * Renders every theme lane against one shared project domain so schedules
 * compare directly. Pure geometry lives in
 * `application/workspace/workspace-overview-timeline.ts`; this component only
 * lays it out. Bars express planned dates — never progress, effort or
 * forecast confidence. No dragging, resizing or date mutation.
 */

import type { TimelineDomain, TimelineScheduleState } from '../../../application/workspace/workspace-overview-timeline';
import {
  computeTimelineBar,
  computeTimelineTicks,
  todayPositionPercent,
} from '../../../application/workspace/workspace-overview-timeline';
import './theme-timeline.css';

export interface ThemeTimelineAxisProps {
  readonly domain: TimelineDomain;
  readonly todayIso: string | null;
  readonly label: string;
}

function formatExactDate(iso: string): string {
  // ISO YYYY-MM-DD -> "Mon D" (local date, no timezone conversion).
  const [, month, day] = iso.split('-');
  const monthAbbr = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const index = Number(month) - 1;
  return `${monthAbbr[index] ?? month} ${Number(day)}`;
}

/**
 * Near either end of the axis a centred label would spill past the timeline,
 * so it anchors to that edge instead.
 */
export function todayLabelEdgeModifier(percent: number): string {
  if (percent < 8) return ' pm-theme-timeline-axis__today-label--start';
  if (percent > 92) return ' pm-theme-timeline-axis__today-label--end';
  return '';
}

export function ThemeTimelineAxis({ domain, todayIso, label }: ThemeTimelineAxisProps): React.ReactElement {
  const ticks = computeTimelineTicks(domain);
  const todayPercent = todayIso ? todayPositionPercent(domain, todayIso) : null;

  return (
    <div className="pm-theme-timeline-axis" role="img" aria-label={label}>
      <div className="pm-theme-timeline-axis__track">
        {ticks.map((tick) => (
          <span
            key={`${tick.label}-${tick.leftPercent}`}
            className={`pm-theme-timeline-axis__tick pm-theme-timeline-axis__tick--${tick.kind}`}
            style={{ left: `${tick.leftPercent}%` }}
          >
            {tick.label}
          </span>
        ))}
        {todayPercent !== null && (
          <span
            className={`pm-theme-timeline-axis__today-label${todayLabelEdgeModifier(todayPercent)}`}
            style={{ left: `${todayPercent}%` }}
          >
            Today · {formatExactDate(todayIso as string)}
          </span>
        )}
      </div>
    </div>
  );
}

export interface ThemeTimelineLaneProps {
  readonly domain: TimelineDomain;
  readonly state: TimelineScheduleState;
  readonly todayIso: string | null;
  readonly themeName: string;
}

export function ThemeTimelineLane({ domain, state, todayIso, themeName }: ThemeTimelineLaneProps): React.ReactElement {
  if (state.kind !== 'scheduled') {
    const message =
      state.kind === 'not_scheduled'
        ? 'Not scheduled'
        : state.kind === 'incomplete'
          ? 'Dates incomplete'
          : 'Invalid schedule';
    return (
      <div className="pm-theme-timeline-lane pm-theme-timeline-lane--empty">
        <span className="pm-theme-timeline-lane__state">{message}</span>
      </div>
    );
  }

  const bar = computeTimelineBar(state, domain);
  const todayPercent = todayIso ? todayPositionPercent(domain, todayIso) : null;
  const startLabel = formatExactDate(state.startDate);
  const endLabel = formatExactDate(state.endDate);
  const ariaLabel = `${themeName}: planned ${state.startDate} to ${state.endDate}`;

  return (
    <div className="pm-theme-timeline-lane">
      <div className="pm-theme-timeline-lane__chart" role="img" aria-label={ariaLabel}>
        {bar && (
          <span
            className="pm-theme-timeline-lane__bar"
            style={{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }}
          />
        )}
        {todayPercent !== null && (
          <span
            className="pm-theme-timeline-lane__today"
            style={{ left: `${todayPercent}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <span className="pm-theme-timeline-lane__dates">
        {startLabel} – {endLabel}
      </span>
    </div>
  );
}

/**
 * Delivery Board team panel. Shows shared capacity or the staffed roster and
 * keeps the capacity lever visible next to the trade-off bench.
 */

import { useEffect, useState } from 'react';
import type { ForecastPlan } from '../../../domain/forecast/forecast-plan.entity';
import type { ForecastResult } from '../../../domain/forecast/forecast-result';

export interface DeliveryTeamPanelProps {
  readonly plan: ForecastPlan;
  readonly result: ForecastResult | null;
  readonly onSaveConfiguration: (config: {
    pointsPerSprint: number | null;
    sprintLengthDays: number | null;
    startSprintOrdinal: number | null;
    startDate: string | null;
  }) => void;
  readonly onOpenPeople?: () => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase();
}

export function DeliveryTeamPanel({
  plan,
  result,
  onSaveConfiguration,
  onOpenPeople,
}: DeliveryTeamPanelProps): React.ReactElement {
  const config = plan.configuration;
  const isStaffed = plan.policyVersion === 'staffed-capacity-v1';
  const capacity = isStaffed ? (result?.arithmetic?.pointsPerSprint ?? null) : config.pointsPerSprint;
  const [editing, setEditing] = useState(false);
  const [capacityDraft, setCapacityDraft] = useState(config.pointsPerSprint?.toString() ?? '');

  useEffect(() => {
    setCapacityDraft(config.pointsPerSprint?.toString() ?? '');
  }, [config.pointsPerSprint]);

  const saveCapacity = (): void => {
    if (!editing) return;
    const raw = capacityDraft.trim();
    const next = raw === '' ? null : Number(raw);
    if (next !== null && (!Number.isSafeInteger(next) || next < 0)) return;
    onSaveConfiguration({
      pointsPerSprint: next,
      sprintLengthDays: config.sprintLengthDays,
      startSprintOrdinal: config.startSprintOrdinal,
      startDate: config.startDate,
    });
    setEditing(false);
  };

  return (
    <section className="pm-delivery__team" aria-label="Team capacity">
      <div className="pm-delivery__panel-head">
        <span>Team</span>
        <span className="pm-delivery__panel-meta">
          {isStaffed ? `${plan.roster.length} ${plan.roster.length === 1 ? 'person' : 'people'}` : 'Whole team'}
        </span>
      </div>

      {isStaffed ? (
        <>
          <div className="pm-delivery__roster">
            {plan.roster.length === 0 && (
              <p className="pm-delivery__note">No people on the roster yet.</p>
            )}
            {plan.roster.map((person) => (
              <div className="pm-delivery__person" key={person.id}>
                <span className="pm-delivery__avatar" aria-hidden="true">{initials(person.name)}</span>
                <span className="pm-delivery__person-main">
                  <span className="pm-delivery__person-name">{person.name}</span>
                  <span className="pm-delivery__person-weight">
                    weight {(person.weightUnits / 100).toFixed(2)}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="pm-delivery__capacity-row">
            <span>Capacity</span>
            <b>{capacity === null || capacity === undefined ? 'Unset' : `${capacity} / sprint`}</b>
          </div>
          {onOpenPeople && (
            <button type="button" className="pm-delivery__button pm-delivery__button--wide" onClick={onOpenPeople}>
              {plan.roster.length > 0 ? 'Manage people' : 'Add people'}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="pm-delivery__capacity-row">
            <span>Capacity</span>
            {editing ? (
              <span className="pm-delivery__capacity-edit">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={capacityDraft}
                  aria-label="Points per sprint"
                  onChange={(event) => setCapacityDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveCapacity();
                    if (event.key === 'Escape') {
                      setEditing(false);
                      setCapacityDraft(config.pointsPerSprint?.toString() ?? '');
                    }
                  }}
                  autoFocus
                />
                <button type="button" className="pm-delivery__inline-button" onClick={saveCapacity}>
                  Save
                </button>
                <button
                  type="button"
                  className="pm-delivery__inline-button"
                  onClick={() => {
                    setEditing(false);
                    setCapacityDraft(config.pointsPerSprint?.toString() ?? '');
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <span className="pm-delivery__capacity-value">
                <b>{capacity === null || capacity === undefined ? 'Unset' : `${capacity} / sprint`}</b>
                <button type="button" className="pm-delivery__inline-button" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </span>
            )}
          </div>
          <p className="pm-delivery__note">
            Switch to Assigned people in the header to add named people.
          </p>
        </>
      )}
    </section>
  );
}

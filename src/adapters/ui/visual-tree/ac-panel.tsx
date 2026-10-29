import './ac-panel.css';

export interface AcceptanceCriterionItem {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface AcceptancePanelProps {
  criteria: readonly AcceptanceCriterionItem[];
  onToggleCriterion?: (criterionId: string, completed: boolean) => void;
}

/**
 * Acceptance criteria checklist panel (Story 6.7 Task 2).
 *
 * Rendered inside selected Feature cards:
 * - Checkbox per criterion with title
 * - Toggling immediately calls onToggleCriterion
 * - Keyboard accessible (Space to toggle)
 */
export function AcceptancePanel({
  criteria,
  onToggleCriterion,
}: AcceptancePanelProps): React.ReactElement | null {
  if (criteria.length === 0) {
    // AC4: no fabricated empty branch — the resting AcceptanceIndicator's
    // "no acceptance criteria yet" text is the only surface for this state.
    return null;
  }

  return (
    <div className="pm-ac-panel" role="group" aria-label="Acceptance criteria checklist">
      <ul className="pm-ac-list">
        {criteria.map((item) => (
          <li key={item.id} className="pm-ac-item">
            <label className="pm-ac-label">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={(e) => {
                  e.stopPropagation();
                  onToggleCriterion?.(item.id, e.target.checked);
                }}
                onClick={(e) => e.stopPropagation()}
                className="pm-ac-checkbox"
                aria-label={item.title || 'Untitled criterion'}
              />
              <span className={`pm-ac-title ${item.completed ? 'pm-ac-title--completed' : ''}`}>
                {item.title || 'Untitled criterion'}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

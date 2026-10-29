import { calculateAcceptanceRatio } from '../../../domain/tree/acceptance-criteria.policy';
import './ac-indicator.css';

export interface AcceptanceIndicatorProps {
  criteria: readonly { readonly id: string; readonly completed: boolean }[];
}

/**
 * Acceptance criteria pips and ratio indicator (Story 6.7 Task 1).
 *
 * Rendered inside Feature cards in rest state:
 * - Pips row (filled dots for met, unfilled dots for unmet)
 * - Ratio text: "n / m met" or "no acceptance criteria yet"
 */
export function AcceptanceIndicator({
  criteria,
}: AcceptanceIndicatorProps): React.ReactElement {
  const ratio = calculateAcceptanceRatio(
    criteria.map((c) => ({
      id: c.id,
      nodeType: 'AcceptanceCriterion',
      completed: c.completed,
    })),
  );

  return (
    <div className="pm-ac-indicator" aria-label={`Acceptance criteria: ${ratio.ratioText}`}>
      {ratio.hasCriteria && (
        <div className="pm-ac-pips" aria-hidden="true">
          {criteria.map((c, i) => (
            <span
              key={c.id || i}
              className={`pm-ac-pip ${c.completed ? 'pm-ac-pip--met' : 'pm-ac-pip--unmet'}`}
            />
          ))}
        </div>
      )}
      <span className="pm-ac-ratio-text">{ratio.ratioText}</span>
    </div>
  );
}

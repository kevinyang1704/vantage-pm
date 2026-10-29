import type { CoherenceChipState } from './coherence.encoding';
import { riskCountPhrase } from '../vocabulary';
import './coherence-chips.css';

export interface CoherenceChipsProps {
  chips: readonly CoherenceChipState[];
}

/**
 * Theme-row coherence cell.
 *
 * Orphan and sequencing findings are aggregated into one "N risks & blockers"
 * chip — the raw reason code is internal vocabulary and never surfaces
 * (handoff README → Copy & terminology changes). Effort concentration keeps
 * its own chip: it encodes investment shape, not "this needs attention".
 */
export function CoherenceChips({ chips }: CoherenceChipsProps): React.ReactElement {
  const attentionCount = chips
    .filter((c) => c.kind === 'orphan' || c.kind === 'sequencing')
    .reduce((sum, c) => sum + c.count, 0);
  const effortCount = chips
    .filter((c) => c.kind === 'effort')
    .reduce((sum, c) => sum + c.count, 0);

  if (attentionCount === 0 && effortCount === 0) {
    return (
      <span className="pm-coherence-chips">
        <span className="pm-coherence-clear">Clear</span>
      </span>
    );
  }

  return (
    <span className="pm-coherence-chips">
      {attentionCount > 0 && (
        <span
          className="pm-coherence-chip pm-coherence-chip--attention"
          aria-label={riskCountPhrase(attentionCount)}
        >
          {riskCountPhrase(attentionCount)}
        </span>
      )}
      {effortCount > 0 && (
        <span
          className="pm-coherence-chip pm-coherence-chip--effort"
          aria-label={`${effortCount} effort concentration ${effortCount === 1 ? 'finding' : 'findings'}`}
        >
          {effortCount} effort
        </span>
      )}
    </span>
  );
}

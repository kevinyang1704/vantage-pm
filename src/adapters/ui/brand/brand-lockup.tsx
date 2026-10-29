/**
 * Vantage brand lockup — faceted mark + wordmark.
 *
 * The mark is the faceted "V" from the Vantage identity board (2026-09-26),
 * drawn inline from brand/vantage-mark.ts — the same geometry the generated
 * app and browser icons use. Facet colours are `brand-facet-*` tokens and do
 * not change with the theme.
 *
 * Scope note: header lockup for Vantage with mark and wordmark.
 */

import './brand-lockup.css';
import { VANTAGE_MARK_FACETS, VANTAGE_MARK_VIEWBOX } from './vantage-mark';

export interface BrandLockupProps {
  /** Invoked when the lockup is clicked — returns to the workspace. */
  readonly onActivate?: () => void;
}

export function BrandLockup({ onActivate }: BrandLockupProps): React.ReactElement {
  const mark = (
    <>
      <svg
        className="pm-brand-mark"
        viewBox={VANTAGE_MARK_VIEWBOX}
        aria-hidden="true"
        focusable="false"
      >
        {VANTAGE_MARK_FACETS.map((facet) => (
          <polygon
            key={facet.points}
            points={facet.points}
            className={`pm-brand-facet pm-brand-facet--${facet.tone}`}
          />
        ))}
      </svg>
      <span className="pm-brand-wordmark">Vantage</span>
    </>
  );

  if (!onActivate) {
    return <span className="pm-brand-lockup">{mark}</span>;
  }

  return (
    <button
      type="button"
      className="pm-brand-lockup pm-brand-lockup--interactive"
      onClick={onActivate}
      aria-label="Vantage — go to workspace"
    >
      {mark}
    </button>
  );
}

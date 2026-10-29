/**
 * Theme Feature details (Story 24.3, DO-FR6/DO-FR7, DO-UX4).
 *
 * Expandable, strictly read-only list of a theme's Features and their existing
 * statuses. Presentation only: no editing, no graph writes, no persistence.
 * Bounded to 50 rows per page with accessible Previous/Next when a theme has
 * more, while status totals are computed over all of a theme's Features.
 *
 * Split into a toggle (rendered in the theme summary row) and a panel
 * (rendered below the summary table), matching the approved mock. The pair
 * shares a deterministic id so `aria-controls` resolves across the table.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFeatureRow, WorkspaceThemeRow } from '../../../contracts/workspace-overview';
import { deliveryStatusLabel, deliveryStatusModifier } from './delivery-status';
import { itemCountPhrase } from '../vocabulary';
import './theme-details.css';

export const FEATURE_DETAIL_PAGE_SIZE = 50;

/** Deterministic, DOM-safe element id for a theme's details panel. */
export function themeDetailsPanelId(projectId: string, themeId: string): string {
  return `pm-theme-details-${projectId}-${themeId}`;
}

export function untitledFeature(title: string): string {
  return title.trim().length > 0 ? title : 'Untitled Feature';
}

export function paginateFeatures(
  features: readonly WorkspaceFeatureRow[],
  page: number,
  pageSize: number = FEATURE_DETAIL_PAGE_SIZE,
): { readonly page: number; readonly pageCount: number; readonly rows: readonly WorkspaceFeatureRow[] } {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : FEATURE_DETAIL_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(features.length / size));
  const clamped = Math.min(Math.max(0, page), pageCount - 1);
  const start = clamped * size;
  return Object.freeze({
    page: clamped,
    pageCount,
    rows: Object.freeze(features.slice(start, start + size)),
  });
}

export interface ThemeDetailsToggleProps {
  readonly projectId: string;
  readonly theme: WorkspaceThemeRow;
  readonly open: boolean;
  readonly onToggle: (projectId: string, themeId: string) => void;
}

/**
 * The disclosure control. Rendered in the theme summary row. A zero-Feature
 * theme renders no control (AC 24.3-1).
 */
export function ThemeDetailsToggle({ projectId, theme, open, onToggle }: ThemeDetailsToggleProps): React.ReactElement | null {
  if (theme.featureCount === 0) return null;

  const plural = theme.featureCount === 1 ? 'feature' : 'features';
  const visibleLabel = open ? 'Hide features' : `View ${theme.featureCount} ${plural}`;
  const ariaLabel = open
    ? `Hide ${theme.themeName} features`
    : `View ${theme.featureCount} ${plural} in ${theme.themeName}`;

  return (
    <button
      type="button"
      className="pm-theme-details__toggle"
      aria-expanded={open}
      aria-controls={themeDetailsPanelId(projectId, theme.themeId)}
      aria-label={ariaLabel}
      onClick={() => onToggle(projectId, theme.themeId)}
    >
      {visibleLabel}
      <span className="pm-theme-details__chevron" aria-hidden="true">
        {open ? '↑' : '↓'}
      </span>
    </button>
  );
}

export interface ThemeDetailsPanelProps {
  readonly projectId: string;
  readonly theme: WorkspaceThemeRow;
  /**
   * Whether the panel is expanded. The panel element is always mounted for a
   * nonempty theme so the toggle's `aria-controls` idref always resolves
   * (AC 24.3-1); its rows render only when open, so a collapsed overview never
   * eagerly renders Features (AC 24.3-6).
   */
  readonly open: boolean;
}

/** The read-only detail section, rendered below the summary table. */
export function ThemeDetailsPanel({ projectId, theme, open }: ThemeDetailsPanelProps): React.ReactElement | null {
  const [page, setPage] = useState(0);
  const paged = useMemo(() => paginateFeatures(theme.features, page), [theme.features, page]);
  const prevRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  // Direction of the most recent paging action, so focus can be restored after
  // commit even when the pressed button becomes disabled on a boundary page.
  const lastDirectionRef = useRef<'prev' | 'next' | null>(null);
  // Mirror the current page so `changePage` can compare without a dependency
  // that would change its identity every render.
  const pagedPageRef = useRef(paged.page);
  pagedPageRef.current = paged.page;

  // Clamp the page after deletions shrink the list (AC 24.3-6).
  useEffect(() => {
    setPage((current) => (current > paged.pageCount - 1 ? paged.pageCount - 1 : current));
  }, [paged.pageCount]);

  // Restore focus after a page change. The pressed button may now be disabled
  // (boundary pages drop a focused disabled button to <body> in Chromium), so
  // fall back to the control that remains actionable (AC 24.3-6).
  useEffect(() => {
    const dir = lastDirectionRef.current;
    if (dir === null) return;
    const pressed = dir === 'prev' ? prevRef.current : nextRef.current;
    const other = dir === 'prev' ? nextRef.current : prevRef.current;
    if (pressed && !pressed.disabled) pressed.focus();
    else other?.focus();
  }, [paged.page]);

  const changePage = useCallback((next: number) => {
    lastDirectionRef.current = next < pagedPageRef.current ? 'prev' : 'next';
    setPage(next);
  }, []);

  if (theme.featureCount === 0) return null;

  const panelId = themeDetailsPanelId(projectId, theme.themeId);

  return (
    <section
      id={panelId}
      className="pm-theme-details__panel"
      aria-label={`${theme.themeName} features`}
      hidden={!open}
    >
      {open && (
        <>
          <div className="pm-theme-details__head">
            <strong className="pm-theme-details__title">{theme.themeName} / Features</strong>
            <span className="pm-theme-details__count">{itemCountPhrase(theme.featureCount)}</span>
          </div>
          <table className="pm-theme-details__table">
            <caption className="pm-theme-details__caption">
              Feature titles and existing delivery statuses for {theme.themeName}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="pm-theme-details__th pm-theme-details__th--feature">Feature</th>
                <th scope="col" className="pm-theme-details__th pm-theme-details__th--status">Status</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((feature) => (
                <tr key={feature.featureId} className="pm-theme-details__row">
                  <td className="pm-theme-details__cell pm-theme-details__feature">
                    {untitledFeature(feature.title)}
                  </td>
                  <td className="pm-theme-details__cell pm-theme-details__status">
                    <span
                      className={`pm-theme-details__status-dot pm-theme-details__status-dot--${deliveryStatusModifier(feature.deliveryStatus)}`}
                      aria-hidden="true"
                    />
                    {deliveryStatusLabel(feature.deliveryStatus)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {paged.pageCount > 1 && (
            <nav className="pm-theme-details__pager" aria-label={`${theme.themeName} feature pages`}>
              <button
                ref={prevRef}
                type="button"
                className="pm-theme-details__page-btn"
                onClick={() => changePage(paged.page - 1)}
                disabled={paged.page === 0}
              >
                Previous
              </button>
              <span className="pm-theme-details__page-state" aria-live="polite">
                Page {paged.page + 1} of {paged.pageCount}
              </span>
              <button
                ref={nextRef}
                type="button"
                className="pm-theme-details__page-btn"
                onClick={() => changePage(paged.page + 1)}
                disabled={paged.page >= paged.pageCount - 1}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

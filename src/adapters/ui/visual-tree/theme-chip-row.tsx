import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computeVisibleChipCount } from '../../../application/visual/theme-chip-overflow';
import './theme-chip-row.css';

export interface ThemeChipItem {
  readonly id: string;
  readonly title: string;
}

export interface ThemeChipRowProps {
  themes: readonly ThemeChipItem[];
  focusedThemeId: string | null;
  onSelectTheme: (themeId: string) => void;
  onOpenThemeJump?: () => void;
  /**
   * Moves focus to the previous/next theme in ordinal order (wraps).
   * Story 6.4 Task 7: the direction logic is ready and keyboard-reachable via
   * these visible affordances; the exact global keyboard chord is a separate,
   * still-open decision (EXPERIENCE.md's proposed ⌘[/⌘] is browser-reserved
   * per NFR-20), so no global binding is wired to it yet.
   */
  onFocusAdjacentTheme?: (direction: 'previous' | 'next') => void;
}

const ESTIMATED_OVERFLOW_WIDTH = 76;
const GAP = 6;

export function ThemeChipRow({
  themes,
  focusedThemeId,
  onSelectTheme,
  onOpenThemeJump,
  onFocusAdjacentTheme,
}: ThemeChipRowProps): React.ReactElement | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [visibleCount, setVisibleCount] = useState<number>(themes.length);

  const measureAndAdjust = () => {
    if (!containerRef.current || themes.length === 0) return;
    const containerWidth = containerRef.current.offsetWidth;
    const chipWidths = themes.map((t) => {
      const el = chipRefs.current.get(t.id);
      return el ? el.offsetWidth : 120;
    });

    const count = computeVisibleChipCount({
      chipWidths,
      containerWidth,
      overflowChipWidth: ESTIMATED_OVERFLOW_WIDTH,
      gap: GAP,
    });

    setVisibleCount(count);
  };

  useLayoutEffect(() => {
    measureAndAdjust();
  }, [themes]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      measureAndAdjust();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [themes]);

  if (themes.length === 0) return null;

  const visibleThemes = themes.slice(0, visibleCount);
  const hiddenCount = themes.length - visibleCount;

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="Theme navigation"
      className="pm-theme-chip-row"
    >
      {onFocusAdjacentTheme && themes.length > 1 && (
        <button
          type="button"
          className="pm-theme-chip pm-theme-chip--adjacent"
          onClick={() => onFocusAdjacentTheme('previous')}
          aria-label="Focus previous theme"
        >
          ‹
        </button>
      )}
      {visibleThemes.map((theme) => {
        const isSelected = theme.id === focusedThemeId;
        return (
          <button
            key={theme.id}
            ref={(el) => {
              if (el) chipRefs.current.set(theme.id, el);
              else chipRefs.current.delete(theme.id);
            }}
            role="tab"
            aria-selected={isSelected}
            className={`pm-theme-chip ${isSelected ? 'pm-theme-chip--selected' : ''}`}
            onClick={() => onSelectTheme(theme.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                const next = (e.currentTarget.nextElementSibling as HTMLElement | null);
                next?.focus();
              } else if (e.key === 'ArrowLeft') {
                const prev = (e.currentTarget.previousElementSibling as HTMLElement | null);
                prev?.focus();
              }
            }}
          >
            <span className="pm-theme-chip__title">{theme.title || 'Untitled Theme'}</span>
          </button>
        );
      })}

      {hiddenCount > 0 && (
        <button
          type="button"
          className="pm-theme-chip pm-theme-chip--overflow"
          onClick={() => onOpenThemeJump?.()}
          aria-label={`Open search for ${hiddenCount} more themes`}
        >
          +{hiddenCount} more
        </button>
      )}

      {onFocusAdjacentTheme && themes.length > 1 && (
        <button
          type="button"
          className="pm-theme-chip pm-theme-chip--adjacent"
          onClick={() => onFocusAdjacentTheme('next')}
          aria-label="Focus next theme"
        >
          ›
        </button>
      )}
    </div>
  );
}

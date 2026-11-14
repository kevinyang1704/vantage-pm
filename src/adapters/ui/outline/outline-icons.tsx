import React from 'react';

export type OutlineIconName =
  | 'brief'
  | 'schedule'
  | 'unlocks'
  | 'effort'
  | 'weight'
  | 'phase'
  | 'question';

export interface OutlineIconProps {
  name: OutlineIconName;
  size?: number;
  className?: string;
}

/**
 * Dual-tone soft-fill vector icons (Option C) sized to stay sharp at 12–16px
 * and inherit theme polarity cleanly via `currentColor`.
 */
export function OutlineIcon({
  name,
  size = 15,
  className,
}: OutlineIconProps): React.ReactElement {
  const mergedClassName = className ? `pm-outline-icon ${className}` : 'pm-outline-icon';

  return (
    <svg
      className={mergedClassName}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {renderIconGlyph(name)}
    </svg>
  );
}

function renderIconGlyph(name: OutlineIconName): React.ReactElement {
  switch (name) {
    case 'brief':
      return (
        <>
          <path
            d="M3.5 2.25h6.25L12.75 5.25v8.5a1 1 0 0 1-1 1h-8.25a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1Z"
            fill="currentColor"
            fillOpacity="0.18"
            stroke="none"
          />
          <path d="M3.5 2.25h6.25l3 3v8.5a1 1 0 0 1-1 1h-8.25a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1Z" />
          <path d="M9.5 2.25v3.25h3.25" />
          <path d="M5.25 8h5.25" />
          <path d="M5.25 10.75h3.5" />
        </>
      );
    case 'schedule':
      return (
        <>
          <path
            d="M2.5 5.75h11v6.75a1.25 1.25 0 0 1-1.25 1.25H3.75A1.25 1.25 0 0 1 2.5 12.5V5.75Z"
            fill="currentColor"
            fillOpacity="0.18"
            stroke="none"
          />
          <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
          <path d="M2.25 6h11.5" />
          <path d="M5.25 2v2" />
          <path d="M10.75 2v2" />
          <circle cx="10.25" cy="9.75" r="0.9" fill="currentColor" stroke="none" />
        </>
      );
    case 'unlocks':
      return (
        <>
          <rect
            x="3"
            y="7.25"
            width="10"
            height="6.5"
            rx="1.5"
            fill="currentColor"
            fillOpacity="0.2"
          />
          <path d="M5.5 7.25V5a2.5 2.5 0 0 1 4.75-1.08" />
          <path d="M8 9.6v1.6" />
        </>
      );
    case 'effort':
      return (
        <path
          d="M9.1 1.75 3.6 8.75h4.2l-.9 5.5 5.5-7H8.2l.9-5.5Z"
          fill="currentColor"
          fillOpacity="0.22"
        />
      );
    case 'weight':
      return (
        <>
          <path
            d="M8 2.25v11.5M4.5 13.75h7M3 5.25h10"
          />
          <path
            d="m3.5 5.25-1.5 4h3l-1.5-4Zm9 0-1.5 4h3l-1.5-4Z"
            fill="currentColor"
            fillOpacity="0.2"
          />
        </>
      );
    case 'phase':
      return (
        <>
          <path
            d="M2.5 3.25A1.25 1.25 0 0 1 3.75 2h4.1l5.4 5.4a1.25 1.25 0 0 1 0 1.77l-4.08 4.08a1.25 1.25 0 0 1-1.77 0L2.5 8.35V3.25Z"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <circle cx="5.4" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
        </>
      );
    case 'question':
      return (
        <>
          <circle cx="8" cy="8" r="5.75" fill="currentColor" fillOpacity="0.18" />
          <path d="M6.45 6.35a1.65 1.65 0 0 1 3.2.45c0 1.05-1.65 1.35-1.65 2.45" />
          <circle cx="8" cy="11.55" r="0.7" fill="currentColor" stroke="none" />
        </>
      );
  }
}

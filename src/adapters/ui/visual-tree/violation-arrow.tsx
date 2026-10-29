import './violation-arrow.css';

export interface ViolationArrowItem {
  readonly edgeId: string;
  readonly path: string;
  readonly origin: { readonly x: number; readonly y: number };
  readonly narrative: string;
}

export interface ViolationArrowProps {
  violations: readonly ViolationArrowItem[];
  width: number;
  height: number;
}

/**
 * Sequencing violation arrow SVG layer (Story 6.6 Task 3).
 *
 * Renders backward sequencing violation arrows:
 * - Stroke: var(--pm-flag-seq)
 * - 1.6px stroke width (invariant to node properties)
 * - dasharray 6 4, butt caps
 * - Filled triangle marker (8x8 at refX 10) and origin dot (2.6r)
 * - Supporting text: finding's narrative verbatim
 */
export function ViolationArrowLayer({
  violations,
  width,
  height,
}: ViolationArrowProps): React.ReactElement | null {
  if (violations.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      className="pm-violation-arrow-layer"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      <defs>
        <marker
          id="pm-violation-seq-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="var(--pm-flag-seq)" />
        </marker>
      </defs>
      {violations.map((violation) => (
        <g key={violation.edgeId} className="pm-violation-arrow-group">
          <title>{violation.narrative}</title>
          <circle
            cx={violation.origin.x}
            cy={violation.origin.y}
            r={2.6}
            fill="var(--pm-flag-seq)"
            className="pm-violation-origin-dot"
          />
          <path
            d={violation.path}
            fill="none"
            stroke="var(--pm-flag-seq)"
            strokeWidth={1.6}
            strokeDasharray="6 4"
            strokeLinecap="butt"
            markerEnd="url(#pm-violation-seq-arrow)"
            className="pm-violation-arrow-path"
          />
        </g>
      ))}
    </svg>
  );
}

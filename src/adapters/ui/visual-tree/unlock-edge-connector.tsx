import './unlock-edge-connector.css';

export interface UnlockEdgeItem {
  readonly edgeId: string;
  readonly path: string;
  readonly origin: { readonly x: number; readonly y: number };
}

export interface UnlockEdgeConnectorProps {
  edges: readonly UnlockEdgeItem[];
  width: number;
  height: number;
}

/**
 * Unlock edge SVG connector layer (Story 6.5 Task 2).
 *
 * Renders in-subtree and ghost unlock edges:
 * - Dashed accent stroke (var(--pm-accent))
 * - 1.5px constant stroke-width (invariant to node properties, AC4)
 * - dasharray 5 4
 * - Origin dot (r=2.6) and filled triangle arrow marker (8x8 at refX 10)
 */
export function UnlockEdgeConnector({
  edges,
  width,
  height,
}: UnlockEdgeConnectorProps): React.ReactElement | null {
  if (edges.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      className="pm-unlock-edges-layer"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      <defs>
        <marker
          id="pm-unlock-arrow"
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="var(--pm-accent)" />
        </marker>
      </defs>
      {edges.map((edge) => (
        <g key={edge.edgeId} className="pm-unlock-edge-group">
          <circle
            cx={edge.origin.x}
            cy={edge.origin.y}
            r={2.6}
            fill="var(--pm-accent)"
            className="pm-unlock-origin-dot"
          />
          <path
            d={edge.path}
            fill="none"
            stroke="var(--pm-accent)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
            strokeLinecap="butt"
            markerEnd="url(#pm-unlock-arrow)"
            className="pm-unlock-edge-path"
          />
        </g>
      ))}
    </svg>
  );
}

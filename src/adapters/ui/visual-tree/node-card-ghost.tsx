import './node-card-ghost.css';

export interface NodeCardGhostProps {
  ghostId: string;
  targetTitle: string;
  targetThemeName: string | null;
  geometry: { x: number; y: number; width: number; height: number };
  /** 'destination' (default) for an outward edge's target; 'source' for an inbound edge's origin. */
  variant?: 'destination' | 'source';
}

/**
 * Ghost card representing an unlock edge endpoint outside the focused subtree
 * (Story 6.5 Task 3) — either an outward edge's destination or an inbound
 * edge's source.
 *
 * Implements {components.node-card-ghost}: dashed border, canvas background,
 * names the far node's title and theme. Non-editable, non-focusable as a tree
 * item, never counted in subtree membership.
 */
export function NodeCardGhost({
  ghostId,
  targetTitle,
  targetThemeName,
  geometry,
  variant = 'destination',
}: NodeCardGhostProps): React.ReactElement {
  return (
    <div
      data-ghost-id={ghostId}
      aria-hidden="true"
      className="pm-node-card-ghost"
      style={{
        transform: `translate(${geometry.x}px, ${geometry.y}px)`,
        width: geometry.width,
        height: geometry.height,
      }}
    >
      <div className="pm-node-card-ghost__header">
        <span className="pm-node-card-ghost__tag">
          {variant === 'source' ? '↰ UNLOCK SOURCE' : '↳ UNLOCK DESTINATION'}
        </span>
      </div>
      <div className="pm-node-card-ghost__title" title={targetTitle}>
        {targetTitle || 'Untitled Destination'}
      </div>
      {targetThemeName && (
        <div className="pm-node-card-ghost__theme">
          Theme: {targetThemeName}
        </div>
      )}
    </div>
  );
}

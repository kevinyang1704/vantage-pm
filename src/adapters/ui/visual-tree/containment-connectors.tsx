import type { RailGeometry, DropGeometry } from './connector-geometry';
import './containment-connectors.css';

export interface ContainmentConnectorsProps {
  rails: readonly RailGeometry[];
  drops: readonly DropGeometry[];
  width: number;
  height: number;
}

/**
 * SVG containment-connector layer (Story 6.2 Task 4).
 *
 * Decorative enforcement for sighted users — aria-hidden is deliberate:
 * containment is already conveyed by the role="treeitem"/aria-level/
 * aria-posinset/aria-setsize structure on the HTML cards.
 */
export function ContainmentConnectors({ rails, drops, width, height }: ContainmentConnectorsProps): React.ReactElement {
  return (
    <svg
      className="pm-visual-connectors"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {rails.map((rail, i) => (
        <path key={`rail-${rail.parentId}-${i}`} className="pm-visual-rail" d={rail.path} />
      ))}
      {drops.map((drop) => (
        <path key={`drop-${drop.ownerId}-${drop.kind}`} className="pm-visual-drop" d={drop.path} />
      ))}
      {drops.map((drop) => (
        <circle key={`junction-${drop.ownerId}-${drop.kind}`} className="pm-visual-junction" cx={drop.junction.x} cy={drop.junction.y} r={2.2} />
      ))}
    </svg>
  );
}
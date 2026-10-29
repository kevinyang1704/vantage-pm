/**
 * Export preview-sentence formatter (Story 8.1 Task 5, AC3).
 *
 * Builds exactly one plain-language sentence from fields already present on a
 * resolved `ViewScope` — never re-derived independently. Segments joined by
 * " · ", present only when the scope variant carries that data, matching the
 * UX spec's worked example: "12 themes · 84 features · 1 Jan – 31 Dec 2026 ·
 * 6 undated excluded".
 *
 * Date-window segment is Gantt-only (Outline/Visual carry no date field per
 * their contract shapes). Undated-excluded segment is omitted when zero.
 */

import type { ViewScope } from '../../contracts/view-scope';
import type { NodeType } from '../../domain/tree/node.entity';

/** Minimal node shape the formatter needs: only id + nodeType for counting. */
export interface ScopeNodeRef {
  readonly id: string;
  readonly nodeType: NodeType | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format an ISO YYYY-MM-DD date as "D Mon YYYY" (deterministic, matches the worked example). */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function formatExportScopeSentence(scope: ViewScope, nodes: readonly ScopeNodeRef[]): string {
  const nodeTypeById = new Map(nodes.map((n) => [n.id, n.nodeType]));

  let themeCount = 0;
  let featureCount = 0;
  for (const id of scope.orderedNodeIds) {
    const type = nodeTypeById.get(id);
    if (type === 'Theme') themeCount++;
    else if (type === 'Feature') featureCount++;
  }

  const segments: string[] = [pluralize(themeCount, 'theme'), pluralize(featureCount, 'feature')];

  if (scope.kind === 'GanttVisible') {
    segments.push(`${formatDate(scope.window.dateWindowStart)} – ${formatDate(scope.window.dateWindowEnd)}`);
    if (scope.undatedCount > 0) {
      segments.push(`${scope.undatedCount} undated excluded`);
    }
  } else if (scope.kind === 'OutlineVisible') {
    if (scope.excluded.length > 0) {
      segments.push(`${scope.excluded.length} excluded`);
    }
  }
  // VisualFocus carries no exclusion segment at all.

  return segments.join(' · ');
}

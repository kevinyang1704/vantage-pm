/**
 * Build the pure rebase's MergeState from the app's analysis snapshot (H08).
 *
 * The rebase decides whether a pending local edit survives a confirmed remote
 * one using only structure: parents, sibling order, forecast order/groups,
 * assignments, roster and points. Sibling order follows the authored gap
 * position (ties broken by id), exactly as the outline renders it.
 */

import type { MergeState } from '../../domain/collaboration/rebase';
import type { Node } from '../../domain/tree/node.entity';
import type { ForecastPlan } from '../../domain/forecast/forecast-plan.entity';

export function mergeStateFromSnapshot(snapshot: Readonly<{ projectId: string; nodes: readonly Node[]; forecastPlan?: ForecastPlan }>): MergeState {
  const nodes = new Map<string, Readonly<{ parentId: string | null }>>();
  const children = new Map<string, Node[]>();
  const points = new Map<string, number>();
  const pointsDone = new Map<string, number>();
  for (const node of snapshot.nodes) {
    nodes.set(node.id, Object.freeze({ parentId: node.parentId }));
    const key = node.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), node]);
    if (node.effortPoints !== null) points.set(node.id, node.effortPoints);
    if (node.effortPointsDone !== null) pointsDone.set(node.id, node.effortPointsDone);
  }
  const order = new Map<string, readonly string[]>();
  for (const [parent, siblings] of children) {
    order.set(parent, Object.freeze([...siblings]
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id.localeCompare(b.id)))
      .map((node) => node.id)));
  }
  const plan = snapshot.forecastPlan;
  return Object.freeze({
    projectId: snapshot.projectId,
    nodes,
    order,
    forecastOrder: Object.freeze([...(plan?.selectedFeatureIds ?? [])]),
    forecastGroups: Object.freeze((plan?.parallelGroups ?? []).map((group) => Object.freeze({ featureIds: Object.freeze([...group.featureIds]) }))),
    assignments: Object.freeze({ ...(plan?.assignments ?? {}) }),
    rosterIds: new Set((plan?.roster ?? []).map((person) => person.id)),
    points,
    pointsDone,
  });
}

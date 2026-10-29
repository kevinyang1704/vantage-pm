/**
 * Pure rebase (Story 27.3, AC 27.3-4, D1/D8, R4).
 *
 * When confirmed remote commands arrive while local commands are unconfirmed,
 * the client rolls the pending commands back and re-applies them after the
 * remote ones. This module decides, purely and deterministically, which pending
 * commands survive re-application and which are rejected with a named reason.
 *
 * It models only the facts the merge depends on: which target ids still exist
 * (a delete removes a node/subtree), collection order (for placement), and the
 * forecast plan's scope/groups/points. It performs no I/O and imports no
 * adapter (AD-1). The same outcomes must hold in the Rust core and the browser
 * repository; the named rejections match the 27.1 table and the existing
 * `ProductCommandRejected` codes.
 *
 * The caller applies `toReapply` in order against the post-confirmed state.
 */

import type { ProductCommand } from '../../contracts/repository-commands';
import { resolveAnchoredIndex, type AnchoredPlacement } from './anchor-placement.policy';

/** Named rejection reasons a rebase can produce (AC 27.3-4). */
export type RebaseRejectionReason =
  | 'TargetDeleted'
  | 'WouldCreateCycle'
  | 'DestinationMissing'
  | 'GroupPartnerMissing'
  | 'PersonMissing'
  | 'PointsDoneExceedsPoints'
  | 'ForecastScopeInvalid';

/**
 * The minimal fact snapshot the merge needs. `nodes` maps id → `{ parentId }`
 * (present means alive). `order` is the ordered child ids per parent ('' for
 * roots). Forecast fields mirror the plan's relevant parts.
 */
export type MergeState = Readonly<{
  projectId: string;
  nodes: ReadonlyMap<string, Readonly<{ parentId: string | null }>>;
  /** Ordered child ids keyed by parent id ('' = roots). */
  order: ReadonlyMap<string, readonly string[]>;
  forecastOrder: readonly string[];
  forecastGroups: readonly Readonly<{ featureIds: readonly string[] }>[];
  assignments: Readonly<Record<string, readonly string[]>>;
  rosterIds: ReadonlySet<string>;
  points: ReadonlyMap<string, number>;
  pointsDone: ReadonlyMap<string, number>;
}>;

export type RebaseDecision = Readonly<{
  toReapply: readonly ProductCommand[];
  rejected: readonly Readonly<{ command: ProductCommand; reason: RebaseRejectionReason }>[];
}>;

/** Whether a node is an ancestor of (or equal to) `candidate`. */
function isAncestor(state: MergeState, ancestor: string, candidate: string): boolean {
  let current: string | null | undefined = candidate;
  let guard = 0;
  while (current) {
    if (current === ancestor) return true;
    if (guard > state.nodes.size) return false;
    guard += 1;
    current = state.nodes.get(current)?.parentId ?? null;
  }
  return false;
}

/** Placement anchors a command carries, if it is a move. */
function anchorsOf(command: ProductCommand): AnchoredPlacement | null {
  switch (command.type) {
    case 'MoveNode':
      return {
        afterId: command.afterId ?? null,
        beforeId: command.beforeId ?? null,
        intendedIndex: command.intendedIndex ?? 0,
      };
    case 'MovePhase':
    case 'MoveNodeQuestion':
    case 'MoveForecastFeature':
      return { afterId: command.afterId, beforeId: command.beforeId, intendedIndex: command.intendedIndex };
    default:
      return null;
  }
}

/**
 * Decide which pending commands survive re-application after `confirmed` was
 * applied. Pure and deterministic.
 */
export function rebase(
  pending: readonly ProductCommand[],
  confirmed: readonly ProductCommand[],
  state: MergeState,
): RebaseDecision {
  // A working copy of the state mutated by confirmed commands (nodes, points,
  // forecast scope/groups/assignments), so rejection decisions see the effects
  // of every confirmed command, not a superseded snapshot (H-review).
  const nodes = new Map(state.nodes);
  const order = new Map<string, readonly string[]>();
  for (const [k, v] of state.order) order.set(k, [...v]);
  const points = new Map(state.points);
  const pointsDone = new Map(state.pointsDone);
  const forecastOrder = [...state.forecastOrder];
  const forecastGroups = state.forecastGroups.map((g) => [...g.featureIds]);
  const rosterIds = new Set(state.rosterIds);
  const assignments: Record<string, readonly string[]> = { ...state.assignments };

  const removeNode = (id: string): void => {
    // Remove the whole subtree. A node's descendants are reachable by parent.
    const toRemove = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [candidate, meta] of nodes) {
        if (meta.parentId && toRemove.has(meta.parentId) && !toRemove.has(candidate)) {
          toRemove.add(candidate);
          grew = true;
        }
      }
    }
    for (const victim of toRemove) nodes.delete(victim);
    for (const [k, ids] of order) order.set(k, ids.filter((x) => !toRemove.has(x)));
  };

  const removeFeatureFromForecast = (featureId: string): void => {
    const at = forecastOrder.indexOf(featureId);
    if (at !== -1) forecastOrder.splice(at, 1);
    for (let i = forecastGroups.length - 1; i >= 0; i -= 1) {
      forecastGroups[i] = forecastGroups[i].filter((id) => id !== featureId);
      if (forecastGroups[i].length < 2) forecastGroups.splice(i, 1);
    }
    delete assignments[featureId];
  };

  for (const command of confirmed) {
    switch (command.type) {
      case 'CreateNode':
        nodes.set(command.nodeId, { parentId: command.parentId ?? null });
        break;
      case 'DeleteSubtree':
        removeNode(command.nodeId);
        removeFeatureFromForecast(command.nodeId);
        break;
      case 'MoveNode':
        if (nodes.has(command.nodeId)) nodes.set(command.nodeId, { parentId: command.newParentId ?? null });
        break;
      case 'SetNodePointsDone':
        if (typeof command.effortPointsDone === 'number') pointsDone.set(command.nodeId, command.effortPointsDone);
        break;
      case 'SetNodeEffort':
        if (typeof command.effortPoints === 'number') points.set(command.nodeId, command.effortPoints);
        break;
      case 'SetForecastMembership':
        if (command.included) {
          if (!forecastOrder.includes(command.featureId)) forecastOrder.push(command.featureId);
        } else {
          removeFeatureFromForecast(command.featureId);
        }
        break;
      case 'SetForecastAssignment':
        if (command.assigned) {
          const current = new Set(assignments[command.featureId] ?? []);
          current.add(command.personId);
          assignments[command.featureId] = [...current];
        } else {
          const current = (assignments[command.featureId] ?? []).filter((id) => id !== command.personId);
          if (current.length > 0) assignments[command.featureId] = current;
          else delete assignments[command.featureId];
        }
        break;
      case 'AddForecastPerson':
        rosterIds.add(command.personId);
        break;
      case 'RemoveForecastPerson':
        rosterIds.delete(command.personId);
        break;
      default:
        break;
    }
  }

  // The working state reflects the confirmed effects, so rejection decisions are
  // made against the post-confirmed snapshot.
  const workingState: MergeState = Object.freeze({
    projectId: state.projectId,
    nodes,
    order,
    forecastOrder: Object.freeze(forecastOrder),
    forecastGroups: Object.freeze(forecastGroups.map((g) => Object.freeze({ featureIds: Object.freeze(g) }))),
    assignments: Object.freeze(assignments),
    rosterIds,
    points,
    pointsDone,
  });

  const toReapply: ProductCommand[] = [];
  const rejected: { command: ProductCommand; reason: RebaseRejectionReason }[] = [];

  for (const command of pending) {
    const reason = rejectionFor(command, workingState, nodes, points, pointsDone);
    if (reason) rejected.push(Object.freeze({ command, reason }));
    else toReapply.push(command);
  }

  return Object.freeze({
    toReapply: Object.freeze(toReapply),
    rejected: Object.freeze(rejected.map((r) => Object.freeze(r))),
  });
}

/**
 * The reason a pending command cannot re-apply, or null if it can. Mirrors the
 * merge table's named rejections.
 */
function rejectionFor(
  command: ProductCommand,
  state: MergeState,
  nodes: ReadonlyMap<string, Readonly<{ parentId: string | null }>>,
  points: ReadonlyMap<string, number>,
  pointsDone: ReadonlyMap<string, number>,
): RebaseRejectionReason | null {
  switch (command.type) {
    case 'SetNodeTitle':
    case 'SetNodeBodyText':
    case 'SetNodeType':
    case 'SetNodeCustomField':
    case 'SetNodeSchedule':
    case 'ToggleNodeCompleted':
    case 'SetNodeStatus':
    case 'SetNodeEffort':
    case 'SetThemeWeight':
    case 'AssignNodePhase':
    case 'AddNodeQuestion':
      return nodes.has(command.nodeId) ? null : 'TargetDeleted';

    case 'SetNodePointsDone': {
      if (!nodes.has(command.nodeId)) return 'TargetDeleted';
      const done = command.effortPointsDone;
      if (typeof done === 'number') {
        const pointsValue = points.get(command.nodeId);
        if (typeof pointsValue === 'number' && done > pointsValue) return 'PointsDoneExceedsPoints';
      }
      return null;
    }

    case 'MoveNode': {
      if (!nodes.has(command.nodeId)) return 'TargetDeleted';
      if (command.newParentId !== null) {
        if (!nodes.has(command.newParentId)) return 'DestinationMissing';
        if (isAncestor({ ...state, nodes }, command.nodeId, command.newParentId)) return 'WouldCreateCycle';
      }
      return null;
    }

    case 'SetForecastAssignment': {
      if (!state.forecastOrder.includes(command.featureId)) return 'ForecastScopeInvalid';
      if (!state.rosterIds.has(command.personId)) return 'PersonMissing';
      return null;
    }

    case 'MoveForecastFeature': {
      if (!state.forecastOrder.includes(command.featureId)) return 'ForecastScopeInvalid';
      if (command.groupChange.kind === 'join' && !state.forecastOrder.includes(command.groupChange.partnerId)) {
        return 'GroupPartnerMissing';
      }
      return null;
    }

    case 'SetForecastMembership':
      return null;
    case 'SetForecastBlocker':
      return state.forecastOrder.includes(command.featureId) ? null : 'ForecastScopeInvalid';
    case 'SetForecastPlanningLevel':
      // A plan-level change is independent of a feature's presence.
      return null;

    default:
      // Independent/local commands re-apply unchanged (their own handler
      // validates existence; a delete of their target is caught by the
      // handler's TargetDeleted path at apply time).
      return null;
  }
}

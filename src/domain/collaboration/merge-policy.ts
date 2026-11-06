/**
 * Merge-class policy (Story 27.3, D8, R2).
 *
 * Every `ProductCommand` type is assigned exactly one merge class from the
 * 27.1 table. The switch is exhaustive: a new command type without a class
 * fails typecheck (the `never` guard below). Classes:
 *
 * - `independent` — no cross-actor conflict; order is irrelevant;
 * - `same-field` — the later-*confirmed* edit wins in server order (D8(a));
 * - `placement` — after/before anchors resolved by D8(c);
 * - `invariant-checked` — a domain invariant decides, with named rejections;
 * - `local-only` — never submitted remotely (project lifecycle, admin/undo).
 *
 * Pure, deterministic, no I/O (AD-1).
 */

import type { ProductCommand } from '../../contracts/repository-commands';

export type MergeClass =
  | 'independent'
  | 'same-field'
  | 'placement'
  | 'invariant-checked'
  | 'local-only';

/** The merge class for one command type. Exhaustive by construction. */
export function mergeClassFor(type: ProductCommand['type']): MergeClass {
  switch (type) {
    // ── Project lifecycle: local/owner only, never a remote editor request ──
    case 'CreateProject':
    case 'RenameProject':
    case 'DeleteProject':
    case 'RemoveForecastPlan':
    case 'RemoveForecastScenario':
    case 'RestoreForecastScenario':
    case 'RestoreForecastScope':
    case 'RestoreForecastPlanningLevel':
    case 'RemoveForecastPerson':
    case 'RestoreForecastPerson':
    case 'RestoreSubtree':
    case 'RestorePhase':
      return 'local-only';

    // ── Same-field: later confirmed wins ──
    case 'SetNodeTitle':
    case 'SetNodeBodyText':
    case 'SetNodeType':
    case 'SetNodeCustomField':
    case 'SetNodeSchedule':
    case 'ToggleNodeCompleted':
    case 'SetNodeStatus':
    case 'RenamePhase':
    case 'UpdateNodeQuestion':
    case 'ResolveNodeQuestion':
    case 'SetForecastBlocker':
    case 'SetForecastSprintPlan':
    case 'SetForecastPlanningLevel':
    case 'UpdateForecastPerson':
      return 'same-field';

    // ── Placement: anchors + intended index (D8(c)) ──
    case 'MoveNode':
    case 'ReorderPhases':
    case 'MovePhase':
    case 'ReorderNodeQuestions':
    case 'MoveNodeQuestion':
    case 'ReorderForecastFeatures':
    case 'SetForecastSequence':
    case 'SetForecastParallelGroups':
    case 'MoveForecastFeature':
    case 'SetForecastAssignments':
    case 'SetForecastAssignment':
      return 'placement';

    // ── Invariant-checked: a domain invariant decides ──
    case 'SetNodeEffort':
    case 'SetNodePointsDone':
    case 'SetThemeWeight':
    case 'AssignNodePhase':
    case 'CreateUnlockEdge':
    case 'ConfigureForecastPlan':
    case 'SetForecastMembership':
    case 'SetForecastPolicy':
      return 'invariant-checked';

    // ── Independent: no cross-actor conflict ──
    case 'CreateNode':
    case 'DeleteSubtree':
    case 'DuplicateSubtree':
    case 'PromoteFieldToTemplate':
    case 'CreatePhase':
    case 'DeletePhase':
    case 'DeleteUnlockEdge':
    case 'DismissFinding':
    case 'UndismissFinding':
    case 'RecordAffectedReasons':
    case 'AcknowledgeAffectedReason':
    case 'ClearNodeAffectedReasons':
    case 'AddNodeQuestion':
    case 'DeleteNodeQuestion':
    case 'CreateForecastScenario':
    case 'AddForecastPerson':
      return 'independent';

    default: {
      // Exhaustiveness guard: adding a ProductCommand type without a class
      // makes `type` non-never here and fails typecheck (AC 27.3-3).
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

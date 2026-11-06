import { describe, expect, it } from 'vitest';
import { mergeClassFor, type MergeClass } from './merge-policy';
import type { ProductCommand } from '../../contracts/repository-commands';

describe('merge-policy (Story 27.3, AC 27.3-3)', () => {
  const cases: [ProductCommand['type'], MergeClass][] = [
    ['CreateProject', 'local-only'],
    ['RenameProject', 'local-only'],
    ['DeleteProject', 'local-only'],
    ['RestoreForecastScope', 'local-only'],
    ['RestoreSubtree', 'local-only'],
    ['SetNodeTitle', 'same-field'],
    ['SetNodeBodyText', 'same-field'],
    ['ToggleNodeCompleted', 'same-field'],
    ['SetForecastBlocker', 'same-field'],
    ['SetForecastSprintPlan', 'same-field'],
    ['MoveNode', 'placement'],
    ['MoveForecastFeature', 'placement'],
    ['SetForecastAssignment', 'placement'],
    ['MovePhase', 'placement'],
    ['MoveNodeQuestion', 'placement'],
    ['SetNodePointsDone', 'invariant-checked'],
    ['SetNodeEffort', 'invariant-checked'],
    ['ConfigureForecastPlan', 'invariant-checked'],
    ['CreateNode', 'independent'],
    ['DeleteSubtree', 'independent'],
    ['AddNodeQuestion', 'independent'],
  ];

  for (const [type, expected] of cases) {
    it(`classifies ${type} as ${expected}`, () => {
      expect(mergeClassFor(type)).toBe(expected);
    });
  }

  it('returns a class for every union member (exhaustive switch)', () => {
    // A representative spread; the exhaustive switch fails typecheck if a new
    // type is added without a class (AC 27.3-3).
    const samples: ProductCommand['type'][] = [
      'CreateProject', 'RenameProject', 'DeleteProject', 'CreateNode', 'SetNodeTitle',
      'SetNodeBodyText', 'MoveNode', 'DeleteSubtree', 'DuplicateSubtree', 'RestoreSubtree',
      'SetNodeType', 'SetNodeCustomField', 'PromoteFieldToTemplate', 'SetNodeSchedule',
      'ToggleNodeCompleted', 'SetNodeEffort', 'SetNodePointsDone', 'SetNodeStatus',
      'SetThemeWeight', 'CreatePhase', 'RenamePhase', 'ReorderPhases', 'MovePhase',
      'AssignNodePhase', 'DeletePhase', 'RestorePhase', 'CreateUnlockEdge', 'DeleteUnlockEdge',
      'DismissFinding', 'UndismissFinding', 'RecordAffectedReasons', 'AcknowledgeAffectedReason',
      'ClearNodeAffectedReasons', 'AddNodeQuestion', 'UpdateNodeQuestion', 'ResolveNodeQuestion',
      'ReorderNodeQuestions', 'MoveNodeQuestion', 'DeleteNodeQuestion', 'ConfigureForecastPlan',
      'SetForecastMembership', 'RemoveForecastPlan', 'ReorderForecastFeatures',
      'SetForecastSequence', 'SetForecastParallelGroups', 'RestoreForecastScope',
      'SetForecastPlanningLevel', 'RestoreForecastPlanningLevel', 'SetForecastBlocker', 'SetForecastSprintPlan',
      'CreateForecastScenario', 'RemoveForecastScenario', 'RestoreForecastScenario',
      'AddForecastPerson', 'UpdateForecastPerson', 'RemoveForecastPerson', 'RestoreForecastPerson',
      'SetForecastAssignments', 'SetForecastPolicy', 'MoveForecastFeature', 'SetForecastAssignment',
    ];
    const allowed: MergeClass[] = ['independent', 'same-field', 'placement', 'invariant-checked', 'local-only'];
    for (const type of samples) expect(allowed).toContain(mergeClassFor(type));
  });
});

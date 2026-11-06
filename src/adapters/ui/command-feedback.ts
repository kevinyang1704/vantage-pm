/**
 * Command-rejection feedback (Story 6.3 Task 4).
 *
 * View-agnostic formatter mapping a ProductCommandRejected.code to a
 * human-safe cause + resultingState pair, mirroring TreeRegion's error-state
 * contract. No existing formatter covered this; shared so Outline can adopt
 * the same copy later.
 */

import type { ProductCommandRejected } from '../../contracts/repository-commands';

export interface RejectionFeedback {
  readonly cause: string;
  readonly resultingState: string;
}

const COPY: Readonly<Record<ProductCommandRejected['code'], RejectionFeedback>> = Object.freeze({
  INVALID_NODE_STATUS: Object.freeze({cause: 'The delivery status is invalid.', resultingState: 'The edit was not applied; your input is preserved.'}),
  INVALID_DELETION_BUNDLE: Object.freeze({cause: 'The saved deletion data is incomplete or invalid.', resultingState: 'Nothing was restored; the saved deletion is preserved.'}),
  RESTORE_IDENTITY_CONFLICT: Object.freeze({cause: 'A saved identity is already in use.', resultingState: 'Nothing was restored; the saved deletion is preserved.'}),
  RESTORE_POSITION_CONFLICT: Object.freeze({cause: 'The saved tree position is now occupied.', resultingState: 'Nothing was restored; the saved deletion is preserved.'}),
  RESTORE_DEPENDENCY_MISSING: Object.freeze({cause: 'A parent, phase or connected node needed for restoration is missing.', resultingState: 'Nothing was restored; the saved deletion is preserved.'}),
  SHARED_BUNDLED_RESTORE_UNAVAILABLE: Object.freeze({cause: 'Complete deletion undo is not available in a shared project yet.', resultingState: 'Nothing was restored; the saved deletion is preserved.'}),
  SHARED_PROJECT_READ_ONLY: Object.freeze({cause: 'You can view this shared project but not change it.', resultingState: 'Nothing was changed. Ask an owner for editor access.'}),
  SHARED_PROJECT_NOT_CONNECTED: Object.freeze({cause: 'This project is shared, so edits need the collaboration version of the app, connected to your team.', resultingState: 'Nothing was changed. In the collaboration version, wait for it to connect and try again.'}),
  SHARED_ATOMIC_GROUP_UNAVAILABLE: Object.freeze({cause: 'This shared project is still connecting, so a grouped edit cannot be saved yet.', resultingState: 'Nothing was changed; try again in a moment.'}),
  ATOMIC_GROUP_REJECTED: Object.freeze({cause: 'Another part of this grouped edit could not be applied.', resultingState: 'Nothing from the grouped edit was changed; your input is preserved.'}),
  VIEWER_CANNOT_WRITE: Object.freeze({cause: 'You can view this shared project but not change it.', resultingState: 'The edit was not applied; your input is preserved.'}),
  REVISION_CONFLICT: Object.freeze({
    cause: 'This edit is based on an outdated version of the project.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  PROJECT_NOT_FOUND: Object.freeze({
    cause: 'The project could not be found.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  COMMAND_IDENTITY_CONFLICT: Object.freeze({
    cause: 'This command was already recorded with a different identity.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  NODE_NOT_FOUND: Object.freeze({
    cause: 'The node no longer exists.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  PARENT_NOT_FOUND: Object.freeze({
    cause: 'The target parent node no longer exists.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  CYCLE_DETECTED: Object.freeze({
    cause: 'This move would create a cycle in the tree.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  PHASE_NOT_FOUND: Object.freeze({
    cause: 'The phase no longer exists.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  EDGE_CONFLICT: Object.freeze({
    cause: 'This relationship conflicts with an existing one.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  FIELD_CONFLICT: Object.freeze({
    cause: 'This field conflicts with an existing value.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  HIERARCHY_CONFLICT: Object.freeze({
    cause: 'This move or type change would create an invalid hierarchy relationship.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  FORECAST_SCOPE_INVALID: Object.freeze({
    cause: 'The forecast scope contains a foreign, non-Feature, duplicate, or overlapping member.',
    resultingState: 'The forecast was not changed; your selection is preserved.',
  }),
  FORECAST_GROUP_INVALID: Object.freeze({
    cause: 'The forecast parallel group is invalid (too small, overlapping, or not contiguous).',
    resultingState: 'The forecast was not changed; your selection is preserved.',
  }),
  FORECAST_GROUP_SPLIT: Object.freeze({
    cause: 'That position splits a parallel group. Place it before or after the group, or ungroup first.',
    resultingState: 'The forecast was not changed; your order is preserved.',
  }),
  FORECAST_CONFIG_INVALID: Object.freeze({
    cause: 'The forecast configuration has an invalid value (capacity, sprint length, start sprint, or date).',
    resultingState: 'The forecast was not changed; your saved configuration is preserved.',
  }),
  FORECAST_POLICY_UNSUPPORTED: Object.freeze({
    cause: 'The forecast policy version is not supported by this build.',
    resultingState: 'The forecast was not changed; your selection is preserved.',
  }),
  FORECAST_BLOCKER_INVALID: Object.freeze({
    cause: 'That Feature is not in the forecast, or its blocker is already in that state.',
    resultingState: 'The forecast was not changed; your selection is preserved.',
  }),
  FORECAST_SPRINT_PLAN_INVALID: Object.freeze({
    cause: 'That sprint plan could not be saved; the plan is missing or has not changed.',
    resultingState: 'The sprint plan was not changed; your selection is preserved.',
  }),
  FORECAST_SCENARIO_INVALID: Object.freeze({
    cause: 'That scenario could not be saved — its identity is already in use or its patch references a node that is not a Feature.',
    resultingState: 'No scenario was saved; your draft is preserved.',
  }),
  FORECAST_SCENARIO_STALE: Object.freeze({
    cause: 'The live plan changed after this scenario preview was taken.',
    resultingState: 'No scenario was saved; re-preview against the current plan and try again.',
  }),
  FORECAST_SCENARIO_NOT_FOUND: Object.freeze({
    cause: 'That scenario no longer exists.',
    resultingState: 'No change was made.',
  }),
  FORECAST_PERSON_INVALID: Object.freeze({
    cause: 'The person has an invalid name or non-positive capacity weight.',
    resultingState: 'The roster was not changed; your input is preserved.',
  }),
  FORECAST_PERSON_NOT_FOUND: Object.freeze({
    cause: 'That person could not be found in the project roster.',
    resultingState: 'The roster was not changed.',
  }),
  FORECAST_PERSON_ASSIGNED: Object.freeze({
    cause: 'That person is currently assigned to work in the forecast. Remove their assignments first.',
    resultingState: 'The roster was not changed; your input is preserved.',
  }),
  FORECAST_PERSON_EXISTS: Object.freeze({
    cause: 'A person with that ID already exists in this roster.',
    resultingState: 'The roster was not changed.',
  }),
  FORECAST_ASSIGNMENT_INVALID: Object.freeze({
    cause: 'The assignment contains invalid, duplicate, or foreign person references.',
    resultingState: 'The assignment was not changed; your input is preserved.',
  }),
  FORECAST_ASSIGNMENT_CONFLICT: Object.freeze({
    cause: 'A person is assigned to multiple positive-point items in the same parallel bucket.',
    resultingState: 'The change was not applied; your input is preserved.',
  }),
  FORECAST_ASSIGNMENT_ZERO_WORK: Object.freeze({
    cause: 'Assignments cannot be added to a zero-point milestone item.',
    resultingState: 'The assignment was not changed.',
  }),
  FORECAST_POLICY_INVALID: Object.freeze({
    cause: 'The requested forecast policy is invalid or cannot be activated due to unresolved conflicts.',
    resultingState: 'The forecast mode was not changed; your plan is preserved.',
  }),
  FORECAST_PLAN_CORRUPT: Object.freeze({
    cause: 'Stored forecast inputs could not be read.',
    resultingState: 'Reopen the project or restore from a backup.',
  }),
  UNSUPPORTED_NEWER_SCHEMA: Object.freeze({
    cause: 'This project data was saved by a newer version of the app.',
    resultingState: 'Reload to update.',
  }),
  EFFORT_BELOW_POINTS_DONE: Object.freeze({
    cause: 'The new estimate is lower than the points already recorded as done.',
    resultingState: 'The estimate was not changed; lower the points done first.',
  }),
  POINTS_DONE_CONFLICT: Object.freeze({
    cause: 'Points done must be a whole number between 0 and the item\'s estimate.',
    resultingState: 'The value was not saved; correct it and try again.',
  }),
  SELF_ANCHOR: Object.freeze({
    cause: 'An item cannot be placed next to itself.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  INVALID_PLACEMENT: Object.freeze({
    cause: 'That position is not a valid place for this item.',
    resultingState: 'The edit was not applied; your input is preserved.',
  }),
  CHANGED_BY_OTHER_ACTOR: Object.freeze({
    cause: 'A teammate changed this after you.',
    resultingState: 'The undo was not applied; your change stays as it is.',
  }),
});

export function formatCommandRejection(rejection: ProductCommandRejected): RejectionFeedback {
  return COPY[rejection.code] ?? Object.freeze({
    cause: 'The command was rejected.',
    resultingState: 'The edit was not applied; your input is preserved.',
  });
}
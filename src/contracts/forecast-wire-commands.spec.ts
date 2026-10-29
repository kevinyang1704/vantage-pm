/**
 * Forecast wire-command + portable-plan validation specs
 * (Epic 18 review, 2026-09-06).
 *
 *  - the structured-clone-on-receipt validators for the two Epic 18 commands
 *    (AR-21) — previously untested
 *  - `validateForecastPlan` inside a v4 portable envelope: numeric domain,
 *    strict calendar date, supported policy, unique in-scope Feature
 *    references, and disjoint / contiguous / >=2 parallel groups (AR-25)
 */

import { describe, expect, it } from 'vitest';
import { createUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import {
  validateConfigureForecastPlanWireCommand,
  validateRemoveForecastPlanWireCommand,
  validateSetForecastMembershipWireCommand,
  validateReorderForecastFeaturesWireCommand,
  validateSetForecastParallelGroupsWireCommand,
  validateRestoreForecastScopeWireCommand,
  validateSetForecastPlanningLevelWireCommand,
  validateRestoreForecastPlanningLevelWireCommand,
  validateAddForecastPersonWireCommand,
  validateUpdateForecastPersonWireCommand,
  validateRemoveForecastPersonWireCommand,
  validateRestoreForecastPersonWireCommand,
  validateSetForecastAssignmentsWireCommand,
  validateSetForecastPolicyWireCommand,
} from './repository-commands';
import { validatePortableFileEnvelope } from './portable-file.schema';

const PROJECT_ID = '018f3a80-0000-7000-8000-000000000001';
const FEATURE_A = '018f3a80-0000-7000-8000-0000000000a1';
const FEATURE_B = '018f3a80-0000-7000-8000-0000000000a2';
const FEATURE_C = '018f3a80-0000-7000-8000-0000000000a3';

function configCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ConfigureForecastPlan',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
    pointsPerSprint: 10,
    sprintLengthDays: 14,
    startSprintOrdinal: 12,
    startDate: '2026-09-07',
    ...over,
  };
}

describe('validateConfigureForecastPlanWireCommand (AR-21)', () => {
  it('accepts a well-formed command', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd())).not.toThrow();
  });

  it('rejects a negative capacity', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ pointsPerSprint: -5 }))).toThrow(/INVALID_POINTS/);
  });

  it('rejects a non-integer sprint length', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ sprintLengthDays: 1.5 }))).toThrow(/INVALID_SPRINT_LENGTH/);
  });

  it('rejects a zero start ordinal', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ startSprintOrdinal: 0 }))).toThrow(/INVALID_START_ORDINAL/);
  });

  it('rejects a malformed start date', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ startDate: '09/07/2026' }))).toThrow(/INVALID_START_DATE/);
  });

  it('rejects an expectedRevision that is not baseRevision + 1', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ expectedRevision: 7 }))).toThrow(/INVALID_COMMAND/);
  });

  it('accepts explicit nulls (incomplete configuration is valid plan state)', () => {
    expect(() =>
      validateConfigureForecastPlanWireCommand(
        configCmd({ pointsPerSprint: null, sprintLengthDays: null, startSprintOrdinal: null, startDate: null }),
      ),
    ).not.toThrow();
  });

  it('accepts each valid carried planning level and an explicit null (Story 21.13 D5)', () => {
    for (const level of ['Theme', 'Component', 'Feature']) {
      expect(() => validateConfigureForecastPlanWireCommand(configCmd({ planningLevel: level }))).not.toThrow();
    }
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ planningLevel: null }))).not.toThrow();
  });

  it('rejects an unknown carried planning level (Story 21.13 D5)', () => {
    expect(() => validateConfigureForecastPlanWireCommand(configCmd({ planningLevel: 'Epic' }))).toThrow(/INVALID_PLANNING_LEVEL/);
  });
});

describe('validateRemoveForecastPlanWireCommand (Story 21.13 D5)', () => {
  const base = {
    type: 'RemoveForecastPlan',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
  };

  it('accepts a well-formed removal', () => {
    expect(() => validateRemoveForecastPlanWireCommand({ ...base, commandId: createUuidV7() })).not.toThrow();
  });

  it('rejects a mismatched expected revision', () => {
    expect(() => validateRemoveForecastPlanWireCommand({ ...base, commandId: createUuidV7(), expectedRevision: 9 })).toThrow(/INVALID_COMMAND/);
  });

  it('rejects a non-UUIDv7 projectId', () => {
    expect(() => validateRemoveForecastPlanWireCommand({ ...base, commandId: createUuidV7(), projectId: 'nope' })).toThrow();
  });
});

describe('validateSetForecastMembershipWireCommand (AR-21)', () => {
  const base = {
    type: 'SetForecastMembership',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
    featureId: FEATURE_A,
    included: true,
  };

  it('accepts a well-formed command', () => {
    expect(() => validateSetForecastMembershipWireCommand({ ...base, commandId: createUuidV7() })).not.toThrow();
  });

  it('rejects a non-boolean included', () => {
    expect(() =>
      validateSetForecastMembershipWireCommand({ ...base, commandId: createUuidV7(), included: 'yes' }),
    ).toThrow(/INVALID_INCLUDED/);
  });

  it('rejects a non-UUIDv7 featureId', () => {
    expect(() =>
      validateSetForecastMembershipWireCommand({ ...base, commandId: createUuidV7(), featureId: 'nope' }),
    ).toThrow();
  });
});

describe('validateReorderForecastFeaturesWireCommand (AR-21, Epic 19)', () => {
  const base = {
    type: 'ReorderForecastFeatures',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
    featureIds: [FEATURE_B, FEATURE_A, FEATURE_C],
  };

  it('accepts a well-formed command', () => {
    expect(() => validateReorderForecastFeaturesWireCommand({ ...base, commandId: createUuidV7() })).not.toThrow();
  });

  it('rejects a non-array featureIds', () => {
    expect(() =>
      validateReorderForecastFeaturesWireCommand({ ...base, commandId: createUuidV7(), featureIds: 'nope' }),
    ).toThrow(/INVALID_FEATURE_IDS/);
  });

  it('rejects invalid UUIDv7 in featureIds', () => {
    expect(() =>
      validateReorderForecastFeaturesWireCommand({ ...base, commandId: createUuidV7(), featureIds: [FEATURE_A, 'invalid'] }),
    ).toThrow();
  });
});

describe('validateSetForecastParallelGroupsWireCommand (AR-21, Epic 19)', () => {
  const base = {
    type: 'SetForecastParallelGroups',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
    parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }],
  };

  it('accepts a well-formed command', () => {
    expect(() => validateSetForecastParallelGroupsWireCommand({ ...base, commandId: createUuidV7() })).not.toThrow();
  });

  it('rejects non-array parallelGroups', () => {
    expect(() =>
      validateSetForecastParallelGroupsWireCommand({ ...base, commandId: createUuidV7(), parallelGroups: 'nope' }),
    ).toThrow(/INVALID_PARALLEL_GROUPS/);
  });

  it('rejects invalid group element in parallelGroups', () => {
    expect(() =>
      validateSetForecastParallelGroupsWireCommand({ ...base, commandId: createUuidV7(), parallelGroups: [null] }),
    ).toThrow(/INVALID_PARALLEL_GROUPS/);
  });
});

describe('validateRestoreForecastScopeWireCommand (AR-21, Epic 19)', () => {
  const base = {
    type: 'RestoreForecastScope',
    protocolVersion: '1.0.0',
    commandId: createUuidV7(),
    projectId: PROJECT_ID,
    baseRevision: 4,
    expectedRevision: 5,
    selectedFeatureIds: [FEATURE_A, FEATURE_B],
    parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }],
    blockedFeatureIds: [],
  };

  it('accepts a well-formed command', () => {
    expect(() => validateRestoreForecastScopeWireCommand({ ...base, commandId: createUuidV7() })).not.toThrow();
  });

  it('rejects non-array selectedFeatureIds', () => {
    expect(() =>
      validateRestoreForecastScopeWireCommand({ ...base, commandId: createUuidV7(), selectedFeatureIds: 'nope' }),
    ).toThrow(/INVALID_SELECTED_FEATURE_IDS/);
  });
});

function v4Envelope(forecastPlan: unknown): unknown {
  return {
    schemaVersion: 4,
    exportedAt: '2026-08-14T00:00:00.000Z',
    project: { id: PROJECT_ID, name: 'Test Project' },
    phases: [],
    nodes: [
      { id: FEATURE_A, parentId: null, title: 'Feature A', bodyText: null, position: '4294967296', nodeType: 'Feature', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: 10, strategicWeight: null, phaseId: null },
      { id: FEATURE_B, parentId: null, title: 'Feature B', bodyText: null, position: '8589934592', nodeType: 'Feature', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: 10, strategicWeight: null, phaseId: null },
      { id: FEATURE_C, parentId: null, title: 'Feature C', bodyText: null, position: '12884901888', nodeType: 'Feature', startDate: null, endDate: null, durationDays: null, scheduleSourceMode: null, completed: false, effortPoints: 10, strategicWeight: null, phaseId: null },
    ],
    nodeCustomFields: [],
    typeTemplateFields: [],
    unlockEdges: [],
    findingDismissals: [],
    affectedReasons: [],
    openQuestions: [],
    forecastPlan,
  };
}

const VALID_PLAN = Object.freeze({
  selectedFeatureIds: [FEATURE_A, FEATURE_B, FEATURE_C],
  parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }],
  pointsPerSprint: 10,
  sprintLengthDays: 14,
  cadence: 'fixed-contiguous',
  startSprintOrdinal: 12,
  startDate: '2026-09-07',
  policyVersion: 'shared-capacity-v1',
});

describe('portable v4 forecastPlan validation (AR-25)', () => {
  it('accepts a fully valid plan', () => {
    const res = validatePortableFileEnvelope(v4Envelope(VALID_PLAN));
    expect(res.ok).toBe(true);
  });

  it('rejects an impossible calendar date', () => {
    const res = validatePortableFileEnvelope(v4Envelope({ ...VALID_PLAN, startDate: '2026-02-30' }));
    expect(res.ok).toBe(false);
  });

  it('rejects a fractional capacity', () => {
    const res = validatePortableFileEnvelope(v4Envelope({ ...VALID_PLAN, pointsPerSprint: 3.5 }));
    expect(res.ok).toBe(false);
  });

  it('rejects a negative sprint length', () => {
    const res = validatePortableFileEnvelope(v4Envelope({ ...VALID_PLAN, sprintLengthDays: -3 }));
    expect(res.ok).toBe(false);
  });

  it('rejects a duplicate selected reference', () => {
    const res = validatePortableFileEnvelope(
      v4Envelope({ ...VALID_PLAN, selectedFeatureIds: [FEATURE_A, FEATURE_A, FEATURE_B] }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a reference to a node that is not a Feature in the file', () => {
    const res = validatePortableFileEnvelope(
      v4Envelope({ ...VALID_PLAN, selectedFeatureIds: [FEATURE_A, '018f3a80-0000-7000-8000-0000000000ff'] }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects a non-contiguous parallel group', () => {
    const res = validatePortableFileEnvelope(
      v4Envelope({ ...VALID_PLAN, parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_C] }] }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an unsupported policy version', () => {
    const res = validatePortableFileEnvelope(v4Envelope({ ...VALID_PLAN, policyVersion: 'shared-capacity-v2' }));
    expect(res.ok).toBe(false);
  });
});

// ── Epic 21 Wire Commands (Story 21.7) ────────────────────────────────────

describe('validateSetForecastPlanningLevelWireCommand (Story 21.7)', () => {
  function levelCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'SetForecastPlanningLevel',
      protocolVersion: '1.0.0',
      commandId: createUuidV7(),
      projectId: PROJECT_ID,
      baseRevision: 4,
      expectedRevision: 5,
      planningLevel: 'Theme',
      ...over,
    };
  }

  it('accepts a well-formed command for each level', () => {
    for (const level of ['Theme', 'Component', 'Feature']) {
      expect(() => validateSetForecastPlanningLevelWireCommand(levelCmd({ planningLevel: level }))).not.toThrow();
    }
  });

  it('rejects an unknown planning level', () => {
    expect(() => validateSetForecastPlanningLevelWireCommand(levelCmd({ planningLevel: 'Epic' }))).toThrow(/INVALID_PLANNING_LEVEL/);
  });

  it('rejects a mismatched expected revision', () => {
    expect(() => validateSetForecastPlanningLevelWireCommand(levelCmd({ expectedRevision: 9 }))).toThrow(/INVALID_COMMAND/);
  });
});

describe('validateRestoreForecastPlanningLevelWireCommand (Story 21.7)', () => {
  function restoreCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'RestoreForecastPlanningLevel',
      protocolVersion: '1.0.0',
      commandId: createUuidV7(),
      projectId: PROJECT_ID,
      baseRevision: 4,
      expectedRevision: 5,
      planningLevel: 'Feature',
      selectedFeatureIds: [FEATURE_A, FEATURE_B],
      parallelGroups: [{ featureIds: [FEATURE_A, FEATURE_B] }],
      blockedFeatureIds: [FEATURE_A],
      ...over,
    };
  }

  it('accepts a well-formed command', () => {
    expect(() => validateRestoreForecastPlanningLevelWireCommand(restoreCmd())).not.toThrow();
  });

  it('rejects a non-array selectedFeatureIds', () => {
    expect(() => validateRestoreForecastPlanningLevelWireCommand(restoreCmd({ selectedFeatureIds: 'nope' }))).toThrow(/INVALID_SELECTED_FEATURE_IDS/);
  });

  it('rejects a malformed parallel group', () => {
    expect(() => validateRestoreForecastPlanningLevelWireCommand(restoreCmd({ parallelGroups: [{ featureIds: 'nope' }] }))).toThrow(/INVALID_PARALLEL_GROUPS/);
  });

  it('rejects a non-array blockedFeatureIds', () => {
    expect(() => validateRestoreForecastPlanningLevelWireCommand(restoreCmd({ blockedFeatureIds: 'nope' }))).toThrow(/INVALID_BLOCKED_FEATURE_IDS/);
  });
});

describe('Story 22.3 Roster Wire Commands', () => {
  const PERSON_ID = '018f3a80-0000-7000-8000-0000000000d1';

  describe('validateAddForecastPersonWireCommand', () => {
    function addCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'AddForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 2,
        expectedRevision: 3,
        personId: PERSON_ID,
        name: 'Ada Lovelace',
        weightUnits: 100,
        ...over,
      };
    }

    it('accepts a valid AddForecastPerson wire command', () => {
      expect(() => validateAddForecastPersonWireCommand(addCmd())).not.toThrow();
    });

    it('rejects an empty name', () => {
      expect(() => validateAddForecastPersonWireCommand(addCmd({ name: '   ' }))).toThrow(/INVALID_PERSON_NAME/);
    });

    it('rejects non-positive weight', () => {
      expect(() => validateAddForecastPersonWireCommand(addCmd({ weightUnits: 0 }))).toThrow(/INVALID_STAFFING_WEIGHT/);
      expect(() => validateAddForecastPersonWireCommand(addCmd({ weightUnits: -10 }))).toThrow(/INVALID_STAFFING_WEIGHT/);
    });

    it('rejects invalid revision', () => {
      expect(() => validateAddForecastPersonWireCommand(addCmd({ expectedRevision: 5 }))).toThrow(/INVALID_COMMAND/);
    });
  });

  describe('validateUpdateForecastPersonWireCommand', () => {
    function updateCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'UpdateForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 3,
        expectedRevision: 4,
        personId: PERSON_ID,
        name: 'Augusta Ada King',
        weightUnits: 150,
        ...over,
      };
    }

    it('accepts a valid UpdateForecastPerson wire command', () => {
      expect(() => validateUpdateForecastPersonWireCommand(updateCmd())).not.toThrow();
    });

    it('rejects non-positive weight', () => {
      expect(() => validateUpdateForecastPersonWireCommand(updateCmd({ weightUnits: -5 }))).toThrow(/INVALID_STAFFING_WEIGHT/);
    });
  });

  describe('validateRemoveForecastPersonWireCommand', () => {
    function removeCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'RemoveForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 4,
        expectedRevision: 5,
        personId: PERSON_ID,
        ...over,
      };
    }

    it('accepts a valid RemoveForecastPerson wire command', () => {
      expect(() => validateRemoveForecastPersonWireCommand(removeCmd())).not.toThrow();
    });

    it('rejects invalid UUIDv7 personId', () => {
      expect(() => validateRemoveForecastPersonWireCommand(removeCmd({ personId: 'not-a-uuid' }))).toThrow();
    });
  });

  describe('validateRestoreForecastPersonWireCommand', () => {
    function restorePersonCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'RestoreForecastPerson',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 5,
        expectedRevision: 6,
        person: {
          id: PERSON_ID,
          name: 'Ada Lovelace',
          weightUnits: 100,
        },
        ...over,
      };
    }

    it('accepts a valid RestoreForecastPerson wire command', () => {
      expect(() => validateRestoreForecastPersonWireCommand(restorePersonCmd())).not.toThrow();
    });

    it('rejects missing or invalid person', () => {
      expect(() => validateRestoreForecastPersonWireCommand(restorePersonCmd({ person: null }))).toThrow(/INVALID_PERSON/);
      expect(() => validateRestoreForecastPersonWireCommand(restorePersonCmd({ person: { id: PERSON_ID, name: '', weightUnits: 100 } }))).toThrow(/INVALID_PERSON_NAME/);
    });
  });
});

describe('Story 22.4 Assignments and Policy Wire Commands', () => {
  const PERSON_ID = '018f3a80-0000-7000-8000-0000000000d1';

  describe('validateSetForecastAssignmentsWireCommand', () => {
    function assignCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'SetForecastAssignments',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 2,
        expectedRevision: 3,
        featureId: FEATURE_A,
        personIds: [PERSON_ID],
        ...over,
      };
    }

    it('accepts a valid SetForecastAssignments wire command', () => {
      expect(() => validateSetForecastAssignmentsWireCommand(assignCmd())).not.toThrow();
    });

    it('accepts empty assignments', () => {
      expect(() => validateSetForecastAssignmentsWireCommand(assignCmd({ personIds: [] }))).not.toThrow();
    });

    it('rejects invalid featureId', () => {
      expect(() => validateSetForecastAssignmentsWireCommand(assignCmd({ featureId: 'bad' }))).toThrow();
    });

    it('rejects invalid personIds list', () => {
      expect(() => validateSetForecastAssignmentsWireCommand(assignCmd({ personIds: 'not-an-array' }))).toThrow(/INVALID_PERSON_IDS/);
      expect(() => validateSetForecastAssignmentsWireCommand(assignCmd({ personIds: ['invalid-uuid'] }))).toThrow();
    });
  });

  describe('validateSetForecastPolicyWireCommand', () => {
    function policyCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        type: 'SetForecastPolicy',
        protocolVersion: '1.0.0',
        commandId: createUuidV7(),
        projectId: PROJECT_ID,
        baseRevision: 3,
        expectedRevision: 4,
        policyVersion: 'staffed-capacity-v1',
        ...over,
      };
    }

    it('accepts valid policy versions', () => {
      expect(() => validateSetForecastPolicyWireCommand(policyCmd({ policyVersion: 'shared-capacity-v1' }))).not.toThrow();
      expect(() => validateSetForecastPolicyWireCommand(policyCmd({ policyVersion: 'staffed-capacity-v1' }))).not.toThrow();
    });

    it('rejects unknown policy versions', () => {
      expect(() => validateSetForecastPolicyWireCommand(policyCmd({ policyVersion: 'unsupported-v2' }))).toThrow(/INVALID_POLICY_VERSION/);
    });
  });
});



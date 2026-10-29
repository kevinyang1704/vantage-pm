import { describe, it, expect } from 'vitest';
import { computeInverseDescriptor } from './inverse-command.policy';
import { createChangeSet } from '../../contracts/change-set';

describe('inverse-command.policy', () => {
  it('returns null for empty change list', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [],
    });
    expect(computeInverseDescriptor(cs)).toBeNull();
  });

  it('computes inverse for NodeCreated', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeCreated',
        nodeId: 'node1',
        parentId: null,
        title: 'New Node',
        position: '1000',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'DeleteSubtree',
      nodeId: 'node1',
    });
  });

  it('computes inverse for NodeTitleSet', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeTitleSet',
        nodeId: 'node1',
        title: 'Updated Title',
        priorTitle: 'Old Title',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'SetNodeTitle',
      nodeId: 'node1',
      title: 'Old Title',
    });
  });

  it('computes inverse for NodeBodyTextSet', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeBodyTextSet',
        nodeId: 'node1',
        bodyText: 'New text',
        priorBodyText: 'Old text',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'SetNodeBodyText',
      nodeId: 'node1',
      bodyText: 'Old text',
    });
  });

  it('computes inverse for NodeMoved', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeMoved',
        nodeId: 'node1',
        parentId: 'p2',
        position: '2000',
        priorParentId: 'p1',
        priorPosition: '1000',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'MoveNode',
      nodeId: 'node1',
      newParentId: 'p1',
      newPosition: '1000',
    });
  });

  it('computes inverse for SubtreeDeleted', () => {
    const nodeSnap = {
      nodeId: 'node1',
      parentId: null,
      title: 'Root',
      bodyText: null,
      position: '1000',
      depth: 0,
      nodeType: null,
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: 'none' as const,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
    };
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'SubtreeDeleted',
        rootNodeId: 'node1',
        nodes: [nodeSnap],
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'RestoreSubtree',
      rootNodeId: 'node1',
      nodes: [nodeSnap],
    });
  });

  it('computes inverse for SubtreeRestored and SubtreeDuplicated', () => {
    const nodeSnap = {
      nodeId: 'node1',
      parentId: null,
      title: 'Root',
      bodyText: null,
      position: '1000',
      depth: 0,
      nodeType: null,
      startDate: null,
      endDate: null,
      durationDays: null,
      scheduleSourceMode: 'none' as const,
      completed: false,
      effortPoints: null,
      strategicWeight: null,
      phaseId: null,
    };

    const csRestored = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'SubtreeRestored',
        rootNodeId: 'node1',
        nodes: [nodeSnap],
      }],
    });
    expect(computeInverseDescriptor(csRestored)).toEqual({
      type: 'DeleteSubtree',
      nodeId: 'node1',
    });

    const csDup = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'SubtreeDuplicated',
        sourceRootId: 'node1',
        newRootId: 'dup1',
        nodes: [{ ...nodeSnap, nodeId: 'dup1' }],
      }],
    });
    expect(computeInverseDescriptor(csDup)).toEqual({
      type: 'DeleteSubtree',
      nodeId: 'dup1',
    });
  });

  it('computes inverse for SetNodeType', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeTypeSet',
        nodeId: 'node1',
        nodeType: 'Feature',
        priorNodeType: 'Theme',
      }],
    });
    const inv = computeInverseDescriptor(cs);
    expect(inv).toEqual({
      type: 'SetNodeType',
      nodeId: 'node1',
      nodeType: 'Theme',
    });
  });

  it('computes inverse for SetNodeCustomField', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeCustomFieldSet',
        nodeId: 'node1',
        fieldKey: 'k1',
        fieldValue: 'v1',
        priorFieldValue: 'v0',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'SetNodeCustomField',
      nodeId: 'node1',
      fieldKey: 'k1',
      fieldValue: 'v0',
    });
  });

  it('computes inverse for SetNodeSchedule', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeScheduleSet',
        nodeId: 'node1',
        startDate: '2026-09-01',
        endDate: '2026-09-07',
        durationDays: 7,
        sourceMode: 'start_end',
        priorStartDate: null,
        priorEndDate: null,
        priorDurationDays: null,
        priorSourceMode: 'none',
      }],
    });
    const inv = computeInverseDescriptor(cs);
    expect(inv).toEqual({
      type: 'SetNodeSchedule',
      nodeId: 'node1',
      startDate: null,
      endDate: null,
      durationDays: null,
      sourceMode: 'none',
    });
  });

  it('computes inverse for ToggleNodeCompleted', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeCompletedToggled',
        nodeId: 'node1',
        completed: true,
        priorCompleted: false,
      }],
    });
    const inv = computeInverseDescriptor(cs);
    expect(inv).toEqual({
      type: 'ToggleNodeCompleted',
      nodeId: 'node1',
      completed: false,
    });
  });

  it('computes inverse for SetNodeEffort and SetThemeWeight', () => {
    const csEffort = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeEffortSet',
        nodeId: 'node1',
        effortPoints: 5,
        priorEffortPoints: 3,
      }],
    });
    expect(computeInverseDescriptor(csEffort)).toEqual({
      type: 'SetNodeEffort',
      nodeId: 'node1',
      effortPoints: 3,
    });

    const csWeight = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'ThemeWeightSet',
        nodeId: 'node1',
        strategicWeight: 50,
        priorStrategicWeight: null,
      }],
    });
    expect(computeInverseDescriptor(csWeight)).toEqual({
      type: 'SetThemeWeight',
      nodeId: 'node1',
      strategicWeight: null,
    });
  });

  it('computes inverse for SetNodeStatus (restores the prior delivery status)', () => {
    const cs = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodeStatusSet',
        nodeId: 'node1',
        deliveryStatus: 'delivered',
        priorDeliveryStatus: 'in_progress',
      }],
    });
    expect(computeInverseDescriptor(cs)).toEqual({
      type: 'SetNodeStatus',
      nodeId: 'node1',
      deliveryStatus: 'in_progress',
    });
  });

  it('computes inverse for Phase operations', () => {
    const csCreate = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'PhaseCreated',
        phaseId: 'ph1',
        name: 'Phase 1',
        position: '1000',
      }],
    });
    expect(computeInverseDescriptor(csCreate)).toEqual({
      type: 'DeletePhase',
      phaseId: 'ph1',
      reassignments: {},
    });

    const csRename = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'PhaseRenamed',
        phaseId: 'ph1',
        name: 'New Name',
        priorName: 'Old Name',
      }],
    });
    expect(computeInverseDescriptor(csRename)).toEqual({
      type: 'RenamePhase',
      phaseId: 'ph1',
      name: 'Old Name',
    });

    const csReorder = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'PhasesReordered',
        phases: [{ phaseId: 'ph1', position: '2000' }],
        priorPhases: [{ phaseId: 'ph1', position: '1000' }],
      }],
    });
    expect(computeInverseDescriptor(csReorder)).toEqual({
      type: 'ReorderPhases',
      phases: [{ phaseId: 'ph1', position: '1000' }],
    });

    const csAssign = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'NodePhaseAssigned',
        nodeId: 'node1',
        phaseId: 'ph1',
        priorPhaseId: null,
      }],
    });
    expect(computeInverseDescriptor(csAssign)).toEqual({
      type: 'AssignNodePhase',
      nodeId: 'node1',
      phaseId: null,
    });

    const csDelete = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'PhaseDeleted',
        phaseId: 'ph1',
        name: 'Phase 1',
        position: '1000',
        reassignments: { node1: null },
        priorAssignments: { node1: 'ph1' },
      }],
    });
    expect(computeInverseDescriptor(csDelete)).toEqual({
      type: 'RestorePhase',
      phaseId: 'ph1',
      name: 'Phase 1',
      position: '1000',
      priorAssignments: { node1: 'ph1' },
    });
  });

  it('computes inverse for UnlockEdgeCreated and UnlockEdgeDeleted', () => {
    const csCreate = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'UnlockEdgeCreated',
        edgeId: 'edge1',
        sourceNodeId: 'nodeA',
        targetNodeId: 'nodeB',
      }],
    });
    expect(computeInverseDescriptor(csCreate)).toEqual({
      type: 'DeleteUnlockEdge',
      edgeId: 'edge1',
      sourceNodeId: 'nodeA',
      targetNodeId: 'nodeB',
    });

    const csDelete = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'UnlockEdgeDeleted',
        edgeId: 'edge1',
        sourceNodeId: 'nodeA',
        targetNodeId: 'nodeB',
      }],
    });
    expect(computeInverseDescriptor(csDelete)).toEqual({
      type: 'CreateUnlockEdge',
      edgeId: 'edge1',
      sourceNodeId: 'nodeA',
      targetNodeId: 'nodeB',
    });
  });

  it('computes inverse for FindingDismissed and FindingUndismissed', () => {
    const csDismiss = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'FindingDismissed',
        findingId: 'f1',
        findingKind: 'OrphanedFeature',
        targetId: 'node1',
        fingerprint: 'fp1',
        dismissedAt: '2026-08-15T00:00:00Z',
      }],
    });
    expect(computeInverseDescriptor(csDismiss)).toEqual({
      type: 'UndismissFinding',
      findingId: 'f1',
      findingKind: 'OrphanedFeature',
      targetId: 'node1',
      fingerprint: 'fp1',
    });

    const csUndismiss = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'FindingUndismissed',
        findingId: 'f1',
        findingKind: 'OrphanedFeature',
        targetId: 'node1',
        fingerprint: 'fp1',
        priorDismissedAt: '2026-08-15T00:00:00Z',
      }],
    });
    expect(computeInverseDescriptor(csUndismiss)).toEqual({
      type: 'DismissFinding',
      findingId: 'f1',
      findingKind: 'OrphanedFeature',
      targetId: 'node1',
      fingerprint: 'fp1',
      dismissedAt: '2026-08-15T00:00:00Z',
    });
  });

  it('returns null for un-invertible changes like AffectedReasonsRecorded and unknown', () => {
    const csAff = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'AffectedReasonsRecorded',
        reasons: [],
      }],
    });
    expect(computeInverseDescriptor(csAff)).toBeNull();

    const csAck = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'AffectedReasonAcknowledged',
        reasonId: 'r1',
        acknowledgedAt: '2026-08-15T00:00:00Z',
      }],
    });
    expect(computeInverseDescriptor(csAck)).toBeNull();

    const csUnknown = createChangeSet({
      projectId: 'proj1',
      baseRevision: 1,
      targetRevision: 2,
      changes: [{
        type: 'UnknownType',
      } as unknown as import('../../contracts/change-set').NodeChange],
    });
    expect(computeInverseDescriptor(csUnknown)).toBeNull();
  });

  describe('Story 22.3 Roster Inverses', () => {
    const person = { id: '018f3a80-0000-7000-8000-0000000000d1', name: 'Ada', weightUnits: 100 };

    it('computes inverse for ForecastPersonAdded', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 1,
        targetRevision: 2,
        changes: [{ type: 'ForecastPersonAdded', projectId: 'proj1', person }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RemoveForecastPerson',
        personId: person.id,
      });
    });

    it('computes inverse for ForecastPersonUpdated', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 2,
        targetRevision: 3,
        changes: [{
          type: 'ForecastPersonUpdated',
          projectId: 'proj1',
          personId: person.id,
          name: 'Ada Lovelace',
          weightUnits: 150,
          priorName: 'Ada',
          priorWeightUnits: 100,
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'UpdateForecastPerson',
        personId: person.id,
        name: 'Ada',
        weightUnits: 100,
      });
    });

    it('computes inverse for ForecastPersonRemoved', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 3,
        targetRevision: 4,
        changes: [{ type: 'ForecastPersonRemoved', projectId: 'proj1', person }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RestoreForecastPerson',
        person,
      });
    });

    it('computes inverse for ForecastPersonRestored', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 4,
        targetRevision: 5,
        changes: [{ type: 'ForecastPersonRestored', projectId: 'proj1', person }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RemoveForecastPerson',
        personId: person.id,
      });
    });
  });

  describe('Story 22.4 Assignment & Staffing Inverses', () => {
    const person = { id: '018f3a80-0000-7000-8000-0000000000d1', name: 'Ada', weightUnits: 100 };
    const featureA = '018f3a80-0000-7000-8000-000000000001';
    const featureB = '018f3a80-0000-7000-8000-000000000002';

    it('computes inverse for ForecastAssignmentsSet', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 1,
        targetRevision: 2,
        changes: [{
          type: 'ForecastAssignmentsSet',
          projectId: 'proj1',
          featureId: featureA,
          personIds: [person.id],
          priorPersonIds: [],
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'SetForecastAssignments',
        featureId: featureA,
        personIds: [],
      });
    });

    it('computes inverse for ForecastPolicySet', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 2,
        targetRevision: 3,
        changes: [{
          type: 'ForecastPolicySet',
          projectId: 'proj1',
          policyVersion: 'staffed-capacity-v1',
          priorPolicyVersion: 'shared-capacity-v1',
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'SetForecastPolicy',
        policyVersion: 'shared-capacity-v1',
      });
    });

    it('computes inverse for ForecastPersonRemoved with priorAssignments', () => {
      const priorAssignments = { [featureA]: [person.id] };
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 3,
        targetRevision: 4,
        changes: [{
          type: 'ForecastPersonRemoved',
          projectId: 'proj1',
          person,
          priorAssignments,
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RestoreForecastPerson',
        person,
        assignments: priorAssignments,
      });
    });

    it('computes inverse for ForecastPlanningLevelSet with priorAssignments', () => {
      const priorAssignments = { [featureA]: [person.id] };
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 4,
        targetRevision: 5,
        changes: [{
          type: 'ForecastPlanningLevelSet',
          planningLevel: 'Theme',
          selectedFeatureIds: [],
          parallelGroups: [],
          blockedFeatureIds: [],
          priorPlanningLevel: 'Feature',
          priorSelectedFeatureIds: [featureA],
          priorParallelGroups: [],
          priorBlockedFeatureIds: [],
          priorAssignments,
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RestoreForecastPlanningLevel',
        planningLevel: 'Feature',
        selectedFeatureIds: [featureA],
        parallelGroups: [],
        blockedFeatureIds: [],
        assignments: priorAssignments,
      });
    });

    it('bypasses membership toggle shortcut and returns RestoreForecastScope when clearedAssignments exist', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 5,
        targetRevision: 6,
        changes: [{
          type: 'ForecastScopeSet',
          selectedFeatureIds: [featureA],
          parallelGroups: [],
          priorSelectedFeatureIds: [featureA, featureB],
          priorParallelGroups: [],
          blockedFeatureIds: [],
          priorBlockedFeatureIds: [],
          clearedAssignments: [person.id],
          priorAssignments: { [featureB]: [person.id] },
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'RestoreForecastScope',
        selectedFeatureIds: [featureA, featureB],
        parallelGroups: [],
        blockedFeatureIds: [],
        assignments: { [featureB]: [person.id] },
      });
    });

    it('computes inverse for NodeEffortSet with clearedAssignments', () => {
      const cs = createChangeSet({
        projectId: 'proj1',
        baseRevision: 6,
        targetRevision: 7,
        changes: [{
          type: 'NodeEffortSet',
          nodeId: featureA,
          effortPoints: 0,
          priorEffortPoints: 10,
          clearedAssignments: [person.id],
        }],
      });
      expect(computeInverseDescriptor(cs)).toEqual({
        type: 'SetNodeEffort',
        nodeId: featureA,
        effortPoints: 10,
        restoredAssignments: [person.id],
      });
    });
  });
});


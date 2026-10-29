/** Explicit wire-field inventory; keep exhaustive with NodeChange. */
import type { NodeChange } from './change-set';
export const RECOVERY_EFFECT_FIELDS = {
  "NodeCreated": {
    "required": [
      "type",
      "nodeId",
      "parentId",
      "position",
      "title"
    ],
    "optional": []
  },
  "NodeTitleSet": {
    "required": [
      "type",
      "nodeId",
      "title",
      "priorTitle"
    ],
    "optional": []
  },
  "NodeBodyTextSet": {
    "required": [
      "type",
      "nodeId",
      "bodyText",
      "priorBodyText"
    ],
    "optional": []
  },
  "NodeMoved": {
    "required": [
      "type",
      "nodeId",
      "parentId",
      "position",
      "priorParentId",
      "priorPosition"
    ],
    "optional": []
  },
  "SiblingPositionsRebalanced": {
    "required": [
      "type",
      "parentId",
      "positions"
    ],
    "optional": [
      "priorPositions"
    ]
  },
  "SubtreeDeleted": {
    "required": [
      "type",
      "rootNodeId",
      "nodes"
    ],
    "optional": [
      "deletionBundle"
    ]
  },
  "SubtreeRestored": {
    "required": [
      "type",
      "rootNodeId",
      "nodes"
    ],
    "optional": [
      "deletionBundle"
    ]
  },
  "SubtreeDuplicated": {
    "required": [
      "type",
      "sourceRootId",
      "newRootId",
      "nodes"
    ],
    "optional": []
  },
  "NodeTypeSet": {
    "required": [
      "type",
      "nodeId",
      "nodeType",
      "priorNodeType"
    ],
    "optional": []
  },
  "NodeCustomFieldSet": {
    "required": [
      "type",
      "nodeId",
      "fieldKey",
      "fieldValue",
      "priorFieldValue"
    ],
    "optional": []
  },
  "FieldTemplatePromoted": {
    "required": [
      "type",
      "nodeType",
      "fieldKey",
      "fieldLabel"
    ],
    "optional": []
  },
  "NodeScheduleSet": {
    "required": [
      "type",
      "nodeId",
      "startDate",
      "endDate",
      "durationDays",
      "sourceMode",
      "priorStartDate",
      "priorEndDate",
      "priorDurationDays",
      "priorSourceMode"
    ],
    "optional": []
  },
  "NodeCompletedToggled": {
    "required": [
      "type",
      "nodeId",
      "completed",
      "priorCompleted"
    ],
    "optional": []
  },
  "NodeEffortSet": {
    "required": [
      "type",
      "nodeId",
      "effortPoints",
      "priorEffortPoints"
    ],
    "optional": [
      "clearedAssignments"
    ]
  },
  "NodePointsDoneSet": {
    "required": [
      "type",
      "nodeId",
      "effortPointsDone",
      "priorEffortPointsDone"
    ],
    "optional": []
  },
  "NodeStatusSet": {
    "required": [
      "type",
      "nodeId",
      "deliveryStatus",
      "priorDeliveryStatus"
    ],
    "optional": []
  },
  "ThemeWeightSet": {
    "required": [
      "type",
      "nodeId",
      "strategicWeight",
      "priorStrategicWeight"
    ],
    "optional": []
  },
  "PhaseCreated": {
    "required": [
      "type",
      "phaseId",
      "name",
      "position"
    ],
    "optional": []
  },
  "PhaseRenamed": {
    "required": [
      "type",
      "phaseId",
      "name",
      "priorName"
    ],
    "optional": []
  },
  "PhasesReordered": {
    "required": [
      "type",
      "phases",
      "priorPhases"
    ],
    "optional": []
  },
  "NodePhaseAssigned": {
    "required": [
      "type",
      "nodeId",
      "phaseId",
      "priorPhaseId"
    ],
    "optional": []
  },
  "PhaseDeleted": {
    "required": [
      "type",
      "phaseId",
      "name",
      "position",
      "reassignments",
      "priorAssignments"
    ],
    "optional": []
  },
  "PhaseRestored": {
    "required": [
      "type",
      "phaseId",
      "name",
      "position",
      "priorAssignments"
    ],
    "optional": []
  },
  "UnlockEdgeCreated": {
    "required": [
      "type",
      "edgeId",
      "sourceNodeId",
      "targetNodeId"
    ],
    "optional": []
  },
  "UnlockEdgeDeleted": {
    "required": [
      "type",
      "edgeId",
      "sourceNodeId",
      "targetNodeId"
    ],
    "optional": []
  },
  "FindingDismissed": {
    "required": [
      "type",
      "findingId",
      "findingKind",
      "targetId",
      "fingerprint",
      "dismissedAt"
    ],
    "optional": []
  },
  "FindingUndismissed": {
    "required": [
      "type",
      "findingId",
      "findingKind",
      "targetId",
      "fingerprint",
      "priorDismissedAt"
    ],
    "optional": []
  },
  "AffectedReasonsRecorded": {
    "required": [
      "type",
      "reasons"
    ],
    "optional": []
  },
  "AffectedReasonAcknowledged": {
    "required": [
      "type",
      "reasonId",
      "acknowledgedAt"
    ],
    "optional": []
  },
  "NodeQuestionAdded": {
    "required": [
      "type",
      "questionId",
      "nodeId",
      "questionText",
      "position",
      "createdAtISO"
    ],
    "optional": []
  },
  "NodeQuestionUpdated": {
    "required": [
      "type",
      "questionId",
      "questionText",
      "priorQuestionText"
    ],
    "optional": []
  },
  "NodeQuestionResolved": {
    "required": [
      "type",
      "questionId",
      "decisionText",
      "resolvedAtISO",
      "priorStatus",
      "priorDecisionText",
      "priorResolvedAtISO"
    ],
    "optional": []
  },
  "NodeQuestionsReordered": {
    "required": [
      "type",
      "nodeId",
      "questionIds",
      "priorQuestionIds"
    ],
    "optional": []
  },
  "NodeQuestionDeleted": {
    "required": [
      "type",
      "questionId",
      "nodeId",
      "questionText",
      "status",
      "decisionText",
      "position",
      "resolvedAtISO",
      "createdAtISO"
    ],
    "optional": []
  },
  "ForecastPlanCreated": {
    "required": [
      "type",
      "projectId"
    ],
    "optional": []
  },
  "ForecastPlanRemoved": {
    "required": [
      "type",
      "projectId"
    ],
    "optional": []
  },
  "ForecastConfigurationSet": {
    "required": [
      "type",
      "pointsPerSprint",
      "sprintLengthDays",
      "startSprintOrdinal",
      "startDate",
      "priorPointsPerSprint",
      "priorSprintLengthDays",
      "priorStartSprintOrdinal",
      "priorStartDate"
    ],
    "optional": []
  },
  "ForecastScopeSet": {
    "required": [
      "type",
      "selectedFeatureIds",
      "parallelGroups",
      "priorSelectedFeatureIds",
      "priorParallelGroups",
      "blockedFeatureIds",
      "priorBlockedFeatureIds"
    ],
    "optional": [
      "clearedAssignments",
      "priorAssignments",
      "assignments"
    ]
  },
  "ForecastOrderSet": {
    "required": [
      "type",
      "selectedFeatureIds",
      "priorSelectedFeatureIds"
    ],
    "optional": [
      "priorMove"
    ]
  },
  "ForecastSequenceSet": {
    "required": [
      "type",
      "selectedFeatureIds",
      "parallelGroups",
      "priorSelectedFeatureIds",
      "priorParallelGroups"
    ],
    "optional": [
      "priorMove"
    ]
  },
  "ForecastParallelGroupsSet": {
    "required": [
      "type",
      "parallelGroups",
      "priorParallelGroups"
    ],
    "optional": []
  },
  "ForecastBlockerSet": {
    "required": [
      "type",
      "featureId",
      "blocked",
      "priorBlocked"
    ],
    "optional": []
  },
  "ForecastScenarioCreated": {
    "required": [
      "type",
      "scenario"
    ],
    "optional": []
  },
  "ForecastScenarioRemoved": {
    "required": [
      "type",
      "scenarioId",
      "scenario"
    ],
    "optional": []
  },
  "ForecastScenarioRestored": {
    "required": [
      "type",
      "scenario"
    ],
    "optional": []
  },
  "ForecastPlanningLevelSet": {
    "required": [
      "type",
      "planningLevel",
      "selectedFeatureIds",
      "parallelGroups",
      "blockedFeatureIds",
      "priorPlanningLevel",
      "priorSelectedFeatureIds",
      "priorParallelGroups",
      "priorBlockedFeatureIds"
    ],
    "optional": [
      "priorAssignments",
      "assignments"
    ]
  },
  "ForecastPersonAdded": {
    "required": [
      "type",
      "projectId",
      "person"
    ],
    "optional": []
  },
  "ForecastPersonUpdated": {
    "required": [
      "type",
      "projectId",
      "personId",
      "name",
      "weightUnits",
      "priorName",
      "priorWeightUnits"
    ],
    "optional": []
  },
  "ForecastPersonRemoved": {
    "required": [
      "type",
      "projectId",
      "person"
    ],
    "optional": [
      "priorAssignments"
    ]
  },
  "ForecastPersonRestored": {
    "required": [
      "type",
      "projectId",
      "person"
    ],
    "optional": [
      "assignments"
    ]
  },
  "ForecastAssignmentsSet": {
    "required": [
      "type",
      "projectId",
      "featureId",
      "personIds",
      "priorPersonIds"
    ],
    "optional": []
  },
  "ForecastPolicySet": {
    "required": [
      "type",
      "projectId",
      "policyVersion",
      "priorPolicyVersion"
    ],
    "optional": []
  }
} as const satisfies Record<NodeChange['type'], { required: readonly string[]; optional: readonly string[] }>;
export type RecoveryEffectSchema = 'string' | 'integer' | 'boolean' | Readonly<{literal:string|null}> | Readonly<{union:readonly RecoveryEffectSchema[]}> | Readonly<{array:RecoveryEffectSchema}> | Readonly<{dictionary:RecoveryEffectSchema}> | Readonly<{custom:string}> | Readonly<{object:Readonly<Record<string,Readonly<{schema:RecoveryEffectSchema;optional:boolean}>>>}>;
export const RECOVERY_EFFECT_SCHEMAS: Readonly<Record<NodeChange['type'], RecoveryEffectSchema>> = {
  "NodeCreated": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeCreated"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "parentId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "title": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeTitleSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeTitleSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "title": {
        "schema": "string",
        "optional": false
      },
      "priorTitle": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeBodyTextSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeBodyTextSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "bodyText": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorBodyText": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "NodeMoved": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeMoved"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "parentId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "priorParentId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorPosition": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "SiblingPositionsRebalanced": {
    "object": {
      "type": {
        "schema": {
          "literal": "SiblingPositionsRebalanced"
        },
        "optional": false
      },
      "parentId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "positions": {
        "schema": {
          "array": {
            "object": {
              "nodeId": {
                "schema": "string",
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorPositions": {
        "schema": {
          "array": {
            "object": {
              "nodeId": {
                "schema": "string",
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              }
            }
          }
        },
        "optional": true
      }
    }
  },
  "SubtreeDeleted": {
    "object": {
      "type": {
        "schema": {
          "literal": "SubtreeDeleted"
        },
        "optional": false
      },
      "rootNodeId": {
        "schema": "string",
        "optional": false
      },
      "nodes": {
        "schema": {
          "array": {
            "object": {
              "nodeId": {
                "schema": "string",
                "optional": false
              },
              "parentId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "title": {
                "schema": "string",
                "optional": false
              },
              "bodyText": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              },
              "depth": {
                "schema": "integer",
                "optional": false
              },
              "nodeType": {
                "schema": {
                  "union": [
                    {
                      "custom": "NodeType"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "startDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "endDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "durationDays": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "scheduleSourceMode": {
                "schema": {
                  "union": [
                    {
                      "custom": "ScheduleSourceMode"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "completed": {
                "schema": "boolean",
                "optional": true
              },
              "effortPoints": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "effortPointsDone": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "strategicWeight": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "phaseId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "deliveryStatus": {
                "schema": {
                  "custom": "DeliveryStatus"
                },
                "optional": true
              }
            }
          }
        },
        "optional": false
      },
      "deletionBundle": {
        "schema": {
          "custom": "DeletionBundle"
        },
        "optional": true
      }
    }
  },
  "SubtreeRestored": {
    "object": {
      "type": {
        "schema": {
          "literal": "SubtreeRestored"
        },
        "optional": false
      },
      "rootNodeId": {
        "schema": "string",
        "optional": false
      },
      "nodes": {
        "schema": {
          "array": {
            "object": {
              "nodeId": {
                "schema": "string",
                "optional": false
              },
              "parentId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "title": {
                "schema": "string",
                "optional": false
              },
              "bodyText": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              },
              "depth": {
                "schema": "integer",
                "optional": false
              },
              "nodeType": {
                "schema": {
                  "union": [
                    {
                      "custom": "NodeType"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "startDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "endDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "durationDays": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "scheduleSourceMode": {
                "schema": {
                  "union": [
                    {
                      "custom": "ScheduleSourceMode"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "completed": {
                "schema": "boolean",
                "optional": true
              },
              "effortPoints": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "effortPointsDone": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "strategicWeight": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "phaseId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "deliveryStatus": {
                "schema": {
                  "custom": "DeliveryStatus"
                },
                "optional": true
              }
            }
          }
        },
        "optional": false
      },
      "deletionBundle": {
        "schema": {
          "custom": "DeletionBundle"
        },
        "optional": true
      }
    }
  },
  "SubtreeDuplicated": {
    "object": {
      "type": {
        "schema": {
          "literal": "SubtreeDuplicated"
        },
        "optional": false
      },
      "sourceRootId": {
        "schema": "string",
        "optional": false
      },
      "newRootId": {
        "schema": "string",
        "optional": false
      },
      "nodes": {
        "schema": {
          "array": {
            "object": {
              "nodeId": {
                "schema": "string",
                "optional": false
              },
              "parentId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "title": {
                "schema": "string",
                "optional": false
              },
              "bodyText": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              },
              "depth": {
                "schema": "integer",
                "optional": false
              },
              "nodeType": {
                "schema": {
                  "union": [
                    {
                      "custom": "NodeType"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "startDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "endDate": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "durationDays": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "scheduleSourceMode": {
                "schema": {
                  "union": [
                    {
                      "custom": "ScheduleSourceMode"
                    },
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "completed": {
                "schema": "boolean",
                "optional": true
              },
              "effortPoints": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "effortPointsDone": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "strategicWeight": {
                "schema": {
                  "union": [
                    "integer",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "phaseId": {
                "schema": {
                  "union": [
                    "string",
                    {
                      "literal": null
                    }
                  ]
                },
                "optional": true
              },
              "deliveryStatus": {
                "schema": {
                  "custom": "DeliveryStatus"
                },
                "optional": true
              }
            }
          }
        },
        "optional": false
      }
    }
  },
  "NodeTypeSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeTypeSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "nodeType": {
        "schema": {
          "union": [
            {
              "custom": "NodeType"
            },
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorNodeType": {
        "schema": {
          "union": [
            {
              "custom": "NodeType"
            },
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "NodeCustomFieldSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeCustomFieldSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "fieldKey": {
        "schema": "string",
        "optional": false
      },
      "fieldValue": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorFieldValue": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "FieldTemplatePromoted": {
    "object": {
      "type": {
        "schema": {
          "literal": "FieldTemplatePromoted"
        },
        "optional": false
      },
      "nodeType": {
        "schema": {
          "custom": "NodeType"
        },
        "optional": false
      },
      "fieldKey": {
        "schema": "string",
        "optional": false
      },
      "fieldLabel": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeScheduleSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeScheduleSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "startDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "endDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "durationDays": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "sourceMode": {
        "schema": {
          "custom": "ScheduleSourceMode"
        },
        "optional": false
      },
      "priorStartDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorEndDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorDurationDays": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorSourceMode": {
        "schema": {
          "custom": "ScheduleSourceMode"
        },
        "optional": false
      }
    }
  },
  "NodeCompletedToggled": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeCompletedToggled"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "completed": {
        "schema": "boolean",
        "optional": false
      },
      "priorCompleted": {
        "schema": "boolean",
        "optional": false
      }
    }
  },
  "NodeEffortSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeEffortSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "effortPoints": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorEffortPoints": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "clearedAssignments": {
        "schema": {
          "array": "string"
        },
        "optional": true
      }
    }
  },
  "NodePointsDoneSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodePointsDoneSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "effortPointsDone": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorEffortPointsDone": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "NodeStatusSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeStatusSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "deliveryStatus": {
        "schema": {
          "custom": "DeliveryStatus"
        },
        "optional": false
      },
      "priorDeliveryStatus": {
        "schema": {
          "custom": "DeliveryStatus"
        },
        "optional": false
      }
    }
  },
  "ThemeWeightSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ThemeWeightSet"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "strategicWeight": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorStrategicWeight": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "PhaseCreated": {
    "object": {
      "type": {
        "schema": {
          "literal": "PhaseCreated"
        },
        "optional": false
      },
      "phaseId": {
        "schema": "string",
        "optional": false
      },
      "name": {
        "schema": "string",
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "PhaseRenamed": {
    "object": {
      "type": {
        "schema": {
          "literal": "PhaseRenamed"
        },
        "optional": false
      },
      "phaseId": {
        "schema": "string",
        "optional": false
      },
      "name": {
        "schema": "string",
        "optional": false
      },
      "priorName": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "PhasesReordered": {
    "object": {
      "type": {
        "schema": {
          "literal": "PhasesReordered"
        },
        "optional": false
      },
      "phases": {
        "schema": {
          "array": {
            "object": {
              "phaseId": {
                "schema": "string",
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorPhases": {
        "schema": {
          "array": {
            "object": {
              "phaseId": {
                "schema": "string",
                "optional": false
              },
              "position": {
                "schema": "string",
                "optional": false
              }
            }
          }
        },
        "optional": false
      }
    }
  },
  "NodePhaseAssigned": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodePhaseAssigned"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "phaseId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorPhaseId": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "PhaseDeleted": {
    "object": {
      "type": {
        "schema": {
          "literal": "PhaseDeleted"
        },
        "optional": false
      },
      "phaseId": {
        "schema": "string",
        "optional": false
      },
      "name": {
        "schema": "string",
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "reassignments": {
        "schema": {
          "dictionary": {
            "union": [
              "string",
              {
                "literal": null
              }
            ]
          }
        },
        "optional": false
      },
      "priorAssignments": {
        "schema": {
          "dictionary": {
            "union": [
              "string",
              {
                "literal": null
              }
            ]
          }
        },
        "optional": false
      }
    }
  },
  "PhaseRestored": {
    "object": {
      "type": {
        "schema": {
          "literal": "PhaseRestored"
        },
        "optional": false
      },
      "phaseId": {
        "schema": "string",
        "optional": false
      },
      "name": {
        "schema": "string",
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "priorAssignments": {
        "schema": {
          "dictionary": {
            "union": [
              "string",
              {
                "literal": null
              }
            ]
          }
        },
        "optional": false
      }
    }
  },
  "UnlockEdgeCreated": {
    "object": {
      "type": {
        "schema": {
          "literal": "UnlockEdgeCreated"
        },
        "optional": false
      },
      "edgeId": {
        "schema": "string",
        "optional": false
      },
      "sourceNodeId": {
        "schema": "string",
        "optional": false
      },
      "targetNodeId": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "UnlockEdgeDeleted": {
    "object": {
      "type": {
        "schema": {
          "literal": "UnlockEdgeDeleted"
        },
        "optional": false
      },
      "edgeId": {
        "schema": "string",
        "optional": false
      },
      "sourceNodeId": {
        "schema": "string",
        "optional": false
      },
      "targetNodeId": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "FindingDismissed": {
    "object": {
      "type": {
        "schema": {
          "literal": "FindingDismissed"
        },
        "optional": false
      },
      "findingId": {
        "schema": "string",
        "optional": false
      },
      "findingKind": {
        "schema": {
          "union": [
            {
              "literal": "OrphanedFeature"
            },
            {
              "literal": "PhaseSequencingConflict"
            },
            {
              "literal": "DateSequencingConflict"
            },
            {
              "literal": "UnlockCycle"
            },
            {
              "literal": "StrategicImbalance"
            },
            {
              "literal": "ExplicitOverrideBoundaryViolation"
            }
          ]
        },
        "optional": false
      },
      "targetId": {
        "schema": "string",
        "optional": false
      },
      "fingerprint": {
        "schema": "string",
        "optional": false
      },
      "dismissedAt": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "FindingUndismissed": {
    "object": {
      "type": {
        "schema": {
          "literal": "FindingUndismissed"
        },
        "optional": false
      },
      "findingId": {
        "schema": "string",
        "optional": false
      },
      "findingKind": {
        "schema": {
          "union": [
            {
              "literal": "OrphanedFeature"
            },
            {
              "literal": "PhaseSequencingConflict"
            },
            {
              "literal": "DateSequencingConflict"
            },
            {
              "literal": "UnlockCycle"
            },
            {
              "literal": "StrategicImbalance"
            },
            {
              "literal": "ExplicitOverrideBoundaryViolation"
            }
          ]
        },
        "optional": false
      },
      "targetId": {
        "schema": "string",
        "optional": false
      },
      "fingerprint": {
        "schema": "string",
        "optional": false
      },
      "priorDismissedAt": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "AffectedReasonsRecorded": {
    "object": {
      "type": {
        "schema": {
          "literal": "AffectedReasonsRecorded"
        },
        "optional": false
      },
      "reasons": {
        "schema": {
          "array": {
            "object": {
              "id": {
                "schema": "string",
                "optional": false
              },
              "affectedNodeId": {
                "schema": "string",
                "optional": false
              },
              "causalNodeId": {
                "schema": "string",
                "optional": false
              },
              "deltaDays": {
                "schema": "integer",
                "optional": false
              },
              "causalDateSummary": {
                "schema": "string",
                "optional": false
              },
              "createdAt": {
                "schema": "string",
                "optional": false
              }
            }
          }
        },
        "optional": false
      }
    }
  },
  "AffectedReasonAcknowledged": {
    "object": {
      "type": {
        "schema": {
          "literal": "AffectedReasonAcknowledged"
        },
        "optional": false
      },
      "reasonId": {
        "schema": "string",
        "optional": false
      },
      "acknowledgedAt": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeQuestionAdded": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeQuestionAdded"
        },
        "optional": false
      },
      "questionId": {
        "schema": "string",
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "questionText": {
        "schema": "string",
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "createdAtISO": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeQuestionUpdated": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeQuestionUpdated"
        },
        "optional": false
      },
      "questionId": {
        "schema": "string",
        "optional": false
      },
      "questionText": {
        "schema": "string",
        "optional": false
      },
      "priorQuestionText": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "NodeQuestionResolved": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeQuestionResolved"
        },
        "optional": false
      },
      "questionId": {
        "schema": "string",
        "optional": false
      },
      "decisionText": {
        "schema": "string",
        "optional": false
      },
      "resolvedAtISO": {
        "schema": "string",
        "optional": false
      },
      "priorStatus": {
        "schema": {
          "union": [
            {
              "literal": "OPEN"
            },
            {
              "literal": "DECIDED"
            }
          ]
        },
        "optional": false
      },
      "priorDecisionText": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorResolvedAtISO": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "NodeQuestionsReordered": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeQuestionsReordered"
        },
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "questionIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorQuestionIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      }
    }
  },
  "NodeQuestionDeleted": {
    "object": {
      "type": {
        "schema": {
          "literal": "NodeQuestionDeleted"
        },
        "optional": false
      },
      "questionId": {
        "schema": "string",
        "optional": false
      },
      "nodeId": {
        "schema": "string",
        "optional": false
      },
      "questionText": {
        "schema": "string",
        "optional": false
      },
      "status": {
        "schema": {
          "union": [
            {
              "literal": "OPEN"
            },
            {
              "literal": "DECIDED"
            }
          ]
        },
        "optional": false
      },
      "decisionText": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "position": {
        "schema": "string",
        "optional": false
      },
      "resolvedAtISO": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "createdAtISO": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "ForecastPlanCreated": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPlanCreated"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "ForecastPlanRemoved": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPlanRemoved"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      }
    }
  },
  "ForecastConfigurationSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastConfigurationSet"
        },
        "optional": false
      },
      "pointsPerSprint": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "sprintLengthDays": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "startSprintOrdinal": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "startDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorPointsPerSprint": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorSprintLengthDays": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorStartSprintOrdinal": {
        "schema": {
          "union": [
            "integer",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      },
      "priorStartDate": {
        "schema": {
          "union": [
            "string",
            {
              "literal": null
            }
          ]
        },
        "optional": false
      }
    }
  },
  "ForecastScopeSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastScopeSet"
        },
        "optional": false
      },
      "selectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "parallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorSelectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorParallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "blockedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorBlockedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "clearedAssignments": {
        "schema": {
          "array": "string"
        },
        "optional": true
      },
      "priorAssignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      },
      "assignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      }
    }
  },
  "ForecastOrderSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastOrderSet"
        },
        "optional": false
      },
      "selectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorSelectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorMove": {
        "schema": {
          "object": {
            "featureId": {
              "schema": "string",
              "optional": false
            },
            "afterId": {
              "schema": {
                "union": [
                  "string",
                  {
                    "literal": null
                  }
                ]
              },
              "optional": false
            },
            "beforeId": {
              "schema": {
                "union": [
                  "string",
                  {
                    "literal": null
                  }
                ]
              },
              "optional": false
            },
            "intendedIndex": {
              "schema": "integer",
              "optional": false
            },
            "groupChange": {
              "schema": {
                "custom": "ForecastGroupChange"
              },
              "optional": false
            }
          }
        },
        "optional": true
      }
    }
  },
  "ForecastSequenceSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastSequenceSet"
        },
        "optional": false
      },
      "selectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "parallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorSelectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorParallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorMove": {
        "schema": {
          "object": {
            "featureId": {
              "schema": "string",
              "optional": false
            },
            "afterId": {
              "schema": {
                "union": [
                  "string",
                  {
                    "literal": null
                  }
                ]
              },
              "optional": false
            },
            "beforeId": {
              "schema": {
                "union": [
                  "string",
                  {
                    "literal": null
                  }
                ]
              },
              "optional": false
            },
            "intendedIndex": {
              "schema": "integer",
              "optional": false
            },
            "groupChange": {
              "schema": {
                "custom": "ForecastGroupChange"
              },
              "optional": false
            }
          }
        },
        "optional": true
      }
    }
  },
  "ForecastParallelGroupsSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastParallelGroupsSet"
        },
        "optional": false
      },
      "parallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorParallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      }
    }
  },
  "ForecastBlockerSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastBlockerSet"
        },
        "optional": false
      },
      "featureId": {
        "schema": "string",
        "optional": false
      },
      "blocked": {
        "schema": "boolean",
        "optional": false
      },
      "priorBlocked": {
        "schema": "boolean",
        "optional": false
      }
    }
  },
  "ForecastScenarioCreated": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastScenarioCreated"
        },
        "optional": false
      },
      "scenario": {
        "schema": {
          "custom": "PersistedForecastScenario"
        },
        "optional": false
      }
    }
  },
  "ForecastScenarioRemoved": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastScenarioRemoved"
        },
        "optional": false
      },
      "scenarioId": {
        "schema": "string",
        "optional": false
      },
      "scenario": {
        "schema": {
          "custom": "PersistedForecastScenario"
        },
        "optional": false
      }
    }
  },
  "ForecastScenarioRestored": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastScenarioRestored"
        },
        "optional": false
      },
      "scenario": {
        "schema": {
          "custom": "PersistedForecastScenario"
        },
        "optional": false
      }
    }
  },
  "ForecastPlanningLevelSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPlanningLevelSet"
        },
        "optional": false
      },
      "planningLevel": {
        "schema": {
          "custom": "ForecastNodeLevel"
        },
        "optional": false
      },
      "selectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "parallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "blockedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorPlanningLevel": {
        "schema": {
          "custom": "ForecastNodeLevel"
        },
        "optional": false
      },
      "priorSelectedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorParallelGroups": {
        "schema": {
          "array": {
            "object": {
              "featureIds": {
                "schema": {
                  "array": "string"
                },
                "optional": false
              }
            }
          }
        },
        "optional": false
      },
      "priorBlockedFeatureIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorAssignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      },
      "assignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      }
    }
  },
  "ForecastPersonAdded": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPersonAdded"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "person": {
        "schema": {
          "custom": "ForecastPerson"
        },
        "optional": false
      }
    }
  },
  "ForecastPersonUpdated": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPersonUpdated"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "personId": {
        "schema": "string",
        "optional": false
      },
      "name": {
        "schema": "string",
        "optional": false
      },
      "weightUnits": {
        "schema": "integer",
        "optional": false
      },
      "priorName": {
        "schema": "string",
        "optional": false
      },
      "priorWeightUnits": {
        "schema": "integer",
        "optional": false
      }
    }
  },
  "ForecastPersonRemoved": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPersonRemoved"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "person": {
        "schema": {
          "custom": "ForecastPerson"
        },
        "optional": false
      },
      "priorAssignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      }
    }
  },
  "ForecastPersonRestored": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPersonRestored"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "person": {
        "schema": {
          "custom": "ForecastPerson"
        },
        "optional": false
      },
      "assignments": {
        "schema": {
          "dictionary": {
            "array": "string"
          }
        },
        "optional": true
      }
    }
  },
  "ForecastAssignmentsSet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastAssignmentsSet"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "featureId": {
        "schema": "string",
        "optional": false
      },
      "personIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      },
      "priorPersonIds": {
        "schema": {
          "array": "string"
        },
        "optional": false
      }
    }
  },
  "ForecastPolicySet": {
    "object": {
      "type": {
        "schema": {
          "literal": "ForecastPolicySet"
        },
        "optional": false
      },
      "projectId": {
        "schema": "string",
        "optional": false
      },
      "policyVersion": {
        "schema": {
          "custom": "ForecastPolicyVersion"
        },
        "optional": false
      },
      "priorPolicyVersion": {
        "schema": {
          "custom": "ForecastPolicyVersion"
        },
        "optional": false
      }
    }
  }
};

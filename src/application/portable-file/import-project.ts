/**
 * Import project use case (Story 1.8 Task 4, Epic 13 Story 13.1 Task 4).
 *
 * Imports a *.pmapp.json portable file with full-validate-then-atomic-commit
 * semantics. The entire file is schema-validated before any repository write
 * begins. Schema v2 files yield a validated portable import candidate
 * containing the complete project graph; legacy v1 files upgrade to a
 * project-only candidate through the explicit compatibility adapter.
 *
 * AD-13: "import validates completely before one transaction"
 * AD-7: imported project keeps its original file-recorded ID
 */

import {
  parsePortableFile,
  upgradeLegacyEnvelope,
  upgradeV2Envelope,
  upgradeV3Envelope,
  upgradeV6Envelope,
  type PortableFileEnvelopeV4,
  type PortableFileEnvelopeV5,
  type PortableFileEnvelopeV6,
  type PortableFileEnvelopeV7,
  type PortableFileEnvelopeV8,
  type PortableFileEnvelopeV9,
  type PortableFileEnvelopeV10,
  type PortableFileRejection,
  type PortableForecastPlan,
  type PortableForecastScenario,
  type PortableProjectSnapshot,
} from '../../contracts/portable-file.schema';
import { computeForecastFingerprintSync } from '../../domain/forecast/forecast-canonical';
import { forecastMaterialFacts } from '../../domain/forecast/whole-set.policy';
import { createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

/** Result of an import attempt. */
export type ImportResult =
  | Readonly<{ ok: true; candidate: PortableProjectSnapshot }>
  | Readonly<{ ok: false; error: ImportRejection }>;

/** Typed import rejection causes. */
export type ImportRejection =
  | PortableFileRejection
  | Readonly<{ type: 'DuplicateProjectId'; projectId: string }>;

/** Maps a validated v4/v5/v6/v7 envelope onto the persistence-boundary snapshot. */
export function envelopeToSnapshot(
  envelope: PortableFileEnvelopeV4 | PortableFileEnvelopeV5 | PortableFileEnvelopeV6 | PortableFileEnvelopeV7 | PortableFileEnvelopeV8 | PortableFileEnvelopeV9 | PortableFileEnvelopeV10,
): PortableProjectSnapshot {
  return Object.freeze({
    projectId: envelope.project.id,
    projectName: envelope.project.name,
    projectRevision: 1,
    phases: envelope.phases,
    nodes: envelope.nodes,
    nodeCustomFields: envelope.nodeCustomFields,
    typeTemplateFields: envelope.typeTemplateFields,
    unlockEdges: envelope.unlockEdges,
    findingDismissals: envelope.findingDismissals,
    affectedReasons: envelope.affectedReasons,
    openQuestions: envelope.openQuestions,
    ...(envelope.forecastPlan ? { forecastPlan: envelope.forecastPlan } : {}),
    ...('forecastScenarios' in envelope && envelope.forecastScenarios
      ? { forecastScenarios: envelope.forecastScenarios }
      : {}),
  });
}

/**
 * Remap all durable identities in a portable snapshot for "import as new project" (SF-AR8, AC 22.8-1).
 * Consistently remaps:
 * - project ID
 * - node IDs (and parentId references, phaseId references)
 * - phase IDs
 * - unlock edges (id, sourceNodeId, targetNodeId)
 * - node custom fields (nodeId)
 * - finding dismissals (targetId)
 * - affected reasons (id, affectedNodeId, causalNodeId)
 * - open questions (id, nodeId)
 * - forecastPlan:
 *   - selectedFeatureIds
 *   - parallelGroups (featureIds)
 *   - blockedFeatureIds
 *   - roster (person id)
 *   - assignments (item ID keys and person ID arrays)
 * - forecastScenarios (scenarioId, baseline orderedScope, parallelGroups, blockedFeatureIds, factMap keys and
 *   every fact's ancestorIds — including ancestors deleted from the live tree — recalculates fingerprint)
 */
export function remapPortableSnapshot(
  snapshot: PortableProjectSnapshot,
  generateId: (sourceId?: string) => string = () => createUuidV7(),
): PortableProjectSnapshot {
  const newProjectId = generateId(snapshot.projectId);
  const phaseMap = new Map<string, string>();
  for (const phase of snapshot.phases) {
    phaseMap.set(phase.id, generateId(phase.id));
  }
  const nodeMap = new Map<string, string>();
  for (const node of snapshot.nodes) {
    nodeMap.set(node.id, generateId(node.id));
  }
  const personMap = new Map<string, string>();
  if (snapshot.forecastPlan?.roster) {
    for (const person of snapshot.forecastPlan.roster) {
      personMap.set(person.id, generateId(person.id));
    }
  }

  // Story 23.5 (SF-AR8, AC 23.5-1, AC 23.5-2):
  // Discover and remap historical-only person identities and node identities
  // that may only exist within historical scenario facts.
  // Each source UUIDv7 identity maps deterministically and consistently wherever
  // it appears across live plan and any scenarios.
  if (snapshot.forecastScenarios) {
    for (const s of snapshot.forecastScenarios) {
      for (const id of s.baseline.orderedScope) {
        if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
      }
      for (const [id, fact] of Object.entries(s.baseline.factMap)) {
        if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
        // An ancestor deleted from the live tree can survive only here: it is
        // neither a live node nor a fact-map key. Discover it before mapping,
        // or the mapping below keeps its source UUID (Story 22.10, R10).
        for (const ancestorId of fact.ancestorIds) {
          if (!nodeMap.has(ancestorId)) nodeMap.set(ancestorId, generateId(ancestorId));
        }
      }
      for (const g of s.baseline.parallelGroups) {
        for (const id of g.featureIds) {
          if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
        }
      }
      for (const id of s.baseline.blockedFeatureIds) {
        if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
      }
      if (s.baseline.assignments) {
        for (const [id, pids] of Object.entries(s.baseline.assignments)) {
          if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
          for (const pid of pids) {
            if (!personMap.has(pid)) personMap.set(pid, generateId(pid));
          }
        }
      }
      if (s.baseline.roster) {
        for (const p of s.baseline.roster) {
          if (!personMap.has(p.id)) personMap.set(p.id, generateId(p.id));
        }
      }
      if (s.patch.orderedScope) {
        for (const id of s.patch.orderedScope) {
          if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
        }
      }
      if (s.patch.pointOverrides) {
        for (const id of Object.keys(s.patch.pointOverrides)) {
          if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
        }
      }
      if (s.patch.weightOverrides) {
        for (const pid of Object.keys(s.patch.weightOverrides)) {
          if (!personMap.has(pid)) personMap.set(pid, generateId(pid));
        }
      }
      if (s.patch.assignmentOverrides) {
        for (const [id, pids] of Object.entries(s.patch.assignmentOverrides)) {
          if (!nodeMap.has(id)) nodeMap.set(id, generateId(id));
          for (const pid of pids) {
            if (!personMap.has(pid)) personMap.set(pid, generateId(pid));
          }
        }
      }
    }
  }

  const phases = snapshot.phases.map((p) =>
    Object.freeze({
      ...p,
      id: phaseMap.get(p.id) ?? p.id,
    }),
  );

  const nodes = snapshot.nodes.map((n) =>
    Object.freeze({
      ...n,
      id: nodeMap.get(n.id) ?? n.id,
      parentId: n.parentId ? (nodeMap.get(n.parentId) ?? null) : null,
      phaseId: n.phaseId ? (phaseMap.get(n.phaseId) ?? null) : null,
    }),
  );

  const unlockEdges = snapshot.unlockEdges.map((e) =>
    Object.freeze({
      ...e,
      id: generateId(e.id),
      sourceNodeId: nodeMap.get(e.sourceNodeId) ?? e.sourceNodeId,
      targetNodeId: nodeMap.get(e.targetNodeId) ?? e.targetNodeId,
    }),
  );

  const nodeCustomFields = snapshot.nodeCustomFields.map((f) =>
    Object.freeze({
      ...f,
      nodeId: nodeMap.get(f.nodeId) ?? f.nodeId,
    }),
  );

  const findingDismissals = snapshot.findingDismissals.map((d) =>
    Object.freeze({
      ...d,
      targetId: nodeMap.get(d.targetId) ?? d.targetId,
    }),
  );

  const affectedReasons = snapshot.affectedReasons.map((r) =>
    Object.freeze({
      ...r,
      id: generateId(r.id),
      affectedNodeId: nodeMap.get(r.affectedNodeId) ?? r.affectedNodeId,
      causalNodeId: nodeMap.get(r.causalNodeId) ?? r.causalNodeId,
    }),
  );

  const openQuestions = snapshot.openQuestions.map((q) =>
    Object.freeze({
      ...q,
      id: generateId(q.id),
      nodeId: nodeMap.get(q.nodeId) ?? q.nodeId,
    }),
  );

  let forecastPlan: PortableForecastPlan | undefined;
  if (snapshot.forecastPlan) {
    const origPlan = snapshot.forecastPlan;
    const remappedSelectedFeatureIds = origPlan.selectedFeatureIds.map((id) => nodeMap.get(id) ?? id);
    const remappedParallelGroups = origPlan.parallelGroups.map((g) =>
      Object.freeze({
        featureIds: Object.freeze(g.featureIds.map((id) => nodeMap.get(id) ?? id)),
      }),
    );
    const remappedBlockedFeatureIds = origPlan.blockedFeatureIds?.map((id) => nodeMap.get(id) ?? id);
    const remappedRoster = origPlan.roster?.map((p) =>
      Object.freeze({
        ...p,
        id: personMap.get(p.id) ?? p.id,
      }),
    );
    let remappedAssignments: Record<string, readonly string[]> | undefined;
    if (origPlan.assignments) {
      const a: Record<string, readonly string[]> = {};
      for (const [k, pids] of Object.entries(origPlan.assignments)) {
        const remappedK = nodeMap.get(k) ?? k;
        a[remappedK] = Object.freeze(pids.map((pid) => personMap.get(pid) ?? pid));
      }
      remappedAssignments = Object.freeze(a);
    }

    forecastPlan = Object.freeze({
      ...origPlan,
      selectedFeatureIds: Object.freeze(remappedSelectedFeatureIds),
      parallelGroups: Object.freeze(remappedParallelGroups),
      ...(remappedBlockedFeatureIds ? { blockedFeatureIds: Object.freeze(remappedBlockedFeatureIds) } : {}),
      ...(remappedRoster ? { roster: Object.freeze(remappedRoster) } : {}),
      ...(remappedAssignments ? { assignments: remappedAssignments } : {}),
      ...(origPlan.sprintPlan
        ? {
            sprintPlan: Object.freeze({
              placements: Object.freeze(
                origPlan.sprintPlan.placements.map((placement) =>
                  Object.freeze({ itemId: nodeMap.get(placement.itemId) ?? placement.itemId, sprint: placement.sprint }),
                ),
              ),
              capacities: origPlan.sprintPlan.capacities,
            }),
          }
        : {}),
    });
  }

  let forecastScenarios: readonly PortableForecastScenario[] | undefined;
  if (snapshot.forecastScenarios) {
    forecastScenarios = Object.freeze(
      snapshot.forecastScenarios.map((s) => {
        const newScenarioId = generateId(s.scenarioId);
        const remappedScope = s.baseline.orderedScope.map((id) => nodeMap.get(id) ?? id);
        const remappedGroups = s.baseline.parallelGroups.map((g) => ({
          featureIds: g.featureIds.map((id) => nodeMap.get(id) ?? id),
        }));
        const remappedBlocked = s.baseline.blockedFeatureIds.map((id) => nodeMap.get(id) ?? id);
        const remappedFactMap: Record<string, { effortPoints: number | null; nodeType?: string; projectId: string; ancestorIds: readonly string[] }> = {};
        for (const [k, v] of Object.entries(s.baseline.factMap)) {
          remappedFactMap[nodeMap.get(k) ?? k] = {
            ...v,
            projectId: newProjectId,
            ancestorIds: v.ancestorIds.map((aid) => nodeMap.get(aid) ?? aid),
          };
        }

        let remappedRoster: readonly import('../../domain/forecast/forecast-plan.entity').ForecastPerson[] | undefined;
        if (s.baseline.roster) {
          remappedRoster = Object.freeze(
            s.baseline.roster.map((p) =>
              Object.freeze({
                ...p,
                id: personMap.get(p.id) ?? p.id,
              }),
            ),
          );
        }

        let remappedAssignments: Record<string, readonly string[]> | undefined;
        if (s.baseline.assignments) {
          const a: Record<string, readonly string[]> = {};
          for (const [k, pids] of Object.entries(s.baseline.assignments)) {
            const remappedK = nodeMap.get(k) ?? k;
            a[remappedK] = Object.freeze(pids.map((pid) => personMap.get(pid) ?? pid));
          }
          remappedAssignments = Object.freeze(a);
        }

        const patchScope = s.patch.orderedScope?.map((id) => nodeMap.get(id) ?? id);
        let patchPoints: Record<string, number> | undefined;
        if (s.patch.pointOverrides) {
          patchPoints = {};
          for (const [k, v] of Object.entries(s.patch.pointOverrides)) {
            patchPoints[nodeMap.get(k) ?? k] = v;
          }
        }
        let patchWeights: Record<string, number> | undefined;
        if (s.patch.weightOverrides) {
          patchWeights = {};
          for (const [pid, w] of Object.entries(s.patch.weightOverrides)) {
            patchWeights[personMap.get(pid) ?? pid] = w;
          }
        }
        let patchAssignments: Record<string, readonly string[]> | undefined;
        if (s.patch.assignmentOverrides) {
          patchAssignments = {};
          for (const [k, pids] of Object.entries(s.patch.assignmentOverrides)) {
            patchAssignments[nodeMap.get(k) ?? k] = Object.freeze(pids.map((pid) => personMap.get(pid) ?? pid));
          }
        }

        const remappedPatch = Object.freeze({
          ...s.patch,
          ...(patchScope !== undefined ? { orderedScope: Object.freeze(patchScope) } : {}),
          ...(patchPoints !== undefined ? { pointOverrides: Object.freeze(patchPoints) } : {}),
          ...(patchWeights !== undefined ? { weightOverrides: Object.freeze(patchWeights) } : {}),
          ...(patchAssignments !== undefined ? { assignmentOverrides: Object.freeze(patchAssignments) } : {}),
        });

        const capturedLevel = (s.baseline as { planningLevel?: string }).planningLevel ?? 'Feature';
        const newEstimates: Record<string, number | null> = {};
        for (const id of remappedScope) {
          const fact = remappedFactMap[id];
          const factNodeType = fact?.nodeType ?? ((fact as unknown as { isFeature?: boolean })?.isFeature ? 'Feature' : undefined);
          if (factNodeType === capturedLevel) {
            newEstimates[id] = fact.effortPoints;
          }
        }
        const newFingerprint = computeForecastFingerprintSync(
          forecastMaterialFacts({
            projectId: newProjectId,
            projectRevision: s.baselineRevision,
            policyVersion: s.policyVersion as import('../../domain/forecast/forecast-plan.entity').ForecastPolicyVersion,
            selectedFeatureIds: remappedScope,
            estimates: newEstimates,
            pointsPerSprint: s.baseline.configuration.pointsPerSprint,
            sprintLengthDays: s.baseline.configuration.sprintLengthDays,
            startSprintOrdinal: s.baseline.configuration.startSprintOrdinal,
            startDate: s.baseline.configuration.startDate,
            parallelGroups: remappedGroups,
            blockedFeatureIds: remappedBlocked,
            ...(s.policyVersion === 'staffed-capacity-v1' ? {
              roster: remappedRoster,
              assignments: remappedAssignments,
            } : {}),
          }),
        );
        return Object.freeze({
          ...s,
          scenarioId: newScenarioId,
          baselineFingerprint: newFingerprint,
          baseline: Object.freeze({
            ...s.baseline,
            orderedScope: Object.freeze(remappedScope),
            parallelGroups: Object.freeze(remappedGroups.map((g) => Object.freeze({ featureIds: Object.freeze(g.featureIds) }))),
            blockedFeatureIds: Object.freeze(remappedBlocked),
            factMap: Object.freeze(remappedFactMap),
            ...(remappedRoster !== undefined ? { roster: remappedRoster } : {}),
            ...(remappedAssignments !== undefined ? { assignments: remappedAssignments } : {}),
          }),
          patch: remappedPatch,
        });
      }),
    );
  }

  return Object.freeze({
    projectId: newProjectId,
    projectName: snapshot.projectName,
    projectRevision: 1,
    phases: Object.freeze(phases),
    nodes: Object.freeze(nodes),
    nodeCustomFields: Object.freeze(nodeCustomFields),
    typeTemplateFields: snapshot.typeTemplateFields,
    unlockEdges: Object.freeze(unlockEdges),
    findingDismissals: Object.freeze(findingDismissals),
    affectedReasons: Object.freeze(affectedReasons),
    openQuestions: Object.freeze(openQuestions),
    ...(forecastPlan ? { forecastPlan } : {}),
    ...(forecastScenarios ? { forecastScenarios } : {}),
  });
}

/**
 * Import a project from raw portable-file bytes.
 *
 * @param raw - Raw file content as string
 * @param projectExists - Function to check if a project ID already exists locally
 * @param options - Optional import configuration (asNewProject and custom id generator)
 */
export function importProject(
  raw: string,
  projectExists: (id: string) => boolean,
  options?: { asNewProject?: boolean; generateId?: () => string },
): ImportResult {
  // Step 1: Parse and validate the entire file (AC2).
  const parsed = parsePortableFile(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const envelope = parsed.value;

  // Step 2: Check for duplicate project ID (AC4) unless importing as a new project.
  if (!options?.asNewProject && projectExists(envelope.project.id)) {
    return {
      ok: false,
      error: Object.freeze({
        type: 'DuplicateProjectId' as const,
        projectId: envelope.project.id,
      }),
    };
  }

  // Step 3: Upgrade older envelope versions to current representation.
  const upgraded =
    envelope.schemaVersion === 1
      ? upgradeLegacyEnvelope(envelope)
      : envelope.schemaVersion === 2
        ? upgradeV2Envelope(envelope)
        : envelope.schemaVersion === 3
          ? upgradeV3Envelope(envelope)
          : envelope.schemaVersion === 6
            ? upgradeV6Envelope(envelope)
            : envelope;
  let candidate = envelopeToSnapshot(upgraded);
  if (options?.asNewProject) {
    candidate = remapPortableSnapshot(candidate, options.generateId);
  }

  return Object.freeze({ ok: true, candidate });
}

/**
 * Feature 1-Pager projection (Story 16.4, E16-FR6, E16-AR3, AC-EXPORT-ONE-PAGER).
 *
 * Pure projection: one Feature node + its subtree context -> a standalone
 * DocumentProjection shaped for a single-page Word brief:
 *   - Executive header: Feature Title (Heading 1) + 2-column metadata table
 *     (Theme, Phase, Span, Effort, Status).
 *   - Amber Open Questions callout (suppressed cleanly when 0 questions exist).
 *   - Formatted Markdown narrative body.
 *   - Acceptance Criteria checklist with completion glyphs and rollup ratio.
 *   - Graph dependencies: inbound and outbound unlock titles.
 *
 * No I/O, no clock read, no prose generation — every figure is carried through
 * from the read model verbatim (E16-AR3).
 */

import type { DeliveryStatus, Node } from '../../domain/tree/node.entity';
import type { NodeOpenQuestion } from '../../domain/tree/node-question.entity';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { DocumentProjection, DocumentSectionNode } from '../../contracts/document';
import { DEFAULT_DOCUMENT_STYLE } from '../../contracts/document';
import { deriveNodeSchedule } from '../../domain/tree/schedule.policy';
import { resolveEffectiveField } from '../../domain/tree/field-inheritance.policy';
import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';
import { calculateAcceptanceRatio } from '../../domain/tree/acceptance-criteria.policy';

const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  delivered: 'Delivered',
};

export interface FeatureOnePagerInput {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectName: string;
  readonly featureNodeId: string;
  readonly nodes: readonly Node[];
  readonly phases: readonly Phase[];
  readonly unlockEdges: readonly UnlockEdge[];
  readonly openQuestionsByNode?: ReadonlyMap<string, readonly NodeOpenQuestion[]>;
  readonly generatedAt: string;
  readonly locale: string;
}

export interface FeatureOnePagerResult {
  readonly projection: DocumentProjection;
  readonly featureTitle: string;
  readonly metadata: Readonly<{
    readonly theme: string | null;
    readonly phase: string | null;
    readonly span: string | null;
    readonly effort: string | null;
    readonly status: string;
  }>;
  readonly dependencyLines: readonly string[];
}

/**
 * Build a standalone Feature 1-Pager DocumentProjection.
 * Returns a typed rejection when the feature node is missing or not a Feature.
 */
export function projectFeatureOnePager(input: FeatureOnePagerInput): FeatureOnePagerResult | { ok: false; error: string } {
  const feature = input.nodes.find((n) => n.id === input.featureNodeId);
  if (!feature) {
    return { ok: false, error: `Feature node ${input.featureNodeId} not found.` };
  }
  if (feature.nodeType !== 'Feature') {
    return { ok: false, error: `Node ${input.featureNodeId} is not a Feature.` };
  }

  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const childrenByParent = new Map<string | null, Node[]>();
  for (const n of input.nodes) {
    const list = childrenByParent.get(n.parentId) ?? [];
    list.push(n);
    childrenByParent.set(n.parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  }

  const phaseNameById = new Map(input.phases.map((p) => [p.id, p.name]));
  const minimalNodes = new Map(input.nodes.map((n) => [n.id, { id: n.id, parentId: n.parentId, title: n.title }]));

  const schedule = deriveNodeSchedule({
    startDate: feature.startDate,
    endDate: feature.endDate,
    durationDays: feature.durationDays,
    sourceMode: feature.scheduleSourceMode,
  });

  const effectivePhase = resolveEffectiveField(minimalNodes, feature.id, (nId) => {
    const n = nodeById.get(nId);
    if (!n || !n.phaseId) return { kind: 'inherit' };
    const name = phaseNameById.get(n.phaseId) ?? n.phaseId;
    return { kind: 'explicit', value: name };
  });

  const directChildren = childrenByParent.get(feature.id) ?? [];
  const criteria = directChildren
    .filter((c) => c.nodeType === 'AcceptanceCriterion')
    .map((c) =>
      Object.freeze({
        nodeId: c.id,
        title: c.title,
        bodyText: c.bodyText,
        completed: c.completed,
      }),
    );
  const ratio = criteria.length > 0 ? calculateAcceptanceRatio(directChildren) : null;

  const rawQuestions = input.openQuestionsByNode?.get(feature.id) ?? [];
  const openQuestions = rawQuestions.map((q) =>
    Object.freeze({
      questionId: q.id,
      questionText: q.questionText,
      status: q.status,
      decisionText: q.decisionText,
      resolvedAtISO: q.resolvedAtISO,
    }),
  );

  // Graph dependencies: inbound (unlocked by) and outbound (unlocks).
  const inbound = input.unlockEdges.filter((e) => e.targetNodeId === feature.id);
  const outbound = input.unlockEdges.filter((e) => e.sourceNodeId === feature.id);
  const dependencyLines: string[] = [];
  for (const e of inbound) {
    const source = nodeById.get(e.sourceNodeId);
    dependencyLines.push(`Unlocked by: ${source?.title ?? 'Untitled'}`);
  }
  for (const e of outbound) {
    const target = nodeById.get(e.targetNodeId);
    dependencyLines.push(`Unlocks: ${target?.title ?? 'Untitled'}`);
  }

  // Executive metadata table rendered as a 2-column block in the docx renderer.
  // Walk to the nearest Theme ancestor — a Feature's direct parent may now be
  // a Component, which is structural, not the strategic Theme.
  const theme = (() => {
    let cursor: Node | undefined = feature.parentId ? nodeById.get(feature.parentId) : undefined;
    while (cursor) {
      if (cursor.nodeType === 'Theme') return cursor.title;
      cursor = cursor.parentId ? nodeById.get(cursor.parentId) : undefined;
    }
    return null;
  })();
  const metadata = Object.freeze({
    theme,
    phase: effectivePhase.effectiveValue ?? null,
    span: schedule.startDate && schedule.endDate ? `${schedule.startDate} → ${schedule.endDate}` : null,
    effort: feature.effortPoints !== null ? `${feature.effortPoints} pt` : null,
    status: DELIVERY_STATUS_LABELS[feature.deliveryStatus],
  });

  const section: DocumentSectionNode = Object.freeze({
    nodeId: feature.id,
    parentId: feature.parentId,
    depth: 0,
    headingLevel: 1,
    title: feature.title,
    typeTag: formatNodeTypeTag(feature.nodeType),
    nodeType: feature.nodeType,
    bodyText: feature.bodyText,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    durationDays: schedule.durationDays,
    effectivePhaseName: effectivePhase.effectiveValue ?? null,
    effectivePhaseSource: effectivePhase.source,
    completed: feature.completed,
    acceptanceCriteria: Object.freeze(criteria),
    acceptanceRatioText: ratio && ratio.hasCriteria ? ratio.ratioText : null,
    openQuestions: Object.freeze(openQuestions),
    openQuestionsCount: openQuestions.length,
    siblingIndex: 0,
    siblingSetSize: 1,
  });

  const projection: DocumentProjection = Object.freeze({
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    projectName: input.projectName,
    generatedAt: input.generatedAt,
    locale: input.locale,
    sections: Object.freeze([section]),
    exclusions: Object.freeze({
      totalProjectNodes: input.nodes.length,
      includedNodeCount: 1 + criteria.length,
      undatedCount: 0,
      collapsedCount: 0,
      outOfWindowCount: 0,
    }),
    style: DEFAULT_DOCUMENT_STYLE,
  });

  return Object.freeze({
    projection,
    featureTitle: feature.title,
    metadata,
    dependencyLines: Object.freeze(dependencyLines),
  });
}

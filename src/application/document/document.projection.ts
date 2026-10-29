/**
 * Document projection builder (Story 8.2 Task 3, AD-2, AD-11, AD-12, AD-16).
 *
 * Pure transform: Node[] + resolved ViewScope + phases -> DocumentProjection.
 * No I/O, no clock read, no prose generation.
 *
 * Scope filtering is 100% determined by the resolved scope's included node set
 * (AC2) — no node-type-specific or date-specific filtering is added on top of
 * what Story 8.1's scope already decided. Undated nodes follow exactly the same
 * visible-scope inclusion rule as every other node.
 *
 * Every computed figure (dates, phase, acceptance ratios) is carried through
 * from an existing canonical domain function — never recomputed here (AC3).
 */

import type { Node } from '../../domain/tree/node.entity';
import type { NodeOpenQuestion } from '../../domain/tree/node-question.entity';
import type { Phase } from '../../domain/phase/phase.entity';
import type { ViewScope } from '../../contracts/view-scope';
import type {
  DocumentProjection,
  DocumentSectionNode,
  DocumentAcceptanceCriterionRow,
  DocumentOpenQuestionRow,
} from '../../contracts/document';
import { deriveNodeSchedule } from '../../domain/tree/schedule.policy';
import { resolveEffectiveField } from '../../domain/tree/field-inheritance.policy';
import { formatNodeTypeTag } from '../../domain/tree/node-type.policy';
import { calculateAcceptanceRatio } from '../../domain/tree/acceptance-criteria.policy';
import { DEFAULT_DOCUMENT_STYLE } from '../../contracts/document';

export interface ProjectDocumentInput {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectName: string;
  readonly nodes: readonly Node[]; // full snapshot; scope below determines which are included
  readonly phases: readonly Phase[];
  readonly scope: ViewScope; // Story 8.1's resolved scope — ordered in-scope nodeIds + exclusion counts
  readonly generatedAt: string; // ISO instant from the injected clock
  readonly locale: string;
  /** Open questions per node, pre-sorted by position ascending (Story 16.1 AC4, E16-AR2). */
  readonly openQuestionsByNode?: ReadonlyMap<string, readonly NodeOpenQuestion[]>;
}

function compareSiblings(a: Node, b: Node): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Minimal tree shape `resolveEffectiveField` needs (id, parentId, title). */
interface MinimalNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
}

export function projectDocument(input: ProjectDocumentInput): DocumentProjection {
  const { projectId, projectRevision, projectName, nodes, phases, scope, generatedAt, locale, openQuestionsByNode } = input;

  const inScopeIds = new Set(scope.orderedNodeIds);

  // 1. Group included nodes by parentId; sort siblings deterministically.
  const nodeById = new Map<string, Node>();
  const childrenByParent = new Map<string | null, Node[]>();
  const minimalNodes = new Map<string, MinimalNode>();
  const phaseNameById = new Map<string, string>();

  for (const phase of phases) {
    phaseNameById.set(phase.id, phase.name);
  }

  for (const node of nodes) {
    nodeById.set(node.id, node);
    minimalNodes.set(node.id, { id: node.id, parentId: node.parentId, title: node.title });
  }

  for (const node of nodes) {
    if (!inScopeIds.has(node.id)) continue;
    // If a node's parent is out of scope (or unknown), treat it as a root —
    // matching projectVisibleOutline's effective-parent handling so a scoped
    // document still emits every in-scope node, never silently dropping one.
    const effectiveParentId =
      node.parentId && inScopeIds.has(node.parentId) ? node.parentId : null;
    let list = childrenByParent.get(effectiveParentId);
    if (!list) {
      list = [];
      childrenByParent.set(effectiveParentId, list);
    }
    list.push(node);
  }

  for (const list of childrenByParent.values()) {
    list.sort(compareSiblings);
  }

  // 2. Pre-order walk emitting DocumentSectionNode rows. AcceptanceCriterion
  //    nodes are folded into their parent's acceptanceCriteria list and never
  //    emitted as their own section.
  const sections: DocumentSectionNode[] = [];
  let criteriaFoldedCount = 0;

  function resolveSection(node: Node, depth: number, siblingIndex: number, siblingSetSize: number): DocumentSectionNode {
    const schedule = deriveNodeSchedule({
      startDate: node.startDate,
      endDate: node.endDate,
      durationDays: node.durationDays,
      sourceMode: node.scheduleSourceMode,
    });

    const effectivePhase = resolveEffectiveField(minimalNodes, node.id, (nId) => {
      const n = nodeById.get(nId);
      if (!n || !n.phaseId) return { kind: 'inherit' };
      const name = phaseNameById.get(n.phaseId) ?? n.phaseId;
      return { kind: 'explicit', value: name };
    });

    const directChildren = childrenByParent.get(node.id) ?? [];
    const criteria: DocumentAcceptanceCriterionRow[] = [];
    for (const child of directChildren) {
      if (child.nodeType === 'AcceptanceCriterion') {
        criteria.push(
          Object.freeze({
            nodeId: child.id,
            title: child.title,
            bodyText: child.bodyText,
            completed: child.completed,
          }),
        );
      }
    }
    criteriaFoldedCount += criteria.length;

    const ratio = criteria.length > 0 ? calculateAcceptanceRatio(directChildren) : null;

    // Story 16.1/16.4 (E16-AR2): open questions carried through verbatim,
    // pre-sorted by position ascending (the read model already sorts them).
    const rawQuestions = openQuestionsByNode?.get(node.id) ?? [];
    const openQuestions: DocumentOpenQuestionRow[] = rawQuestions.map((q) =>
      Object.freeze({
        questionId: q.id,
        questionText: q.questionText,
        status: q.status,
        decisionText: q.decisionText,
        resolvedAtISO: q.resolvedAtISO,
      }),
    );

    return Object.freeze({
      nodeId: node.id,
      parentId: node.parentId,
      depth,
      headingLevel: Math.min(depth + 1, 6),
      title: node.title,
      typeTag: formatNodeTypeTag(node.nodeType),
      nodeType: node.nodeType,
      bodyText: node.bodyText,
      startDate: schedule.startDate,
      endDate: schedule.endDate,
      durationDays: schedule.durationDays,
      effectivePhaseName: effectivePhase.effectiveValue ?? null,
      effectivePhaseSource: effectivePhase.source,
      completed: node.completed,
      acceptanceCriteria: Object.freeze(criteria),
      acceptanceRatioText: ratio && ratio.hasCriteria ? ratio.ratioText : null,
      openQuestions: Object.freeze(openQuestions),
      openQuestionsCount: openQuestions.length,
      siblingIndex,
      siblingSetSize,
    });
  }

  function walk(parentId: string | null, depth: number): void {
    const siblings = childrenByParent.get(parentId);
    if (!siblings || siblings.length === 0) return;
    const setSize = siblings.length;
    for (let i = 0; i < setSize; i++) {
      const node = siblings[i];
      if (node.nodeType === 'AcceptanceCriterion') continue; // folded into parent, never its own section
      sections.push(resolveSection(node, depth, i, setSize));
      walk(node.id, depth + 1);
    }
  }

  walk(null, 0);

  const includedNodeCount = sections.length + criteriaFoldedCount;

  // 3. Exclusions copied verbatim from the resolved scope — never re-derived.
  const exclusions = Object.freeze({
    totalProjectNodes: nodes.length,
    includedNodeCount,
    undatedCount: scope.kind === 'GanttVisible' ? scope.undatedCount : 0,
    collapsedCount: scope.kind === 'GanttVisible' ? scope.collapsedCount : 0,
    outOfWindowCount: scope.kind === 'GanttVisible' ? scope.outOfWindowCount : 0,
  });

  return Object.freeze({
    projectId,
    projectRevision,
    projectName,
    generatedAt,
    locale,
    sections: Object.freeze(sections),
    exclusions,
    style: DEFAULT_DOCUMENT_STYLE,
  });
}

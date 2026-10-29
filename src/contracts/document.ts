/**
 * DocumentProjection contract (Story 8.2, AD-12, AD-2, AD-11, AD-16).
 *
 * Pure derived projection of the scoped project into a flat, pre-resolved,
 * narrative document structure — never persisted, never in a ChangeSet, no
 * SQLite table. It fixes every structural decision Story 8.2 exists to make:
 * containment + persisted sibling order, verbatim body-text inclusion, untyped
 * node presentation, date/phase presentation, and default professional styles.
 *
 * Every computed figure (dates, phase, acceptance ratios) is carried through
 * from an existing domain function upstream (deriveNodeSchedule,
 * deriveAncestorSpan, resolveEffectiveField, calculateAcceptanceRatio,
 * formatNodeTypeTag) — this contract never recomputes any of them.
 */

import type { NodeType } from '../domain/tree/node.entity';

export interface DocumentAcceptanceCriterionRow {
  readonly nodeId: string;
  readonly title: string;
  readonly bodyText: string | null; // FR-8, included verbatim when authored
  readonly completed: boolean;
}

export interface DocumentOpenQuestionRow {
  readonly questionId: string;
  readonly questionText: string;
  readonly status: 'OPEN' | 'DECIDED';
  readonly decisionText: string | null;
  readonly resolvedAtISO: string | null;
}

export interface DocumentSectionNode {
  readonly nodeId: string;
  readonly parentId: string | null; // null only for a forest root (node.entity.ts's own "vision-tree forest")
  readonly depth: number; // 0-based, containment depth
  readonly headingLevel: number; // min(depth + 1, 6); beyond 6, adapters render a styled paragraph, not an invalid heading
  readonly title: string;
  readonly typeTag: string; // formatNodeTypeTag() output verbatim — 'VISION' | 'THEME' | 'FEATURE' | 'AC' | 'NO TYPE'; AcceptanceCriterion nodes never appear here (see acceptanceCriteria below)
  readonly nodeType: NodeType | null;
  readonly bodyText: string | null; // FR-8, included verbatim, never summarized or truncated
  readonly startDate: string | null; // ISO YYYY-MM-DD via deriveNodeSchedule; null renders no date line
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly effectivePhaseName: string | null; // via resolveEffectiveField, same as OutlineNodeReadModel
  readonly effectivePhaseSource: 'explicit' | 'inherited' | 'none';
  readonly completed: boolean;
  readonly acceptanceCriteria: readonly DocumentAcceptanceCriterionRow[]; // this node's direct AcceptanceCriterion children, in sibling order; empty when none
  readonly acceptanceRatioText: string | null; // calculateAcceptanceRatio().ratioText verbatim; null when acceptanceCriteria is empty
  readonly openQuestions: readonly DocumentOpenQuestionRow[]; // Story 16.1/16.4 (E16-AR2): ordered by position ascending
  readonly openQuestionsCount: number; // Story 16.4 (E16-AR2): total, including DECIDED
  readonly siblingIndex: number;
  readonly siblingSetSize: number;
}

export interface DocumentExclusionSummary {
  readonly totalProjectNodes: number;
  readonly includedNodeCount: number; // sections.length + criteria folded into them
  readonly undatedCount: number; // carried through verbatim from the resolved ViewScope — never recomputed here (AC2, AC3)
  readonly collapsedCount: number; // carried through from the resolved ViewScope
  readonly outOfWindowCount: number; // carried through; 0 unless the originating view was Gantt
}

export interface DocumentStyleTokens {
  readonly headingFontFamily: string;
  readonly bodyFontFamily: string;
  readonly baseFontSizePt: number;
  readonly headingLevelFontSizesPt: Readonly<Record<number, number>>; // keys 1..6
}

export const DEFAULT_DOCUMENT_STYLE: DocumentStyleTokens = Object.freeze({
  headingFontFamily: 'Calibri',
  bodyFontFamily: 'Calibri',
  baseFontSizePt: 11,
  headingLevelFontSizesPt: Object.freeze({ 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 }),
});

export interface DocumentProjection {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectName: string;
  readonly generatedAt: string; // ISO 8601, from injected ClockPort (FR-55)
  readonly locale: string; // BCP-47 tag, injected; carried through for adapter-side display formatting only — this projection's own date fields stay canonical ISO (AD-8)
  readonly sections: readonly DocumentSectionNode[]; // pre-order, containment + persisted sibling order (AD-11)
  readonly exclusions: DocumentExclusionSummary;
  readonly style: DocumentStyleTokens;
}

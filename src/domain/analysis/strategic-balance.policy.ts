/**
 * Strategic Balance & Effort Concentration Policy (Story 4.5, FR-36, AD-13; Story 5.1 Task 2).
 *
 * Compares theme strategic importance (weight share %) against normalized
 * effort points share (%) and calendar span share (%).
 * Emits advisory findings when share divergence exceeds 20 percentage points.
 * Explicitly tracks data coverage to avoid false positives on incomplete models.
 *
 * Story 5.1: exports `computeThemeRollup` so every theme produces a row
 * regardless of flag state (FR-3), and derives spanShare from each theme's
 * inclusive ancestor span (AD-9) rather than a sum of descendant durations.
 */

import type { Node } from '../tree/node.entity';
import type { StrategicImbalanceFinding } from '../../contracts/analysis-protocol';
import { computeSubtreeEffortWithIndex, createEffortIndex } from '../tree/effort-frontier.policy';
import { deriveAncestorSpan } from '../tree/schedule.policy';
import { getDescendantNodesWithIndex, createChildrenIndex } from '../tree/tree-walk.policy';

export interface ThemeRollupRow {
  readonly themeId: string;
  readonly themeName: string;
  readonly strategicWeight: number | null;
  readonly frontierEffort: number | null;
  readonly spanStartDate: string | null;
  readonly spanEndDate: string | null;
  readonly totalSpanDays: number | null;
  readonly strategicWeightShare: number | null;
  readonly effortShare: number | null;
  readonly spanShare: number | null;
  readonly coveragePercentage: number;
  readonly missingDataNotes: readonly string[];
}

export const DIVERGENCE_THRESHOLD_PP = 20;

/**
 * Compute a rollup row for every Theme node — not just flagged ones.
 * spanShare uses each theme's inclusive derived ancestor span (AD-9).
 */
export function computeThemeRollup(nodes: readonly Node[]): readonly ThemeRollupRow[] {
  const themeNodes = nodes.filter((n) => n.nodeType === 'Theme');
  if (themeNodes.length === 0) {
    return Object.freeze([]);
  }

  // Build the two indexes once for the whole node set rather than rebuilding
  // them per theme (Story 25.3 AC 25.3-5); output is unchanged.
  const effortIndex = createEffortIndex(nodes);
  const childrenIndex = createChildrenIndex(nodes);

  const rollup: ThemeRollupRow[] = themeNodes.map((theme) => {
    const effortSummary = computeSubtreeEffortWithIndex(effortIndex, theme.id);
    const frontierEffort = effortSummary.frontierEffort > 0 ? effortSummary.frontierEffort : null;

    const themeDescendants = getDescendantNodesWithIndex(childrenIndex, theme.id);
    const datedDescendants = themeDescendants.filter(
      (d) => d.startDate !== null || d.endDate !== null,
    );
    const span = deriveAncestorSpan(datedDescendants);

    return Object.freeze({
      themeId: theme.id,
      themeName: theme.title || '(Untitled Theme)',
      strategicWeight: theme.strategicWeight !== null && theme.strategicWeight > 0 ? theme.strategicWeight : null,
      frontierEffort,
      spanStartDate: span.startDate,
      spanEndDate: span.endDate,
      totalSpanDays: span.durationDays !== null && span.durationDays > 0 ? span.durationDays : null,
      strategicWeightShare: null,
      effortShare: null,
      spanShare: null,
      coveragePercentage: 0,
      missingDataNotes: Object.freeze([]),
    });
  });

  let totalWeight = 0;
  let weightCount = 0;
  let totalEffort = 0;
  let effortCount = 0;
  let totalSpan = 0;
  let spanCount = 0;

  for (const row of rollup) {
    if (row.strategicWeight !== null) {
      totalWeight += row.strategicWeight;
      weightCount++;
    }
    if (row.frontierEffort !== null) {
      totalEffort += row.frontierEffort;
      effortCount++;
    }
    if (row.totalSpanDays !== null) {
      totalSpan += row.totalSpanDays;
      spanCount++;
    }
  }

  const missingNotes: string[] = [];
  if (weightCount < rollup.length) {
    missingNotes.push(`${rollup.length - weightCount} theme(s) missing strategic weight`);
  }
  if (effortCount < rollup.length) {
    missingNotes.push(`${rollup.length - effortCount} theme(s) missing effort points`);
  }
  if (spanCount < rollup.length) {
    missingNotes.push(`${rollup.length - spanCount} theme(s) missing schedule`);
  }

  const coveragePercentage = Math.round(
    ((weightCount + effortCount + spanCount) / (rollup.length * 3)) * 100,
  );

  return Object.freeze(
    rollup.map((row) =>
      Object.freeze({
        ...row,
        strategicWeightShare:
          row.strategicWeight !== null && totalWeight > 0
            ? (row.strategicWeight / totalWeight) * 100
            : null,
        effortShare:
          row.frontierEffort !== null && totalEffort > 0
            ? (row.frontierEffort / totalEffort) * 100
            : null,
        spanShare:
          row.totalSpanDays !== null && totalSpan > 0
            ? (row.totalSpanDays / totalSpan) * 100
            : null,
        coveragePercentage,
        missingDataNotes: Object.freeze(missingNotes),
      }),
    ),
  );
}

export function computeStrategicEffortBalance(
  nodes: readonly Node[],
): readonly StrategicImbalanceFinding[] {
  const rollup = computeThemeRollup(nodes);
  const coveragePercentage = rollup[0]?.coveragePercentage ?? 0;
  const missingNotes = rollup[0]?.missingDataNotes ?? [];

  if (rollup.length < 2) {
    return Object.freeze([]);
  }

  const findings: StrategicImbalanceFinding[] = [];

  for (const row of rollup) {
    if (row.strategicWeightShare === null || row.effortShare === null) continue;
    if (row.strategicWeight === null || row.frontierEffort === null) continue;

    const divergence = Math.abs(row.effortShare - row.strategicWeightShare);

    if (divergence >= DIVERGENCE_THRESHOLD_PP) {
      const isOverInvested = row.effortShare > row.strategicWeightShare;
      const roundedWeight = Math.round(row.strategicWeightShare);
      const roundedEffort = Math.round(row.effortShare);
      const roundedDivergence = Math.round(divergence);
      const spanShare = row.spanShare ?? 0;

      const narrative = isOverInvested
        ? `Theme "${row.themeName}" has ${roundedEffort}% of effort but only ${roundedWeight}% of strategic weight (+${roundedDivergence}% divergence).`
        : `Theme "${row.themeName}" has ${roundedWeight}% of strategic weight but only ${roundedEffort}% of effort (-${roundedDivergence}% divergence).`;

      const fingerprint = `imbalance:${row.themeId}:${roundedWeight}:${roundedEffort}:${coveragePercentage}`;

      findings.push(
        Object.freeze({
          id: `imbalance-${row.themeId}`,
          kind: 'StrategicImbalance',
          projectId: nodes.find((n) => n.id === row.themeId)?.projectId ?? '',
          targetNodeId: row.themeId,
          title: `Strategic investment imbalance: "${row.themeName}"`,
          narrative,
          actionableEditPrompt: `Rebalance effort or adjust strategic weight for "${row.themeName}".`,
          themeId: row.themeId,
          themeName: row.themeName,
          strategicWeightShare: roundedWeight,
          effortShare: roundedEffort,
          spanShare: Math.round(spanShare),
          divergencePercentage: roundedDivergence,
          coveragePercentage,
          missingDataNotes: Object.freeze(missingNotes),
          fingerprint,
        }),
      );
    }
  }

  return Object.freeze(findings);
}

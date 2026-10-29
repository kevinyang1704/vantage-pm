/**
 * Coherence chip encoding (Epic 24, DO-UX1/DO-UX2).
 *
 * Pure presentation decision for a theme row's coherence cell. Effort
 * concentration is encoded only at theme-vs-theme altitude (the workspace
 * overview and coherence review); it must never be imported by the outline,
 * visual or Gantt surfaces (FR-36 — see `altitude-guardrail.spec.ts`).
 */

export interface ThemeFindingCounts {
  readonly orphan: number;
  readonly sequencing: number;
  readonly effort: number;
}

export interface CoherenceChipState {
  readonly kind: 'clear' | 'orphan' | 'sequencing' | 'effort';
  readonly count: number;
}

export function encodeCoherenceChips(counts: ThemeFindingCounts): readonly CoherenceChipState[] {
  const { orphan, sequencing, effort } = counts;

  if (orphan === 0 && sequencing === 0 && effort === 0) {
    return Object.freeze([Object.freeze({ kind: 'clear' as const, count: 0 })]);
  }

  const chips: CoherenceChipState[] = [];
  if (orphan > 0) chips.push(Object.freeze({ kind: 'orphan' as const, count: orphan }));
  if (sequencing > 0) chips.push(Object.freeze({ kind: 'sequencing' as const, count: sequencing }));
  if (effort > 0) chips.push(Object.freeze({ kind: 'effort' as const, count: effort }));

  return Object.freeze(chips);
}

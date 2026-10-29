/**
 * Acceptance criteria derived ratio policy (Story 3.5).
 *
 * Derives completion statistics for Feature nodes directly from canonical
 * child node states. Never persists duplicate percentages.
 */

export interface AcceptanceCriterionChild {
  readonly id: string;
  readonly nodeType: string | null;
  readonly completed: boolean;
}

export interface AcceptanceRatioResult {
  readonly total: number;
  readonly completed: number;
  readonly ratioText: string;
  readonly hasCriteria: boolean;
  readonly percentage: number | null;
}

export function calculateAcceptanceRatio(
  children: readonly AcceptanceCriterionChild[],
): AcceptanceRatioResult {
  const criteria = children.filter((c) => c.nodeType === 'AcceptanceCriterion');
  const total = criteria.length;

  if (total === 0) {
    return Object.freeze({
      total: 0,
      completed: 0,
      ratioText: 'no acceptance criteria yet',
      hasCriteria: false,
      percentage: null,
    });
  }

  const completed = criteria.filter((c) => c.completed).length;
  const percentage = Math.round((completed / total) * 100);

  return Object.freeze({
    total,
    completed,
    ratioText: `${completed} / ${total} met`,
    hasCriteria: true,
    percentage,
  });
}

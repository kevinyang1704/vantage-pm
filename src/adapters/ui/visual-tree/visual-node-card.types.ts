/**
 * Visual node card types (Story 6.2 Task 1).
 *
 * CardInteractionState is a 3-value discriminant (rest/editing/selected);
 * nodeType === null is ORTHOGONAL to it (an untyped node can be selected),
 * driving the tag text independently — never a 4-way discriminant.
 */

import type { NodeType } from '../../../domain/tree/node.entity';

export type CardInteractionState = 'rest' | 'editing' | 'selected';

export interface VisualNodeCardModel {
  readonly nodeId: string;
  readonly title: string;
  readonly nodeType: NodeType | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly durationDays: number | null;
  readonly completed: boolean;
  readonly interactionState: CardInteractionState;
  readonly isTrunk: boolean; // theme root renders as node-card-trunk, not node-card
  readonly isOrphan?: boolean; // orphan feature renders as node-card-orphan
  readonly acceptanceCriteria?: readonly {
    readonly id: string;
    readonly title: string;
    readonly completed: boolean;
  }[];
}
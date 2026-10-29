/**
 * Structural keyboard mapping and constraint descriptions (Story 2.4 Task 5).
 *
 * Maps key combinations to structural gestures and provides human-readable
 * constraint text following the Voice and Tone contract.
 */

import type { StructuralGesture, MoveConstraint } from '../../../domain/tree/move-node.policy';

export type KeyDescriptor = Readonly<{
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}>;

export function mapKeyboardEventToGesture(event: KeyDescriptor): StructuralGesture | null {
  if (event.metaKey || event.ctrlKey) {
    return null;
  }

  if (event.key === 'Tab') {
    return event.shiftKey ? 'Outdent' : 'Indent';
  }

  if (event.altKey && event.shiftKey) {
    if (event.key === 'ArrowUp') return 'MoveUp';
    if (event.key === 'ArrowDown') return 'MoveDown';
  }

  return null;
}

export function formatMoveConstraint(constraint: MoveConstraint): string {
  switch (constraint) {
    case 'NoPrecedingSiblingToNestUnder':
      return 'No preceding sibling to nest under';
    case 'AlreadyAtTopLevel':
      return 'Already at the top level';
    case 'AlreadyFirstAmongSiblings':
      return 'Already the first sibling';
    case 'AlreadyLastAmongSiblings':
      return 'Already the last sibling';
    case 'HierarchyConflict':
      return 'Cannot nest under lower-ranking item';
  }
}

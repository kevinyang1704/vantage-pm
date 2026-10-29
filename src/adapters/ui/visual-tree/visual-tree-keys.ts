/**
 * Visual card keyboard mapping (Story 6.3 Task 2).
 *
 * Pure keyboard-to-gesture mapping for visual-tree cards. Structural gestures
 * (Tab/Shift+Tab/Alt+Shift+arrows) DELEGATE to the shared structural-keys
 * mapper — Visual never re-implements indent/outdent/reorder key detection.
 * Only the card-specific gestures (Enter, Shift+Enter, plain arrows, Esc)
 * are new here, and they are focus-navigation/editing concerns, not
 * authoring math.
 */

import {
  mapKeyboardEventToGesture,
  type KeyDescriptor,
} from '../outline/structural-keys';
import type { StructuralGesture } from '../../../domain/tree/move-node.policy';

export type VisualCardGesture =
  | 'CreateSibling'
  | 'ToggleBodyText'
  | 'NavigateDown'
  | 'NavigateUp'
  | 'NavigateLeft'
  | 'NavigateRight'
  | 'DiscardOrClose';

export type VisualCardAction =
  | { kind: 'structural'; gesture: StructuralGesture }
  | { kind: 'card'; gesture: VisualCardGesture };

export function mapVisualCardKey(event: KeyDescriptor): VisualCardAction | null {
  // Meta/Ctrl chords are project-wide shortcuts handled elsewhere, never here.
  if (event.metaKey || event.ctrlKey) {
    return null;
  }

  // Structural keys delegate to the shared Outline mapping (AD-11/FR-6/FR-7).
  const structural = mapKeyboardEventToGesture(event);
  if (structural) {
    return { kind: 'structural', gesture: structural };
  }

  if (event.key === 'Enter') {
    return event.shiftKey
      ? { kind: 'card', gesture: 'ToggleBodyText' }
      : { kind: 'card', gesture: 'CreateSibling' };
  }

  if (event.key === 'Escape') {
    return { kind: 'card', gesture: 'DiscardOrClose' };
  }

  if (event.key === 'ArrowDown') return { kind: 'card', gesture: 'NavigateDown' };
  if (event.key === 'ArrowUp') return { kind: 'card', gesture: 'NavigateUp' };
  if (event.key === 'ArrowLeft') return { kind: 'card', gesture: 'NavigateLeft' };
  if (event.key === 'ArrowRight') return { kind: 'card', gesture: 'NavigateRight' };

  return null;
}
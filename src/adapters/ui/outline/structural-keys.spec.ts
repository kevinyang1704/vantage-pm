import { describe, it, expect } from 'vitest';
import {
  mapKeyboardEventToGesture,
  formatMoveConstraint,
} from './structural-keys';

describe('structural-keys mapping', () => {
  it('maps Tab to Indent', () => {
    const gesture = mapKeyboardEventToGesture({
      key: 'Tab',
      shiftKey: false,
      altKey: false,
    });
    expect(gesture).toBe('Indent');
  });

  it('maps Shift+Tab to Outdent', () => {
    const gesture = mapKeyboardEventToGesture({
      key: 'Tab',
      shiftKey: true,
      altKey: false,
    });
    expect(gesture).toBe('Outdent');
  });

  it('maps Alt+Shift+ArrowUp to MoveUp', () => {
    const gesture = mapKeyboardEventToGesture({
      key: 'ArrowUp',
      shiftKey: true,
      altKey: true,
    });
    expect(gesture).toBe('MoveUp');
  });

  it('maps Alt+Shift+ArrowDown to MoveDown', () => {
    const gesture = mapKeyboardEventToGesture({
      key: 'ArrowDown',
      shiftKey: true,
      altKey: true,
    });
    expect(gesture).toBe('MoveDown');
  });

  it('ignores events with metaKey or ctrlKey', () => {
    expect(
      mapKeyboardEventToGesture({
        key: 'Tab',
        shiftKey: false,
        altKey: false,
        metaKey: true,
      }),
    ).toBeNull();

    expect(
      mapKeyboardEventToGesture({
        key: 'Tab',
        shiftKey: false,
        altKey: false,
        ctrlKey: true,
      }),
    ).toBeNull();
  });

  it('formats move constraints properly without errors or warnings', () => {
    expect(formatMoveConstraint('NoPrecedingSiblingToNestUnder')).toBe(
      'No preceding sibling to nest under',
    );
    expect(formatMoveConstraint('AlreadyAtTopLevel')).toBe('Already at the top level');
    expect(formatMoveConstraint('AlreadyFirstAmongSiblings')).toBe('Already the first sibling');
    expect(formatMoveConstraint('AlreadyLastAmongSiblings')).toBe('Already the last sibling');
    expect(formatMoveConstraint('HierarchyConflict')).toBe('Cannot nest under lower-ranking item');
  });
});

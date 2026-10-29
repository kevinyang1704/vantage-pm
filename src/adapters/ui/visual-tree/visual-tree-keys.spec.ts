import { describe, expect, it } from 'vitest';
import { mapVisualCardKey } from './visual-tree-keys';

function ev(key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}): {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
} {
  return { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods };
}

describe('visual-tree-keys (Story 6.3 Task 2)', () => {
  it('maps Enter to CreateSibling and Shift+Enter to ToggleBodyText', () => {
    expect(mapVisualCardKey(ev('Enter'))).toEqual({ kind: 'card', gesture: 'CreateSibling' });
    expect(mapVisualCardKey(ev('Enter', { shiftKey: true }))).toEqual({ kind: 'card', gesture: 'ToggleBodyText' });
  });

  it('delegates Tab/Shift+Tab to the shared structural mapper', () => {
    expect(mapVisualCardKey(ev('Tab'))).toEqual({ kind: 'structural', gesture: 'Indent' });
    expect(mapVisualCardKey(ev('Tab', { shiftKey: true }))).toEqual({ kind: 'structural', gesture: 'Outdent' });
  });

  it('delegates Alt+Shift+arrows to the shared structural mapper', () => {
    expect(mapVisualCardKey(ev('ArrowUp', { altKey: true, shiftKey: true }))).toEqual({ kind: 'structural', gesture: 'MoveUp' });
    expect(mapVisualCardKey(ev('ArrowDown', { altKey: true, shiftKey: true }))).toEqual({ kind: 'structural', gesture: 'MoveDown' });
  });

  it('maps plain arrows to spatial navigation', () => {
    expect(mapVisualCardKey(ev('ArrowDown'))).toEqual({ kind: 'card', gesture: 'NavigateDown' });
    expect(mapVisualCardKey(ev('ArrowUp'))).toEqual({ kind: 'card', gesture: 'NavigateUp' });
    expect(mapVisualCardKey(ev('ArrowLeft'))).toEqual({ kind: 'card', gesture: 'NavigateLeft' });
    expect(mapVisualCardKey(ev('ArrowRight'))).toEqual({ kind: 'card', gesture: 'NavigateRight' });
  });

  it('maps Escape to DiscardOrClose', () => {
    expect(mapVisualCardKey(ev('Escape'))).toEqual({ kind: 'card', gesture: 'DiscardOrClose' });
  });

  it('returns null for meta/ctrl chords (project-wide shortcuts)', () => {
    expect(mapVisualCardKey(ev('z', { ctrlKey: true }))).toBeNull();
    expect(mapVisualCardKey(ev('k', { metaKey: true }))).toBeNull();
  });

  it('returns null for unhandled keys', () => {
    expect(mapVisualCardKey(ev('a'))).toBeNull();
  });
});
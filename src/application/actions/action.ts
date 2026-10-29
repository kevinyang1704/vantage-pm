/**
 * Action declaration types (Story 2.7 Task 1, FR-11, AD-16).
 */

import type { ActionContext } from './action-context';

export type ActionScope = 'workspace' | 'project' | 'view' | 'node' | 'subtree';

export type ActionAvailability =
  | Readonly<{ kind: 'Available' }>
  | Readonly<{ kind: 'Unavailable'; reason: string }>;

export type PaletteVisibility = 'listed' | 'binding-only';
export type FocusPolicy = 'ReturnToInvoker' | 'ActionOwns';

export interface KeyBinding {
  readonly key: string;
  readonly ctrlOrMeta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface ActionDeclaration {
  readonly id: string; // stable kebab: 'node.duplicate-subtree'
  readonly label: string; // authored language
  readonly keywords: readonly string[]; // synonyms/aliases
  readonly requirement: readonly string[]; // e.g. ['FR-13']
  readonly scope: ActionScope;
  readonly binding: KeyBinding | null;
  readonly paletteVisibility: PaletteVisibility;
  readonly focusPolicy: FocusPolicy;
  readonly isAvailable: (ctx: ActionContext) => ActionAvailability;
  readonly run: (ctx: ActionContext) => void | Promise<void>;
}

export function createActionDeclaration(decl: ActionDeclaration): ActionDeclaration {
  return Object.freeze({
    ...decl,
    keywords: Object.freeze([...decl.keywords]),
    requirement: Object.freeze([...decl.requirement]),
  });
}

/**
 * ActionRegistry (Story 2.7 Task 1).
 *
 * Validates action declarations at creation and provides access to registered actions.
 */

import type { ActionDeclaration } from './action';

export class ActionRegistry {
  private readonly actionsById = new Map<string, ActionDeclaration>();

  constructor(declarations: readonly ActionDeclaration[]) {
    for (const decl of declarations) {
      if (this.actionsById.has(decl.id)) {
        throw new Error(`Duplicate action id: ${decl.id}`);
      }
      this.actionsById.set(decl.id, decl);
    }
  }

  getAll(): readonly ActionDeclaration[] {
    return Object.freeze(Array.from(this.actionsById.values()));
  }

  getById(id: string): ActionDeclaration | undefined {
    return this.actionsById.get(id);
  }
}

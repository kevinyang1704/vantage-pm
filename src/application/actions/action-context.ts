/**
 * Action Context interface (Story 2.7 Task 1).
 */

export interface ActionContext {
  readonly workspace: { readonly projectCount: number };
  readonly projectId: string | null;
  readonly viewId: string; // 'overview' | 'outline' | 'visual' | 'gantt'
  readonly focusedNodeId: string | null;
  readonly focusedSubtreeSize: number | null;
  readonly queue: { readonly isSettled: boolean; readonly blockingCause: string | null };
}

export function createDefaultActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return Object.freeze({
    workspace: Object.freeze({ projectCount: overrides.workspace?.projectCount ?? 1 }),
    projectId: overrides.projectId ?? null,
    viewId: overrides.viewId ?? 'outline',
    focusedNodeId: overrides.focusedNodeId ?? null,
    focusedSubtreeSize: overrides.focusedSubtreeSize ?? null,
    queue: Object.freeze({
      isSettled: overrides.queue?.isSettled ?? true,
      blockingCause: overrides.queue?.blockingCause ?? null,
    }),
  });
}

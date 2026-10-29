/**
 * Field inheritance policy (Story 3.3, AD-8).
 *
 * Deterministic ancestor inheritance selector for planning fields (phase, strategic weight, etc.).
 * Pure function that walks parent pointers to resolve the nearest authored value.
 */

export type FieldInheritanceValue<T> =
  | Readonly<{ kind: 'inherit' }>
  | Readonly<{ kind: 'explicit'; value: T }>
  | Readonly<{ kind: 'none' }>;

export type EffectiveField<T> = Readonly<{
  effectiveValue: T | null;
  source: 'explicit' | 'inherited' | 'none';
  sourceNodeId: string | null;
  sourceNodeTitle: string | null;
}>;

export interface MinimalTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
}

/**
 * Resolves the effective field value by walking the ancestor chain.
 * - If current node has an explicit value, returns source 'explicit'.
 * - If current node has explicit 'none', returns source 'none' (effectiveValue: null).
 * - If current node is 'inherit', traverses ancestors until finding the first non-'inherit' ancestor.
 * - If top of tree is reached without finding a value, returns source 'none' (effectiveValue: null).
 */
export function resolveEffectiveField<T>(
  nodeMap: ReadonlyMap<string, MinimalTreeNode>,
  nodeId: string,
  getter: (nodeId: string) => FieldInheritanceValue<T>,
): EffectiveField<T> {
  const current = nodeMap.get(nodeId);
  if (!current) {
    return Object.freeze({
      effectiveValue: null,
      source: 'none',
      sourceNodeId: null,
      sourceNodeTitle: null,
    });
  }

  const directVal = getter(nodeId);
  if (directVal.kind === 'explicit') {
    return Object.freeze({
      effectiveValue: directVal.value,
      source: 'explicit',
      sourceNodeId: current.id,
      sourceNodeTitle: current.title,
    });
  }

  if (directVal.kind === 'none') {
    return Object.freeze({
      effectiveValue: null,
      source: 'none',
      sourceNodeId: current.id,
      sourceNodeTitle: current.title,
    });
  }

  // Walk parent pointers
  let currParentId = current.parentId;
  const visited = new Set<string>([nodeId]);

  while (currParentId) {
    if (visited.has(currParentId)) {
      // Cycle safeguard
      break;
    }
    visited.add(currParentId);

    const ancestor = nodeMap.get(currParentId);
    if (!ancestor) break;

    const ancestorVal = getter(currParentId);
    if (ancestorVal.kind === 'explicit') {
      return Object.freeze({
        effectiveValue: ancestorVal.value,
        source: 'inherited',
        sourceNodeId: ancestor.id,
        sourceNodeTitle: ancestor.title,
      });
    }
    if (ancestorVal.kind === 'none') {
      return Object.freeze({
        effectiveValue: null,
        source: 'none',
        sourceNodeId: ancestor.id,
        sourceNodeTitle: ancestor.title,
      });
    }

    currParentId = ancestor.parentId;
  }

  return Object.freeze({
    effectiveValue: null,
    source: 'none',
    sourceNodeId: null,
    sourceNodeTitle: null,
  });
}

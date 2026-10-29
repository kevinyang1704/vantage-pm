export type UpdateState = Readonly<{ clean: boolean; unresolvedCommands: number; compatible: boolean; approved: boolean }>;
export type UpdateDecision = { type: 'ActivationAllowed'; assets: string; schema: string } | { type: 'ActivationBlocked'; code: 'DIRTY_STATE' | 'UNRESOLVED_COMMANDS' | 'INCOMPATIBLE_ASSET_SCHEMA' | 'APPROVAL_REQUIRED'; keepAssets: 'current' };

export function decideUpdate(state: UpdateState): UpdateDecision {
  if (!state.clean) return { type: 'ActivationBlocked', code: 'DIRTY_STATE', keepAssets: 'current' };
  if (state.unresolvedCommands) return { type: 'ActivationBlocked', code: 'UNRESOLVED_COMMANDS', keepAssets: 'current' };
  if (!state.compatible) return { type: 'ActivationBlocked', code: 'INCOMPATIBLE_ASSET_SCHEMA', keepAssets: 'current' };
  if (!state.approved) return { type: 'ActivationBlocked', code: 'APPROVAL_REQUIRED', keepAssets: 'current' };
  return { type: 'ActivationAllowed', assets: 'phase0-v2-candidate', schema: '2.0.0' };
}

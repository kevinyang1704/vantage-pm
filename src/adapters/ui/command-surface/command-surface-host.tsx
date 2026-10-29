/**
 * CommandSurfaceHost (Story 2.7 Task 3, Story 2.8 Task 0).
 *
 * Single non-stacked modal host ensuring palette, jump-to-node, and confirmation
 * surfaces never stack on top of each other.
 */

import React, { type ReactElement } from 'react';
import type { ActionDeclaration } from '../../../application/actions/action';
import type { ActionContext } from '../../../application/actions/action-context';
import type { NodeTitleIndex } from '../../../application/search/node-title-index';
import { CommandPalette } from './command-palette';
import { JumpToNode } from './jump-to-node';

export type ActiveCommandSurface = 'none' | 'palette' | 'jump' | 'jump-theme';

export interface CommandSurfaceHostProps {
  readonly activeSurface: ActiveCommandSurface;
  readonly actions: readonly ActionDeclaration[];
  readonly actionContext: ActionContext;
  readonly searchIndex: NodeTitleIndex;
  readonly onClose: () => void;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onCreateNodeFromSearch?: (title: string) => void;
  /** Node IDs the 'jump-theme' surface restricts results to (Story 6.4's theme-scoped overflow jump). */
  readonly themeJumpNodeIds?: ReadonlySet<string>;
}

export function CommandSurfaceHost({
  activeSurface,
  actions,
  actionContext,
  searchIndex,
  onClose,
  onSelectNode,
  onCreateNodeFromSearch,
  themeJumpNodeIds,
}: CommandSurfaceHostProps): ReactElement | null {
  if (activeSurface === 'none') {
    return null;
  }

  if (activeSurface === 'palette') {
    return (
      <CommandPalette
        actions={actions}
        context={actionContext}
        onClose={onClose}
      />
    );
  }

  if (activeSurface === 'jump') {
    return (
      <JumpToNode
        searchIndex={searchIndex}
        onSelectNode={onSelectNode}
        onCreateNodeFromSearch={onCreateNodeFromSearch}
        onClose={onClose}
      />
    );
  }

  if (activeSurface === 'jump-theme') {
    return (
      <JumpToNode
        searchIndex={searchIndex}
        onSelectNode={onSelectNode}
        onClose={onClose}
        restrictToNodeIds={themeJumpNodeIds ?? new Set()}
        restrictedItemLabel="themes"
      />
    );
  }

  return null;
}

/**
 * PRD Action Inventory (Story 2.7 Task 2, FR-11).
 *
 * Verifiable count of all PRD actions and their registration status.
 */

export interface PrdActionInventoryEntry {
  readonly actionId: string;
  readonly requirement: readonly string[];
  readonly owningStory: string;
  readonly status: 'registered' | 'pending';
}

export const PRD_ACTION_INVENTORY: readonly PrdActionInventoryEntry[] = Object.freeze([
  {
    actionId: 'node.create-sibling',
    requirement: ['FR-5'],
    owningStory: '2.3',
    status: 'registered',
  },
  {
    actionId: 'node.indent',
    requirement: ['FR-6'],
    owningStory: '2.4',
    status: 'registered',
  },
  {
    actionId: 'node.outdent',
    requirement: ['FR-6'],
    owningStory: '2.4',
    status: 'registered',
  },
  {
    actionId: 'node.move-up',
    requirement: ['FR-7'],
    owningStory: '2.4',
    status: 'registered',
  },
  {
    actionId: 'node.move-down',
    requirement: ['FR-7'],
    owningStory: '2.4',
    status: 'registered',
  },
  {
    actionId: 'node.collapse',
    requirement: ['FR-9'],
    owningStory: '2.5',
    status: 'registered',
  },
  {
    actionId: 'node.expand',
    requirement: ['FR-9'],
    owningStory: '2.5',
    status: 'registered',
  },
  {
    actionId: 'node.zoom-in',
    requirement: ['FR-10'],
    owningStory: '2.5',
    status: 'registered',
  },
  {
    actionId: 'node.zoom-out',
    requirement: ['FR-10'],
    owningStory: '2.5',
    status: 'registered',
  },
  {
    actionId: 'node.delete-subtree',
    requirement: ['FR-13'],
    owningStory: '2.6',
    status: 'registered',
  },
  {
    actionId: 'node.duplicate-subtree',
    requirement: ['FR-13'],
    owningStory: '2.6',
    status: 'registered',
  },
  {
    actionId: 'history.undo',
    requirement: ['FR-14', 'AD-4'],
    owningStory: '2.6',
    status: 'registered',
  },
  {
    actionId: 'history.redo',
    requirement: ['FR-14', 'AD-4'],
    owningStory: '2.6',
    status: 'registered',
  },
  {
    actionId: 'palette.open',
    requirement: ['FR-11'],
    owningStory: '2.7',
    status: 'registered',
  },
  {
    actionId: 'search.jump-to-node',
    requirement: ['FR-12'],
    owningStory: '2.8',
    status: 'registered',
  },
]);

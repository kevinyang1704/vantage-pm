/**
 * Visual sibling order policy (Story 6.1 Task 3, AD-11).
 *
 * Resolved start date, then persisted gap position, then UUID; undated nodes
 * follow dated nodes. Layout coordinates are disposable and never an order signal.
 */

import type { Node } from './node.entity';
import { deriveNodeSchedule } from './schedule.policy';

/** AD-11: resolved start date, then persisted order, then UUID; undated nodes follow dated nodes. */
export function compareVisualSiblingOrder(a: Node, b: Node): number {
  const aStart = deriveNodeSchedule({
    startDate: a.startDate,
    endDate: a.endDate,
    durationDays: a.durationDays,
    sourceMode: a.scheduleSourceMode,
  }).startDate;
  const bStart = deriveNodeSchedule({
    startDate: b.startDate,
    endDate: b.endDate,
    durationDays: b.durationDays,
    sourceMode: b.scheduleSourceMode,
  }).startDate;

  if (aStart !== null && bStart === null) return -1;
  if (aStart === null && bStart !== null) return 1;
  if (aStart !== null && bStart !== null && aStart !== bStart) {
    return aStart < bStart ? -1 : 1; // ISO YYYY-MM-DD compares lexicographically = chronologically
  }
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
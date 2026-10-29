/**
 * Action coverage verification (Story 2.7 Task 2, FR-11).
 */

import type { ActionRegistry } from './action-registry';
import { PRD_ACTION_INVENTORY } from './prd-action-inventory';

export interface CoverageReport {
  readonly totalPrdActions: number;
  readonly registeredCount: number;
  readonly pendingCount: number;
  readonly missingFromRegistry: readonly string[];
}

export function computeActionCoverage(registry: ActionRegistry): CoverageReport {
  const registeredEntries = PRD_ACTION_INVENTORY.filter((e) => e.status === 'registered');
  const pendingEntries = PRD_ACTION_INVENTORY.filter((e) => e.status === 'pending');

  const missing: string[] = [];
  for (const entry of registeredEntries) {
    if (!registry.getById(entry.actionId)) {
      missing.push(entry.actionId);
    }
  }

  return Object.freeze({
    totalPrdActions: PRD_ACTION_INVENTORY.length,
    registeredCount: registeredEntries.length,
    pendingCount: pendingEntries.length,
    missingFromRegistry: Object.freeze(missing),
  });
}

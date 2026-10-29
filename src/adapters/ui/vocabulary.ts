/**
 * User-visible vocabulary for coherence findings and hierarchy items.
 *
 * Source: design/UI polish and professionalism/design_handoff_ui_polish/README.md
 * → "Copy & terminology changes". The graph vocabulary ("node", "flag",
 * raw reason codes) is internal only; every user-visible string routes
 * through here so the two can never drift.
 *
 * Presentation layer only — no domain type is renamed, and `CoherenceFindingKind`
 * stays the wire vocabulary.
 */

import type { CoherenceFindingKind } from '../../contracts/analysis-protocol';
import type { DeliveryStatus } from '../../domain/tree/node.entity';

/** Generic hierarchy item — replaces "node" everywhere a user can read it. */
export const ITEM_NOUN = 'item';
export const ITEM_NOUN_PLURAL = 'items';

/** Aggregate label for a mixed count of blocking and non-blocking findings. */
export const RISKS_AND_BLOCKERS_LABEL = 'Risks & blockers';

/**
 * `{n} items`, correctly singular at one.
 */
export function itemCountPhrase(count: number): string {
  return `${count} ${count === 1 ? ITEM_NOUN : ITEM_NOUN_PLURAL}`;
}

/**
 * Aggregate finding-count phrase. Mixes blocking and non-blocking reasons,
 * so it never claims a severity — that split is per-item (see
 * `findingSeverityLabel`).
 */
export function riskCountPhrase(count: number): string {
  if (count <= 0) return 'no risks or blockers';
  if (count === 1) return '1 risk or blocker';
  return `${count} risks & blockers`;
}

/**
 * Per-item severity label. "Blocker" is reserved for reasons that actually
 * stop progress — an unlock cycle can never resolve itself, so nothing in
 * the cycle is reachable. Sequencing conflicts, orphans, and imbalances are
 * advisory: they read as "Risk".
 */
export function findingSeverityLabel(kind: CoherenceFindingKind): 'Risk' | 'Blocker' {
  return kind === 'UnlockCycle' ? 'Blocker' : 'Risk';
}

/**
 * Ordered delivery-status options, in canonical display order (Not started →
 * In progress → Delivered). The single source of truth for both the outline
 * status badge/menu and the workspace overview (Story 25.4 AC 25.4-3).
 *
 * `modifier` is the CSS class suffix (`not-started`, `in-progress`,
 * `delivered`); it is shared so the outline and the overview cannot diverge.
 */
export interface DeliveryStatusOption {
  readonly value: DeliveryStatus;
  readonly label: string;
  readonly modifier: string;
}

export const DELIVERY_STATUS_OPTIONS: readonly DeliveryStatusOption[] = Object.freeze([
  Object.freeze({ value: 'not_started', label: 'Not started', modifier: 'not-started' }),
  Object.freeze({ value: 'in_progress', label: 'In progress', modifier: 'in-progress' }),
  Object.freeze({ value: 'delivered', label: 'Delivered', modifier: 'delivered' }),
] as const);

/** Display label for a delivery status; falls back to the default status label. */
export function deliveryStatusLabel(status: DeliveryStatus): string {
  return DELIVERY_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? 'Not started';
}

/** CSS modifier suffix for a delivery status; falls back to the default. */
export function deliveryStatusModifier(status: DeliveryStatus): string {
  return DELIVERY_STATUS_OPTIONS.find((o) => o.value === status)?.modifier ?? 'not-started';
}

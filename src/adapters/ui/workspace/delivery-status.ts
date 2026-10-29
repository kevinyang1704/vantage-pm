/**
 * Delivery-status presentation vocabulary for the workspace overview
 * (Epic 24, DO-UX2; consolidated in Story 25.4 AC 25.4-3).
 *
 * Labels and CSS modifiers come from the single shared `../vocabulary` module
 * so the outline and the overview cannot drift. This module adds only the
 * overview-specific count key.
 */

import type { DeliveryStatus } from '../../../domain/tree/node.entity';
import type { WorkspaceStatusCounts } from '../../../contracts/workspace-overview';
import {
  DELIVERY_STATUS_OPTIONS,
  deliveryStatusLabel,
  deliveryStatusModifier,
} from '../vocabulary';

export interface DeliveryStatusDescriptor {
  readonly value: DeliveryStatus;
  readonly label: string;
  /** Modifier class suffix, e.g. `not-started`. */
  readonly modifier: string;
  /** Count key on `WorkspaceStatusCounts`. */
  readonly countKey: keyof WorkspaceStatusCounts;
}

/** Overview-only count key per status; labels and modifiers come from the shared vocabulary. */
const OVERVIEW_COUNT_KEYS: Readonly<Record<DeliveryStatus, keyof WorkspaceStatusCounts>> = Object.freeze({
  not_started: 'notStarted' as const,
  in_progress: 'inProgress' as const,
  delivered: 'delivered' as const,
});

export const DELIVERY_STATUS_ORDER: readonly DeliveryStatusDescriptor[] = Object.freeze(
  DELIVERY_STATUS_OPTIONS.map((option) =>
    Object.freeze({
      value: option.value,
      label: option.label,
      modifier: option.modifier,
      countKey: OVERVIEW_COUNT_KEYS[option.value],
    }),
  ),
);

export { deliveryStatusLabel, deliveryStatusModifier };

export interface DeliveryBucket {
  readonly descriptor: DeliveryStatusDescriptor;
  readonly count: number;
}

/** Non-zero buckets, in canonical order. Empty when no Feature carries one. */
export function deliveryBuckets(
  counts: WorkspaceStatusCounts,
): readonly DeliveryBucket[] {
  return Object.freeze(
    DELIVERY_STATUS_ORDER.filter((d) => counts[d.countKey] > 0).map((d) =>
      Object.freeze({ descriptor: d, count: counts[d.countKey] }),
    ),
  );
}

/**
 * `{n} {status}` phrase for the accessible name, e.g. `2 Not started`.
 */
export function deliveryCountPhrase(bucket: DeliveryBucket): string {
  return `${bucket.count} ${bucket.descriptor.label}`;
}

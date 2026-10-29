/**
 * Node domain entity (Story 2.3, Epic 3).
 *
 * Represents an authored node in the vision-tree forest (AD-7).
 * Progressively enriched with computable planning fields in Epic 3:
 *   - nodeType (Story 3.1)
 *   - schedule (startDate, endDate, durationDays, scheduleSourceMode) (Story 3.4)
 *   - completed (Story 3.5)
 *   - effortPoints, strategicWeight (Story 3.6)
 *   - phaseId (Story 3.7)
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type NodeType = 'Vision' | 'Theme' | 'Component' | 'Feature' | 'AcceptanceCriterion';

export type ScheduleSourceMode = 'start_end' | 'start_duration' | 'end_duration' | 'none';

/**
 * Delivery status of a node (outline status badging).
 *
 * User-set, three-state marker shown as a badge on each outline row.
 * Every node has one; a fresh node is 'not_started'. The persisted column
 * is nullable for schema-migration reasons — the read path coalesces a
 * legacy NULL to 'not_started'.
 */
export type DeliveryStatus = 'not_started' | 'in_progress' | 'delivered';

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'not_started',
  'in_progress',
  'delivered',
] as const;

/**
 * Read-path coercion: a persisted `delivery_status` cell is nullable (schema
 * migration) and, in principle, could hold an unrecognised string. Map any
 * legacy NULL / unknown value to 'not_started' so every read model has a
 * well-formed status.
 */
export function coerceDeliveryStatus(value: unknown): DeliveryStatus {
  return value === 'in_progress' || value === 'delivered' ? value : 'not_started';
}

export type Node = Readonly<{
  id: string; // lowercase UUIDv7
  projectId: string; // project scope; AD-7 forbids cross-project references
  parentId: string | null; // null = a root of this project's forest
  title: string; // '' is valid (AC2)
  bodyText: string | null; // null = no body text authored (FR-8)
  position: bigint; // signed 64-bit gap position among siblings (AD-7)
  nodeType: NodeType | null;
  startDate: string | null; // ISO YYYY-MM-DD
  endDate: string | null;   // ISO YYYY-MM-DD
  durationDays: number | null;
  scheduleSourceMode: ScheduleSourceMode | null;
  completed: boolean;
  effortPoints: number | null;
  /**
   * Points already done on an in-progress item (Story 26.5, FC-FR5): null
   * means "not recorded", otherwise an integer with 0 <= done <= effortPoints.
   * Lives beside `effortPoints`; never flips `deliveryStatus` and is never
   * inferred from the calendar (Epic 26 out-of-scope rules).
   */
  effortPointsDone: number | null;
  strategicWeight: number | null;
  phaseId: string | null;
  deliveryStatus: DeliveryStatus;
}>;

export function createNode(params: {
  id: string;
  projectId: string;
  parentId?: string | null;
  title?: string;
  bodyText?: string | null;
  position: bigint;
  nodeType?: NodeType | null;
  startDate?: string | null;
  endDate?: string | null;
  durationDays?: number | null;
  scheduleSourceMode?: ScheduleSourceMode | null;
  completed?: boolean;
  effortPoints?: number | null;
  effortPointsDone?: number | null;
  strategicWeight?: number | null;
  phaseId?: string | null;
  deliveryStatus?: DeliveryStatus;
}): Node {
  assertUuidV7(params.id, 'Node.id must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'Node.projectId must be a valid UUIDv7');
  if (params.parentId !== null && params.parentId !== undefined) {
    assertUuidV7(params.parentId, 'Node.parentId must be a valid UUIDv7 when present');
  }
  if (params.phaseId !== null && params.phaseId !== undefined) {
    assertUuidV7(params.phaseId, 'Node.phaseId must be a valid UUIDv7 when present');
  }

  return Object.freeze({
    id: params.id,
    projectId: params.projectId,
    parentId: params.parentId ?? null,
    title: params.title ?? '',
    bodyText: params.bodyText ?? null,
    position: params.position,
    nodeType: params.nodeType ?? null,
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    durationDays: params.durationDays ?? null,
    scheduleSourceMode: params.scheduleSourceMode ?? null,
    completed: params.completed ?? false,
    effortPoints: params.effortPoints ?? null,
    effortPointsDone: params.effortPointsDone ?? null,
    strategicWeight: params.strategicWeight ?? null,
    phaseId: params.phaseId ?? null,
    deliveryStatus: params.deliveryStatus ?? 'not_started',
  });
}

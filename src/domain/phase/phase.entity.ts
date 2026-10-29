/**
 * Phase domain entity (Story 3.7, AD-4, AD-7).
 *
 * Ordered project sequencing phase.
 */

import { assertUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';

export type Phase = Readonly<{
  id: string; // lowercase UUIDv7
  projectId: string; // project scope
  name: string; // phase name (e.g. "Phase 1: Foundation")
  position: bigint; // signed 64-bit gap position (AD-7)
}>;

export function createPhase(params: {
  id: string;
  projectId: string;
  name: string;
  position: bigint;
}): Phase {
  assertUuidV7(params.id, 'Phase.id must be a valid UUIDv7');
  assertUuidV7(params.projectId, 'Phase.projectId must be a valid UUIDv7');

  const trimmed = params.name.trim();
  if (!trimmed) {
    throw new Error('Phase name cannot be empty');
  }

  return Object.freeze({
    id: params.id,
    projectId: params.projectId,
    name: trimmed,
    position: params.position,
  });
}

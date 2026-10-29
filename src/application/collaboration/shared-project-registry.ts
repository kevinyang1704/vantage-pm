/**
 * Shared-project registry port (Story 27.6/27.7, H08).
 *
 * Maps a local project to the collaboration identity it syncs under: the
 * service origin, this device's id and actor id, its role, and the share
 * operation that provisioned it. Nonportable by construction — portable v9
 * files never carry it, and an imported project is always local. Secrets are
 * NOT stored here; the credential port owns them.
 */

import type { ProjectRole } from '../../domain/collaboration/share-lifecycle';

/** `joining`: an invite was redeemed and owner approval is pending. */
export type SharedProjectStatus = 'provisioning' | 'joining' | 'shared' | 'stopped';

export interface SharedProjectRecord {
  readonly projectId: string;
  readonly origin: string;
  readonly deviceId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly role: ProjectRole;
  readonly status: SharedProjectStatus;
  /** Idempotent share-operation id reused on retry (R7); null for joiners. */
  readonly shareOperationId: string | null;
  /** The redeemed join request a joiner waits on; null for owners. */
  readonly joinRequestId?: string | null;
  readonly createdAtISO: string;
}

export interface SharedProjectRegistry {
  get(projectId: string): Promise<SharedProjectRecord | null>;
  put(record: SharedProjectRecord): Promise<void>;
  remove(projectId: string): Promise<void>;
}

const ROLES: readonly ProjectRole[] = ['owner', 'editor', 'viewer'];
const STATUSES: readonly SharedProjectStatus[] = ['provisioning', 'joining', 'shared', 'stopped'];

/** Validate a stored record; anything malformed is treated as absent. */
export function parseSharedProjectRecord(value: unknown): SharedProjectRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const str = (key: string) => (typeof r[key] === 'string' && (r[key] as string).length > 0 ? (r[key] as string) : null);
  const projectId = str('projectId'); const origin = str('origin'); const deviceId = str('deviceId');
  const actorId = str('actorId'); const displayName = str('displayName'); const createdAtISO = str('createdAtISO');
  if (!projectId || !origin || !deviceId || !actorId || !displayName || !createdAtISO) return null;
  if (!ROLES.includes(r.role as ProjectRole) || !STATUSES.includes(r.status as SharedProjectStatus)) return null;
  if (r.shareOperationId !== null && typeof r.shareOperationId !== 'string') return null;
  if (r.joinRequestId !== undefined && r.joinRequestId !== null && typeof r.joinRequestId !== 'string') return null;
  return Object.freeze({
    projectId, origin, deviceId, actorId, displayName, createdAtISO,
    role: r.role as ProjectRole, status: r.status as SharedProjectStatus,
    shareOperationId: (r.shareOperationId as string | null) ?? null,
    joinRequestId: (r.joinRequestId as string | null | undefined) ?? null,
  });
}

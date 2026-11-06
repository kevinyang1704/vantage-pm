/**
 * Attribution, activity and presence logic (Story 27.8, TC-FR7, TC-UX2, R9).
 *
 * Pure projections over confirmed commands and ephemeral presence. No I/O, no
 * persistence: the UI consumes these; the service supplies the data. Only
 * shared projects show any of this — a local project never has actors or
 * presence (AC 27.8-4).
 */

import type { ProductCommand } from '../../contracts/repository-commands';

/** A confirmed change with its server order and actor (attribution source). */
export type ConfirmedChange = Readonly<{
  /** Monotonic server revision (server order; never a device clock). */
  serverRevision: number;
  /** ISO instant the server confirmed the command. */
  confirmedAtISO: string;
  actorId: string;
  /** Display name resolved from membership; retained historically. */
  actorName: string;
  command: ProductCommand;
}>;

/** Resolve the actor who last changed an item, from confirmed changes only. */
export function lastChangedBy(
  changes: readonly ConfirmedChange[],
  targetId: string,
): Readonly<{ actorId: string; actorName: string; confirmedAtISO: string }> | null {
  let best: ConfirmedChange | null = null;
  for (const change of changes) {
    if (!commandTouches(change.command, targetId)) continue;
    if (!best || change.serverRevision > best.serverRevision) best = change;
  }
  return best
    ? Object.freeze({ actorId: best.actorId, actorName: best.actorName, confirmedAtISO: best.confirmedAtISO })
    : null;
}

/** The item id(s) a command touches, for attribution and footprints. */
export function commandTouches(command: ProductCommand, targetId: string): boolean {
  const c = command as unknown as Record<string, unknown>;
  return (
    c.nodeId === targetId ||
    c.featureId === targetId ||
    c.phaseId === targetId ||
    c.questionId === targetId ||
    c.personId === targetId ||
    c.edgeId === targetId ||
    c.scenarioId === targetId
  );
}

/**
 * A plain-language description of a confirmed change (TC-UX2). Uses the
 * resolved display name and the item title; no raw ids leak to the reader.
 */
export function describeChange(change: ConfirmedChange, titleFor: (id: string) => string): string {
  const c = change.command as unknown as Record<string, unknown>;
  const t = (id: unknown) => (typeof id === 'string' ? titleFor(id) : 'an item');
  switch (change.command.type) {
    case 'SetNodeTitle':
      return `${change.actorName} renamed ${t(c.nodeId)}`;
    case 'SetNodeBodyText':
      return `${change.actorName} edited the notes on ${t(c.nodeId)}`;
    case 'MoveNode':
      return `${change.actorName} moved ${t(c.nodeId)}`;
    case 'MoveForecastFeature':
      return `${change.actorName} reordered ${t(c.featureId)}`;
    case 'SetForecastAssignment':
      return `${change.actorName} ${c.assigned ? 'assigned' : 'unassigned'} a person ${t(c.featureId)}`;
    case 'SetNodeEffort':
      return `${change.actorName} changed the effort of ${t(c.nodeId)}`;
    case 'SetNodePointsDone':
      return `${change.actorName} recorded points done on ${t(c.nodeId)}`;
    case 'ToggleNodeCompleted':
      return `${change.actorName} marked ${t(c.nodeId)} ${c.completed ? 'done' : 'not done'}`;
    case 'CreateNode':
      return `${change.actorName} added ${t(c.nodeId)}`;
    case 'DeleteSubtree':
      return `${change.actorName} deleted ${t(c.nodeId)}`;
    case 'RenamePhase':
      return `${change.actorName} renamed a phase`;
    case 'MovePhase':
      return `${change.actorName} reordered phases`;
    case 'SetForecastBlocker':
      return `${change.actorName} ${c.blocked ? 'blocked' : 'unblocked'} ${t(c.featureId)}`;
    case 'SetForecastSprintPlan':
      return `${change.actorName} changed the sprint plan`;
    default:
      return `${change.actorName} made a change`;
  }
}

/** The attributed activity feed, newest confirmed first, optionally filtered. */
export function activityFeed(
  changes: readonly ConfirmedChange[],
  titleFor: (id: string) => string,
  filter?: { actorId?: string; limit?: number; offset?: number },
): readonly Readonly<{ serverRevision: number; confirmedAtISO: string; actorId: string; actorName: string; description: string }>[] {
  const filtered = filter?.actorId
    ? changes.filter((c) => c.actorId === filter.actorId)
    : [...changes];
  const sorted = [...filtered].sort((a, b) => b.serverRevision - a.serverRevision);
  const offset = Math.max(0, Math.floor(filter?.offset ?? 0));
  const limit = Math.max(0, Math.floor(filter?.limit ?? sorted.length));
  return Object.freeze(
    sorted.slice(offset, offset + limit).map((c) =>
      Object.freeze({
        serverRevision: c.serverRevision,
        confirmedAtISO: c.confirmedAtISO,
        actorId: c.actorId,
        actorName: c.actorName,
        description: describeChange(c, titleFor),
      }),
    ),
  );
}

// ── Presence (ephemeral; D9 heartbeat 10 s, gone after 30 s) ───────────────

export const PRESENCE_HEARTBEAT_MS = 10_000;
export const PRESENCE_TIMEOUT_MS = 30_000;

export type PresenceEntry = Readonly<{ actorId: string; actorName: string; lastSeenISO: string }>;

/** Who is currently present, given `now`; expired entries are dropped. */
export function presentMembers(
  entries: readonly PresenceEntry[],
  nowISO: string,
): readonly PresenceEntry[] {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) return Object.freeze([]);
  return Object.freeze(
    entries.filter((e) => {
      const seen = Date.parse(e.lastSeenISO);
      return Number.isFinite(seen) && now - seen < PRESENCE_TIMEOUT_MS;
    }),
  );
}

/** Initials from a display name (never color alone, TC-UX2). */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A relative-time phrase for a confirmed instant ("2 min ago"). */
export function relativeTime(confirmedAtISO: string, nowISO: string): string {
  const deltaMs = Date.parse(nowISO) - Date.parse(confirmedAtISO);
  if (Number.isNaN(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

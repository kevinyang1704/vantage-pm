/**
 * Version handshake (Story 27.9, TC-NFR5, R10).
 *
 * The client sends its protocol + schema versions before any snapshot or
 * command admission. The service accepts every supported combination (current
 * and previous release, at least 30 days); otherwise it answers
 * `UpdateRequired`, and the app shows “Update to keep syncing” while local work
 * continues and queues (nothing is lost).
 *
 * Pure: versions in, decision out.
 */

export const PROTOCOL_VERSION = '1.0.0';

/** The version-support period in days (D9/R10). */
export const VERSION_SUPPORT_WINDOW_DAYS = 30;

/** A supported (protocol, schema) pair the service can serve. */
export type SupportedVersion = Readonly<{
  protocolVersion: string;
  schemaVersion: number;
  /** ISO date this pair stops being supported (its retirement clock). */
  retiresAtISO: string;
}>;

export type HandshakeDecision =
  | Readonly<{ kind: 'accepted'; matched: SupportedVersion }>
  | Readonly<{ kind: 'update-required'; reason: 'UNSUPPORTED_PROTOCOL' | 'UNSUPPORTED_SCHEMA' | 'RETIRED' }>;

/**
 * Decide whether a client may proceed. A client inside the support period whose
 * exact pair is listed is accepted; anything else requires an update (local work
 * is retained and queued).
 */
export function handshake(
  client: Readonly<{ protocolVersion: string; schemaVersion: number }>,
  supported: readonly SupportedVersion[],
  nowISO: string,
): HandshakeDecision {
  const byProtocol = supported.find((s) => s.protocolVersion === client.protocolVersion);
  if (!byProtocol) {
    return Object.freeze({ kind: 'update-required', reason: 'UNSUPPORTED_PROTOCOL' });
  }
  const exact = supported.find(
    (s) => s.protocolVersion === client.protocolVersion && s.schemaVersion === client.schemaVersion,
  );
  if (!exact) {
    // Same protocol but a schema we do not serve: expand/contract should have
    // kept this working; if not, it is unsupported schema.
    return Object.freeze({ kind: 'update-required', reason: 'UNSUPPORTED_SCHEMA' });
  }
  if (nowISO >= exact.retiresAtISO) {
    return Object.freeze({ kind: 'update-required', reason: 'RETIRED' });
  }
  return Object.freeze({ kind: 'accepted', matched: exact });
}

/**
 * Whether both N and N−1 (and, per R10, an N−2 inside the period after rapid
 * releases) remain supported at `nowISO`. Used by the compatibility tests.
 */
export function supportedCountAt(supported: readonly SupportedVersion[], nowISO: string): number {
  const live = supported.filter((s) => nowISO < s.retiresAtISO);
  const protocols = new Set(live.map((s) => s.protocolVersion));
  return protocols.size;
}

/** The label the app shows when it must update (TC-UX1 / R8). */
export function updateRequiredLabel(): string {
  return 'Update to keep syncing';
}

/**
 * Whether an update may proceed: it waits for local queue settlement and a
 * durable outbox/rejections, never for an unavailable server to drain the
 * outbox (R10).
 */
export function updateMayProceed(state: Readonly<{ queueSettled: boolean; outboxDurable: boolean }>): boolean {
  return state.queueSettled && state.outboxDurable;
}

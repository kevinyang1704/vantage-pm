import type { LedgerInspection } from './repository-ledger';

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function inspectRestart(inspection: LedgerInspection) {
  return Object.freeze({
    ...inspection,
    semanticDatabaseHash: await sha256Hex(inspection.semanticState),
    reconciliationAccepted:
      inspection.quickCheck === 'ok' &&
      inspection.partialMutation === false &&
      inspection.commandReceiptCount === inspection.recordedResultCount,
  });
}

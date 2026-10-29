import type { ProductCommand } from '../../contracts/repository-commands';
import type { ConfirmedHistoryEntry, RecoveryEnvelope } from '../../contracts/collaboration-recovery';
import { recoveryPayloadDigest } from '../../contracts/collaboration-recovery.validation';

export function historyFixture(command: ProductCommand, revision = 1): ConfirmedHistoryEntry {
  return Object.freeze({ command, result: Object.freeze({ type: 'ProductCommandApplied', protocolVersion: command.protocolVersion,
    commandId: command.commandId, projectId: command.projectId, baseRevision: revision - 1, targetRevision: revision,
    outcome: 'VfsCommitAccepted', disposition: 'NewCommit', changeSet: Object.freeze({ protocolVersion: command.protocolVersion,
      projectId: command.projectId, baseRevision: revision - 1, targetRevision: revision, changes: Object.freeze([]) }) }),
    payloadDigest: '0'.repeat(64), wireIdentityAvailability: 'original', actorId: command.actorId ?? null, protocolVersion: command.protocolVersion,
    serverRevision: revision, receiptRevisionAvailability: 'authoritative', recordedAtIso: null, label: null,
    commandFootprint: Object.freeze({ availability: 'unavailable', reason: 'SYNTHETIC_HISTORICAL_METADATA', knownTargets: Object.freeze([]) }),
    effectFootprint: Object.freeze({ availability: 'unavailable', reason: 'SYNTHETIC_HISTORICAL_METADATA', knownTargets: Object.freeze([]) }), deletionMetadata: 'not-applicable' });
}
export async function boundHistoryFixture(command: ProductCommand, revision = 1): Promise<ConfirmedHistoryEntry> {
  return Object.freeze({ ...historyFixture(command, revision), payloadDigest: await recoveryPayloadDigest(command) });
}
export function envelopeFixture(projectId: string, revision = 42): RecoveryEnvelope {
  return Object.freeze({ version: 1, protocolVersion: '1.0.0', projectId, streamEpoch: 1, serverRevision: revision,
    historyFloor: revision, dedupCoverage: 'complete', graph: Object.freeze({ project: Object.freeze({ id: projectId, name: 'Synthetic recovery', revision }),
      phases: [], nodes: [], customFields: [], typeTemplateFields: [], unlockEdges: [], dismissals: [], affectedReasons: [],
      openQuestions: [], forecastPlans: [], forecastScenarios: [] }), confirmedHistory: [], terminalRejections: [] });
}

/**
 * Browser sync-repository adapter (Story 27.7, R4/H04).
 *
 * Implements the runtime-neutral `SyncRepository` port over the browser
 * repository worker + the durable outbox. It guarantees the two atomic
 * operations the sync client needs:
 *
 * - `commitWithOutbox`: apply the command through the repository AND write the
 *   outbox entry in one local operation, so a crash cannot ack an unqueued edit.
 * - `applyRebase`: remove rejected pending entries, apply the confirmed remote
 *   command (unless own echo) and re-apply survivors, persisting their outbox
 *   entries, as one recoverable operation.
 *
 * The native (Tauri) build implements the same port over its repository client.
 */

import type { ProductCommand } from '../../contracts/repository-commands';
import type { MergeState } from '../../domain/collaboration/rebase';
import type { OutboxEntry } from '../../application/collaboration/sync-client';
import type { SyncRepository } from '../../application/collaboration/collaboration-service';
import { applyCommandWithOutbox, applyGroupWithOutbox, applyRebaseAtomic, readCollaborationOutbox, discardCollaborationOutboxEntry } from './repository-worker.client';
import { installCollaborationSnapshot } from './repository-worker.client';
import { validateRecoveryEnvelope } from '../../contracts/collaboration-recovery.validation';

export interface BrowserSyncRepositoryDeps {
  /** The current merge state (nodes/order/forecast) for a project. */
  mergeState: (projectId: string) => MergeState;
}

export function createBrowserSyncRepository(deps: BrowserSyncRepositoryDeps): SyncRepository {
  return {
    readOutbox: readCollaborationOutbox,
    async installSnapshot(projectId, envelope) {
      await installCollaborationSnapshot(projectId, await validateRecoveryEnvelope(envelope, projectId));
      return readCollaborationOutbox(projectId);
    },
    discardOutboxEntry: discardCollaborationOutboxEntry,
    async commitWithOutbox(projectId, command, outboxEntry) {
      // Apply the command AND write the durable outbox entry in ONE worker
      // transaction (R4/H04), so a crash can never acknowledge a locally-applied
      // edit whose outbox entry was not written.
      const result = await applyCommandWithOutbox(
        command,
        {
          commandId: outboxEntry.commandId,
          commandJson: JSON.stringify(outboxEntry.command),
          commitAttemptId: outboxEntry.commitAttemptId,
          queuedAtISO: outboxEntry.queuedAtISO,
        },
        projectId,
      );
      if (result.type !== 'ProductCommandApplied') {
        const reason = 'code' in result ? String(result.code) : 'The edit was not applied.';
        return { applied: false, rejectedReason: reason, result };
      }
      return { applied: true, result };
    },

    async commitGroupWithOutbox(projectId, commands, entries) {
      const groupId = entries[0]?.groupId;
      if (!groupId || entries.length !== commands.length || entries.some((entry, index) => entry.groupId !== groupId || entry.command !== commands[index])) throw new Error('OUTBOX_GROUP_INVALID');
      const results = await applyGroupWithOutbox(projectId, entries.map((entry) => ({
        command: entry.command, commandJson: JSON.stringify(entry.command), commitAttemptId: entry.commitAttemptId, queuedAtISO: entry.queuedAtISO,
      })), groupId);
      const refused = results.find((result) => result.type !== 'ProductCommandApplied');
      if (refused) return { applied: false, rejectedReason: 'code' in refused ? String(refused.code) : 'The edit was not applied.', results };
      return { applied: true, results };
    },

    async applyRebase(projectId, remote, toReapply, rejected) {
      // The whole rebase runs in ONE worker transaction (R4/H04): remove
      // rejected pending entries, apply the confirmed remote command (unless own
      // echo), re-queue the surviving pending commands with their bumped commit
      // attempt, and advance the stream cursor. A crash can never leave a
      // partial rebase.
      const outcome = await applyRebaseAtomic(
        projectId,
        remote,
        toReapply.map((entry) => ({
          commandId: entry.commandId,
          command: entry.command,
          commitAttemptId: entry.commitAttemptId,
          queuedAtISO: entry.queuedAtISO,
          ...(entry.groupId !== undefined ? { groupId: entry.groupId, groupIndex: entry.groupIndex } : {}),
        })),
        rejected.map((r) => ({ commandId: r.commandId, reason: r.reason })),
      );
      // A locally-rejected confirmed remote command means we diverged from the
      // server log. The durable cursor has already advanced inside the atomic
      // rebase, so signal the caller to request a fresh snapshot rather than
      // silently staying divergent (H-review/r3). We do NOT write a fake cursor
      // here — the service owns resync via `since = 0`.
      const resyncRequired = outcome !== null && outcome.type !== 'ProductCommandApplied';
      return { resyncRequired, ...(!resyncRequired ? { state: await readCollaborationOutbox(projectId) } : {}) };
    },

    mergeState(projectId) {
      return deps.mergeState(projectId);
    },
  };
}

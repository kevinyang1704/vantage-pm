import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createLocalFileState, createShareBundle, joinSharedProject, parseLocalFile,
  parseLocalFileState, prepareLocalMerge, resolveLocalMerge, localSnapshotHash,
  type ParsedLocalFile, type MergeReview, type MergeDecision, type LocalFileState,
} from '../application/portable-file/local-merge';
import { remapPortableSnapshot } from '../application/portable-file/import-project';
import type { PortableProjectSnapshot } from '../contracts/portable-file.schema';
import {
  applyLocalFileMerge, batchImportPortable, isNativeBridge, queryPortableSnapshot,
  readLocalFileRecovery, readLocalFileState, restoreLocalFileMerge, writeLocalFileState,
} from '../adapters/persistence/repository-worker.client';
import { createBrowserPortableFilePicker } from '../adapters/platform/browser-portable-file-picker';
import { tauriPortableFilePicker } from '../adapters/platform/tauri-portable-file-picker';
import { saveGeneratedFile } from '../adapters/platform/save-generated-file';
import { sanitizePortableFilenameBase } from '../application/portable-file/export-project';
import { createUuidV7 } from '../../spikes/phase-0-durability/src/command-receipt';
import type { CommandQueueOrchestrator } from '../application/command-queue/command-queue-orchestrator';

type Ports = Readonly<{
  selectedProjectId: string | null;
  orchestrator: () => CommandQueueOrchestrator | null;
  onChanged: (projectId: string, revision: number) => Promise<void>;
  onStatus: (message: string | null) => void;
  onIncompatibleStorage: () => void;
}>;
type Session = Readonly<{ file: ParsedLocalFile; fileName: string; operationId: string }>;
const message = (error: unknown): string => error instanceof Error ? error.message : 'The file operation could not be completed.';

/** UI orchestration only. All merge decisions are pure; persistence owns atomicity. */
export function useLocalFileCollaboration(ports: Ports) {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'standalone' | 'merge'>('standalone');
  const [targetId, setTargetId] = useState('');
  const [parentId, setParentId] = useState('');
  const [linked, setLinked] = useState(true);
  const [review, setReview] = useState<MergeReview | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, MergeDecision>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [showDeclined, setShowDeclined] = useState(false);
  const [forceBranch, setForceBranch] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [recovering, setRecovering] = useState<Readonly<{ projectId: string; revision: number; operationId: string }> | null>(null);
  const locked = useRef(false);
  const preparedStandalone = useRef<Readonly<{ key: string; snapshot: PortableProjectSnapshot; state?: LocalFileState }> | null>(null);
  const reviewToken = useRef(0);
  const selectedRef = useRef(ports.selectedProjectId);
  selectedRef.current = ports.selectedProjectId;
  function failure(error: unknown): string {
    const text = message(error);
    if (/UNSUPPORTED_NEWER_SCHEMA|NewerSchemaVersion|newer.*schema/i.test(text)) ports.onIncompatibleStorage();
    return text;
  }

  function settled(projectId: string): CommandQueueOrchestrator {
    const queue = ports.orchestrator();
    if (!queue || !queue.isQueueSettled(projectId)) throw new Error('Finish or resolve pending edits before sharing or merging.');
    return queue;
  }
  async function localState(snapshot: PortableProjectSnapshot) {
    const raw = await readLocalFileState(snapshot.projectId);
    return raw ? parseLocalFileState(raw, snapshot) : createLocalFileState(snapshot);
  }
  useEffect(() => {
    let cancelled = false;
    setRecoveryAvailable(false);
    if (ports.selectedProjectId) {
      void readLocalFileRecovery(ports.selectedProjectId).then(value => {
        if (!cancelled) setRecoveryAvailable(value !== null);
      }).catch(() => { /* No recovery action until storage can confirm it. */ });
    }
    return () => { cancelled = true; };
  }, [ports.selectedProjectId, session, recovering]);

  useEffect(() => {
    const token = ++reviewToken.current;
    setReview(null); setChoices({}); setError(null);
    if (!session || mode !== 'merge' || !targetId) { setPreparing(false); return; }
    setPreparing(true);
    void (async () => {
      settled(targetId);
      const snapshot = await queryPortableSnapshot(targetId);
      const state = await localState(snapshot);
      const next = prepareLocalMerge(snapshot, state, session.file, parentId || null, showDeclined, forceBranch);
      if (token === reviewToken.current) setReview(next);
    })().catch(err => { if (token === reviewToken.current) setError(failure(err)); })
      .finally(() => { if (token === reviewToken.current) setPreparing(false); });
    return () => { reviewToken.current++; };
  }, [session, mode, targetId, parentId, showDeclined, forceBranch]);

  async function reconcile(projectId: string): Promise<void> {
    const snapshot = await queryPortableSnapshot(projectId);
    ports.orchestrator()?.reconcileAtomicBatchRevision(projectId, snapshot.projectRevision);
    await ports.onChanged(projectId, snapshot.projectRevision);
  }
  async function pick() {
    if (locked.current || session) return;
    locked.current = true;
    ports.onStatus(null);
    try {
      const picker = isNativeBridge() ? tauriPortableFilePicker : createBrowserPortableFilePicker(document);
      const path = await picker.openFilePicker();
      if (path === null) { ports.onStatus('Import cancelled — no file was selected.'); return; }
      const file = parseLocalFile(await picker.readFile(path));
      setMode('standalone'); setLinked(Boolean(file.bundle)); setParentId(''); setShowDeclined(false); setForceBranch(false);
      setTargetId(selectedRef.current ?? ''); setError(null);
      setSession({ file, fileName: path.split(/[\\/]/).pop()?.replace(/^browser-file:\d+:/, '') ?? 'Project file', operationId: createUuidV7() });
    } catch (err) { ports.onStatus(`Import rejected: ${failure(err)}`); }
    finally { locked.current = false; }
  }
  async function share() {
    const projectId = selectedRef.current;
    if (!projectId || locked.current) return;
    locked.current = true; setBusy(true);
    try {
      settled(projectId);
      const snapshot = await queryPortableSnapshot(projectId);
      const shared = createShareBundle(snapshot, await localState(snapshot));
      // Saving the checkpoint first prevents publishing an unrecorded ancestry.
      settled(projectId);
      await writeLocalFileState(projectId, snapshot.projectRevision, JSON.stringify(shared.state));
      const current = await queryPortableSnapshot(projectId);
      if (current.projectRevision !== snapshot.projectRevision) throw new Error('The plan changed while preparing the file. Share again.');
      const saved = await saveGeneratedFile(new TextEncoder().encode(shared.json), `${sanitizePortableFilenameBase(snapshot.projectName)}.vantage-share.json`, 'application/json');
      if (!saved.ok) {
        if (saved.failure.kind === 'SelectionCancelled') return;
        throw new Error(`File could not be saved (${saved.failure.kind}).`);
      }
      ports.onStatus(`Shared editing file created: ${saved.filename}. It contains the whole project and its shared history. Send it through your approved file-sharing channel.`);
    } catch (err) { ports.onStatus(`Share blocked: ${failure(err)}`); }
    finally { locked.current = false; setBusy(false); }
  }
  async function approve() {
    if (!session || locked.current || preparing) return;
    locked.current = true; setBusy(true); setError(null);
    let changedProject: string | null = null;
    let committed = false;
    let standaloneReplyReceived = false;
    let standaloneSnapshot: PortableProjectSnapshot | null = null;
    try {
      if (mode === 'standalone') {
        const key = `${session.operationId}:${linked}`;
        if (preparedStandalone.current?.key !== key) {
          const candidate = linked && session.file.bundle ? joinSharedProject(session.file) : { snapshot: remapPortableSnapshot(session.file.snapshot), state: undefined };
          preparedStandalone.current = { key, ...candidate };
        }
        const imported = preparedStandalone.current;
        standaloneSnapshot = imported.snapshot;
        changedProject = imported.snapshot.projectId;
        const result = await batchImportPortable(imported.snapshot, imported.state ? JSON.stringify(imported.state) : undefined);
        standaloneReplyReceived = true;
        if (!result.ok) throw new Error(result.code === 'DUPLICATE_PROJECT_ID' ? 'This shared plan already exists here. Choose Merge into existing project, or uncheck Keep linked to create an independent copy.' : `Import failed (${result.code}).`);
        changedProject = result.projectId;
        committed = true;
        setSession(null);
        await ports.onChanged(result.projectId, result.revision);
        ports.onStatus(`Imported "${imported.snapshot.projectName}"${imported.state ? ' for continued shared editing' : ' as an independent project'}.`);
      } else {
        if (!review || targetId !== review.local.projectId) throw new Error('Choose a destination and wait for its review.');
        const resolved = resolveLocalMerge(review, choices);
        if (resolved.error) throw new Error(resolved.error);
        const queue = settled(targetId);
        changedProject = targetId;
        if (localSnapshotHash(resolved.snapshot) === localSnapshotHash(review.local)) {
          if (JSON.stringify(resolved.state) !== JSON.stringify(review.state)) {
            await queue.runAuthoritativeEdit(targetId, async () => {
              await writeLocalFileState(targetId, review.local.projectRevision, JSON.stringify(resolved.state));
              return { revision: review.local.projectRevision };
            });
          }
          setSession(null);
          ports.onStatus(review.changes.length ? 'No incoming plan changes applied. Your review decisions were saved.' : 'No new changes to apply. This contribution is already incorporated.');
          return;
        }
        const result = await queue.runAuthoritativeEdit(targetId, () => applyLocalFileMerge({
          operationId: session.operationId, projectId: targetId,
          expectedRevision: review.local.projectRevision, snapshot: resolved.snapshot,
          stateJson: JSON.stringify(resolved.state),
        }));
        committed = true;
        setSession(null);
        await ports.onChanged(targetId, result.revision);
        const count = review.changes.filter(c => (choices[c.id] ?? c.defaultDecision) === 'accept').length;
        ports.onStatus(count ? `Merged ${count} approved changes. A recovery point was saved.` : 'No incoming changes applied. Review decisions were saved.');
      }
      setSession(null);
    } catch (err) {
      if (standaloneSnapshot && !standaloneReplyReceived) {
        try {
          const saved = await queryPortableSnapshot(standaloneSnapshot.projectId);
          if (localSnapshotHash(saved) === localSnapshotHash(standaloneSnapshot)) {
            committed = true;
            setSession(null);
          }
        } catch { /* Retain the same prepared identity for a safe retry. */ }
      }
      if (changedProject) {
        try { await reconcile(changedProject); } catch { /* Keep queue gate if authoritative read fails. */ }
      }
      if (committed) ports.onStatus('The import was saved. If its result is not visible, reload to refresh; do not import again.');
      else setError(`${failure(err)} If the project changed, cancel and import again to review its latest version.`);
    } finally { locked.current = false; setBusy(false); }
  }
  async function openRecovery() {
    const projectId = selectedRef.current;
    if (!projectId || locked.current) return;
    try {
      settled(projectId);
      const snapshot = await queryPortableSnapshot(projectId);
      const recovery = await readLocalFileRecovery(projectId);
      if (!recovery) throw new Error('No saved merge recovery point is available.');
      setError(null); setRecovering({ projectId, revision: snapshot.projectRevision, operationId: createUuidV7() });
    } catch (err) { ports.onStatus(failure(err)); }
  }
  async function recover() {
    if (!recovering || locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    let committed = false;
    try {
      const result = await settled(recovering.projectId).runAuthoritativeEdit(recovering.projectId, () => restoreLocalFileMerge(recovering.projectId, recovering.revision, recovering.operationId));
      committed = true;
      setRecovering(null);
      await ports.onChanged(recovering.projectId, result.revision);
      ports.onStatus('Restored the previous plan and merge history. The replaced plan is now the recovery point.');
    } catch (err) {
      try { await reconcile(recovering.projectId); } catch { /* Keep uncertain queue gated. */ }
      if (committed) ports.onStatus('The recovery was saved. Reload to refresh its result.');
      else setError(failure(err));
    } finally { locked.current = false; setBusy(false); }
  }
  const result = useMemo(() => review ? resolveLocalMerge(review, choices) : null, [review, choices]);
  return {
    session, mode, targetId, parentId, linked, review, choices, busy, preparing, forceBranch,
    error: error ?? result?.error ?? null, recovering, recoveryAvailable, showDeclined,
    pick, share, approve, openRecovery, recover,
    setMode, setLinked, setForceBranch,
    setTargetId: (value: string) => { setParentId(''); setForceBranch(false); setTargetId(value); },
    setParentId,
    onChoice: (id: string, decision: MergeDecision) => { setError(null); setChoices(previous => ({ ...previous, [id]: decision })); },
    acceptSafe: () => { setError(null); setChoices(previous => ({ ...previous, ...Object.fromEntries(review?.changes.filter(c => !c.conflict && c.defaultDecision === 'accept').map(c => [c.id, 'accept' as const]) ?? []) })); },
    reviewDeclined: () => { setShowDeclined(value => !value); },
    cancel: () => { if (!locked.current) { setSession(null); setRecovering(null); setError(null); } },
  };
}

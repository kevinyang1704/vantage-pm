import { readNativeCollaborationOutbox, discardNativeCollaborationOutboxEntry, applyNativeCommandWithOutbox, applyNativeRebaseAtomic } from './tauri-repository.client';
/**
 * Dedicated Repository Worker Client Adapter.
 *
 * Bridge between Main Thread application state and the background Repository Web Worker.
 * Manages request/response correlation via requestId (UUIDv7) and provides
 * fallback to synchronous in-process database when Workers are unsupported (e.g. Vitest/SSR).
 */

import { PROTOCOL_VERSION, createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { validateProductCommandBatch, validateProductCommandBatchResults } from './product-batch.protocol';
import type {
  ProductCommand,
  ProductCommandResult,
} from '../../contracts/repository-commands';
import type { OutlineReadModel } from '../../application/outline/outline-read-model';
import type {
  ViewId,
  ViewStateSnapshot,
  ViewStatePatch,
} from '../../contracts/view-state';
import type { WorkspaceOverviewProjection } from '../../contracts/workspace-overview';
import type { UnlockEdge } from '../../domain/edge/unlock-edge.entity';
import type { FindingDismissal, AffectedReason, AnalysisSnapshotRequest } from '../../contracts/analysis-protocol';
import type { PortableProjectSnapshot } from '../../contracts/portable-file.schema';
import type {
  WorkerRequest,
  WorkerResponse,
} from './repository.worker';
import { validateProductCommand } from '../../contracts/repository-commands';
import { initializeCollaborationSchema, readOutbox, deleteOutboxEntry } from './collaboration-outbox';
import type { OutboxState } from '../../application/collaboration/sync-client';
import type { WorkspaceRegistry, WorkspaceMutationResult } from '../../contracts/workspace';
// Static import is safe under E9-NFR8: workspace-operations pulls in
// @sqlite.org/sqlite-wasm as a TYPE ONLY (erased at compile), so nothing here
// drags browser SQLite into the desktop bundle.
import {
  queryWorkspaceRegistry,
  createWorkspaceOp,
  renameWorkspaceOp,
  deleteWorkspaceOp,
  setActiveWorkspaceOp,
  moveProjectToWorkspaceOp,
} from './workspace-operations';

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Lazily loads the browser worker module. In the Tauri build the native
 * bridge is used, so the SQLite-WASM worker must NOT be in the bundle
 * (E9-NFR8: no browser SQLite inside the desktop shell).
 */
async function loadBrowserModule(): Promise<typeof import('./repository.worker')> {
  return import('./repository.worker');
}

let browserModulePromise: Promise<typeof import('./repository.worker')> | null = null;

async function browserModule(): Promise<typeof import('./repository.worker')> {
  browserModulePromise ??= loadBrowserModule();
  return browserModulePromise;
}

export class RepositoryWorkerClient {
  #worker: Worker | null = null;
  #pendingRequests = new Map<string, PendingRequest<any>>();
  #isOpfs = false;

  constructor(customWorker?: Worker | null) {
    if (customWorker !== undefined) {
      this.#worker = customWorker;
      if (this.#worker) {
        this.#worker.addEventListener('message', this.#handleMessage);
      }
      return;
    }

    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        this.#worker = new Worker(
          new URL('./repository.worker.ts', import.meta.url),
          { type: 'module' },
        );
        this.#worker.addEventListener('message', this.#handleMessage);
      } catch {
        this.#worker = null;
      }
    }
  }

  #handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    const data = event.data;
    if (!data || typeof data !== 'object' || !('requestId' in data)) return;

    const pending = this.#pendingRequests.get(data.requestId);
    if (!pending) return;
    this.#pendingRequests.delete(data.requestId);

    if (data.type === 'WorkerError') {
      // Preserve the worker's typed refusal code (e.g. UNSUPPORTED_NEWER_SCHEMA)
      // so callers can map it to canonical guidance instead of a bare string
      // (Story 22.15 AC 22.15-2, review L2).
      const error = new Error(data.error) as Error & { code?: string };
      if (typeof data.code === 'string') error.code = data.code;
      pending.reject(error);
      return;
    }

    pending.resolve(data);
  };

  #sendRequest<T extends WorkerResponse>(req: WorkerRequest): Promise<T> {
    if (!this.#worker) {
      throw new Error('Worker not available');
    }

    return new Promise<T>((resolve, reject) => {
      this.#pendingRequests.set(req.requestId, { resolve: resolve as (val: any) => void, reject });
      this.#worker!.postMessage(req);
    });
  }

  async initWorkerDatabase(): Promise<{ isOpfs: boolean }> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'WorkerReady' }>>({
        type: 'Initialize',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      this.#isOpfs = res.isOpfs;
      return { isOpfs: this.#isOpfs };
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    this.#isOpfs = mod.getIsOpfs();
    return { isOpfs: this.#isOpfs };
  }

  async applyProductCommand(command: ProductCommand): Promise<ProductCommandResult> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProductCommandResult' }>>({
        type: 'ApplyProductCommand',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command,
      });
      return res.result;
    }

    // Fallback path
    const mod = await browserModule();
    const handler = await mod.initWorkerDatabase();
    const validated = validateProductCommand(command);
    return handler.apply(validated);
  }

  async applyProductCommandBatch(input: readonly ProductCommand[]): Promise<readonly ProductCommandResult[]> {
    const commands = validateProductCommandBatch(input);
    if (this.#worker) {
      const response = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProductCommandBatchResult' }>>({ type: 'ApplyProductCommandBatch', protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), commands });
      return validateProductCommandBatchResults(commands, response.results);
    }
    const mod = await browserModule(); const handler = await mod.initWorkerDatabase();
    return validateProductCommandBatchResults(commands, handler.applyBatch(commands));
  }

  async forgetCollaboration(projectId: string): Promise<void> {
    if (this.#worker) {
      await this.#sendRequest<Extract<WorkerResponse, { type: 'CollaborationForgotten' }>>({
        type: 'ForgetCollaboration', protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), projectId,
      });
      return;
    }
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (!db) throw new Error('Repository database unavailable');
    initializeCollaborationSchema(db);
    const { forgetCollaboration } = await import('./collaboration-outbox');
    forgetCollaboration(db, projectId);
  }

  async collaborationHistory(projectId: string, before: number | null, limit: number): Promise<readonly import('./collaboration-outbox').CollaborationHistoryRow[]> {
    if (this.#worker) {
      const response = await this.#sendRequest<Extract<WorkerResponse, { type: 'CollaborationHistoryResult' }>>({
        type: 'ReadCollaborationHistory', protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), projectId, before, limit,
      });
      return response.rows;
    }
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (!db) throw new Error('Repository database unavailable');
    initializeCollaborationSchema(db);
    const { readCollaborationHistoryRows } = await import('./collaboration-outbox');
    return readCollaborationHistoryRows(db, projectId, before, limit);
  }

  async collaborationOutbox(projectId: string, commandId?: string): Promise<OutboxState> {
    if (this.#worker) {
      const response = await this.#sendRequest<Extract<WorkerResponse, { type: 'CollaborationOutboxResult' }>>({
        type: commandId === undefined ? 'ReadCollaborationOutbox' : 'DiscardCollaborationOutboxEntry',
        protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), projectId, commandId,
      });
      return response.state;
    }
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (!db) throw new Error('Repository database unavailable');
    initializeCollaborationSchema(db);
    if (commandId !== undefined) deleteOutboxEntry(db, projectId, commandId);
    return readOutbox(db, projectId);
  }

  async localFileOperation(request: Omit<Extract<WorkerRequest,{type:'LocalFileOperation'}>,'type'|'protocolVersion'|'requestId'>):Promise<Extract<WorkerResponse,{type:'LocalFileResult'}>['result']>{
   if(this.#worker){const response=await this.#sendRequest<Extract<WorkerResponse,{type:'LocalFileResult'}>>({...request,type:'LocalFileOperation',protocolVersion:PROTOCOL_VERSION,requestId:createUuidV7()});return response.result;}
   const mod=await browserModule();await mod.initWorkerDatabase();return mod.runLocalFileOperation({...request,type:'LocalFileOperation',protocolVersion:PROTOCOL_VERSION,requestId:createUuidV7()});
  }
  async installCollaborationSnapshot(projectId: string, envelope: import('../../contracts/collaboration-recovery').RecoveryEnvelope): Promise<Readonly<{ revision: number; recoveryRequired: boolean }>> {
    if (this.#worker) {
      const response = await this.#sendRequest<Extract<WorkerResponse, { type: 'SnapshotInstallResult' }>>({ type: 'InstallCollaborationSnapshot', protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), projectId, envelope });
      return { revision: response.revision, recoveryRequired: response.recoveryRequired };
    }
    const mod = await browserModule(); const handler = await mod.initWorkerDatabase();
    return handler.installSnapshotAtomic(projectId, envelope);
  }

  /** Apply a command and durably queue its outbox entry in ONE transaction (H04). */
  async applyCommandWithOutbox(
    command: ProductCommand,
    outbox: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>,
    projectId: string,
  ): Promise<ProductCommandResult> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProductCommandResult' }>>({
        type: 'ApplyCommandWithOutbox',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command,
        outbox,
        projectId,
      });
      return res.result;
    }
    const mod = await browserModule();
    const handler = await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (db) initializeCollaborationSchema(db);
    const validated = validateProductCommand(command);
    return handler.applyWithOutbox(validated, outbox, projectId);
  }

  /** A composite gesture's members + outbox entries in ONE worker transaction. */
  async applyGroupWithOutbox(projectId: string, members: readonly Readonly<{ command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string }>[], groupId: string): Promise<readonly ProductCommandResult[]> {
    if (this.#worker) {
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProductCommandBatchResult' }>>({
        type: 'ApplyGroupWithOutbox', protocolVersion: PROTOCOL_VERSION, requestId: createUuidV7(), projectId, groupId, members,
      });
      return res.results;
    }
    const mod = await browserModule();
    const handler = await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (db) initializeCollaborationSchema(db);
    return handler.applyGroupWithOutbox(projectId, members.map((member) => ({ ...member, command: validateProductCommand(member.command) })), groupId);
  }

  /** Apply one whole rebase in ONE worker transaction (R4/H04). */
  async applyRebaseAtomic(
    projectId: string,
    remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch?: number; historyEntry?: import('../../contracts/collaboration-recovery').ConfirmedHistoryEntry }>,
    toReapply: readonly Readonly<{ commandId: string; command: ProductCommand; commitAttemptId: number; queuedAtISO: string; groupId?: string; groupIndex?: number }>[],
    rejected: readonly Readonly<{ commandId: string; reason?: string }>[],
  ): Promise<ProductCommandResult | null> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'RebaseResult' }>>({
        type: 'ApplyRebaseAtomic',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
        remote,
        toReapply,
        rejected,
      });
      return res.result;
    }
    const mod = await browserModule();
    const handler = await mod.initWorkerDatabase();
    const db = mod.getDatabase();
    if (db) initializeCollaborationSchema(db);
    const validatedRemote = { ...remote, command: validateProductCommand(remote.command) };
    const validatedSurvivors = toReapply.map((e) => ({ ...e, command: validateProductCommand(e.command) }));
    return handler.applyConfirmedRebaseAtomic(projectId, validatedRemote, validatedSurvivors, rejected);
  }

  async queryProjectNodes(projectId: string): Promise<OutlineReadModel> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProjectNodesResult' }>>({
        type: 'QueryProjectNodes',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
      });
      return res.model;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryProjectNodes(projectId);
  }

  async queryProjects(): Promise<readonly { id: string; name: string; revision: number }[]> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ProjectsResult' }>>({
        type: 'QueryProjects',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      return res.projects;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryProjects();
  }

  async queryWorkspaceOverview(): Promise<WorkspaceOverviewProjection> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'WorkspaceOverviewResult' }>>({
        type: 'QueryWorkspaceOverview',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      return res.overview;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryWorkspaceOverview();
  }

  // ── Epic 17: workspace registry ────────────────────────────────────

  async queryWorkspaceRegistry(): Promise<WorkspaceRegistry> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'WorkspaceRegistryResult' }>>({
        type: 'QueryWorkspaceRegistry',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      return res.registry;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return queryWorkspaceRegistry(mod.getDatabase()!);
  }

  async mutateWorkspace(
    mutation: Extract<WorkerRequest, { type: 'MutateWorkspace' }>['mutation'],
  ): Promise<WorkspaceMutationResult> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'WorkspaceMutationResponse' }>>({
        type: 'MutateWorkspace',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        mutation,
      });
      return res.result;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    const db = mod.getDatabase()!;
    switch (mutation.kind) {
      case 'Create':
        return createWorkspaceOp(db, { workspaceId: mutation.workspaceId, name: mutation.name });
      case 'Rename':
        return renameWorkspaceOp(db, { workspaceId: mutation.workspaceId, name: mutation.name });
      case 'Delete':
        return deleteWorkspaceOp(db, { workspaceId: mutation.workspaceId });
      case 'SetActive':
        return setActiveWorkspaceOp(db, { workspaceId: mutation.workspaceId });
      case 'MoveProject':
        return moveProjectToWorkspaceOp(db, {
          projectId: mutation.projectId,
          workspaceId: mutation.workspaceId,
        });
    }
  }

  async queryNodeEdges(
    projectId: string,
    nodeId: string,
  ): Promise<{ inbound: readonly UnlockEdge[]; outbound: readonly UnlockEdge[] }> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'NodeEdgesResult' }>>({
        type: 'QueryNodeEdges',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
        nodeId,
      });
      return res.edges;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryNodeEdges(projectId, nodeId);
  }

  async querySubtreeEdges(projectId: string, rootNodeId: string): Promise<readonly UnlockEdge[]> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'SubtreeEdgesResult' }>>({
        type: 'QuerySubtreeEdges',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
        rootNodeId,
      });
      return res.edges;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.querySubtreeEdges(projectId, rootNodeId);
  }

  async queryDismissals(projectId: string): Promise<readonly FindingDismissal[]> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'DismissalsResult' }>>({
        type: 'QueryDismissals',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
      });
      return res.dismissals;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryDismissals(projectId);
  }

  async queryAffectedReasons(projectId: string): Promise<readonly AffectedReason[]> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'AffectedReasonsResult' }>>({
        type: 'QueryAffectedReasons',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
      });
      return res.reasons;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryAffectedReasons(projectId);
  }

  async queryAnalysisSnapshot(projectId: string): Promise<AnalysisSnapshotRequest> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'AnalysisSnapshotResult' }>>({
        type: 'QueryAnalysisSnapshot',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
      });
      return res.snapshot;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryAnalysisSnapshot(projectId);
  }

  async queryViewState(projectId: string, viewId: ViewId): Promise<ViewStateSnapshot> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'ViewStateResult' }>>({
        type: 'QueryViewState',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
        viewId,
      });
      return res.snapshot;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryViewState(projectId, viewId);
  }

  async updateViewState(
    projectId: string,
    viewId: ViewId,
    baseRevision: number,
    patch: ViewStatePatch,
  ): Promise<{ kind: 'Applied'; snapshot: ViewStateSnapshot } | { kind: 'StaleBase'; snapshot: ViewStateSnapshot }> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'UpdateViewStateResult' }>>({
        type: 'UpdateViewState',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
        viewId,
        baseRevision,
        patch,
      });
      return res.outcome;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.updateViewState(projectId, viewId, baseRevision, patch);
  }

  async getStorageStatus(): Promise<{ isOpfs: boolean }> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'StorageStatusResult' }>>({
        type: 'GetStorageStatus',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      this.#isOpfs = res.isOpfs;
      return { isOpfs: this.#isOpfs };
    }

    const mod = await browserModule();
    await mod.initWorkerDatabase();
    this.#isOpfs = mod.getIsOpfs();
    return { isOpfs: this.#isOpfs };
  }

  async queryPortableSnapshot(projectId: string): Promise<PortableProjectSnapshot> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'PortableSnapshotResult' }>>({
        type: 'QueryPortableSnapshot',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        projectId,
      });
      return res.snapshot;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.queryPortableSnapshot(projectId);
  }

  async batchImportPortable(
    snapshot: PortableProjectSnapshot,
    localFileStateJson?: string,
  ): Promise<{ ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string }> {
    if (this.#worker) {
      const requestId = createUuidV7();
      const res = await this.#sendRequest<Extract<WorkerResponse, { type: 'BatchImportResult' }>>({
        type: 'BatchImportPortable',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        snapshot,
        localFileStateJson,
      });
      return res.result;
    }

    // Fallback path
    const mod = await browserModule();
    await mod.initWorkerDatabase();
    return mod.batchImportPortable(snapshot,localFileStateJson);
  }

  async resetDatabase(): Promise<void> {
    if (this.#worker) {
      const requestId = createUuidV7();
      await this.#sendRequest<Extract<WorkerResponse, { type: 'DatabaseReset' }>>({
        type: 'ResetDatabase',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
      });
      return;
    }

    const mod = await browserModule();
    await mod.initWorkerDatabase();
    mod.resetWorkerDatabase();
  }

  get isOpfs(): boolean {
    return this.#isOpfs;
  }

  /**
   * Ask the worker to hand its OPFS sync access handles back, then tear it
   * down. Called as the page unloads so the next page load does not contend
   * with handles this page still owns.
   */
  async releaseStorage(): Promise<void> {
    if (!this.#worker) return;
    try {
      await this.#sendRequest<Extract<WorkerResponse, { type: 'StorageReleased' }>>({
        type: 'ReleaseStorage',
        protocolVersion: PROTOCOL_VERSION,
        requestId: createUuidV7(),
      });
    } catch {
      // The page is unloading; a failed release is no worse than not trying.
    }
    this.terminate();
  }

  terminate(): void {
    this.#worker?.removeEventListener('message', this.#handleMessage);
    this.#worker?.terminate();
    this.#worker = null;
    this.#pendingRequests.clear();
  }
}

export const repositoryWorkerClient = new RepositoryWorkerClient();

// ── Native bridge switch (E9-FR4) ──────────────────────────────────────────
// When built with `vite --mode tauri`, the webview routes every repository
// operation through the narrow typed Tauri command boundary instead of the
// SQLite-WASM worker. The exported function surface stays identical.

declare const __TAURI_NATIVE_BRIDGE__: boolean;

export function isNativeBridge(): boolean {
  try {
    return typeof __TAURI_NATIVE_BRIDGE__ === 'boolean' && __TAURI_NATIVE_BRIDGE__ === true;
  } catch {
    return false;
  }
}

import {
  initNativeBridge,
  resetNativeDatabase,
  applyNativeCommand,
  queryNativeProjects,
  queryNativeProjectNodes,
  queryNativeWorkspaceOverview,
  queryNativeNodeEdges,
  queryNativeSubtreeEdges,
  queryNativeDismissals,
  queryNativeAffectedReasons,
  queryNativeAnalysisSnapshot,
  queryNativeViewState,
  updateNativeViewState,
  getNativeStorageStatus,
  queryNativePortableSnapshot,
  batchImportNativePortable,
  queryNativeWorkspaceRegistry,
  mutateNativeWorkspace,
} from './tauri-repository.client';

export async function initWorkerDatabase(): Promise<{ isOpfs: boolean }> {
  if (isNativeBridge()) {
    return initNativeBridge();
  }
  return repositoryWorkerClient.initWorkerDatabase();
}

export async function resetDatabase(): Promise<void> {
  if (isNativeBridge()) {
    return resetNativeDatabase();
  }
  return repositoryWorkerClient.resetDatabase();
}

/**
 * Release browser storage handles held by this page. No-op on the native
 * bridge, where the Rust side owns the database file's lifetime.
 */
export async function releaseStorage(): Promise<void> {
  if (isNativeBridge()) return;
  return repositoryWorkerClient.releaseStorage();
}

export async function applyProductCommand(command: ProductCommand): Promise<ProductCommandResult> {
  if (isNativeBridge()) {
    return applyNativeCommand(command);
  }
  return repositoryWorkerClient.applyProductCommand(command);
}

export async function applyProductCommandBatch(input: readonly ProductCommand[]): Promise<readonly ProductCommandResult[]> {
  const commands = validateProductCommandBatch(input);
  if (isNativeBridge()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return validateProductCommandBatchResults(commands, await invoke('repository_apply_product_command_batch', { commands }));
  }
  return repositoryWorkerClient.applyProductCommandBatch(commands);
}

/**
 * Apply a command and durably queue its outbox entry in ONE worker transaction
 * (R4/H04). The native (Tauri) path composes its own SyncRepository adapter and
 * must not use this browser-worker function.
 */
export async function readCollaborationOutbox(projectId: string): Promise<OutboxState> {
  if (isNativeBridge()) return readNativeCollaborationOutbox(projectId);
  return repositoryWorkerClient.collaborationOutbox(projectId);
}

export async function installCollaborationSnapshot(projectId: string, envelope: import('../../contracts/collaboration-recovery').RecoveryEnvelope): Promise<Readonly<{ revision: number; recoveryRequired: boolean }>> {
  if (isNativeBridge()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('repository_install_collaboration_snapshot', { projectId, envelope, archivedAtIso: new Date().toISOString() });
  }
  return repositoryWorkerClient.installCollaborationSnapshot(projectId, envelope);
}

/** Drop a project's sync state after the owner stopped sharing. */
export async function forgetCollaborationState(projectId: string): Promise<void> {
  if (isNativeBridge()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('repository_forget_collaboration', { projectId });
    return;
  }
  await repositoryWorkerClient.forgetCollaboration(projectId);
}

/** Confirmed activity history for the current stream epoch (27.8), paged. */
export async function readCollaborationHistory(projectId: string, before: number | null = null, limit = 50): Promise<readonly import('./collaboration-outbox').CollaborationHistoryRow[]> {
  if (isNativeBridge()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('repository_read_collaboration_history', { projectId, before, limit });
  }
  return repositoryWorkerClient.collaborationHistory(projectId, before, limit);
}

export async function discardCollaborationOutboxEntry(projectId: string, commandId: string): Promise<void> {
  if (isNativeBridge()) return discardNativeCollaborationOutboxEntry(projectId, commandId);
  await repositoryWorkerClient.collaborationOutbox(projectId, commandId);
}

export async function applyCommandWithOutbox(
  command: ProductCommand,
  outbox: Readonly<{ commandId: string; commandJson: string; commitAttemptId: number; queuedAtISO: string }>,
  projectId: string,
): Promise<ProductCommandResult> {
  if (isNativeBridge()) {
    return applyNativeCommandWithOutbox(command, outbox, projectId);
  }
  return repositoryWorkerClient.applyCommandWithOutbox(command, outbox, projectId);
}

/** A composite gesture's members + outbox entries in ONE repository transaction. */
export async function applyGroupWithOutbox(projectId: string, members: readonly Readonly<{ command: ProductCommand; commandJson: string; commitAttemptId: number; queuedAtISO: string }>[], groupId: string): Promise<readonly ProductCommandResult[]> {
  if (isNativeBridge()) {
    const { applyNativeGroupWithOutbox } = await import('./tauri-repository.client');
    return applyNativeGroupWithOutbox(projectId, members, groupId);
  }
  return repositoryWorkerClient.applyGroupWithOutbox(projectId, members, groupId);
}

/** One whole rebase in ONE worker transaction (R4/H04). */
export async function applyRebaseAtomic(
  projectId: string,
  remote: Readonly<{ command: ProductCommand; ownEcho: boolean; serverRevision: number; streamEpoch?: number; historyEntry?: import('../../contracts/collaboration-recovery').ConfirmedHistoryEntry }>,
  toReapply: readonly Readonly<{ commandId: string; command: ProductCommand; commitAttemptId: number; queuedAtISO: string; groupId?: string; groupIndex?: number }>[],
  rejected: readonly Readonly<{ commandId: string; reason?: string }>[],
): Promise<ProductCommandResult | null> {
  if (isNativeBridge()) {
    return applyNativeRebaseAtomic(projectId, remote, toReapply, rejected);
  }
  return repositoryWorkerClient.applyRebaseAtomic(projectId, remote, toReapply, rejected);
}

export async function queryProjectNodes(projectId: string): Promise<OutlineReadModel> {
  if (isNativeBridge()) {
    return queryNativeProjectNodes(projectId);
  }
  return repositoryWorkerClient.queryProjectNodes(projectId);
}

export async function queryProjects(): Promise<readonly { id: string; name: string; revision: number }[]> {
  if (isNativeBridge()) {
    return queryNativeProjects();
  }
  return repositoryWorkerClient.queryProjects();
}

export async function queryWorkspaceOverview(): Promise<WorkspaceOverviewProjection> {
  if (isNativeBridge()) {
    return queryNativeWorkspaceOverview();
  }
  return repositoryWorkerClient.queryWorkspaceOverview();
}

// ── Epic 17: workspace registry ──────────────────────────────────────────

export async function queryWorkspaceRegistryForApp(): Promise<WorkspaceRegistry> {
  if (isNativeBridge()) {
    return queryNativeWorkspaceRegistry();
  }
  return repositoryWorkerClient.queryWorkspaceRegistry();
}

export async function mutateWorkspace(
  mutation: Extract<WorkerRequest, { type: 'MutateWorkspace' }>['mutation'],
): Promise<WorkspaceMutationResult> {
  if (isNativeBridge()) {
    return mutateNativeWorkspace(mutation);
  }
  return repositoryWorkerClient.mutateWorkspace(mutation);
}

export async function queryNodeEdges(
  projectId: string,
  nodeId: string,
): Promise<{ inbound: readonly UnlockEdge[]; outbound: readonly UnlockEdge[] }> {
  if (isNativeBridge()) {
    return queryNativeNodeEdges(projectId, nodeId);
  }
  return repositoryWorkerClient.queryNodeEdges(projectId, nodeId);
}

export async function querySubtreeEdges(projectId: string, rootNodeId: string): Promise<readonly UnlockEdge[]> {
  if (isNativeBridge()) {
    return queryNativeSubtreeEdges(projectId, rootNodeId);
  }
  return repositoryWorkerClient.querySubtreeEdges(projectId, rootNodeId);
}

export async function queryDismissals(projectId: string): Promise<readonly FindingDismissal[]> {
  if (isNativeBridge()) {
    return queryNativeDismissals(projectId);
  }
  return repositoryWorkerClient.queryDismissals(projectId);
}

export async function queryAffectedReasons(projectId: string): Promise<readonly AffectedReason[]> {
  if (isNativeBridge()) {
    return queryNativeAffectedReasons(projectId);
  }
  return repositoryWorkerClient.queryAffectedReasons(projectId);
}

export async function queryAnalysisSnapshot(projectId: string): Promise<AnalysisSnapshotRequest> {
  if (isNativeBridge()) {
    return queryNativeAnalysisSnapshot(projectId);
  }
  return repositoryWorkerClient.queryAnalysisSnapshot(projectId);
}

export async function queryViewState(projectId: string, viewId: ViewId): Promise<ViewStateSnapshot> {
  if (isNativeBridge()) {
    return queryNativeViewState(projectId, viewId);
  }
  return repositoryWorkerClient.queryViewState(projectId, viewId);
}

export async function updateViewState(
  projectId: string,
  viewId: ViewId,
  baseRevision: number,
  patch: ViewStatePatch,
): Promise<{ kind: 'Applied'; snapshot: ViewStateSnapshot } | { kind: 'StaleBase'; snapshot: ViewStateSnapshot }> {
  if (isNativeBridge()) {
    return updateNativeViewState(projectId, viewId, baseRevision, patch);
  }
  return repositoryWorkerClient.updateViewState(projectId, viewId, baseRevision, patch);
}

export async function getStorageStatus(): Promise<{ isOpfs: boolean }> {
  if (isNativeBridge()) {
    return getNativeStorageStatus();
  }
  return repositoryWorkerClient.getStorageStatus();
}

export async function queryPortableSnapshot(projectId: string): Promise<PortableProjectSnapshot> {
  if (isNativeBridge()) {
    return queryNativePortableSnapshot(projectId);
  }
  return repositoryWorkerClient.queryPortableSnapshot(projectId);
}

export async function batchImportPortable(
  snapshot: PortableProjectSnapshot,
  localFileStateJson?: string,
): Promise<{ ok: true; projectId: string; revision: number } | { ok: false; code: string; cause?: string }> {
  if (isNativeBridge()) {
    return batchImportNativePortable(snapshot,localFileStateJson);
  }
  return repositoryWorkerClient.batchImportPortable(snapshot,localFileStateJson);
}

export async function readLocalFileState(projectId:string):Promise<string|null>{
 if(isNativeBridge()){const {invoke}=await import('@tauri-apps/api/core');return invoke('repository_local_file_read',{projectId});}
 return await repositoryWorkerClient.localFileOperation({operation:'read',projectId}) as string|null;
}
export async function writeLocalFileState(projectId:string,expectedRevision:number,stateJson:string):Promise<void>{
 if(isNativeBridge()){const {invoke}=await import('@tauri-apps/api/core');return invoke('repository_local_file_write',{projectId,expectedRevision,stateJson});}
 await repositoryWorkerClient.localFileOperation({operation:'write',projectId,expectedRevision,stateJson});
}
export async function applyLocalFileMerge(input:import('./local-file-store').LocalFileMergeInput):Promise<{revision:number}>{
 if(isNativeBridge()){const {invoke}=await import('@tauri-apps/api/core');return invoke('repository_local_file_apply',{input});}
 return await repositoryWorkerClient.localFileOperation({operation:'apply',projectId:input.projectId,input}) as {revision:number};
}
export async function readLocalFileRecovery(projectId:string):Promise<import('./local-file-store').LocalFileRecovery|null>{
 if(isNativeBridge()){const {invoke}=await import('@tauri-apps/api/core');return invoke('repository_local_file_recovery',{projectId});}
 return await repositoryWorkerClient.localFileOperation({operation:'recovery',projectId}) as import('./local-file-store').LocalFileRecovery|null;
}
export async function restoreLocalFileMerge(projectId:string,expectedRevision:number,operationId:string):Promise<{revision:number}>{
 if(isNativeBridge()){const {invoke}=await import('@tauri-apps/api/core');return invoke('repository_local_file_restore',{projectId,expectedRevision,operationId});}
 return await repositoryWorkerClient.localFileOperation({operation:'restore',projectId,expectedRevision,operationId}) as {revision:number};
}

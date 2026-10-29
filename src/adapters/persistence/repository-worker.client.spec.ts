import { describe, expect, it, vi } from 'vitest';
import { RepositoryWorkerClient } from './repository-worker.client';
import { PROTOCOL_VERSION, createUuidV7 } from '../../../spikes/phase-0-durability/src/command-receipt';
import { createCreateProjectCommand } from '../../contracts/repository-commands';
import { createCreateProjectCommand as createDomainCreateProject } from '../../domain/project/create-project.command';
import type { WorkerRequest, WorkerResponse } from './repository.worker';

describe('RepositoryWorkerClient', () => {
  describe('In-process fallback path (Worker unavailable)', () => {
    it('initializes database and queries projects successfully', async () => {
      const client = new RepositoryWorkerClient(null);

      const status = await client.initWorkerDatabase();
      expect(status).toHaveProperty('isOpfs');

      const projId = createUuidV7();
      const createCmd = createCreateProjectCommand(
        createDomainCreateProject({
          commandId: createUuidV7(),
          projectId: projId,
          name: 'Fallback Project',
        }),
      );

      const applied = await client.applyProductCommand(createCmd);
      expect(applied.type).toBe('ProductCommandApplied');

      const projects = await client.queryProjects();
      expect(projects.some((p) => p.id === projId)).toBe(true);

      const outline = await client.queryProjectNodes(projId);
      expect(outline.projectId).toBe(projId);

      const overview = await client.queryWorkspaceOverview();
      expect(overview.projects.some((p) => p.projectId === projId)).toBe(true);

      const viewState = await client.queryViewState(projId, 'outline');
      expect(viewState.projectId).toBe(projId);

      const updateRes = await client.updateViewState(projId, 'outline', viewState.viewStateRevision, {
        collapsedNodeIds: ['node-1'],
      });
      expect(updateRes.kind).toBe('Applied');

      client.terminate();
    });
  });

  describe('Web Worker message protocol path', () => {
    class MockWorker implements Worker {
      onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
      onmessageerror: ((this: Worker, ev: MessageEvent) => any) | null = null;
      onerror: ((this: AbstractWorker, ev: ErrorEvent) => any) | null = null;
      listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
      postedMessages: WorkerRequest[] = [];

      addEventListener(type: string, listener: any): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }

      removeEventListener(type: string, listener: any): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
          type,
          list.filter((l) => l !== listener),
        );
      }

      dispatchEvent(_event: Event): boolean {
        return true;
      }

      postMessage(message: any): void {
        this.postedMessages.push(message);
      }

      terminate(): void {
        this.listeners.clear();
      }

      simulateMessage(data: WorkerResponse): void {
        const event = { data } as MessageEvent;
        for (const listener of this.listeners.get('message') ?? []) {
          listener(event);
        }
      }
    }

    it('correlates requestId to the matching pending promise across concurrent requests', async () => {
      const mockWorker = new MockWorker();
      const client = new RepositoryWorkerClient(mockWorker as unknown as Worker);

      // Issue two concurrent queries
      const promise1 = client.queryProjects();
      const promise2 = client.queryWorkspaceOverview();

      expect(mockWorker.postedMessages.length).toBe(2);
      const req1 = mockWorker.postedMessages[0];
      const req2 = mockWorker.postedMessages[1];

      expect(req1.type).toBe('QueryProjects');
      expect(req2.type).toBe('QueryWorkspaceOverview');

      // Respond out of order (req2 first, then req1)
      mockWorker.simulateMessage({
        type: 'WorkspaceOverviewResult',
        protocolVersion: PROTOCOL_VERSION,
        requestId: req2.requestId,
        overview: {
          revisionVector: [],
          projects: [],
          limitWarning: null,
        },
      });

      mockWorker.simulateMessage({
        type: 'ProjectsResult',
        protocolVersion: PROTOCOL_VERSION,
        requestId: req1.requestId,
        projects: [{ id: 'p1', name: 'Project One', revision: 1 }],
      });

      const [res1, res2] = await Promise.all([promise1, promise2]);

      expect(res1).toEqual([{ id: 'p1', name: 'Project One', revision: 1 }]);
      expect(res2.projects).toEqual([]);

      client.terminate();
    });

    it('rejects the matching promise when WorkerError is returned', async () => {
      const mockWorker = new MockWorker();
      const client = new RepositoryWorkerClient(mockWorker as unknown as Worker);

      const promise = client.queryProjectNodes('missing-project');
      const req = mockWorker.postedMessages[0];

      mockWorker.simulateMessage({
        type: 'WorkerError',
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        error: 'DATABASE_LOCKED',
      });

      await expect(promise).rejects.toThrow('DATABASE_LOCKED');
      client.terminate();
    });

    it('handles initWorkerDatabase and records isOpfs status', async () => {
      const mockWorker = new MockWorker();
      const client = new RepositoryWorkerClient(mockWorker as unknown as Worker);

      const initPromise = client.initWorkerDatabase();
      const req = mockWorker.postedMessages[0];
      expect(req.type).toBe('Initialize');

      mockWorker.simulateMessage({
        type: 'WorkerReady',
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        isOpfs: true,
      });

      const status = await initPromise;
      expect(status.isOpfs).toBe(true);
      expect(client.isOpfs).toBe(true);

      client.terminate();
    });
  });
});

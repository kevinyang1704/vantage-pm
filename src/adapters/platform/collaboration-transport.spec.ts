import { boundHistoryFixture } from '../../application/collaboration/recovery-fixtures.test-only';
import { describe, expect, it, vi } from 'vitest';
import { CollaborationTransport, type WebSocketLike } from './collaboration-transport';
import { PROTOCOL_VERSION } from '../../../spikes/phase-0-durability/src/command-receipt';
import type { ProductCommand } from '../../contracts/repository-commands';

const P = '019fef00-0000-7000-8000-000000000001';

function command(): ProductCommand {
  return { type: 'SetNodeTitle', protocolVersion: PROTOCOL_VERSION, commandId: '019fef00-0000-7000-8000-000000000003', projectId: P, baseRevision: 0, expectedRevision: 1, nodeId: '019fef00-0000-7000-8000-000000000002', title: 'X' } as ProductCommand;
}

const bearerAuth = { deviceId: 'dev-1', bearer: 'sekret', proof: null };

describe('CollaborationTransport (Story 27.7)', () => {
  it('submits a command with the bearer headers and reads the assigned revision', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ streamEpoch: 1, revision: 7, result: { type: 'ProductCommandApplied' } }), { status: 200 }),
    );
    const transport = new CollaborationTransport('http://server', {
      fetch: fetchImpl as unknown as typeof fetch,
      openSocket: () => { throw new Error('unused'); },
    });
    const outcome = await transport.submit(P, command(), bearerAuth, 1);
    expect(outcome).toEqual({ streamEpoch: 1, revision: 7, accepted: true, applied: true, result: { type: 'ProductCommandApplied' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/projects/');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-pmapp-device']).toBe('dev-1');
    expect(headers['x-pmapp-bearer']).toBe('sekret');
    expect(String(init.body)).toContain('"command"');
  });

  it('sends the browser proof headers when bearer is null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ streamEpoch: 1, revision: 1, result: { type: 'ProductCommandApplied' } }), { status: 200 }));
    const transport = new CollaborationTransport('http://server', {
      fetch: fetchImpl as unknown as typeof fetch,
      openSocket: () => { throw new Error('unused'); },
    });
    await transport.submit(P, command(), { deviceId: 'dev-2', bearer: null, proof: { nonce: 'n', timestamp: 't', signature: 's' } }, 1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-pmapp-nonce']).toBe('n');
    expect(headers['x-pmapp-signature']).toBe('s');
    expect(headers['x-pmapp-bearer']).toBeUndefined();
  });

  it('a domain rejection is not treated as applied', async () => {
    const transport = new CollaborationTransport('http://server', {
      fetch: (async () =>
        new Response(JSON.stringify({ streamEpoch: 1, revision: 3, result: { type: 'ProductCommandRejected' } }), { status: 200 })) as unknown as typeof fetch,
      openSocket: () => { throw new Error('unused'); },
    });
    const outcome = await transport.submit(P, command(), bearerAuth, 1);
    expect(outcome.accepted).toBe(true);
    expect(outcome.applied).toBe(false);
  });

  it('a non-ok response is not accepted', async () => {
    const transport = new CollaborationTransport('http://server', {
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      openSocket: () => { throw new Error('unused'); },
    });
    expect((await transport.submit(P, command(), bearerAuth, 1)).accepted).toBe(false);
  });

  it('opens the stream with device+bearer query and delivers validated epoch-bound Command frames', async () => {
    let socket!: WebSocketLike;
    const frames: number[] = [];
    let resynced = false;
    const transport = new CollaborationTransport('http://server', {
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      openSocket: (url) => {
        expect(url).toContain('/projects/' + P + '/stream?');
        expect(url).toContain('since=3');
        expect(url).toContain('device_id=dev-1');
        expect(url).toContain('bearer=sekret');
        socket = { send: () => {}, close: () => {}, onmessage: null, onclose: null, onerror: null };
        return socket;
      },
    });
    transport.openStream(P, 3, bearerAuth, (f) => frames.push(f.serverRevision), () => {}, () => { resynced = true; });
    socket.onmessage!({ data: JSON.stringify({ type: 'Snapshot', envelope: {} }) });
    await vi.waitFor(() => expect(resynced).toBe(true));
    socket.onmessage!({ data: JSON.stringify({ type: 'Command', streamEpoch: 1, serverRevision: 4, command: command(), historyEntry: await boundHistoryFixture(command(),4), appliedCommandIds: [command().commandId] }) });
    socket.onmessage!({ data: 'not json' });
    await vi.waitFor(() => expect(frames).toEqual([4]));
  });
});

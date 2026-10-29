import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
  pending: null as string | null,
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    state.handler = handler;
    return state.unlisten;
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command !== 'app_take_pending_link') throw new Error(command);
    const link = state.pending;
    state.pending = null;
    return link;
  }),
}));

import { subscribeVantageLinks } from './vantage-link';

describe('vantage:// links (Story 28.2)', () => {
  beforeEach(() => { state.handler = null; state.pending = null; state.unlisten.mockClear(); });

  it('delivers the link that started the app, once', async () => {
    state.pending = 'vantage://join?p=1';
    const links: string[] = [];
    await subscribeVantageLinks((l) => links.push(l));
    expect(links).toEqual(['vantage://join?p=1']);
  });

  it('delivers later links from the native event and ignores malformed payloads', async () => {
    const links: string[] = [];
    const off = await subscribeVantageLinks((l) => links.push(l));
    state.handler?.({ payload: { link: 'vantage://recover?p=2' } });
    state.handler?.({ payload: { nope: true } });
    state.handler?.({ payload: null });
    expect(links).toEqual(['vantage://recover?p=2']);
    off();
    expect(state.unlisten).toHaveBeenCalledOnce();
  });
});

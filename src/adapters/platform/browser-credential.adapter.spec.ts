import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCredentialPort, generateBrowserCredential } from './browser-credential.adapter';

function indexedDbEvents(result: unknown = undefined) {
  const request = {
    result, error: null as DOMException | null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  };
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onerror: null as (() => void) | null,
    objectStore: () => ({ get: () => request, put: () => request, delete: () => request }),
  };
  const close = vi.fn();
  const db = { transaction: () => transaction, close };
  const open = { result: db, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
  vi.stubGlobal('indexedDB', { open: () => open });
  return { request, transaction, open, close };
}

afterEach(() => vi.unstubAllGlobals());

describe('browser credential transaction acknowledgement', () => {
  for (const action of ['store', 'remove'] as const) {
    it(`${action} stays pending after request success and rejects a later abort`, async () => {
      const credential = await generateBrowserCredential();
      const events = indexedDbEvents();
      const port = createBrowserCredentialPort();
      const operation = action === 'store' ? port.store('actor', credential) : port.remove('actor');
      let settled = false;
      void operation.then(() => { settled = true; }, () => { settled = true; });
      events.open.onsuccess?.();
      await Promise.resolve();
      events.request.onsuccess?.();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(events.close).not.toHaveBeenCalled();
      const refused = expect(operation).rejects.toThrow('CREDENTIAL_TRANSACTION_ABORTED');
      events.transaction.onabort?.();
      await refused;
      expect(events.close).toHaveBeenCalledOnce();
    });
  }

  it('acknowledges storage only on completion', async () => {
    const credential = await generateBrowserCredential();
    const events = indexedDbEvents();
    const operation = createBrowserCredentialPort().store('actor', credential);
    events.open.onsuccess?.();
    await Promise.resolve();
    events.transaction.oncomplete?.();
    await operation;
    expect(events.close).toHaveBeenCalledOnce();
  });

  it('returns a loaded credential or null only after the read transaction completes', async () => {
    const credential = await generateBrowserCredential();
    for (const record of [credential, undefined]) {
      const events = indexedDbEvents(record);
      const operation = createBrowserCredentialPort().load('actor');
      events.open.onsuccess?.();
      await Promise.resolve();
      events.transaction.oncomplete?.();
      await expect(operation).resolves.toBe(record ?? null);
      expect(events.close).toHaveBeenCalledOnce();
    }
  });

  it('preserves a transaction error and closes the connection', async () => {
    const events = indexedDbEvents();
    const operation = createBrowserCredentialPort().remove('actor');
    events.open.onsuccess?.();
    await Promise.resolve();
    events.transaction.error = new DOMException('Synthetic quota refusal', 'QuotaExceededError');
    const refused = expect(operation).rejects.toBe(events.transaction.error);
    events.transaction.onerror?.();
    await refused;
    expect(events.close).toHaveBeenCalledOnce();
  });

  it('rejects a failed read request and closes its connection', async () => {
    const events = indexedDbEvents();
    const operation = createBrowserCredentialPort().load('actor');
    events.open.onsuccess?.();
    await Promise.resolve();
    events.request.error = new DOMException('Synthetic request refusal', 'UnknownError');
    const refused = expect(operation).rejects.toBe(events.request.error);
    events.request.onerror?.();
    await refused;
    expect(events.close).toHaveBeenCalledOnce();
  });
});

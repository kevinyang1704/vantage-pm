import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './copy-text';

function stubDocument(execResult: boolean | Error) {
  const area = { value: '', style: {} as Record<string, string>, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
  const exec = vi.fn(() => { if (execResult instanceof Error) throw execResult; return execResult; });
  vi.stubGlobal('document', { createElement: () => area, body: { appendChild: vi.fn() }, execCommand: exec });
  return { area, exec };
}

describe('copyText', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports success from the Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyText('link')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('link');
  });

  it('falls back to the copy command when the Clipboard API is refused', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
    const { area, exec } = stubDocument(true);
    await expect(copyText('link')).resolves.toBe(true);
    expect(area.value).toBe('link');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(area.remove).toHaveBeenCalled();
  });

  it('reports failure instead of claiming a copy that did not happen', async () => {
    vi.stubGlobal('navigator', {});
    stubDocument(false);
    await expect(copyText('link')).resolves.toBe(false);
    stubDocument(new Error('unsupported'));
    await expect(copyText('link')).resolves.toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectSaveStrategy, saveViaTauriDialog, saveGeneratedFile } from './save-generated-file';

describe('selectSaveStrategy (Story 8.5 & Epic 12 Story 12.1)', () => {
  it('selects TauriSaveDialog when Tauri native bridge is present', () => {
    expect(selectSaveStrategy({ hasTauriBridge: true, hasShowSaveFilePicker: false, hasBlobDownload: false })).toBe('TauriSaveDialog');
    expect(selectSaveStrategy({ hasTauriBridge: true, hasShowSaveFilePicker: true, hasBlobDownload: true })).toBe('TauriSaveDialog');
  });

  it('prefers File System Access when available in browser mode', () => {
    expect(selectSaveStrategy({ hasShowSaveFilePicker: true, hasBlobDownload: true })).toBe('FileSystemAccess');
    expect(selectSaveStrategy({ hasShowSaveFilePicker: true, hasBlobDownload: false })).toBe('FileSystemAccess');
  });

  it('falls back to download when File System Access is absent in browser mode', () => {
    expect(selectSaveStrategy({ hasShowSaveFilePicker: false, hasBlobDownload: true })).toBe('DownloadFallback');
  });

  it('is Unsupported when neither capability is present', () => {
    expect(selectSaveStrategy({ hasShowSaveFilePicker: false, hasBlobDownload: false })).toBe('Unsupported');
  });
});

describe('saveViaTauriDialog (Epic 12 Story 12.1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('saves bytes through Tauri native save dialog and invoke command on success', async () => {
    const mockSave = vi.fn().mockResolvedValue('C:\\Exports\\project.pptx');
    const mockInvoke = vi.fn().mockResolvedValue({ saved: true, path: 'C:\\Exports\\project.pptx', bytesWritten: 12 });

    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      save: mockSave,
    }));
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: mockInvoke,
    }));

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await saveViaTauriDialog(bytes, 'project.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toBe('project.pptx');
      expect(result.savedVia).toBe('TauriSaveDialog');
    }
    expect(mockSave).toHaveBeenCalledWith({
      defaultPath: 'project.pptx',
      filters: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }],
    });
    expect(mockInvoke).toHaveBeenCalledWith('save_office_export', {
      path: 'C:\\Exports\\project.pptx',
      bytes: [1, 2, 3, 4],
    });
  });

  it('returns SelectionCancelled when user closes save dialog without choosing a path', async () => {
    const mockSave = vi.fn().mockResolvedValue(null);
    const mockInvoke = vi.fn();

    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      save: mockSave,
    }));
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: mockInvoke,
    }));

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await saveViaTauriDialog(bytes, 'project.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('SelectionCancelled');
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('returns PublicationFailed when native invoke fails during write', async () => {
    const mockSave = vi.fn().mockResolvedValue('C:\\Exports\\project.docx');
    const mockInvoke = vi.fn().mockRejectedValue(new Error('Permission denied writing file'));

    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      save: mockSave,
    }));
    vi.doMock('@tauri-apps/api/core', () => ({
      invoke: mockInvoke,
    }));

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await saveViaTauriDialog(bytes, 'project.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('PublicationFailed');
      if (result.failure.kind === 'PublicationFailed') {
        expect(result.failure.detail).toContain('Permission denied');
      }
    }
  });
});


/**
 * Browser file-save adapter (Story 8.5 Task 3, AD-14, AD-15).
 *
 * The first working disk-write path in this codebase. Splits into a pure
 * `selectSaveStrategy` (unit-testable without a browser) and an async
 * `saveGeneratedFile` I/O boundary (AD-1), mirroring the existing
 * `storage-health.ts` pure-selector / I/O-boundary convention.
 *
 * "No partial file" is guaranteed by construction:
 *  (a) this adapter calls the browser's write-completion step (writable.close()
 *      for File System Access, the <a> click for the download fallback) exactly
 *      once, only after the complete byte buffer already exists synchronously
 *      in memory — there is no streaming/chunked write path in this codebase
 *      for exports, so "incomplete bytes reach the disk" cannot happen from
 *      this adapter's own logic.
 *  (b) as defense in depth, File System Access API's createWritable() writes to
 *      a swap/temp file under the hood and only replaces the target file's
 *      contents atomically on a successful close() — an error or abandoned
 *      handle before close() leaves the original target file (if any existed)
 *      untouched, a platform guarantee relied on but not implemented here.
 *      For the <a download> path, a single synchronous Blob built from a
 *      complete Uint8Array handed to native download machinery does not produce
 *      partial files in current browsers (no async/streaming step this code
 *      controls).
 */

import type { PublishResult, SavedVia, ExportFailure } from '../../contracts/export-publish';
import { isNativeBridge } from '../persistence/repository-worker.client';

/** Minimal File System Access API surface used by this adapter (AD-14). */
interface FileSystemWritableFileStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface WindowWithSaveFilePicker extends Window {
  showSaveFilePicker(options: {
    suggestedName: string;
    types: readonly { description: string; accept: Readonly<Record<string, readonly string[]>> }[];
  }): Promise<FileSystemFileHandle>;
}

export type SaveStrategy = 'TauriSaveDialog' | 'FileSystemAccess' | 'DownloadFallback' | 'Unsupported';

export interface SaveCapabilitySignals {
  readonly hasTauriBridge?: boolean;
  readonly hasShowSaveFilePicker: boolean;
  readonly hasBlobDownload: boolean; // Blob + document.createElement('a') + URL.createObjectURL
}

/** Pure strategy selection — unit-testable without a real browser (AD-1, E12-AR3). */
export function selectSaveStrategy(signals: SaveCapabilitySignals): SaveStrategy {
  if (signals.hasTauriBridge) return 'TauriSaveDialog';
  if (signals.hasShowSaveFilePicker) return 'FileSystemAccess';
  if (signals.hasBlobDownload) return 'DownloadFallback';
  return 'Unsupported';
}

/** Known artifact MIME types for the picker's accept filter. */
export const EXPORT_MIME_TYPES: Readonly<Record<'pptx' | 'docx' | 'json', string>> = Object.freeze({
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
});

export const EXPORT_EXTENSIONS: Readonly<Record<'pptx' | 'docx' | 'json', string>> = Object.freeze({
  pptx: '.pptx',
  docx: '.docx',
  json: '.json',
});

function toPublishOk(filename: string, savedVia: SavedVia): PublishResult {
  return Object.freeze({ ok: true, filename, savedVia });
}

function toPublishFailure(failure: ExportFailure): PublishResult {
  return Object.freeze({ ok: false, failure });
}

export async function saveGeneratedFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<PublishResult> {
  const hasTauriBridge = isNativeBridge();
  const hasShowSaveFilePicker = typeof window !== 'undefined' && 'showSaveFilePicker' in window;
  const hasBlobDownload = typeof window !== 'undefined' && typeof document !== 'undefined' && typeof URL !== 'undefined' && 'createObjectURL' in URL && !!document.createElement;

  const strategy = selectSaveStrategy({ hasTauriBridge, hasShowSaveFilePicker, hasBlobDownload });

  if (strategy === 'Unsupported') {
    return toPublishFailure({ kind: 'PublicationFailed', detail: 'No supported file-save mechanism is available in this browser.' });
  }

  if (strategy === 'TauriSaveDialog') {
    return saveViaTauriDialog(bytes, filename, mimeType);
  }

  if (strategy === 'FileSystemAccess') {
    return saveViaFileSystemAccess(bytes, filename, mimeType);
  }

  return saveViaDownloadFallback(bytes, filename, mimeType);
}

export async function saveViaTauriDialog(
  bytes: Uint8Array,
  filename: string,
  _mimeType: string,
): Promise<PublishResult> {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');

    const isPortableProject = filename.toLowerCase().endsWith('.pmapp.json');
    const ext = filename.includes('.') ? filename.split('.').pop() || '' : '';

    let filterName = 'Vantage Export';
    if (ext === 'docx') filterName = 'Word Document';
    else if (ext === 'pptx') filterName = 'PowerPoint Presentation';

    const selectedPath = await save({
      defaultPath: filename,
      filters: isPortableProject
        ? [{ name: 'Vantage Portable Project', extensions: ['pmapp.json'] }]
        : ext
          ? [{ name: filterName, extensions: [ext] }]
          : undefined,
    });

    if (!selectedPath) {
      return toPublishFailure({ kind: 'SelectionCancelled' });
    }

    // Route portable project files through the dedicated command (E13-FR6);
    // Office artifacts keep the existing command.
    const command = isPortableProject ? 'save_portable_project' : 'save_office_export';
    await invoke(command, {
      path: selectedPath,
      bytes: Array.from(bytes),
    });

    return toPublishOk(filename, 'TauriSaveDialog');
  } catch (err) {
    return toPublishFailure({
      kind: 'PublicationFailed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function saveViaFileSystemAccess(bytes: Uint8Array, filename: string, mimeType: string): Promise<PublishResult> {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  const extRaw = filename.includes('.') ? filename.split('.').pop() || '' : '';

  let filterName = 'Vantage Export';
  if (extRaw === 'docx') filterName = 'Word Document';
  else if (extRaw === 'pptx') filterName = 'PowerPoint Presentation';

  try {
    const picker = window as unknown as WindowWithSaveFilePicker;
    const handle = await picker.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: filterName, accept: { [mimeType]: [ext] } }],
    });
    const writable = await handle.createWritable();
    // Single write of the complete buffer, then close — the only completion step.
    await writable.write(bytes);
    await writable.close();
    return toPublishOk(filename, 'FileSystemAccess');
  } catch (err) {
    if (isAbortError(err)) {
      return toPublishFailure({ kind: 'SelectionCancelled' });
    }
    return toPublishFailure({
      kind: 'PublicationFailed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'AbortError' || err.code === DOMException.ABORT_ERR)
  );
}

async function saveViaDownloadFallback(bytes: Uint8Array, filename: string, mimeType: string): Promise<PublishResult> {
  // Blob built only once the full buffer is in hand (never partial).
  const blob = new Blob([bytes.slice()], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return toPublishOk(filename, 'DownloadFallback');
  } catch (err) {
    return toPublishFailure({
      kind: 'PublicationFailed',
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

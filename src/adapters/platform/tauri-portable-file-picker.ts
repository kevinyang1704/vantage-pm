/**
 * Tauri portable-file picker adapter (Epic 15 side-nav hierarchy).
 *
 * Implements `PortableFilePickerPort` over the narrow native surface:
 * `plugin-dialog` `open` for picking and `repository_read_import_candidate`
 * for reading (E9-NFR8: no broad fs). The Tauri modules are dynamic imports
 * so the browser composition never statically depends on the native bridge
 * (same pattern as save-generated-file.ts).
 *
 * The composition root gates availability with `isNativeBridge()` — the
 * side-nav Import action renders only when the picker is available.
 */

import type { PortableFilePickerPort } from '../../application/portable-file/pick-and-import-portable';

export const tauriPortableFilePicker: PortableFilePickerPort = Object.freeze({
  async openFilePicker(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Vantage Portable Project', extensions: ['pmapp', 'json'] }],
    });
    return typeof selected === 'string' ? selected : null;
  },

  async readFile(path: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('repository_read_import_candidate', { path });
  },
});

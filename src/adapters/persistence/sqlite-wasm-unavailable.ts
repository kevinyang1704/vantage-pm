/**
 * Browser-only SQLite-WASM stub (E9-NFR8).
 *
 * In the Tauri desktop composition the native Rust SQLite runtime owns all
 * persistence; the SQLite-WASM module must NEVER be bundled into the desktop
 * shell. This stub replaces `@sqlite.org/sqlite-wasm` in `tauri` build modes.
 * Any attempt to load it is a composition error.
 */

const unavailable = (): never => {
  throw new Error(
    'SQLite-WASM is not available in the native desktop composition. ' +
      'The webview must route persistence through the Tauri repository commands.',
  );
};

export default unavailable;

export const installOpfsSAHPoolVfs = undefined;

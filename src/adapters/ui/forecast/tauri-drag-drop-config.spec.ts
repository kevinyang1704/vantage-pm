/**
 * tauri-drag-drop-config.spec.ts — guards the desktop window config that
 * the Forecast view's HTML5 drag-and-drop depends on.
 *
 * Tauri v2 defaults `dragDropEnabled` to true, which on Windows lets
 * WebView2 capture drags for OS file drops: `dragover`/`drop` never reach
 * the page, so Priority reorder and Backlog → Priority drags silently do
 * nothing. The e2e suite dispatches synthetic drag events and cannot see
 * this, so the config itself is asserted here.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('Tauri window drag-and-drop config', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as { app: { windows: { dragDropEnabled?: boolean }[] } };

  it('disables native file-drop handling on every window so HTML5 DnD reaches the webview', () => {
    expect(config.app.windows.length).toBeGreaterThan(0);
    for (const window of config.app.windows) {
      expect(window.dragDropEnabled).toBe(false);
    }
  });
});

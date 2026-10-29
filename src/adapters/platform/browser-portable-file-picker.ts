/**
 * Browser portable-file picker adapter.
 *
 * Implements `PortableFilePickerPort` for the web build with a hidden
 * `<input type="file">`, so the side-nav Import action works in the browser
 * as it does on desktop (moving a project between devices). The chosen
 * `File` stays in memory, keyed by an opaque token, until the shared
 * pick-and-import flow reads it; nothing leaves the device. Validation and
 * the atomic import are the same single path as the native composition
 * (pick-and-import-portable.ts).
 */

import type { PortableFilePickerPort } from '../../application/portable-file/pick-and-import-portable';

/** The slice of `Document` the picker needs (injectable for tests). */
export interface PickerDocument {
  createElement(tagName: 'input'): HTMLInputElement;
  readonly body: Pick<HTMLElement, 'appendChild'>;
}

/** Accepts `.pmapp.json` exports (and older `.pmapp` / plain `.json`). */
export const PORTABLE_FILE_ACCEPT = '.json,.pmapp,application/json';

export function createBrowserPortableFilePicker(doc: PickerDocument): PortableFilePickerPort {
  const chosen = new Map<string, File>();
  let sequence = 0;

  return Object.freeze({
    openFilePicker(): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = PORTABLE_FILE_ACCEPT;
        input.multiple = false;
        input.hidden = true;
        let settled = false;
        const finish = (token: string | null): void => {
          if (settled) return;
          settled = true;
          input.remove();
          resolve(token);
        };
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) {
            finish(null);
            return;
          }
          sequence += 1;
          const token = `browser-file:${sequence}:${file.name}`;
          chosen.set(token, file);
          finish(token);
        });
        // Fired when the user dismisses the dialog without choosing a file.
        input.addEventListener('cancel', () => finish(null));
        doc.body.appendChild(input);
        input.click();
      });
    },

    async readFile(token: string): Promise<string> {
      const file = chosen.get(token);
      if (!file) throw new Error('The selected file is no longer available. Choose it again.');
      chosen.delete(token);
      return file.text();
    },
  });
}

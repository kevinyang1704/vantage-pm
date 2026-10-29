import { describe, expect, it } from 'vitest';
import { createBrowserPortableFilePicker, PORTABLE_FILE_ACCEPT, type PickerDocument } from './browser-portable-file-picker';

type Listener = () => void;

/** A minimal stand-in for <input type="file"> whose click() runs a scripted user action. */
function fakeDocument(onClick: (input: FakeInput) => void): { doc: PickerDocument; inputs: FakeInput[] } {
  const inputs: FakeInput[] = [];
  const doc = {
    createElement: () => {
      const input = new FakeInput(onClick);
      inputs.push(input);
      return input as unknown as HTMLInputElement;
    },
    body: { appendChild: (node: unknown) => node },
  } as unknown as PickerDocument;
  return { doc, inputs };
}

class FakeInput {
  type = '';
  accept = '';
  multiple = true;
  hidden = false;
  files: File[] | null = null;
  removed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(private readonly onClick: (input: FakeInput) => void) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click(): void {
    this.onClick(this);
  }
  remove(): void {
    this.removed = true;
  }
}

describe('createBrowserPortableFilePicker', () => {
  it('returns a token for the chosen file and reads its contents once', async () => {
    const file = new File(['{"schemaVersion":1}'], 'Roadmap.pmapp.json', { type: 'application/json' });
    const { doc, inputs } = fakeDocument((input) => {
      input.files = [file];
      input.emit('change');
    });
    const picker = createBrowserPortableFilePicker(doc);

    const token = await picker.openFilePicker();
    expect(token).toMatch(/Roadmap\.pmapp\.json$/);
    expect(inputs[0]).toMatchObject({ type: 'file', accept: PORTABLE_FILE_ACCEPT, multiple: false, hidden: true, removed: true });
    await expect(picker.readFile(token as string)).resolves.toBe('{"schemaVersion":1}');
    await expect(picker.readFile(token as string)).rejects.toThrow(/no longer available/);
  });

  it('resolves null when the dialog is cancelled', async () => {
    const { doc, inputs } = fakeDocument((input) => input.emit('cancel'));
    await expect(createBrowserPortableFilePicker(doc).openFilePicker()).resolves.toBeNull();
    expect(inputs[0].removed).toBe(true);
  });

  it('resolves null when the change event carries no file', async () => {
    const { doc } = fakeDocument((input) => {
      input.files = [];
      input.emit('change');
    });
    await expect(createBrowserPortableFilePicker(doc).openFilePicker()).resolves.toBeNull();
  });

  it('settles only once even if cancel follows change', async () => {
    const file = new File(['{}'], 'a.json');
    const { doc } = fakeDocument((input) => {
      input.files = [file];
      input.emit('change');
      input.emit('cancel');
    });
    await expect(createBrowserPortableFilePicker(doc).openFilePicker()).resolves.toMatch(/a\.json$/);
  });
});

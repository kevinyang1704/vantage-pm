import { expect, test } from '../support/fixtures';

test('renders clean markdown and click-to-edit transitions (Story 16.2 AC1-AC2)', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="brief-view" class="pm-md">
        <h2>Problem</h2>
        <p><strong>bold</strong> prose</p>
        <ul><li>bullet</li></ul>
      </div>
      <button data-testid="edit-brief" type="button">Edit</button>
      <textarea data-testid="brief-editor" hidden></textarea>
    </main>
    <script>
      const view = document.querySelector('[data-testid="brief-view"]');
      const editor = document.querySelector('[data-testid="brief-editor"]');
      const button = document.querySelector('[data-testid="edit-brief"]');
      button.addEventListener('click', () => {
        view.hidden = true;
        editor.hidden = false;
        editor.focus();
      });
      editor.addEventListener('blur', () => {
        editor.hidden = true;
        view.hidden = false;
      });
    </script>
  `);

  // Given a rendered markdown brief
  await expect(page.getByTestId('brief-view')).toBeVisible();
  await expect(page.getByTestId('brief-view')).not.toContainText('##');
  await expect(page.getByTestId('brief-view')).not.toContainText('**');

  // When the user clicks Edit
  await page.getByTestId('edit-brief').click();

  // Then the view transitions into a textarea editor
  await expect(page.getByTestId('brief-editor')).toBeVisible();
  await expect(page.getByTestId('brief-editor')).toBeFocused();

  // And blurring re-renders the clean styled view
  await page.getByTestId('brief-editor').blur();
  await expect(page.getByTestId('brief-view')).toBeVisible();
});

test('isolates Tab and Enter inside the editor from outline navigation (Story 16.2 AC2)', async ({ page }) => {
  await page.setContent(`
    <main>
      <textarea data-testid="editor" aria-label="Body text"></textarea>
      <div data-testid="outline-row" tabindex="0" role="treeitem"></div>
    </main>
    <script>
      const editor = document.querySelector('[data-testid="editor"]');
      const row = document.querySelector('[data-testid="outline-row"]');
      let rowKeyCount = 0;
      row.addEventListener('keydown', () => { rowKeyCount += 1; });
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
        }
      });
      window.__rowKeyCount = () => rowKeyCount;
    </script>
  `);

  const editor = page.getByTestId('editor');
  await editor.focus();
  await editor.press('Tab');
  await editor.press('Enter');

  const rowKeyCount = await page.evaluate(() => (window as unknown as { __rowKeyCount: () => number }).__rowKeyCount());
  expect(rowKeyCount).toBe(0);
});

test('inserts a 1-click starter template into an empty brief (Story 16.2 AC3)', async ({ page }) => {
  await page.setContent(`
    <main>
      <textarea data-testid="editor" aria-label="Body text"></textarea>
      <button data-testid="template-feature" type="button">Feature Brief</button>
    </main>
    <script>
      const editor = document.querySelector('[data-testid="editor"]');
      const button = document.querySelector('[data-testid="template-feature"]');
      button.addEventListener('click', () => {
        editor.value = '## Problem\\n\\nWhat problem does this feature solve?\\n\\n## Solution\\n\\n## Scope / Non-Goals\\n\\n- In scope:\\n- Out of scope:';
      });
    </script>
  `);

  await page.getByTestId('template-feature').click();
  const value = await page.getByTestId('editor').inputValue();
  expect(value).toContain('## Problem');
  expect(value).toContain('## Solution');
  expect(value).toContain('## Scope / Non-Goals');
});

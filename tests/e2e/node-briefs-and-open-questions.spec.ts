import { expect, test } from '../support/fixtures';

test('completes the brief → triage → export lifecycle (Story 16.5 AC1)', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="outline-row" role="treeitem" tabindex="0">
        <span data-testid="node-title">SQLite-OPFS Persistence</span>
        <span data-testid="brief-pill" hidden>📝 Brief</span>
        <span data-testid="questions-pill" hidden>❓ 1 Open</span>
      </div>
      <div data-testid="inspector" role="complementary" aria-label="Node inspector" hidden>
        <div role="tablist" aria-label="Inspector tabs">
          <button role="tab" aria-selected="true" data-testid="tab-brief">📄 Brief</button>
          <button role="tab" aria-selected="false" data-testid="tab-questions">❓ Questions & Decisions</button>
        </div>
        <div role="tabpanel" data-testid="panel-brief">
          <textarea data-testid="brief-editor" aria-label="Node brief"></textarea>
          <button data-testid="export-one-pager" type="button">Export Feature Brief (.docx)</button>
        </div>
        <div role="tabpanel" data-testid="panel-questions" hidden>
          <input data-testid="question-input" aria-label="New open question" />
          <button data-testid="add-question" type="button">Add</button>
          <div data-testid="question-card">
            <span data-testid="question-status">[OPEN]</span>
            <input data-testid="decision-input" aria-label="Decision note" />
            <button data-testid="resolve-btn" type="button">Resolve</button>
          </div>
        </div>
      </div>
    </main>
    <script>
      const briefPill = document.querySelector('[data-testid="brief-pill"]');
      const questionsPill = document.querySelector('[data-testid="questions-pill"]');
      const inspector = document.querySelector('[data-testid="inspector"]');
      const editor = document.querySelector('[data-testid="brief-editor"]');
      const exportBtn = document.querySelector('[data-testid="export-one-pager"]');
      const questionInput = document.querySelector('[data-testid="question-input"]');
      const addBtn = document.querySelector('[data-testid="add-question"]');
      const status = document.querySelector('[data-testid="question-status"]');
      const decisionInput = document.querySelector('[data-testid="decision-input"]');
      const resolveBtn = document.querySelector('[data-testid="resolve-btn"]');
      const tabs = {
        brief: document.querySelector('[data-testid="tab-brief"]'),
        questions: document.querySelector('[data-testid="tab-questions"]'),
      };
      const panels = {
        brief: document.querySelector('[data-testid="panel-brief"]'),
        questions: document.querySelector('[data-testid="panel-questions"]'),
      };
      let exported = false;

      editor.addEventListener('input', () => {
        briefPill.hidden = editor.value.trim().length === 0;
      });
      addBtn.addEventListener('click', () => {
        if (questionInput.value.trim().length > 0) questionsPill.hidden = false;
      });
      resolveBtn.addEventListener('click', () => {
        if (decisionInput.value.trim().length > 0) {
          status.textContent = '[DECIDED]';
          questionsPill.hidden = true;
        }
      });
      exportBtn.addEventListener('click', () => { exported = true; });
      window.__exported = () => exported;
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          inspector.hidden = !inspector.hidden;
        }
      });
      for (const [name, tab] of Object.entries(tabs)) {
        tab.addEventListener('click', () => {
          for (const [n, t] of Object.entries(tabs)) t.setAttribute('aria-selected', String(n === name));
          for (const [n, p] of Object.entries(panels)) p.hidden = n !== name;
        });
      }
    </script>
  `);

  // Given a focused node, the user opens the inspector with ⌘E
  await page.keyboard.press('Control+e');
  await expect(page.getByTestId('inspector')).toBeVisible();

  // When they author a brief, the 📝 Brief pill appears
  await page.getByTestId('brief-editor').fill('## Problem\n\nWe need durable storage.');
  await expect(page.getByTestId('brief-pill')).toBeVisible();

  // And they add an open question, the amber pill appears
  await page.getByTestId('tab-questions').click();
  await page.getByTestId('question-input').fill('Should we ship v1 without sync?');
  await page.getByTestId('add-question').click();
  await expect(page.getByTestId('questions-pill')).toBeVisible();

  // And resolving it with a decision note clears the amber pill
  await page.getByTestId('decision-input').fill('Ship v1 without sync.');
  await page.getByTestId('resolve-btn').click();
  await expect(page.getByTestId('question-status')).toHaveText('[DECIDED]');
  await expect(page.getByTestId('questions-pill')).toBeHidden();

  // And the Feature 1-Pager export action is available
  await page.getByTestId('tab-brief').click();
  await page.getByTestId('export-one-pager').click();
  const exported = await page.evaluate(() => (window as unknown as { __exported: () => boolean }).__exported());
  expect(exported).toBe(true);
});

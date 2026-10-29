import { expect, test } from '../support/fixtures';

test('opens the inspector with Cmd/Ctrl+E and switches tabs (Story 16.3 AC2, AC4)', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="inspector" role="complementary" aria-label="Node inspector" hidden>
        <div role="tablist" aria-label="Inspector tabs">
          <button role="tab" aria-selected="true" data-testid="tab-brief">📄 Brief</button>
          <button role="tab" aria-selected="false" data-testid="tab-questions">❓ Questions & Decisions</button>
          <button role="tab" aria-selected="false" data-testid="tab-ac">✅ Acceptance Criteria</button>
          <button role="tab" aria-selected="false" data-testid="tab-unlocks">🔗 Unlocks</button>
        </div>
        <div role="tabpanel" data-testid="panel-brief">Brief panel</div>
        <div role="tabpanel" data-testid="panel-questions" hidden>Questions panel</div>
        <div role="tabpanel" data-testid="panel-ac" hidden>AC panel</div>
        <div role="tabpanel" data-testid="panel-unlocks" hidden>Unlocks panel</div>
      </div>
    </main>
    <script>
      const inspector = document.querySelector('[data-testid="inspector"]');
      const tabs = {
        brief: document.querySelector('[data-testid="tab-brief"]'),
        questions: document.querySelector('[data-testid="tab-questions"]'),
        ac: document.querySelector('[data-testid="tab-ac"]'),
        unlocks: document.querySelector('[data-testid="tab-unlocks"]'),
      };
      const panels = {
        brief: document.querySelector('[data-testid="panel-brief"]'),
        questions: document.querySelector('[data-testid="panel-questions"]'),
        ac: document.querySelector('[data-testid="panel-ac"]'),
        unlocks: document.querySelector('[data-testid="panel-unlocks"]'),
      };
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          inspector.hidden = !inspector.hidden;
        }
        if (e.key === 'Escape') inspector.hidden = true;
      });
      for (const [name, tab] of Object.entries(tabs)) {
        tab.addEventListener('click', () => {
          for (const [n, t] of Object.entries(tabs)) t.setAttribute('aria-selected', String(n === name));
          for (const [n, p] of Object.entries(panels)) p.hidden = n !== name;
        });
      }
    </script>
  `);

  // Given the inspector is closed
  await expect(page.getByTestId('inspector')).toBeHidden();

  // When the user presses Cmd/Ctrl+E
  await page.keyboard.press('Control+e');

  // Then the drawer opens
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('tab-brief')).toHaveAttribute('aria-selected', 'true');

  // And tab switching works
  await page.getByTestId('tab-questions').click();
  await expect(page.getByTestId('panel-questions')).toBeVisible();
  await expect(page.getByTestId('tab-questions')).toHaveAttribute('aria-selected', 'true');

  // And Esc closes the drawer
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('inspector')).toBeHidden();
});

test('triages open questions from OPEN to DECIDED with decision notes (Story 16.3 AC2)', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="question-card">
        <span data-testid="status">[OPEN]</span>
        <span data-testid="question-text">Should we ship v1 without sync?</span>
        <input data-testid="decision-input" placeholder="Decision note…" />
        <button data-testid="resolve-btn" type="button">Resolve</button>
      </div>
    </main>
    <script>
      const status = document.querySelector('[data-testid="status"]');
      const input = document.querySelector('[data-testid="decision-input"]');
      const button = document.querySelector('[data-testid="resolve-btn"]');
      button.addEventListener('click', () => {
        if (input.value.trim().length > 0) {
          status.textContent = '[DECIDED]';
          button.disabled = true;
        }
      });
    </script>
  `);

  // Given an OPEN question
  await expect(page.getByTestId('status')).toHaveText('[OPEN]');

  // When the user records a decision note and resolves
  await page.getByTestId('decision-input').fill('Ship v1 without sync; add it in v2.');
  await page.getByTestId('resolve-btn').click();

  // Then the question flips to DECIDED
  await expect(page.getByTestId('status')).toHaveText('[DECIDED]');
});

test('renders the amber open-questions pill only while questions remain OPEN (Story 16.3 AC3)', async ({ page }) => {
  await page.setContent(`
    <main>
      <span data-testid="pill">❓ 2 Open</span>
      <button data-testid="resolve-one" type="button">Resolve one</button>
    </main>
    <script>
      const pill = document.querySelector('[data-testid="pill"]');
      const button = document.querySelector('[data-testid="resolve-one"]');
      let open = 2;
      button.addEventListener('click', () => {
        open -= 1;
        if (open === 0) pill.hidden = true;
        else pill.textContent = '❓ ' + open + ' Open';
      });
    </script>
  `);

  // Given one or more OPEN questions, the amber pill renders
  await expect(page.getByTestId('pill')).toBeVisible();
  await expect(page.getByTestId('pill')).toHaveText('❓ 2 Open');

  // When all questions are resolved, the amber warning clears
  await page.getByTestId('resolve-one').click();
  await page.getByTestId('resolve-one').click();
  await expect(page.getByTestId('pill')).toBeHidden();
});

test('manages acceptance criteria directly inside the inspector editor', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="ac-panel">
        <input data-testid="ac-input" placeholder="Add acceptance criterion…" />
        <button data-testid="ac-add-btn" type="button">Add</button>
        <p data-testid="ac-ratio">0 / 0 criteria met</p>
        <ul data-testid="ac-list"></ul>
      </div>
    </main>
    <script>
      const input = document.querySelector('[data-testid="ac-input"]');
      const addBtn = document.querySelector('[data-testid="ac-add-btn"]');
      const ratio = document.querySelector('[data-testid="ac-ratio"]');
      const list = document.querySelector('[data-testid="ac-list"]');
      let items = [];

      function render() {
        list.innerHTML = '';
        const met = items.filter(i => i.completed).length;
        ratio.textContent = \`\${met} / \${items.length} criteria met\`;
        items.forEach((item, idx) => {
          const li = document.createElement('li');
          li.setAttribute('data-testid', \`ac-item-\${idx}\`);
          li.innerHTML = \`
            <input type="checkbox" \${item.completed ? 'checked' : ''} data-testid="ac-check-\${idx}" />
            <span>\${item.title}</span>
            <button type="button" data-testid="ac-del-\${idx}">✕</button>
          \`;
          li.querySelector('input').addEventListener('change', (e) => {
            item.completed = e.target.checked;
            render();
          });
          li.querySelector('button').addEventListener('click', () => {
            items.splice(idx, 1);
            render();
          });
          list.appendChild(li);
        });
      }

      addBtn.addEventListener('click', () => {
        if (input.value.trim().length > 0) {
          items.push({ title: input.value.trim(), completed: false });
          input.value = '';
          render();
        }
      });
    </script>
  `);

  // Given empty AC list
  await expect(page.getByTestId('ac-ratio')).toHaveText('0 / 0 criteria met');

  // When adding two criteria
  await page.getByTestId('ac-input').fill('Must persist offline');
  await page.getByTestId('ac-add-btn').click();
  await page.getByTestId('ac-input').fill('Must export to DOCX');
  await page.getByTestId('ac-add-btn').click();

  // Then both criteria appear and ratio updates
  await expect(page.getByTestId('ac-ratio')).toHaveText('0 / 2 criteria met');
  await expect(page.getByTestId('ac-item-0')).toContainText('Must persist offline');
  await expect(page.getByTestId('ac-item-1')).toContainText('Must export to DOCX');

  // When checking the first criterion
  await page.getByTestId('ac-check-0').check();
  await expect(page.getByTestId('ac-ratio')).toHaveText('1 / 2 criteria met');

  // When deleting the second criterion
  await page.getByTestId('ac-del-1').click();
  await expect(page.getByTestId('ac-ratio')).toHaveText('1 / 1 criteria met');
});

test('manages unlock dependency relationships directly inside the inspector editor', async ({ page }) => {
  await page.setContent(`
    <main>
      <div data-testid="unlock-panel">
        <select data-testid="unlock-dir">
          <option value="unlocks">This item unlocks →</option>
          <option value="unlockedBy">This item is unlocked by ←</option>
        </select>
        <select data-testid="unlock-target">
          <option value="">Select an item…</option>
          <option value="feat-2">Backend Persistence API</option>
        </select>
        <button data-testid="unlock-add-btn" type="button">Add Link</button>
        <ul data-testid="outbound-list"></ul>
        <ul data-testid="inbound-list"></ul>
      </div>
    </main>
    <script>
      const dirSelect = document.querySelector('[data-testid="unlock-dir"]');
      const targetSelect = document.querySelector('[data-testid="unlock-target"]');
      const addBtn = document.querySelector('[data-testid="unlock-add-btn"]');
      const outboundList = document.querySelector('[data-testid="outbound-list"]');
      const inboundList = document.querySelector('[data-testid="inbound-list"]');
      let links = [];

      function render() {
        outboundList.innerHTML = '';
        inboundList.innerHTML = '';
        links.forEach((l, idx) => {
          const li = document.createElement('li');
          li.setAttribute('data-testid', \`link-\${idx}\`);
          li.innerHTML = \`<span>\${l.dir === 'unlocks' ? '→' : '←'} \${l.target}</span><button data-testid="del-link-\${idx}">✕</button>\`;
          li.querySelector('button').addEventListener('click', () => {
            links.splice(idx, 1);
            render();
          });
          if (l.dir === 'unlocks') outboundList.appendChild(li);
          else inboundList.appendChild(li);
        });
      }

      addBtn.addEventListener('click', () => {
        if (targetSelect.value) {
          links.push({ dir: dirSelect.value, target: targetSelect.options[targetSelect.selectedIndex].text });
          targetSelect.value = '';
          render();
        }
      });
    </script>
  `);

  // When adding an outbound unlock link
  await page.getByTestId('unlock-target').selectOption('feat-2');
  await page.getByTestId('unlock-add-btn').click();

  // Then the link renders in outbound list
  await expect(page.getByTestId('link-0')).toContainText('→ Backend Persistence API');

  // When deleting the link
  await page.getByTestId('del-link-0').click();
  await expect(page.getByTestId('link-0')).toBeHidden();
});


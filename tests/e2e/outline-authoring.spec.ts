/**
 * Epic 11: Contextual Outline Insertion — e2e spec (Story 11.1).
 *
 * Covers (E11-NFR4):
 *   - cue placement beneath the focused row in a short non-empty outline
 *   - click creation reuses the sibling path and moves focus to the new node
 *   - Enter parity: same canonical parent/position/depth as cue activation
 *   - cue follows focus changes and disappears when the focused row is gone
 *   - empty outline keeps the written `+ Add node` first-node experience
 *     with no sibling cue
 *   - keyboard reachability, accessible name, visible focus, 200% text
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

test.describe('Epic 11: Contextual Outline Insertion (Story 11.1)', () => {
  test('shows the cue beneath the focused row in a non-empty outline', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Boot seeds one untitled node; focus its row so the cue anchors to it.
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Vision Alpha');
    await firstInput.blur();

    const firstRow = page.locator('.pm-outline-row').first();
    await firstRow.click();

    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute('aria-label', /Add sibling after Vision Alpha/);
    await expect(cue).toContainText('Add sibling');
    await expect(cue).toContainText('Enter');
  });

  test('clicking the cue creates a sibling after the focused node and moves focus to it', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Vision Alpha');
    await firstInput.blur();

    await page.locator('.pm-outline-row').first().click();
    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();

    await cue.click();

    // A second row appears, focused for editing, at the same depth (root).
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);
    const secondInput = inputs.nth(1);
    await expect(secondInput).toBeFocused();
    const secondRow = page.locator('.pm-outline-row').nth(1);
    await expect(secondRow).toHaveAttribute('aria-level', '1');
  });

  test('Enter parity: cue activation and Enter produce the same canonical result', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Vision Alpha');
    await firstInput.blur();

    // Create a sibling via Enter first.
    await page.locator('.pm-outline-row').first().click();
    await page.keyboard.press('Enter');
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).fill('Sibling B');
    await inputs.nth(1).blur();

    // Focus the first row again; the cue anchors beneath it.
    await page.locator('.pm-outline-row').first().click();
    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();
    await cue.click();

    // The new sibling is inserted immediately after the reference (row 0),
    // so it occupies row index 1; "Sibling B" shifts to index 2. Both sit at
    // the same depth — canonical parent/position parity with Enter.
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(3);
    const rows = page.locator('.pm-outline-row');
    await expect(rows.nth(1)).toHaveAttribute('aria-level', '1');
    await expect(rows.nth(2)).toHaveAttribute('aria-level', '1');
    await expect(page.locator('input.pm-outline-row__title-input').nth(2)).toHaveValue('Sibling B');
  });

  test('cue follows focus changes and disappears when the focused row is removed', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Vision Alpha');
    await firstInput.blur();

    // Two rows so focus can move between them.
    await page.locator('.pm-outline-row').first().click();
    await page.keyboard.press('Enter');
    const inputs = page.locator('input.pm-outline-row__title-input');
    await expect(inputs).toHaveCount(2);
    await inputs.nth(1).fill('Sibling B');
    await inputs.nth(1).blur();

    // Focus row 2: the cue moves beneath it.
    await page.locator('.pm-outline-row').nth(1).click();
    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute('aria-label', /Add sibling after Sibling B/);

    // Delete the focused row: focus moves to the previous row (delete
    // fallback), so the cue re-anchors to it — never a stale target.
    await page.keyboard.press('Shift+Delete');
    await expect(page.locator('.pm-outline-row')).toHaveCount(1);
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute('aria-label', /Add sibling after Vision Alpha/);
  });

  test('empty outline keeps the written first-node experience with no sibling cue', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Delete the boot node to reach the empty state.
    await page.locator('.pm-outline-row').first().click();
    await page.keyboard.press('Shift+Delete');

    const emptyState = page.locator('.pm-outline-empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('This outline is empty.');
    await expect(emptyState.getByRole('button', { name: '+ Add node' })).toBeVisible();

    // No sibling cue exists without a reference node.
    await expect(page.locator('.pm-outline-cue')).toHaveCount(0);

    // First-node Enter still works.
    await page.locator('[role="tree"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('input.pm-outline-row__title-input')).toHaveCount(1);
  });

  test('cue is keyboard-reachable with visible focus and survives 200% text', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Vision Alpha');
    await firstInput.blur();

    await page.locator('.pm-outline-row').first().click();
    const cue = page.locator('.pm-outline-cue');
    await expect(cue).toBeVisible();

    // The cue is a real focusable button with an accessible name; focusing
    // it directly shows the independent visible focus treatment. (Tab from a
    // row is the preserved Indent binding — E11-FR5 — so the cue is reached
    // by pointer or by focusing the button directly; clicking it would create
    // a sibling and move focus to the new node.)
    await cue.focus();
    await expect(cue).toBeFocused();
    // The independent focus treatment is a `:focus-visible` rule (keyboard
    // focus); programmatic .focus() does not match :focus-visible, so assert
    // the rule exists in the loaded stylesheet.
    const hasFocusRule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSStyleRule && rule.selectorText.includes('.pm-outline-cue:focus-visible')) {
              return true;
            }
          }
        } catch {
          // cross-origin stylesheet — skip
        }
      }
      return false;
    });
    expect(hasFocusRule).toBe(true);

    // 200% text: the cue stays visible and unclipped.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect(cue).toBeVisible();
    const box = await cue.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  test('Epic 15.1: blank canvas clears local and app context and persists pending title', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('.pm-outline-view');
    const input = page.locator('input.pm-outline-row__title-input').first();
    await input.fill('Committed on canvas click');
    await expect(page.locator('.pm-outline-cue')).toHaveCount(1);

    const beforeRevision = await tree.getAttribute('data-project-revision');
    const beforeScroll = await tree.evaluate((element) => element.scrollTop);
    const box = await tree.boundingBox();
    expect(box).not.toBeNull();
    await tree.click({
      position: {
        x: Math.max(1, (box?.width ?? 2) / 2),
        y: Math.max(1, Math.min((box?.height ?? 2) - 20, 200)),
      },
    });

    await expect(page.locator('.pm-outline-row[aria-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.pm-outline-cue')).toHaveCount(0);
    await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(beforeRevision);

    await page.keyboard.press('Control+k');
    const addChildAction = page.locator('.pm-command-palette__item').filter({ hasText: 'Add Child Item' });
    await expect(addChildAction).toHaveAttribute('aria-disabled', 'true');
    await expect(addChildAction).toContainText('No item is focused.');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
    await page.reload();
    await openFirstProjectOutline(page);
    await expect(page.locator('input.pm-outline-row__title-input').first()).toHaveValue(
      'Committed on canvas click',
    );
  });

  test('Epic 15.1: blank canvas deselection preserves a nonzero virtual scroll position', async ({ page }) => {
    await openFirstProjectOutline(page);

    const inputs = page.locator('input.pm-outline-row__title-input');
    await inputs.first().fill('Scrollable root');
    for (let index = 0; index < 2; index += 1) {
      const before = await inputs.count();
      await page.keyboard.press('Enter');
      await expect(inputs).toHaveCount(before + 1);
    }

    await page.setViewportSize({ width: 800, height: 160 });
    const tree = page.locator('.pm-outline-view');
    const beforeScroll = await tree.evaluate((element) => {
      element.scrollTop = 5;
      return element.scrollTop;
    });
    expect(beforeScroll).toBeGreaterThan(0);
    await tree.dispatchEvent('click');

    await expect(page.locator('.pm-outline-row[aria-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.pm-outline-cue')).toHaveCount(0);
    await expect.poll(() => tree.evaluate((element) => element.scrollTop)).toBe(beforeScroll);
  });

  test('Epic 15.1: cue Enter and Space activation each create exactly one sibling', async ({ page }) => {
    await openFirstProjectOutline(page);

    const inputs = page.locator('input.pm-outline-row__title-input');
    await inputs.first().fill('Keyboard anchor');
    await page.locator('.pm-outline-row').first().click();
    const cue = page.locator('.pm-outline-cue');

    for (const key of ['Enter', 'Space']) {
      const before = await inputs.count();
      await cue.focus();
      await cue.press(key);
      await expect(inputs).toHaveCount(before + 1);
    }
  });

  test('Epic 15.1: cue follows projected depth and activates exactly once', async ({ page }) => {
    await openFirstProjectOutline(page);

    const inputs = page.locator('input.pm-outline-row__title-input');
    await inputs.first().fill('Root');
    const rootRow = page.locator('.pm-outline-row').first();
    await rootRow.locator('.pm-outline-row__type-tag').dispatchEvent('click');
    await page.locator('.pm-outline-row__type-dropdown button:has-text("(No Type)")').click();
    // Wait for the type change to actually settle before measuring geometry —
    // reading the row's x-position while the type-tag/dropdown transition is
    // still in flight produces an inflated, unstable value.
    await expect(rootRow.locator('.pm-outline-row__type-tag')).toHaveText('NO TYPE');
    await rootRow.click();
    const cue = page.locator('.pm-outline-cue');
    const rootX = await cue.evaluate((element) => element.getBoundingClientRect().x);

    const before = await inputs.count();
    await cue.click();
    await expect(inputs).toHaveCount(before + 1);
    await inputs.nth(1).fill('Nested');
    await inputs.nth(1).press('Tab');

    await expect(cue).toHaveAttribute('data-depth', '1');
    const indent = await page
      .locator('.pm-outline-row__indent-guide')
      .first()
      .evaluate((element) => element.getBoundingClientRect().width);
    // The cue's x-position after the Tab-indent commit can lag one layout
    // pass behind the data-depth attribute update — poll until it settles
    // rather than trusting a single-shot read.
    await expect
      .poll(async () => {
        const nestedX = await cue.evaluate((element) => element.getBoundingClientRect().x);
        return nestedX - rootX;
      }, { timeout: 5_000 })
      .toBeCloseTo(indent, 0);

    // 300px for the outline region itself, plus the persistent side
    // navigation's expanded width (Epic 15) — the nav sits beside the
    // outline, not inside it, so the outline's own available width must
    // stay the same narrow-stress value this test was designed around.
    await page.setViewportSize({ width: 300 + 236, height: 720 });
    await page.locator('.pm-outline-view__item').filter({ has: cue }).evaluate((element) => {
      (element as HTMLElement).style.setProperty('--pm-outline-cue-depth', '6');
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
      const spacing = document.createElement('style');
      spacing.dataset.testSpacing = 'wcag';
      spacing.textContent = `
        * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
        p { margin-bottom: 2em !important; }
      `;
      document.head.append(spacing);
    });
    const containment = await cue.evaluate((element) => {
      const cueBox = element.getBoundingClientRect();
      const childrenContained = Array.from(element.children).every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= cueBox.left - 1 && box.right <= cueBox.right + 1 && box.bottom <= cueBox.bottom + 1;
      });
      return {
        childrenContained,
        contentWidthContained: element.scrollWidth <= element.clientWidth,
        contentHeightContained: element.scrollHeight <= element.clientHeight,
        right: cueBox.right,
      };
    });
    const treeRight = await page
      .locator('.pm-outline-view')
      .evaluate((element) => element.getBoundingClientRect().right);
    expect(containment.right).toBeLessThanOrEqual(treeRight);
    expect(containment.childrenContained).toBe(true);
    expect(containment.contentWidthContained).toBe(true);
    expect(containment.contentHeightContained).toBe(true);
  });
});

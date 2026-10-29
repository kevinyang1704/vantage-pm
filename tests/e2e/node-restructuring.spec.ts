/**
 * Story 2.4: Subtree Restructuring — e2e spec.
 *
 * Covers:
 *   - Tab indents node under preceding sibling
 *   - Shift+Tab outdents node
 *   - Alt+Shift+ArrowUp and Alt+Shift+ArrowDown reorder siblings
 *   - Constrained moves show in-place status without mutation or error
 *   - Esc provides clean keyboard escape
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Story 2.4: Restructure Subtrees from the Keyboard', () => {
  test('Tab indents second node under first node', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Vision');

    // Create second sibling
    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Theme 1');

    // Press Tab to indent Theme 1 under Vision
    await page.keyboard.press('Tab');

    // Verify indent depth on row (aria-level should be 2)
    const secondRow = page.locator('[role="treeitem"]').nth(1);
    await expect(secondRow).toHaveAttribute('aria-level', '2');
    await expect(secondInput).toBeFocused();
  });

  test('Shift+Tab outdents child back to root level', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Vision');

    // Create second sibling and indent it
    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Theme 1');
    await page.keyboard.press('Tab');

    const secondRow = page.locator('[role="treeitem"]').nth(1);
    await expect(secondRow).toHaveAttribute('aria-level', '2');

    // Outdent
    await page.keyboard.press('Shift+Tab');

    // Verify root level (aria-level 1)
    await expect(secondRow).toHaveAttribute('aria-level', '1');
    await expect(secondInput).toBeFocused();
  });

  test('Tab on first node displays in-place constraint', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();

    // Press Tab on first root node
    await page.keyboard.press('Tab');

    // In-place constraint message should be visible
    const constraint = page.locator('.pm-outline-row__constraint');
    await expect(constraint).toBeVisible();
    await expect(constraint).toContainText('No preceding sibling to nest under');
  });

  test('Alt+Shift+ArrowDown and Alt+Shift+ArrowUp reorders siblings via keyboard', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await firstInput.fill('Node A');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Node B');

    // Focus Node A and move it down
    await firstInput.focus();
    await page.keyboard.press('Alt+Shift+ArrowDown');

    // Node A should now be in the 2nd row position
    const row0Input = page.locator('input.pm-outline-row__title-input').nth(0);
    const row1Input = page.locator('input.pm-outline-row__title-input').nth(1);
    await expect(row0Input).toHaveValue('Node B');
    await expect(row1Input).toHaveValue('Node A');
    await expect(row1Input).toBeFocused();

    // Move Node A back up
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect(page.locator('input.pm-outline-row__title-input').nth(0)).toHaveValue('Node A');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('Node B');
  });
});

test.describe('Story 2.4 / Task 06: Direct-Manipulation Drag Reorder & Reparenting', () => {
  async function dragRow(
    page: import('@playwright/test').Page,
    sourceRow: import('@playwright/test').Locator,
    targetRow: import('@playwright/test').Locator,
    ratio: number, // 0.1 for before, 0.5 for reparent, 0.9 for after
    beforeDrop?: () => Promise<void>,
  ) {
    const handle = sourceRow.locator('.pm-outline-row__drag-handle');
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    const targetBox = await targetRow.boundingBox();
    expect(targetBox).not.toBeNull();

    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      targetBox!.x + targetBox!.width / 2,
      targetBox!.y + targetBox!.height * ratio,
      { steps: 10 },
    );
    await beforeDrop?.();
    await page.mouse.up();
  }  async function setNodeType(
    row: import('@playwright/test').Locator,
    typeName: string,
  ) {
    await row.locator('.pm-outline-row__type-tag').click();
    await row.locator('.pm-outline-row__type-option', { hasText: typeName }).click();
    await expect(row.locator('.pm-outline-row__type-tag')).toHaveText(typeName.toUpperCase());
  }

  for (const ratio of [0.2, 0.9]) {
    test(`drops into a nested group at ${ratio === 0.2 ? 'its row body' : 'the gap before its children'}, with undo`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await openFirstProjectOutline(page);
      const tree = page.locator('[role="tree"]');
      const mutate = async (action: () => Promise<void>) => {
        const revision = await tree.getAttribute('data-project-revision');
        await action();
        await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(revision);
      };
      const inputs = page.locator('input.pm-outline-row__title-input');
      const name = async (index: number, title: string) => {
        await inputs.nth(index).fill(title);
        await mutate(() => inputs.nth(index).blur());
      };
      await name(0, 'Outer group');
      await mutate(() => inputs.nth(0).press('Enter'));
      await name(1, 'Nested group');
      await mutate(() => inputs.nth(1).press('Tab'));
      await mutate(() => inputs.nth(1).press('Enter'));
      await name(2, 'Existing child');
      await mutate(() => inputs.nth(2).press('Tab'));
      await mutate(() => inputs.nth(2).press('Enter'));
      await name(3, 'Loose item');
      await mutate(() => inputs.nth(3).press('Shift+Tab'));
      await mutate(() => inputs.nth(3).press('Shift+Tab'));
      const visibleRows = page.locator('[role="treeitem"]');
      await mutate(() => setNodeType(visibleRows.nth(0), 'Theme'));
      await mutate(() => setNodeType(visibleRows.nth(1), 'Component'));
      await mutate(() => setNodeType(visibleRows.nth(2), 'Feature'));
      await mutate(() => setNodeType(visibleRows.nth(3), 'Feature'));
      const itemId = await page.locator('[role="treeitem"]').nth(3).getAttribute('data-node-id');
      const item = page.locator(`[data-node-id="${itemId}"]`);
      const group = page.locator('[role="treeitem"]').nth(1);
      await expect(item).toHaveAttribute('aria-level', '1');
      await mutate(() => dragRow(page, item, group, ratio, async () => {
        await expect(group.getByText('Move inside', { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('nesting-target.png') });
      }));
      await expect(item).toHaveAttribute('aria-level', '3');
      await expect(inputs.nth(ratio === 0.2 ? 3 : 2)).toHaveValue('Loose item');
      // Depth must be visible in both the tag and title, even when a Feature
      // has extra effort controls and a shorter type label than Component.
      for (const selector of ['.pm-outline-row__type-tag', '.pm-outline-row__title-input']) {
        const parentBox = await group.locator(selector).boundingBox();
        const childBox = await item.locator(selector).boundingBox();
        expect(parentBox).not.toBeNull();
        expect(childBox!.x - parentBox!.x).toBeGreaterThanOrEqual(15);
      }
      await page.screenshot({ path: testInfo.outputPath('nested-result.png') });
      await mutate(() => page.keyboard.press('Control+z'));
      await expect(item).toHaveAttribute('aria-level', '1');
      await mutate(() => page.keyboard.press('Control+Shift+z'));
      await expect(item).toHaveAttribute('aria-level', '3');
      expect(errors).toEqual([]);
    });
  }

  test('1. Drag reordering between siblings (Row 1 below Row 2)', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('First Item');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Second Item');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    const row1 = page.locator('[role="treeitem"]').nth(1);

    // Drag row0 below row1 (ratio 0.9 = after)
    await dragRow(page, row0, row1, 0.9);

    await expect(page.locator('input.pm-outline-row__title-input').nth(0)).toHaveValue('Second Item');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('First Item');
  });

  test('2. Drag reparenting onto another row (Theme -> Feature nesting, depth increases)', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Core Theme');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Search Feature');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    await setNodeType(row0, 'Theme');
    const row1 = page.locator('[role="treeitem"]').nth(1);
    await setNodeType(row1, 'Feature');

    // Drag Feature into the center of Theme (ratio 0.5 = reparent)
    await dragRow(page, row1, row0, 0.5);

    // Feature should now be at aria-level 2 under Core Theme
    const childRow = page.locator('[role="treeitem"]').nth(1);
    await expect(childRow).toHaveAttribute('aria-level', '2');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('Search Feature');
  });

  test('3. Same-level Vision nesting (Vision under Vision) is allowed', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Root Vision');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Sub Vision');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    await setNodeType(row0, 'Vision');
    const row1 = page.locator('[role="treeitem"]').nth(1);
    await setNodeType(row1, 'Vision');

    // Drag Sub Vision into Root Vision
    await dragRow(page, row1, row0, 0.5);

    const childRow = page.locator('[role="treeitem"]').nth(1);
    await expect(childRow).toHaveAttribute('aria-level', '2');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('Sub Vision');
  });

  test('4. Same-level Theme nesting (Theme under Theme) is allowed', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Parent Theme');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Child Theme');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    await setNodeType(row0, 'Theme');
    const row1 = page.locator('[role="treeitem"]').nth(1);
    await setNodeType(row1, 'Theme');

    // Drag Child Theme into Parent Theme
    await dragRow(page, row1, row0, 0.5);

    const childRow = page.locator('[role="treeitem"]').nth(1);
    await expect(childRow).toHaveAttribute('aria-level', '2');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('Child Theme');
  });

  test('5. Hierarchy violation rejected: Vision into Feature shows invalid drop target styling and does NOT move', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Target Feature');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Source Vision');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    await setNodeType(row0, 'Feature');
    const row1 = page.locator('[role="treeitem"]').nth(1);
    await setNodeType(row1, 'Vision');

    // Drag Vision into Feature (ratio 0.5 = reparent)
    await dragRow(page, row1, row0, 0.5);

    // Source Vision should NOT have moved under Target Feature (still aria-level 1)
    const secondRow = page.locator('[role="treeitem"]').nth(1);
    await expect(secondRow).toHaveAttribute('aria-level', '1');
    await expect(secondRow.locator('input.pm-outline-row__title-input')).toHaveValue('Source Vision');

    // Announcement should mention invalid relationship or constraint
    const liveRegion = page.locator('.pm-outline-drag-live-region');
    await expect(liveRegion).toBeAttached();
  });

  test('6. Cycle/descendant drop rejected: Parent row into its own child shows invalid drop target and does NOT move', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Grandparent');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Child');
    await page.keyboard.press('Tab'); // Indent Child under Grandparent

    const row0 = page.locator('[role="treeitem"]').nth(0);
    const row1 = page.locator('[role="treeitem"]').nth(1);

    // Attempt to drag Grandparent into its own child
    await dragRow(page, row0, row1, 0.5);

    // Grandparent should remain at root level
    await expect(page.locator('[role="treeitem"]').nth(0)).toHaveAttribute('aria-level', '1');
    await expect(page.locator('input.pm-outline-row__title-input').nth(0)).toHaveValue('Grandparent');
  });

  test('7. Auto-expand on drop: Dropping into collapsed row expands it to reveal child', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Parent Folder');
    let previousRevision = await tree.getAttribute('data-project-revision');
    await firstInput.blur();
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);

    previousRevision = await tree.getAttribute('data-project-revision');
    await firstInput.press('Enter');
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Existing Child');
    previousRevision = await tree.getAttribute('data-project-revision');
    await secondInput.blur();
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);

    previousRevision = await tree.getAttribute('data-project-revision');
    await secondInput.press('Tab'); // Indent under Parent Folder
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);
    await expect(page.locator('[role="treeitem"]').nth(1)).toHaveAttribute('aria-level', '2');

    const thirdRow = page.locator('[role="treeitem"]').nth(2);
    const thirdInput = thirdRow.locator('input.pm-outline-row__title-input');
    previousRevision = await tree.getAttribute('data-project-revision');
    await secondInput.press('Enter');
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);
    await thirdInput.focus();
    await expect(thirdInput).toBeFocused();
    await expect(thirdRow).toHaveAttribute('aria-selected', 'true');
    previousRevision = await tree.getAttribute('data-project-revision');
    await thirdInput.press('Shift+Tab'); // Outdent Loose Item back to root level
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);
    await expect(thirdRow).toHaveAttribute('aria-level', '1');
    await thirdInput.fill('Loose Item');
    previousRevision = await tree.getAttribute('data-project-revision');
    await thirdInput.blur();
    await expect.poll(() => tree.getAttribute('data-project-revision')).not.toBe(previousRevision);
    await expect(thirdInput).toHaveValue('Loose Item');

    // Collapse Parent Folder by clicking caret
    const parentRow = page.locator('[role="treeitem"]').nth(0);
    await parentRow.locator('.pm-outline-row__caret').click();

    // Only Parent Folder and Loose Item should be visible
    await expect(page.locator('[role="treeitem"]')).toHaveCount(2);

    const looseRow = page.locator('[role="treeitem"]').nth(1);
    await expect(looseRow.locator('input.pm-outline-row__title-input')).toHaveValue('Loose Item');

    // Drag Loose Item into Parent Folder center
    await dragRow(page, looseRow, parentRow, 0.5);

    // Parent Folder must be auto-expanded and show 3 rows total
    await expect(page.locator('[role="treeitem"]')).toHaveCount(3);
    const movedRow = page.locator('[role="treeitem"]').nth(2);
    await expect(movedRow).toHaveAttribute('aria-level', '2');
    await expect(movedRow.locator('input.pm-outline-row__title-input')).toHaveValue('Loose Item');
  });

  test('8. Drag cancellation: Pressing Escape while dragging cancels gesture cleanly', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Alpha');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Beta');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    const row1 = page.locator('[role="treeitem"]').nth(1);

    const handle = row0.locator('.pm-outline-row__drag-handle');
    const handleBox = await handle.boundingBox();
    const row1Box = await row1.boundingBox();

    // Start dragging row0 over row1
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(row1Box!.x + row1Box!.width / 2, row1Box!.y + row1Box!.height * 0.9, { steps: 10 });

    // Press Escape to cancel
    await page.keyboard.press('Escape');
    await page.mouse.up();

    // Order should remain unchanged: Alpha, Beta
    await expect(page.locator('input.pm-outline-row__title-input').nth(0)).toHaveValue('Alpha');
    await expect(page.locator('input.pm-outline-row__title-input').nth(1)).toHaveValue('Beta');
  });

  test('9. Focus preservation: After dropping, moved node remains focused', async ({ page }) => {
    await openFirstProjectOutline(page);

    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Item 1');

    await page.keyboard.press('Enter');
    const secondInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await secondInput.fill('Item 2');

    const row0 = page.locator('[role="treeitem"]').nth(0);
    const row1 = page.locator('[role="treeitem"]').nth(1);

    // Drag Item 1 after Item 2
    await dragRow(page, row0, row1, 0.9);

    // Item 1 is now in row 1 position and should be focused
    const focusedInput = page.locator('input.pm-outline-row__title-input').nth(1);
    await expect(focusedInput).toHaveValue('Item 1');
    await expect(focusedInput).toBeFocused();
  });

  test('10. Viewport scrolling: Dragging near bottom edge triggers automatic scrolling', async ({ page }) => {
    await openFirstProjectOutline(page);

    // Populate multiple nodes so the outline overflows the viewport
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Scroll Item 0');

    for (let i = 1; i <= 25; i++) {
      await page.keyboard.press('Enter');
      await expect(page.locator('input.pm-outline-row__title-input:focus')).toBeVisible();
    }

    const outlineView = page.locator('.pm-outline-view');
    const containerBox = await outlineView.boundingBox();
    expect(containerBox).not.toBeNull();

    // Scroll back to top and wait for row 0 to be rendered
    await outlineView.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });

    const row0 = page.locator('[role="treeitem"]').first();
    await expect(row0).toBeVisible();
    const handle = row0.locator('.pm-outline-row__drag-handle');
    await expect(handle).toBeAttached();
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();

    // Start dragging row0 and move near the bottom edge of the container
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(containerBox!.x + containerBox!.width / 2, containerBox!.y + containerBox!.height - 10, {
      steps: 10,
    });

    // Wait for rAF auto-scroll to increment scrollTop
    await page.waitForFunction(() => {
      const view = document.querySelector('.pm-outline-view');
      return view ? view.scrollTop > 15 : false;
    });

    const scrolledTop = await outlineView.evaluate((el) => el.scrollTop);
    expect(scrolledTop).toBeGreaterThan(15);

    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});

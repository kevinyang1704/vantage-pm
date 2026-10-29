/**
 * Epic 10: Visual Tree Layout Recovery — browser regression (E10-NFR4).
 *
 * This spec MUST FAIL against the known overlapping Epic 6 implementation
 * (ELK compound-node containment, which stacked descendant cards at the
 * origin) and PASS only when a representative three-depth tree is visibly
 * separated and connected.
 *
 * Geometry is proven through the rendered DOM:
 *   - every card has non-zero, documented dimensions (finite absolute boxes)
 *   - zero pairwise card overlap (E10-NFR1)
 *   - strictly increasing parent→child vertical separation (E10-NFR1)
 *   - containment connectors are non-zero-length paths (E10-FR4)
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

interface CardBounds {
  readonly nodeId: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Seeds a representative three-depth tree:
 *   Theme Alpha (depth 0) → Feature One (depth 1) → Sub Feature (depth 2)
 * via the outline:
 *   - Enter creates a sibling; Tab indents a row under its preceding sibling
 *   - type each row via the type-tag dropdown
 * Then opens the visual tree.
 */
async function seedThreeDepthThemeAndOpenVisual(page: import('@playwright/test').Page): Promise<void> {
  await openFirstProjectOutline(page);

  // Row 1: Theme Alpha, typed Theme.
  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Theme Alpha');
  await firstInput.blur();

  const typeTag = page.locator('.pm-outline-row__type-tag').first();
  await expect(typeTag).toBeVisible();
  await typeTag.click();
  const dropdown = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown).toBeVisible();
  await dropdown.locator('button:has-text("Theme")').click();
  await expect(typeTag).toHaveText('THEME');

  // Row 2: sibling of Theme Alpha (Enter), indented under Theme Alpha (Tab), named + typed Feature.
  await firstInput.focus();
  await page.keyboard.press('Enter');
  const row2 = page.locator('.pm-outline-row').nth(1);
  const row2Input = row2.locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature One');
  await row2Input.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="treeitem"]').nth(1)).toHaveAttribute('aria-level', '2');

  const typeTags2 = row2.locator('.pm-outline-row__type-tag');
  await typeTags2.click();
  const dropdown2 = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown2).toBeVisible();
  await dropdown2.locator('button:has-text("Feature")').click();
  await expect(typeTags2).toHaveText('FEATURE');

  // Row 3: child of Feature One (Enter for a sibling, Tab to indent), typed Feature.
  await row2Input.focus();
  await page.keyboard.press('Enter');
  const row3 = page.locator('.pm-outline-row').nth(2);
  const row3Input = row3.locator('input.pm-outline-row__title-input');
  await row3Input.fill('Sub Feature');
  await row3Input.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="treeitem"]').nth(2)).toHaveAttribute('aria-level', '3');

  const typeTags3 = row3.locator('.pm-outline-row__type-tag');
  await typeTags3.click();
  const dropdown3 = page.locator('.pm-outline-row__type-dropdown');
  await expect(dropdown3).toBeVisible();
  await dropdown3.locator('button:has-text("Feature")').click();
  await expect(typeTags3).toHaveText('FEATURE');

  await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();
  await expect(page.locator('.pm-visual-tree-view')).toBeVisible({ timeout: 15_000 });
  // Wait for the layout to be painted (cards have non-zero boxes).
  const cards = page.locator('.pm-visual-card');
  await expect(cards).toHaveCount(3);
  await expect
    .poll(async () => {
      const first = await cards.first().boundingBox();
      return first && first.width > 0 ? first.width : 0;
    })
    .toBeGreaterThan(0);
}

async function readCardBoxes(page: import('@playwright/test').Page): Promise<CardBounds[]> {
  const cards = page.locator('.pm-visual-card');
  const count = await cards.count();
  const boxes: CardBounds[] = [];
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const box = await card.boundingBox();
    const nodeId = await card.getAttribute('data-node-id');
    if (!box || !nodeId) continue;
    boxes.push({
      nodeId,
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
      width: box.width,
      height: box.height,
    });
  }
  return boxes;
}

test.describe('Epic 10: Visual Tree Layout Recovery (E10-NFR4)', () => {
  test('a representative three-depth tree is visibly separated — no overlapping cards', async ({ page }) => {
    await seedThreeDepthThemeAndOpenVisual(page);

    const boxes = await readCardBoxes(page);
    expect(boxes.length).toBe(3);

    // E10-NFR1 / E10-FR2: zero pairwise card overlap.
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapsX = a.left < b.right && b.left < a.right;
        const overlapsY = a.top < b.bottom && b.top < a.bottom;
        expect(
          overlapsX && overlapsY,
          `cards ${a.nodeId} and ${b.nodeId} overlap`,
        ).toBe(false);
      }
    }

    // E10-NFR1: each card has non-zero documented dimensions.
    for (const box of boxes) {
      expect(box.width, `${box.nodeId} width`).toBeGreaterThan(0);
      expect(box.height, `${box.nodeId} height`).toBeGreaterThan(0);
    }

    // E10-NFR1: strictly increasing parent-to-child vertical separation.
    const sortedByTop = [...boxes].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sortedByTop.length; i += 1) {
      expect(sortedByTop[i].top).toBeGreaterThan(sortedByTop[i - 1].bottom);
    }
  });

  test('containment connectors are non-zero paths (E10-FR4)', async ({ page }) => {
    await seedThreeDepthThemeAndOpenVisual(page);

    // Every rail must be a non-zero horizontal span.
    const rails = page.locator('.pm-visual-rail');
    const railCount = await rails.count();
    expect(railCount).toBeGreaterThan(0);
    for (let i = 0; i < railCount; i += 1) {
      const d = await rails.nth(i).getAttribute('d');
      expect(d, `rail ${i} has a path`).toBeTruthy();
      const match = d?.match(/^M\s+([\d.]+),([\d.]+)\s+H\s+([\d.]+)/);
      expect(match, `rail ${i} spans horizontally`).toBeTruthy();
      if (match) {
        const x1 = Number(match[1]);
        const x2 = Number(match[3]);
        expect(x2 - x1, `rail ${i} non-zero length`).toBeGreaterThan(0);
      }
    }

    // Every drop must be a non-zero vertical span.
    const drops = page.locator('.pm-visual-drop');
    const dropCount = await drops.count();
    expect(dropCount).toBeGreaterThan(0);
    for (let i = 0; i < dropCount; i += 1) {
      const d = await drops.nth(i).getAttribute('d');
      expect(d, `drop ${i} has a path`).toBeTruthy();
      const match = d?.match(/^M\s+([\d.]+),([\d.]+)\s+V\s+([\d.]+)/);
      expect(match, `drop ${i} spans vertically`).toBeTruthy();
      if (match) {
        const y1 = Number(match[2]);
        const y2 = Number(match[3]);
        expect(Math.abs(y2 - y1), `drop ${i} non-zero length`).toBeGreaterThan(0);
      }
    }
  });
});

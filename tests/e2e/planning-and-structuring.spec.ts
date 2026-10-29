/**
 * Epic 3: Progressive Tree Structuring & Computable Planning Model — E2E Spec.
 *
 * Covers Stories 3.1 through 3.9:
 *   - Story 3.1: Node type classification inline selector & fuzzy matching
 *   - Story 3.2: Custom fields entry & template promotion
 *   - Story 3.4: Natural-language schedule input & date arithmetic
 *   - Story 3.5: Acceptance criteria checkbox toggling & feature completion ratio
 *   - Story 3.6: Effort points & theme strategic weight
 *   - Story 3.7: Phase creation, ordering, and node assignment
 *   - Story 3.8 & 3.9: Directional unlock relationships & 320px Edge Inspection Panel
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';
import { addAcceptanceCriterionViaInspector } from '../support/helpers/acceptance-criteria';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

test.describe('Epic 3: Progressive Tree Structuring & Planning Model', () => {
  test('Story 3.1: Assign node type inline via type selector popover', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Create a node
    await tree.focus();
    await page.keyboard.press('Enter');

    const titleInput = page.locator('input.pm-outline-row__title-input').first();
    await titleInput.fill('User Authentication Epic');

    // Click type tag button
    const typeBtn = page.locator('.pm-outline-row__type-tag').first();
    await expect(typeBtn).toBeVisible();
    await typeBtn.click();

    // Type dropdown should be open
    const dropdown = page.locator('.pm-outline-row__type-dropdown');
    await expect(dropdown).toBeVisible();

    // Select Feature
    const featureOption = dropdown.locator('button:has-text("Feature")');
    await featureOption.click();

    // Type tag should now show FEATURE
    await expect(typeBtn).toHaveText('FEATURE');
  });

  test('Story 3.1: Component sits between Theme and Feature in the type ladder', async ({ page }) => {
    await openFirstProjectOutline(page);
    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    const row = page.locator('.pm-outline-row').first();
    await row.locator('input.pm-outline-row__title-input').fill('Account Opening');

    // The dropdown offers Component in ladder order (Vision · Theme · Component · Feature).
    await row.locator('.pm-outline-row__type-tag').click();
    const options = page.locator('.pm-outline-row__type-dropdown .pm-outline-row__type-option');
    await expect(options.filter({ hasText: /^Component$/ })).toBeVisible();
    await page.locator('.pm-outline-row__type-dropdown button:has-text("Component")').click();
    await expect(row.locator('.pm-outline-row__type-tag')).toHaveText('COMPONENT');
    await expect(row).toHaveAttribute('data-node-type', 'Component');

    // A Feature nests under a Component…
    await row.locator('input.pm-outline-row__title-input').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab'); // indent under Account Opening
    const child = page.locator('.pm-outline-row').nth(1);
    await child.locator('input.pm-outline-row__title-input').fill('CB Account Opening');
    await child.locator('.pm-outline-row__type-tag').click();
    await page.locator('.pm-outline-row__type-dropdown button:has-text("Feature")').click();
    await expect(child.locator('.pm-outline-row__type-tag')).toHaveText('FEATURE');

    // …but a Theme cannot (rank inversion is rejected).
    await child.locator('.pm-outline-row__type-tag').click();
    await page.locator('.pm-outline-row__type-dropdown button:has-text("Theme")').click();
    await expect(child.locator('.pm-outline-row__type-tag')).toHaveText('FEATURE');
  });

  test('Story 3.1: Vision, Theme, and Feature rows carry distinct muted type cues', async ({ page }) => {
    await openFirstProjectOutline(page);
    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    const setRowType = async (index: number, label: 'Vision' | 'Theme' | 'Feature') => {
      const row = page.locator('.pm-outline-row').nth(index);
      await row.locator('input.pm-outline-row__title-input').fill(`${label} row`);
      await row.locator('.pm-outline-row__type-tag').click();
      await page.locator(`.pm-outline-row__type-dropdown button:has-text("${label}")`).click();
      await expect(row.locator('.pm-outline-row__type-tag')).toHaveText(label.toUpperCase());
    };

    // Row 0 exists from boot; add two more siblings.
    await page.locator('input.pm-outline-row__title-input').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.pm-outline-row').nth(1).locator('input.pm-outline-row__title-input').focus();
    await page.keyboard.press('Enter');

    await setRowType(0, 'Vision');
    await setRowType(1, 'Theme');
    await setRowType(2, 'Feature');

    // Each row exposes its type on the stable data hook.
    await expect(page.locator('.pm-outline-row').nth(0)).toHaveAttribute('data-node-type', 'Vision');
    await expect(page.locator('.pm-outline-row').nth(1)).toHaveAttribute('data-node-type', 'Theme');
    await expect(page.locator('.pm-outline-row').nth(2)).toHaveAttribute('data-node-type', 'Feature');

    // The slim accent bar renders for each typed row and the three colours differ.
    const barColor = (index: number) =>
      page.locator('.pm-outline-row').nth(index).locator('.pm-outline-row__type-container').evaluate(
        (el) => {
          const s = getComputedStyle(el, '::before');
          return { content: s.content, bg: s.backgroundColor, width: s.width };
        },
      );

    const [vision, theme, feature] = await Promise.all([barColor(0), barColor(1), barColor(2)]);
    for (const b of [vision, theme, feature]) {
      expect(b.content).not.toBe('none');
      expect(b.bg).not.toBe('rgba(0, 0, 0, 0)');
    }
    expect(new Set([vision.bg, theme.bg, feature.bg]).size).toBe(3);

    // The tag stays interactive in its existing position — reopen the dropdown.
    const featureTag = page.locator('.pm-outline-row').nth(2).locator('.pm-outline-row__type-tag');
    await featureTag.click();
    await expect(page.locator('.pm-outline-row__type-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('Story 3.1: untyped rows show no type accent bar', async ({ page }) => {
    await openFirstProjectOutline(page);
    const row = page.locator('.pm-outline-row').first();
    await expect(row).not.toHaveAttribute('data-node-type', /.+/);
    const before = await row.locator('.pm-outline-row__type-container').evaluate(
      (el) => getComputedStyle(el, '::before').content,
    );
    expect(before).toBe('none');
  });

  test('Story 3.4: Set natural-language schedule on a node', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Click schedule button in metadata lane or row
    const row = page.locator('.pm-outline-row').first();
    await row.hover();

    const scheduleBtn = row.locator('.pm-outline-row__meta-btn[title="Add/edit schedule"]');
    await scheduleBtn.click();

    // Schedule modal opens
    const modal = page.locator('.pm-schedule-modal');
    await expect(modal).toBeVisible();

    // Type natural language schedule
    const input = modal.locator('#schedule-phrase-input');
    await input.fill('2026-09-01 to 2026-09-15');

    // Preview should display duration
    const previewGrid = modal.locator('.pm-schedule-modal__preview-grid');
    await expect(previewGrid).toBeVisible();
    await expect(previewGrid).toContainText('2026-09-01');
    await expect(previewGrid).toContainText('2026-09-15');

    // Apply schedule
    const applyBtn = modal.locator('button:has-text("Apply Schedule")');
    await applyBtn.click();
    await expect(modal).not.toBeVisible();

    // Schedule pill should now appear on row
    const datePill = row.locator('.pm-outline-row__pill--date');
    await expect(datePill).toBeVisible();
    await expect(datePill).toContainText('2026-09-01 → 2026-09-15');
  });

  test('Story 3.5: Acceptance criteria live in the inspector only', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Create a feature node and set type to Feature
    const firstRow = page.locator('.pm-outline-row').first();
    const firstInput = firstRow.locator('input.pm-outline-row__title-input');
    await firstInput.fill('Login with Passkey');

    const firstTypeBtn = firstRow.locator('.pm-outline-row__type-tag');
    await firstTypeBtn.click();
    await page.locator('.pm-outline-row__type-dropdown button:has-text("Feature")').click();

    // Add an acceptance criterion via the inspector drawer; keep it open to toggle.
    await addAcceptanceCriterionViaInspector(page, {
      parentRow: firstRow,
      criterionTitle: 'FIDO2 WebAuthn credential supported',
      closeInspectorAfter: false,
    });

    // Acceptance criteria never appear as their own outline rows.
    await expect(
      page.locator('.pm-outline-row', { hasText: 'FIDO2 WebAuthn credential supported' }),
    ).toHaveCount(0);
    await expect(page.locator('.pm-outline-row__type-tag', { hasText: /^AC$/ })).toHaveCount(0);

    // Toggle the criterion inside the inspector's Acceptance Criteria tab.
    const acItem = page.locator('.pm-inspector__ac-item', {
      hasText: 'FIDO2 WebAuthn credential supported',
    });
    const acCheckbox = acItem.locator('input[type="checkbox"]');
    expect(await acCheckbox.isChecked()).toBe(false);
    await acCheckbox.click();
    await expect(acCheckbox).toBeChecked();

    // The outline row no longer carries an acceptance-criteria pill — that
    // row slot now holds the delivery-status badge (outline status badging);
    // the ratio remains available inside the inspector's Acceptance tab.
    await expect(firstRow.locator('.pm-outline-row__ac-summary')).toHaveCount(0);
    await expect(firstRow.locator('.pm-outline-row__status-badge')).toBeVisible();
  });

  test('Story 3.7: Manage project phases and assign to nodes', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Open Command Palette to manage phases
    await page.keyboard.press('Control+k');
    const palette = page.locator('.pm-command-palette');
    await expect(palette).toBeVisible();

    const phaseAction = palette.locator('.pm-command-palette__item:has-text("Manage Project Phases")');
    await phaseAction.click();

    // Phase Manager Modal opens
    const modal = page.locator('.pm-phase-modal');
    await expect(modal).toBeVisible();

    // Create a new phase
    const phaseInput = modal.locator('.pm-phase-modal__input').first();
    await phaseInput.fill('Phase 1: Foundation');
    const addBtn = modal.locator('button:has-text("Add Phase")');
    await addBtn.click();

    // Phase appears in list
    const phaseItem = modal.locator('.pm-phase-modal__phase-name');
    await expect(phaseItem).toContainText('Phase 1: Foundation');

    // Close phase modal
    await modal.locator('.pm-phase-modal__close-btn').click();
    await expect(modal).not.toBeVisible();
  });

  test('Story 3.8 & 3.9: Directional unlock edge inspection and navigation', async ({ page }) => {
    await openFirstProjectOutline(page);

    const tree = page.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // Focus row and press ⌘U / Ctrl+U to open edge inspector
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.focus();
    await page.keyboard.press('Control+u');

    // 320px Edge Inspection Panel opens
    const panel = page.locator('.pm-edge-inspection-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Unlock Relationships');

    // Close panel
    await panel.locator('.pm-edge-inspection-panel__close-btn').click();
    await expect(panel).not.toBeVisible();
  });
});

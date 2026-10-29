import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Add an acceptance criterion to a node via the Inspector drawer's Acceptance Criteria tab.
 */
export async function addAcceptanceCriterionViaInspector(
  page: Page,
  params: {
    parentRow?: Locator;
    criterionTitle: string;
    closeInspectorAfter?: boolean;
  },
): Promise<void> {
  const { parentRow, criterionTitle, closeInspectorAfter = true } = params;

  if (parentRow) {
    const input = parentRow.locator('input.pm-outline-row__title-input');
    await input.focus();
  }

  const inspector = page.getByTestId('node-inspector');
  if (!(await inspector.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+e');
    await expect(inspector).toBeVisible();
  }

  // Switch to the Acceptance Criteria tab
  const acTab = page.getByRole('tab', { name: /Acceptance Criteria/ });
  await acTab.click();
  await expect(acTab).toHaveAttribute('aria-selected', 'true');

  // Fill in the criterion title and submit
  const acInput = page.getByRole('textbox', { name: 'New acceptance criterion' });
  await acInput.fill(criterionTitle);
  const addBtn = page.locator('.pm-inspector__ac button:has-text("Add")');
  await addBtn.click();

  // Wait for the criterion item to appear in the inspector list
  await expect(page.locator('.pm-inspector__ac-item', { hasText: criterionTitle })).toBeVisible();

  if (closeInspectorAfter) {
    const closeBtn = inspector.getByRole('button', { name: 'Close inspector' });
    await closeBtn.click();
    await expect(inspector).not.toBeVisible();
  }
}

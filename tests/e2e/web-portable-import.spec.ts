/**
 * Web build portable import: a project exported on one device can be
 * imported on another. Two isolated browser contexts stand in for two
 * devices (separate OPFS storage); the export is the real download and the
 * import goes through the side-nav Import action and a real file chooser.
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

test.describe('Web build: import a portable project', () => {
  test('the Import action is available in the browser build', async ({ page }) => {
    await openFirstProjectOutline(page);
    const importAction = page.getByTestId('import-trigger');
    await expect(importAction).toBeVisible();
    await expect(importAction).toHaveAccessibleName('Import');
  });

  test('a project exported on one device imports on another', async ({ page, browser }) => {
    // Device A: author something recognizable, then export the project.
    await openFirstProjectOutline(page);
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Travelling Vision');
    await firstInput.blur();
    await page.evaluate(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-project-trigger').click();
    const exported = await (await downloadPromise).path();

    // Device B: a separate profile with its own storage.
    const deviceB = await browser.newContext();
    try {
      const other = await deviceB.newPage();
      await openFirstProjectOutline(other);
      const shelf = other.locator('.pm-side-nav__project');
      const before = await shelf.count();

      const chooserPromise = other.waitForEvent('filechooser');
      await other.getByTestId('import-trigger').click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(false);
      await chooser.setFiles(exported);

      await other.getByRole('button', { name: 'Import project', exact: true }).click();

      await expect(other.locator('.pm-status-line-session')).toContainText('Imported "My Project"');
      await expect(shelf).toHaveCount(before + 1);

      // The imported project carries device A's authored content.
      await shelf.last().click();
      await expect(other.locator('input.pm-outline-row__title-input').first()).toHaveValue('Travelling Vision');
    } finally {
      await deviceB.close();
    }
  });

  test('cancelling the file chooser imports nothing', async ({ page }) => {
    await openFirstProjectOutline(page);
    const shelf = page.locator('.pm-side-nav__project');
    const before = await shelf.count();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByTestId('import-trigger').click();
    await (await chooserPromise).setFiles([]);
    await expect(page.locator('.pm-status-line-session')).toContainText('Import cancelled');
    await expect(shelf).toHaveCount(before);
  });
});

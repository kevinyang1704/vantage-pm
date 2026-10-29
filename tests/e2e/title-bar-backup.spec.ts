/**
 * Epic 13: Project export (portable backup) — e2e spec (Story 13.1).
 *
 * The portable-project export is surfaced directly in the side-nav Projects
 * shelf as the "Export" action, paired with "Import" so the round-trip for
 * moving a project to another installation is discoverable (it is no longer
 * hidden inside a "Project actions" overflow menu).
 *
 * Covers (E13-NFR5):
 *   - The Export action is present in the shelf whenever a project is active
 *   - It produces a valid portable file (download captured and validated
 *     through the real schema parser)
 *   - The status line reports the created file (polite live region)
 *   - No unexpected network request
 */

import { expect, test } from '../support/fixtures';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

// The app's own origin, however it is served: a request to anything else is
// the 'unexpected network request' this spec exists to catch. Read from
// BASE_URL like the navigation helper, or a worktree run on another port
// would report every one of the app's own requests as a leak.
const APP_ORIGIN = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:5173');
const APP_ORIGINS = [APP_ORIGIN.origin, `${APP_ORIGIN.protocol}//localhost:${APP_ORIGIN.port}`];

test.describe('Epic 13: Project export / portable backup (Story 13.1)', () => {
  test('the Export action is surfaced in the shelf next to Import', async ({ page }) => {
    await openFirstProjectOutline(page);

    const exportAction = page.getByTestId('export-project-trigger');
    await expect(exportAction).toBeVisible();
    await expect(exportAction).toHaveAccessibleName('Export project');
  });

  test('exporting produces a download with a valid portable v2 envelope and no network requests', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!APP_ORIGINS.some((origin) => url.startsWith(origin))) {
        requests.push(url);
      }
    });

    await openFirstProjectOutline(page);

    // Name the boot node so the envelope carries an authored title.
    const firstInput = page.locator('input.pm-outline-row__title-input').first();
    await firstInput.fill('Backup Vision');
    await firstInput.blur();

    // Force the download-fallback save strategy: headless Chromium cannot
    // open the File System Access picker, so delete showSaveFilePicker before
    // the strategy probe runs (saveGeneratedFile probes at call time).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).showSaveFilePicker;
    });

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-project-trigger').click();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    // The export names the PROJECT (boot default "My Project"), not the node.
    expect(filename).toMatch(/^my-project\.pmapp\.json$/);
    expect(filename.endsWith('.pmapp.json')).toBe(true);

    // Validate the downloaded bytes through the real schema parser.
    const stream = await download.createReadStream();
    let raw = '';
    for await (const chunk of stream) {
      raw += chunk.toString('utf8');
    }
    const { parsePortableFile } = await import('../../src/contracts/portable-file.schema');
    const parsed = parsePortableFile(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.schemaVersion === 2) {
      expect(parsed.value.project.name).toBe('My Project');
      // The authored node title is included as a durable fact.
      expect(parsed.value.nodes.some((n) => n.title === 'Backup Vision')).toBe(true);
    }

    // Status line reports the created file (polite live region).
    await expect(page.locator('.pm-status-line-session')).toContainText('Portable project file created');

    expect(requests, `unexpected off-origin requests: ${requests.join(', ')}`).toHaveLength(0);
  });
});

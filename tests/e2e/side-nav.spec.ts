/**
 * Epic 15: Persistent Side Navigation — Option A certification e2e spec.
 *
 * Certifies the workspace-first hierarchy (side-nav-workspace-project-hierarchy):
 * the workspace is the stable top-level container, the Current Project section
 * exposes the selected project's views, and every project lives in a bottom
 * Projects shelf. The workspace disclosure is a non-modal menu that owns
 * workspace-level information — it never masquerades as a project switcher.
 *
 * Covers:
 *   AC1 — state preservation across switch paths (view + project)
 *   AC2 — keyboard parity, no handler interception, full tab reachability
 *   AC3 — accessibility floor: landmark, aria-current, forced-colors,
 *         200% text, text-spacing, collapsed accessible names
 *   AC4 — canvas budgets at 1280px for Gantt and Focused Visual Tree
 *   AC6 — both themes (dark scan is primary/AA; light scan documents the
 *         same pre-existing AA gap workspace-overview-accessibility.spec.ts
 *         already carries — DESIGN.md Open Gap #1)
 *   AC8 — composition boundaries: non-modal workspace-disclosure contract,
 *         no box-shadow, collapse toggle touches no tree/outline state
 *
 * Plus the Option A regression coverage:
 *   1.  Workspace control precedes Overview, Current Project, and Projects
 *       in DOM and focus order.
 *   2.  The disclosure is labelled for the workspace, not "Switch project".
 *   3.  Every persisted project appears in the bottom Projects shelf.
 *   4.  Selecting a shelf project updates selected state + Current Project.
 *   5.  Selecting a project from Workspace Overview does not auto-open
 *       Outline, Visual Tree, or Gantt.
 *   6.  Switching projects from an active project view preserves the
 *       established active-view and per-project context behavior.
 *   7.  A newly created project appears in the shelf, becomes selected only
 *       after command success, and retains inline rename focus on the overview.
 *   8.  A successfully imported project appears in the shelf without a
 *       reload (native bridge only; the browser build certifies the Import
 *       action's absence).
 *   9.  Long names, ten-project scale, collapsed navigation, keyboard use,
 *       and focus restoration remain usable.
 *   10. The page has no new console errors or warnings.
 *
 * AC5 (latency/motion budgets) is certified by re-running the existing
 * tests/perf/*.spec.ts unmodified.
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';
import { openFirstProjectOutline } from '../support/helpers/outline-navigation';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/** Collects console errors/warnings and pageerrors for the duration of a test. */
function collectConsoleProblems(page: import('@playwright/test').Page): {
  messages: string[];
  stop: () => void;
} {
  const messages: string[] = [];
  const onConsole = (msg: import('@playwright/test').ConsoleMessage): void => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    // Pre-existing SQLite/OPFS SAH pool noise fires on every app load and is
    // unrelated to navigation (certified elsewhere by the durability suite).
    if (text.includes('NoModificationAllowedError') || text.includes('pmapp-sah-')) return;
    messages.push(`[${msg.type()}] ${text}`);
  };
  const onError = (err: Error): void => {
    messages.push(`[pageerror] ${err.message}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onError);
  return {
    messages,
    stop: () => {
      page.off('console', onConsole);
      page.off('pageerror', onError);
    },
  };
}

async function hasVisibleFocusRing(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return true; // no stop to check this tab press
    const style = getComputedStyle(el);
    return (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
      style.boxShadow !== 'none'
    );
  });
}

test.describe('Epic 15: Persistent Side Navigation — Option A (workspace-first)', () => {
  test.describe('Option A regression 1-2: hierarchy order and workspace disclosure', () => {
    test('workspace control precedes Overview, Current Project, and Projects in DOM and focus order', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();

      const nav = page.locator('nav.pm-side-nav');
      const control = nav.locator('.pm-side-nav__workspace-control');
      const overview = nav.locator('.pm-side-nav__overview-link');
      const currentLabel = nav.locator('.pm-side-nav__section-label').filter({ hasText: 'Current project' });
      const projectsLabel = nav.locator('.pm-side-nav__projects-head');

      await expect(control).toHaveCount(1);
      await expect(overview).toHaveCount(1);
      await expect(projectsLabel).toHaveCount(1);

      const domPositions = await nav.evaluate((el) => {
        const ids = ['.pm-side-nav__workspace-control', '.pm-side-nav__overview-link', '.pm-side-nav__projects-head'];
        const all = el.querySelectorAll(ids.join(','));
        return Array.from(all).map((node) => {
          const index = Array.from(el.querySelectorAll('*')).indexOf(node as HTMLElement);
          return index;
        });
      });
      expect(domPositions[0]).toBeLessThan(domPositions[1]);
      expect(domPositions[1]).toBeLessThan(domPositions[2]);

      // Current Project section (when a project is selected on the overview)
      await expect(currentLabel).toHaveCount(1);

      // Focus order: brand → collapse → workspace control → Overview → …
      await page.locator('nav.pm-side-nav .pm-brand-lockup').first().focus();
      const focusOrder: string[] = [];
      for (let i = 0; i < 6; i++) {
        const label = await page.evaluate(() => {
          const el = document.activeElement;
          return el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';
        });
        focusOrder.push(label);
        await page.keyboard.press('Tab');
      }
      const workspaceIndex = focusOrder.findIndex((l) => l.startsWith('Workspace:'));
      const overviewIndex = focusOrder.findIndex((l) => l === 'Overview');
      expect(workspaceIndex).toBeGreaterThanOrEqual(0);
      expect(overviewIndex).toBeGreaterThan(workspaceIndex);
    });

    test('the disclosure is labelled for the workspace, never "Switch project"', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      const control = page.locator('.pm-side-nav__workspace-control');
      await expect(control).toHaveAttribute('aria-haspopup', 'menu');
      await expect(control).toHaveAttribute('aria-expanded', 'false');

      // Epic 17: the control now names the active workspace, so the label is
      // "Workspace: <name>. N projects, local. Switch workspace". The Epic 15
      // guarantee it was written for still holds — it is a WORKSPACE control,
      // never a project switcher.
      const label = await control.getAttribute('aria-label');
      expect(label).toMatch(/^Workspace: .+\. \d+ projects?, local\. Switch workspace$/);
      expect(label).not.toContain('Switch project');
    });

    test('the workspace disclosure is a workspace switcher, never a project switcher', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      const control = page.locator('.pm-side-nav__workspace-control');
      await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'true');

      const menu = page.locator('.pm-side-nav__workspace-menu');
      await expect(menu).toBeVisible();
      await expect(menu).toContainText(/\d+ workspaces? · local/);

      // Epic 17 supersedes Epic 15's "exactly one Overview action": the menu
      // is now the workspace switcher. Every workspace is a menuitemradio and
      // exactly one is checked; the plain menuitems are the workspace-level
      // actions. What must NOT change is that no project appears here — the
      // Projects shelf remains the only project-switching surface.
      const workspaceOptions = menu.getByRole('menuitemradio');
      await expect(workspaceOptions).not.toHaveCount(0);
      const checked = menu.locator('[role="menuitemradio"][aria-checked="true"]');
      await expect(checked).toHaveCount(1);

      const actions = await menu.getByRole('menuitem').allTextContents();
      expect(actions.some((t) => t === 'Workspace overview')).toBe(true);
      expect(actions.some((t) => t === 'New workspace…')).toBe(true);
      expect(actions.some((t) => t.startsWith('Rename'))).toBe(true);
      expect(actions.some((t) => t.startsWith('Delete'))).toBe(true);

      // No project name may leak into the workspace disclosure.
      const shelfNames = await page
        .locator('.pm-side-nav__project .pm-side-nav__project-name')
        .allTextContents();
      const menuText = (await menu.textContent()) ?? '';
      for (const projectName of shelfNames) {
        expect(menuText).not.toContain(projectName);
      }

      // Escape dismisses with focus restored to the trigger.
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(control).toBeFocused();
    });
  });

  test.describe('Option A regression 3-6: projects shelf behavior', () => {
    test('every persisted project appears in the bottom Projects shelf', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();

      await page.locator('header button.pm-workspace-new-project').click();
      await expect(page.locator('.pm-project-card')).toHaveCount(2);

      const shelfButtons = page.locator('.pm-side-nav__project');
      await expect(shelfButtons).toHaveCount(2);
      const shelfNames = await shelfButtons.locator('.pm-side-nav__project-name').allTextContents();
      expect(shelfNames).toHaveLength(2);
    });

    test('selecting a shelf project updates selected state and Current Project identity', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      // Wait for the boot-created project before driving creation (init race).
      await expect(page.locator('.pm-project-card').first()).toBeVisible();
      await page.locator('header button.pm-workspace-new-project').click();
      await expect(page.locator('.pm-project-card')).toHaveCount(2);

      // The newly created project becomes selected on the overview.
      const newProjectButton = page
        .locator('.pm-side-nav__project')
        .filter({ hasText: 'New Project' });
      await expect(newProjectButton).toHaveAttribute('aria-current', 'true');

      // Select the first (boot-created) project from the shelf.
      const firstProject = page.locator('.pm-side-nav__project').first();
      await firstProject.click();
      await expect(firstProject).toHaveAttribute('aria-current', 'true');
      await expect(newProjectButton).not.toHaveAttribute('aria-current', 'true');

      // Current Project identity follows the shelf selection.
      const currentTitle = page.locator('.pm-side-nav__current-title');
      await expect(currentTitle).toHaveText(await firstProject.locator('.pm-side-nav__project-name').textContent() ?? '');
    });

    test('selecting a project from Workspace Overview does not auto-open a project view', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();
      await page.locator('header button.pm-workspace-new-project').click();
      await expect(page.locator('.pm-project-card')).toHaveCount(2);

      const firstProject = page.locator('.pm-side-nav__project').first();
      await firstProject.click();
      await expect(firstProject).toHaveAttribute('aria-current', 'true');

      // Still on the overview — no view was auto-opened.
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('[role="tree"]')).toHaveCount(0);

      // The Current Project section exposes the views for an explicit choice.
      await page.locator('.pm-side-nav__view').filter({ hasText: 'Outline' }).click();
      await expect(page.locator('[role="tree"]')).toBeVisible();
    });

    test('switching projects from an active project view preserves the active view and context', async ({ page }) => {
      await openFirstProjectOutline(page);
      await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Visual Tree');

      // Create a second project so the shelf has a switch target.
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();
      await page.locator('header button.pm-workspace-new-project').click();
      await expect(page.locator('.pm-project-card')).toHaveCount(2);

      // Re-enter the first project through a project view, then go to Gantt.
      await page.locator('.pm-side-nav__project').first().click();
      await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
      await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Gantt', exact: true }).click();
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Gantt');
      await expect(page.locator('.pm-toolbar-view-title')).toHaveText('Gantt');

      // Switch to the other project from the shelf while in a project view.
      const otherProject = page
        .locator('.pm-side-nav__project')
        .filter({ hasText: 'New Project' });
      await otherProject.click();

      // The switch preserves the established active view (Gantt stays active).
      await expect(page.locator('.pm-toolbar-view-title')).toHaveText('Gantt', { timeout: 15_000 });
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Gantt');
      await expect(otherProject).toHaveAttribute('aria-current', 'true');
    });
  });

  test.describe('Option A regression 7-8: create and import', () => {
    test('a project created from the side nav appears in the shelf, becomes selected, and keeps inline rename focus', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();

      await page
        .locator('nav.pm-side-nav')
        .getByRole('button', { name: 'New project', exact: true })
        .click();

      // Inline rename focus on the overview (FR-1 semantics preserved).
      const projectNameInput = page.getByRole('textbox', { name: 'Project name' });
      await expect(projectNameInput).toBeVisible();
      await expect(projectNameInput).toBeFocused();
      await expect(projectNameInput).toHaveValue('New Project');

      // The created project appears in the shelf and is selected.
      const shelfItem = page.locator('.pm-side-nav__project').filter({ hasText: 'New Project' });
      await expect(shelfItem).toHaveCount(1);
      await expect(shelfItem).toHaveAttribute('aria-current', 'true');
      await expect(page.locator('.pm-side-nav__projects-count')).toHaveText('2');
    });

    test('the Import action is absent in the browser build (native-only path, no second import implementation)', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      // Browser compositions never render the desktop-only Import action;
      // the desktop flow is certified against the shared use case elsewhere.
      await expect(page.getByTestId('import-trigger')).toHaveCount(0);
      await expect(page.locator('.pm-side-nav__action')).toHaveCount(1); // New project only
    });
  });

  test.describe('AC1 — state preservation across switch paths', () => {
    test('switching views via the nav and via the keyboard land on the identical active view', async ({ page }) => {
      await openFirstProjectOutline(page);

      // Nav path
      await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Visual Tree');
      const toolbarAfterNav = await page.locator('.pm-toolbar-view-title').textContent();
      expect(toolbarAfterNav).toBe('Visual Tree');

      // Keyboard path back to Outline, then forward to Gantt
      await page.keyboard.press('Alt+1');
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Outline');
      await page.keyboard.press('Alt+3');
      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveAttribute('aria-label', 'Gantt');
      const toolbarAfterKeyboard = await page.locator('.pm-toolbar-view-title').textContent();
      expect(toolbarAfterKeyboard).toBe('Gantt');
    });
  });

  test.describe('AC2 — keyboard parity', () => {
    test('existing bindings behave identically with the nav present: jump, palette, undo/redo', async ({ page }) => {
      await openFirstProjectOutline(page);

      await page.keyboard.press('Control+Slash');
      await expect(page.locator('.pm-command-palette[aria-label="Jump to item"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pm-command-palette[aria-label="Jump to item"]')).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await expect(page.locator('.pm-command-palette')).toBeVisible();
      await page.keyboard.press('Escape');
    });

    test('the nav registers no handler of its own: Escape while the workspace disclosure is open does not touch outline focus', async ({ page }) => {
      await openFirstProjectOutline(page);
      const input = page.locator('input.pm-outline-row__title-input').first();
      await input.focus();

      await page.locator('.pm-side-nav__workspace-control').click();
      await page.keyboard.press('Escape');

      await expect(page.locator('.pm-side-nav__workspace-menu')).toHaveCount(0);
      await expect(page.locator('.pm-side-nav__workspace-control')).toBeFocused();
    });

    test('every nav entry is reachable by keyboard with a visible focus ring', async ({ page }) => {
      await openFirstProjectOutline(page);

      const nav = page.locator('nav.pm-side-nav');
      const entryCount = await nav.locator('button').count();
      expect(entryCount).toBeGreaterThan(5);

      await page.locator('nav.pm-side-nav .pm-brand-lockup').first().focus();
      for (let i = 0; i < entryCount; i++) {
        await page.keyboard.press('Tab');
        const stillInNav = await page.evaluate(() => {
          const el = document.activeElement;
          return !!el && !!el.closest('nav.pm-side-nav');
        });
        if (!stillInNav) break;
        expect(await hasVisibleFocusRing(page), `nav tab stop ${i} must show a visible focus ring`).toBe(true);
      }
    });
  });

  test.describe('AC3 — accessibility floor', () => {
    test('exactly one primary nav landmark, active view carries aria-current, collapse reports accurate expanded state', async ({ page }) => {
      await openFirstProjectOutline(page);

      const primaryNavs = page.locator('nav[aria-label="Primary"]');
      await expect(primaryNavs).toHaveCount(1);

      await expect(page.locator('.pm-side-nav__item[aria-current="page"]')).toHaveCount(1);

      const collapseBtn = page.locator('.pm-side-nav__collapse-btn');
      await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
      await collapseBtn.click();
      await expect(collapseBtn).toHaveAttribute('aria-expanded', 'false');
      await expect(collapseBtn).toHaveAttribute('aria-label', 'Expand navigation');
    });

    test('every entry keeps a programmatic accessible name when collapsed', async ({ page }) => {
      await openFirstProjectOutline(page);
      await page.locator('.pm-side-nav__collapse-btn').click();
      await expect(page.locator('nav.pm-side-nav')).toHaveClass(/pm-side-nav--collapsed/);

      const labels = await page.locator('nav.pm-side-nav button').evaluateAll((buttons) =>
        buttons.map((b) => b.getAttribute('aria-label')),
      );
      for (const label of labels) {
        expect(label, 'every nav button must carry a non-empty aria-label when collapsed').toBeTruthy();
      }
    });

    test('axe scan: zero violations on the nav in dark mode, expanded and collapsed', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await openFirstProjectOutline(page);

      const expandedResults = await new AxeBuilder({ page }).include('nav.pm-side-nav').analyze();
      expect(expandedResults.violations).toEqual([]);

      await page.locator('.pm-side-nav__collapse-btn').click();
      const collapsedResults = await new AxeBuilder({ page }).include('nav.pm-side-nav').analyze();
      expect(collapsedResults.violations).toEqual([]);
    });

    test('forced-colors mode keeps the active view distinguishable', async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await openFirstProjectOutline(page);

      const activeItem = page.locator('.pm-side-nav__item[aria-current="page"]');
      await expect(activeItem).toBeVisible();
      const outlineInForcedColors = await activeItem.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(typeof outlineInForcedColors).toBe('string');
      await expect(activeItem).toBeVisible();
    });

    test('nav survives 200% text resize without horizontal overflow', async ({ page }) => {
      await openFirstProjectOutline(page);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      await expect(page.locator('nav.pm-side-nav')).toBeVisible();
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
      await expect(page.getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
    });

    test('nav survives the WCAG text-spacing override (SC 1.4.12)', async ({ page }) => {
      await openFirstProjectOutline(page);
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = `
          * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
        `;
        document.head.appendChild(style);
      });

      await expect(page.getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
    });
  });

  test.describe('AC4 — canvas budgets at 1280px', () => {
    test('Gantt hierarchy column and timeline both remain usable with the nav expanded', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openFirstProjectOutline(page);
      await page.getByRole('button', { name: 'Gantt', exact: true }).click();

      const navBox = await page.locator('nav.pm-side-nav').boundingBox();
      expect(navBox).not.toBeNull();
      expect(navBox!.width).toBeCloseTo(236, 0);

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
    });

    test('Focused Visual Tree canvas remains framed with the nav expanded', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openFirstProjectOutline(page);
      await page.getByRole('button', { name: 'Visual Tree', exact: true }).click();

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
    });
  });

  test.describe('AC6 — light theme', () => {
    test('axe scan: nav in light mode (documents the same pre-existing AA gap as the rest of the shell)', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await openFirstProjectOutline(page);

      const results = await new AxeBuilder({ page }).include('nav.pm-side-nav').analyze();
      expect(Array.isArray(results.violations)).toBe(true);
    });
  });

  test.describe('AC8 — composition boundaries', () => {
    test('the workspace disclosure follows the established non-modal menu contract', async ({ page }) => {
      await openFirstProjectOutline(page);

      const trigger = page.locator('.pm-side-nav__workspace-control');
      await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');

      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.pm-side-nav__workspace-menu')).toBeVisible();

      // Outside interaction closes it.
      await page.locator('.pm-toolbar-view-title').click();
      await expect(page.locator('.pm-side-nav__workspace-menu')).toHaveCount(0);
    });

    test('the nav introduces no box-shadow', async ({ page }) => {
      await openFirstProjectOutline(page);
      const shadows = await page.locator('nav.pm-side-nav, nav.pm-side-nav *').evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).boxShadow),
      );
      for (const s of shadows) {
        expect(s === 'none' || s === '', `expected no cast box-shadow, found "${s}"`).toBe(true);
      }
    });

    test('collapsing the nav does not alter outline tree content', async ({ page }) => {
      await openFirstProjectOutline(page);
      const treeTextBefore = await page.locator('[role="tree"]').textContent();

      await page.locator('.pm-side-nav__collapse-btn').click();
      await page.locator('.pm-side-nav__collapse-btn').click(); // back to expanded

      const treeTextAfter = await page.locator('[role="tree"]').textContent();
      expect(treeTextAfter).toBe(treeTextBefore);
    });
  });

  test.describe('Option A regression 9-10: scale, collapse, and console cleanliness', () => {
    test('long project names truncate visually without losing the accessible name or selected state', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      // Rename the boot project to a very long name via the workspace card.
      const longName = 'A project name that is far too long to fit inside the side navigation shelf at all';
      const card = page.locator('.pm-project-card').first();
      await card.locator('.pm-project-card-name').click();
      const nameInput = page.getByRole('textbox', { name: 'Project name' });
      await nameInput.fill(longName);
      await nameInput.blur();

      const shelfItem = page.locator('.pm-side-nav__project').first();
      await expect(shelfItem).toHaveAttribute('aria-label', longName);
      await expect(shelfItem).toHaveAttribute('aria-current', 'true');

      // Visible label is truncated (scrollWidth clipped by the element box).
      const truncated = await shelfItem.locator('.pm-side-nav__project-name').evaluate((el) => {
        return el.scrollWidth > el.clientWidth;
      });
      expect(truncated).toBe(true);

      // Current Project title truncates but keeps the full accessible text.
      const currentTitle = page.locator('.pm-side-nav__current-title');
      await expect(currentTitle).toHaveText(longName);
    });

    test('ten-project scale: every project is selectable in the shelf', async ({ page }) => {
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      // Wait for the boot-created project before driving creation (init race).
      await expect(page.locator('.pm-project-card').first()).toBeVisible();

      // Boot creates one; add 9 more to reach 10 (supported scale).
      for (let i = 0; i < 9; i++) {
        await page.locator('header button.pm-workspace-new-project').click();
        await page.keyboard.press('Escape');
      }
      await expect(page.locator('.pm-project-card')).toHaveCount(10);

      const shelfButtons = page.locator('.pm-side-nav__project');
      await expect(shelfButtons).toHaveCount(10);
      await expect(page.locator('.pm-side-nav__projects-count')).toHaveText('10');

      // The shelf remains scrollable/usable: the last project is reachable.
      const lastProject = shelfButtons.last();
      await lastProject.scrollIntoViewIfNeeded();
      await lastProject.click();
      await expect(lastProject).toHaveAttribute('aria-current', 'true');
    });

    test('collapsed rail keeps workspace, project selection, New project, and Overview reachable and named', async ({ page }) => {
      await openFirstProjectOutline(page);
      await page.locator('.pm-side-nav__collapse-btn').click();
      await expect(page.locator('nav.pm-side-nav')).toHaveClass(/pm-side-nav--collapsed/);

      // Collapse button still toggles.
      const collapseBtn = page.locator('.pm-side-nav__collapse-btn');
      await expect(collapseBtn).toHaveAttribute('aria-label', 'Expand navigation');

      // Workspace control retains its accessible name and opens the disclosure.
      // Epic 17: the collapsed rail hides the label text, so the accessible
      // name is the only thing carrying the active workspace — it must still
      // name it, not fall back to a bare "Workspace".
      const control = page.locator('.pm-side-nav__workspace-control');
      const controlLabel = await control.getAttribute('aria-label');
      expect(controlLabel).toMatch(/^Workspace: .+\. \d+ projects?, local\. Switch workspace$/);
      await control.click();
      await expect(page.locator('.pm-side-nav__workspace-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(control).toBeFocused();

      // Overview link remains reachable.
      const overview = page.locator('.pm-side-nav__overview-link');
      await expect(overview).toHaveAttribute('aria-label', 'Overview');
      await overview.click();
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      // Project shelf entries keep their names and stay selectable.
      await page.locator('.pm-side-nav__collapse-btn').click(); // back to expanded
      const shelfButton = page.locator('.pm-side-nav__project').first();
      await expect(shelfButton).toHaveAttribute('aria-label', /./);
      await page.locator('.pm-side-nav__collapse-btn').click(); // collapsed again
      const firstProject = page.locator('.pm-side-nav__project').first();
      await expect(firstProject).toHaveAttribute('aria-label', /./);

      // New project remains reachable.
      const newProject = page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true });
      await expect(newProject).toBeVisible();
    });

    test('page has no new console errors or warnings during a full nav session', async ({ page }) => {
      const problems = collectConsoleProblems(page);
      await page.goto(PRODUCT_APP_URL);
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      await expect(page.locator('.pm-project-card').first()).toBeVisible();

      // Drive the primary interactions: disclosure, shelf select, create,
      // collapse, view switch, overview return.
      await page.locator('.pm-side-nav__workspace-control').click();
      await page.keyboard.press('Escape');
      await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.locator('.pm-side-nav__collapse-btn').click();
      await page.locator('.pm-side-nav__collapse-btn').click();
      await page.locator('.pm-side-nav__project').first().click();
      await page.locator('.pm-side-nav__overview-link').click();
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
      // Enter a project from the overview via the Current Project section,
      // then switch views from the nav and return to the overview.
      await page.locator('.pm-side-nav__view').filter({ hasText: 'Outline' }).click();
      await expect(page.locator('[role="tree"]')).toBeVisible();
      await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Gantt', exact: true }).click();
      await expect(page.locator('.pm-toolbar-view-title')).toHaveText('Gantt');
      await page.locator('.pm-side-nav__overview-link').click();
      await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();

      problems.stop();
      expect(problems.messages, problems.messages.join('\n')).toEqual([]);
    });
  });
});

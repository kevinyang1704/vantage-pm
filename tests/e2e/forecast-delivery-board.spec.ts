/**
 * Delivery Board browser certification.
 *
 * Covers the default board surface: milestone ships, ranked cards, board
 * setup, adding/estimating from the compact Backlog, dragging cards into
 * sprints (capacity and blocker rules), per-sprint capacity, and the
 * Board/List switch.
 */

import { expect, test } from '../support/fixtures';
import AxeBuilder from '@axe-core/playwright';

const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const boardUrl = new URL(PRODUCT_APP_URL);
boardUrl.searchParams.set('forecastView', 'board');
const BOARD_APP_URL = boardUrl.toString();

test.use({ forecastView: 'board' });

async function waitForProjectRevisionAdvance(
  page: import('@playwright/test').Page,
  action: () => Promise<void>,
): Promise<void> {
  const tree = page.locator('[role="tree"]');
  const before = Number(await tree.getAttribute('data-project-revision'));
  await action();
  await expect.poll(async () => Number(await tree.getAttribute('data-project-revision'))).toBeGreaterThan(before);
}

async function setupThreeFeatures(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BOARD_APP_URL);
  await expect(page.getByText('Storage Available')).toBeVisible({ timeout: 30_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'New project', exact: true }).click();
  // The new project becomes current asynchronously; wait for it before opening a view.
  await expect(page.locator('.pm-side-nav__current-title')).toHaveText('New Project', { timeout: 30_000 });
  const outlineNav = page.locator('.pm-side-nav__item[aria-label="Outline"]');
  await outlineNav.waitFor({ state: 'visible', timeout: 30_000 });
  await outlineNav.click();
  await expect(page.locator('[role="tree"]')).toBeVisible();

  const addFirstNode = page.getByRole('button', { name: '+ Add node', exact: true });
  if (await addFirstNode.isVisible()) {
    await waitForProjectRevisionAdvance(page, () => addFirstNode.click());
  }

  const firstInput = page.locator('input.pm-outline-row__title-input').first();
  await firstInput.fill('Feature Alpha');
  await waitForProjectRevisionAdvance(page, () => firstInput.blur());
  await page.getByRole('button', { name: 'NO TYPE' }).first().click();
  await waitForProjectRevisionAdvance(page, () => page.getByRole('button', { name: 'Feature', exact: true }).click());

  await firstInput.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row2Input = page.locator('.pm-outline-row').nth(1).locator('input.pm-outline-row__title-input');
  await row2Input.fill('Feature Beta');
  await waitForProjectRevisionAdvance(page, () => row2Input.blur());

  await row2Input.focus();
  await waitForProjectRevisionAdvance(page, () => page.keyboard.press('Enter'));
  const row3Input = page.locator('.pm-outline-row').nth(2).locator('input.pm-outline-row__title-input');
  await row3Input.fill('Feature Gamma');
  await waitForProjectRevisionAdvance(page, () => row3Input.blur());

  await page.getByRole('button', { name: 'Forecast', exact: true }).click();
}

/** Today in the browser's local calendar: the board starts at the sprint holding it. */
function localTodayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function configureBoard(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Points per sprint').fill('10');
  await page.getByLabel('Sprint length (days)').fill('14');
  await page.getByLabel('Start sprint').fill('12');
  await page.getByLabel('First date').fill(localTodayIso());
  await page.getByRole('button', { name: 'Save baseline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery board' })).toBeVisible();
}

async function addFeatureFromBoardBacklog(
  page: import('@playwright/test').Page,
  title: string,
  points: string,
): Promise<void> {
  // Estimate it in the Backlog first: an unestimated item cannot take a sprint.
  const row = page.locator('.pm-delivery__backlog-card', { hasText: title });
  const pointsInput = row.getByRole('spinbutton', { name: `Points for ${title}` });
  await pointsInput.fill(points);
  await pointsInput.blur();
  await expect(pointsInput).toHaveValue(points);
  await page.getByRole('button', { name: `Add ${title} to the plan` }).click();
  // Added work waits in the Backlog until it is dragged into a sprint.
  await expect(page.locator('.pm-delivery__backlog-card.is-ready', { hasText: title })).toBeVisible({ timeout: 15_000 });
}

const sprintColumn = (page: import('@playwright/test').Page, n: number) =>
  page.locator(`section.pm-delivery__column[aria-label^="Sprint ${n},"]`);

/** Drag a Backlog row into a sprint and wait for the card to land there. */
async function scheduleFromBacklog(page: import('@playwright/test').Page, title: string, sprint: number): Promise<void> {
  const row = page.locator('.pm-delivery__backlog-card', { hasText: title }).first();
  await nativeDrag(page, row, sprintColumn(page, sprint), { x: 60, y: 90 });
  await expect(sprintColumn(page, sprint).locator('article.pm-delivery__card', { hasText: title })).toBeVisible({ timeout: 15_000 });
}

/** Alpha (10) in Sprint 12, Beta (20) in 13-14, Gamma (30) in 15-17. */
async function scheduleThree(page: import('@playwright/test').Page): Promise<void> {
  await scheduleFromBacklog(page, 'Feature Alpha', 12);
  await scheduleFromBacklog(page, 'Feature Beta', 13);
  await scheduleFromBacklog(page, 'Feature Gamma', 15);
  await expect(page.locator('.pm-delivery__launch').getByText('Sprint 17')).toBeVisible({ timeout: 15_000 });
}

/**
 * Native HTML5 drag with intermediate pointer moves. Locator.dragTo jumps
 * straight to the target, which does not start a native drag on this board.
 */
async function nativeDrag(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
  targetOffset?: { x: number; y: number },
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Drag source or target is not visible');
  // Grab a third of the way in: a horizontally scrolled board can clip the
  // source's left edge, and the far right is the points field.
  await page.mouse.move(from.x + from.width * 0.3, from.y + Math.min(from.height / 2, 14));
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2 + 10, { steps: 5 });
  const x = to.x + (targetOffset?.x ?? to.width / 2);
  const y = to.y + (targetOffset?.y ?? to.height / 2);
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

test('board setup, shipping milestones, ranks and view switch', async ({ page }) => {
  await setupThreeFeatures(page);
  await configureBoard(page);

  await expect(page.getByText('What ships').first()).toBeVisible();
  await expect(page.getByText('Nothing scheduled').first()).toBeVisible();

  await addFeatureFromBoardBacklog(page, 'Feature Alpha', '10');
  await addFeatureFromBoardBacklog(page, 'Feature Beta', '20');
  await addFeatureFromBoardBacklog(page, 'Feature Gamma', '30');
  await expect(page.locator('.pm-delivery__launch').getByText('Nothing scheduled')).toBeVisible();
  await expect(page.locator('article.pm-delivery__card')).toHaveCount(0);

  await scheduleThree(page);
  await expect(page.locator('article.pm-delivery__card .pm-delivery__rank')).toHaveText(['01', '02', '03']);
  await expect(page.getByText('01 → 03')).toBeVisible();
  await expect(page.locator('.pm-delivery__ships-pill', { hasText: 'Ships' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Later sprints →' }).click();
  await expect(page.locator('section.pm-delivery__column[aria-label^="Sprint 16,"]')).toBeVisible();

  // Trade-offs and scenarios live in List view; the board is for hand planning.
  await expect(page.getByText('Trade-offs')).toHaveCount(0);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Forecast planning list' })).toBeVisible();
  await page.getByRole('button', { name: 'Delivery board', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivery board' })).toBeVisible();
});

test('drag cards into sprints: a full sprint and a blocked card are refused; a sprint keeps its own capacity', async ({ page }) => {
  await setupThreeFeatures(page);
  await configureBoard(page);
  await addFeatureFromBoardBacklog(page, 'Feature Alpha', '10');
  await addFeatureFromBoardBacklog(page, 'Feature Beta', '20');
  await addFeatureFromBoardBacklog(page, 'Feature Gamma', '30');

  const sprint = (n: number) => sprintColumn(page, n);
  const card = (title: string) => page.locator('article.pm-delivery__card', { hasText: title });
  const banner = page.locator('.pm-delivery__banner');

  // Nothing is in a sprint until it is dragged in.
  await expect(page.locator('article.pm-delivery__card')).toHaveCount(0);
  await expect(page.locator('.pm-delivery__launch').getByText('Nothing scheduled')).toBeVisible();

  // Beta (20) fills Sprint 12 and carries into Sprint 13.
  await scheduleFromBacklog(page, 'Feature Beta', 12);
  await expect(sprint(12).locator('.pm-delivery__full-chip')).toBeVisible();

  // A full sprint refuses more work; Gamma stays in the Backlog.
  await nativeDrag(page, page.locator('.pm-delivery__backlog-card', { hasText: 'Feature Gamma' }), sprint(12), { x: 60, y: 90 });
  await expect(banner).toContainText('Sprint 12 is full');
  await expect(card('Feature Gamma')).toHaveCount(0);
  await expect(page.locator('.pm-delivery__backlog-card.is-ready', { hasText: 'Feature Gamma' })).toBeVisible();

  // A blocked card leaves its sprint and cannot be dropped back in.
  await scheduleFromBacklog(page, 'Feature Alpha', 14);
  await card('Feature Alpha').getByRole('button', { name: 'Block', exact: true }).click();
  const held = page.locator('.pm-delivery__backlog-card.is-held', { hasText: 'Feature Alpha' });
  await expect(held).toContainText('Blocked', { timeout: 15_000 });
  await nativeDrag(page, held, sprint(15), { x: 60, y: 90 });
  await expect(banner).toContainText('Clear the blocker');

  // One sprint gets its own capacity.
  await sprint(15).locator('.pm-delivery__capacity-button').click();
  await sprint(15).getByLabel('Capacity for Sprint 15').fill('4');
  await sprint(15).getByLabel('Capacity for Sprint 15').press('Enter');
  await expect(sprint(15).locator('.pm-delivery__capacity-button')).toContainText('/ 4 pts', { timeout: 15_000 });

  // Taking an item out of the plan also takes it out of its sprint: added
  // back, it waits in the Backlog instead of reappearing in its old sprint.
  await card('Feature Beta').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(card('Feature Beta')).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'Add Feature Beta to the plan' }).click();
  await expect(page.locator('.pm-delivery__backlog-card.is-ready', { hasText: 'Feature Beta' })).toBeVisible({ timeout: 15_000 });
  await expect(card('Feature Beta')).toHaveCount(0);
});

test('board has no automated accessibility violations in dark and light modes', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await setupThreeFeatures(page);
  await configureBoard(page);
  await addFeatureFromBoardBacklog(page, 'Feature Alpha', '10');
  await addFeatureFromBoardBacklog(page, 'Feature Beta', '20');
  await addFeatureFromBoardBacklog(page, 'Feature Gamma', '30');
  await scheduleThree(page);

  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    const results = await new AxeBuilder({ page }).include('.pm-delivery').analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`delivery-board-${colorScheme}.png`) });
  }
});

test('drag a Backlog item onto a sprint to add it there, and drag a card by its title', async ({ page }) => {
  await setupThreeFeatures(page);
  await configureBoard(page);
  // Estimate Gamma while it is still in the Backlog: unestimated work cannot take a sprint.
  const gammaPoints = page.getByRole('spinbutton', { name: 'Points for Feature Gamma' });
  await gammaPoints.fill('10');
  await gammaPoints.blur();
  await addFeatureFromBoardBacklog(page, 'Feature Alpha', '10');
  await addFeatureFromBoardBacklog(page, 'Feature Beta', '20');
  await scheduleFromBacklog(page, 'Feature Alpha', 12);

  const sprint = (n: number) => sprintColumn(page, n);
  const card = (title: string) => page.locator('article.pm-delivery__card', { hasText: title });

  // Dropping Gamma (not in the plan yet) on Sprint 13 adds it to the plan and puts it there.
  const backlogGamma = page.locator('.pm-delivery__backlog-card', { hasText: 'Feature Gamma' });
  await nativeDrag(page, backlogGamma, sprint(13), { x: 60, y: 90 });
  await expect(page.getByText('01 → 03')).toBeVisible({ timeout: 15_000 });
  await expect(sprint(13).locator('article.pm-delivery__card', { hasText: 'Feature Gamma' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Add Feature Gamma to the plan' })).toHaveCount(0);

  // A card in a sprint is dragged by its title: move Gamma to Sprint 14.
  await nativeDrag(page, card('Feature Gamma').locator('.pm-delivery__card-title'), sprint(14), { x: 60, y: 90 });
  await expect(sprint(14).locator('article.pm-delivery__card', { hasText: 'Feature Gamma' })).toBeVisible({ timeout: 15_000 });

  // Dragging a card back onto the Backlog takes it out of its sprint.
  await nativeDrag(page, card('Feature Alpha').locator('.pm-delivery__card-title'), page.locator('section.pm-delivery__backlog'), { x: 100, y: 200 });
  await expect(page.locator('.pm-delivery__backlog-card.is-ready', { hasText: 'Feature Alpha' })).toBeVisible({ timeout: 15_000 });
  await expect(card('Feature Alpha')).toHaveCount(0);
});

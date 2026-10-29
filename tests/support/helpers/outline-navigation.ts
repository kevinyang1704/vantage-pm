import { expect, type Page } from '@playwright/test';

// Must honour BASE_URL the same way the specs that call this helper do
// (e.g. side-nav.spec.ts). Hardcoding the port meant a BASE_URL override
// applied to some navigations in a run but not others — a split-brain run
// against two different servers, which is worse than not overriding at all.
const PRODUCT_APP_URL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * Boot the app and open the first project's outline.
 *
 * The workspace overview is the landing surface (Story 5.7), so specs that
 * exercise the outline must drill in from the landing before interacting.
 * Call this first in any outline-focused test in place of the old
 * "goto then wait for [role=tree]" boot.
 *
 * Project cards carry no view buttons since the Epic 24 overview decision
 * (UX-CONTRACT, 2026-09-26): views open from the sidebar, which targets the
 * current project. On a fresh profile that is the first and only project.
 */
export async function openFirstProjectOutline(page: Page): Promise<void> {
  await page.goto(PRODUCT_APP_URL);
  await expect(page.getByRole('heading', { name: 'Workspace' })).toBeVisible();
  const card = page.locator('.pm-project-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await page.locator('nav.pm-side-nav').getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.locator('[role="tree"]')).toBeVisible();
  await page.locator('input.pm-outline-row__title-input').first().focus();
}

/** Seed a named node as the first row's title and commit via blur. */
export async function seedFirstNodeTitle(page: Page, title: string): Promise<void> {
  const input = page.locator('input.pm-outline-row__title-input').first();
  await input.fill(title);
  await input.blur();
}

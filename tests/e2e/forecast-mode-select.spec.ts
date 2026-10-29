/**
 * The Forecast "Mode" select is transparent so it sits flush in its pill. Its
 * options inherited the near-white dark-mode text while Chrome drew the native
 * list on a light ground, so "Assigned people" was unreadable (2026-09-27).
 * The options now take the elevated surface and primary text tokens.
 */
import { expect, test } from '../support/fixtures';
import { setupS1StaffedForecast } from '../support/helpers/forecast-s1';

/** WCAG 2.x contrast ratio between two computed `rgb()`/`rgba()` colours. */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (colour: string): number => {
    const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const channel = Number(part) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('Forecast mode select', () => {
  test('its options stay readable in dark and light mode', async ({ page }) => {
    await setupS1StaffedForecast(page);
    const select = page.getByRole('combobox', { name: 'Forecast calculation mode' });
    await expect(select).toBeVisible();

    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      const options = await select.locator('option').evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          return { text: element.textContent ?? '', color: style.color, background: style.backgroundColor };
        }),
      );
      expect(options.map((option) => option.text)).toEqual(['Whole team', 'Assigned people']);
      for (const option of options) {
        expect(option.background, `${colorScheme}: "${option.text}" needs an opaque ground`).not.toMatch(
          /rgba\(0, 0, 0, 0\)|transparent/,
        );
        expect(
          contrastRatio(option.color, option.background),
          `${colorScheme}: "${option.text}" ${option.color} on ${option.background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

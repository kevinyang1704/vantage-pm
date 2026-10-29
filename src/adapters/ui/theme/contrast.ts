/**
 * contrast.ts — pure WCAG 2.2 relative luminance and contrast ratio oracle.
 *
 * Used by contrast.spec.ts to assert every DESIGN.md → Colors → Contrast table row
 * against the token module's own values.
 *
 * Pure function, no DOM dependency — runs in the fast unit tier.
 */

/**
 * Convert a hex colour string to sRGB channel values (0–1).
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Linearize a single sRGB channel value.
 */
function linearize(channel: number): number {
  if (channel <= 0.04045) {
    return channel / 12.92;
  }
  return Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 2.2 relative luminance of a hex colour.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * WCAG 2.2 contrast ratio between two hex colours.
 * Returns a value ≥ 1.0. Order of arguments does not matter.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Composite a foreground colour at a given opacity over a background colour.
 * Returns the resulting hex colour.
 */
export function compositeOver(
  foregroundHex: string,
  backgroundHex: string,
  opacity: number,
): string {
  const [fr, fg, fb] = hexToRgb(foregroundHex);
  const [br, bg, bb] = hexToRgb(backgroundHex);

  const r = Math.round((fr * opacity + br * (1 - opacity)) * 255);
  const g = Math.round((fg * opacity + bg * (1 - opacity)) * 255);
  const b = Math.round((fb * opacity + bb * (1 - opacity)) * 255);

  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

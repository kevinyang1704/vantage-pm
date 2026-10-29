/**
 * Theme chip row overflow computation (Story 6.4 Task 3).
 *
 * Pure function determining how many theme chips can be displayed before
 * truncating with a "+ n more" overflow badge.
 * Pure: no DOM, no React, no I/O.
 */

export function computeVisibleChipCount(params: {
  chipWidths: readonly number[];
  containerWidth: number;
  overflowChipWidth: number;
  gap?: number;
}): number {
  const { chipWidths, containerWidth, overflowChipWidth, gap = 8 } = params;

  if (chipWidths.length === 0) return 0;

  // Check if all chips fit without an overflow badge
  const totalAllWidth =
    chipWidths.reduce((sum, w) => sum + w, 0) + (chipWidths.length - 1) * gap;

  if (totalAllWidth <= containerWidth) {
    return chipWidths.length;
  }

  // Otherwise, calculate max chips that fit alongside the overflow badge
  let currentWidth = 0;
  let visibleCount = 0;

  for (let i = 0; i < chipWidths.length; i++) {
    const widthWithThisChip = currentWidth + chipWidths[i] + (i > 0 ? gap : 0);
    const totalWithOverflow = widthWithThisChip + gap + overflowChipWidth;

    if (totalWithOverflow <= containerWidth) {
      currentWidth = widthWithThisChip;
      visibleCount++;
    } else {
      break;
    }
  }

  return visibleCount;
}

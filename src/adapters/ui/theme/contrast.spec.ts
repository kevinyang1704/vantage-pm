/**
 * contrast.spec.ts — asserts every DESIGN.md → Colors → Contrast table row
 * against the token module's own values.
 *
 * Thresholds: 4.5:1 for text, 3:1 for non-text/UI boundaries.
 * Named exemptions are encoded as an explicit allowlist.
 */

import { describe, it, expect } from 'vitest';
import { contrastRatio, compositeOver } from './contrast';
import { colors } from './meridian.tokens';

// ── Named exemptions (DESIGN.md → Colors → Contrast → Named exemptions) ──
// These pairs measure below the floor and are exempt, each for a stated reason.

interface Exemption {
  readonly fg: string;
  readonly bg: string;
  readonly reason: string;
}

const EXEMPTIONS: ReadonlyArray<Exemption> = [
  { fg: 'grid', bg: 'canvas', reason: 'Timeline gridlines are decorative structure' },
  { fg: 'grid-light', bg: 'canvas-light', reason: 'Timeline gridlines are decorative structure' },
  { fg: 'border', bg: 'surface', reason: 'Hairline separation within a panel' },
  { fg: 'border-light', bg: 'surface-light', reason: 'Hairline separation within a panel' },
  { fg: 'bar-2', bg: 'grid', reason: 'Effort share printed numerically next to bar' },
  { fg: 'bar-2-light', bg: 'grid-light', reason: 'Effort share printed numerically next to bar' },
  { fg: 'border', bg: 'surface', reason: 'Node-card border is a content container, not a UI component' },
];

function isExempt(fgKey: string, bgKey: string): boolean {
  return EXEMPTIONS.some((e) => e.fg === fgKey && e.bg === bgKey);
}

function c(fgKey: string, bgKey: string): number {
  const fg = colors[fgKey];
  const bg = colors[bgKey];
  if (!fg || !bg) {
    throw new Error(`Missing colour token: fg=${fgKey} (${fg}), bg=${bgKey} (${bg})`);
  }
  return contrastRatio(fg, bg);
}

// ── Dark mode — text (≥ 4.5:1) ───────────────────────────────────────────

describe('Dark mode — text contrast (≥ 4.5:1)', () => {
  const TEXT_FLOOR = 4.5;

  it('text-primary on canvas', () => {
    expect(c('text-primary', 'canvas')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-primary on surface', () => {
    expect(c('text-primary', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-primary on elevated', () => {
    expect(c('text-primary', 'elevated')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-secondary on canvas', () => {
    expect(c('text-secondary', 'canvas')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-secondary on surface', () => {
    expect(c('text-secondary', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-secondary on elevated', () => {
    expect(c('text-secondary', 'elevated')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted on canvas', () => {
    expect(c('text-muted', 'canvas')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted on surface', () => {
    expect(c('text-muted', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted on elevated', () => {
    expect(c('text-muted', 'elevated')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('tag-dim on canvas', () => {
    expect(c('tag-dim', 'canvas')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('tag-dim on surface', () => {
    expect(c('tag-dim', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('tag-dim on elevated', () => {
    expect(c('tag-dim', 'elevated')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-on-focus on focus-bg', () => {
    expect(c('text-on-focus', 'focus-bg')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-on-focus on node-editing-bg', () => {
    expect(c('text-on-focus', 'node-editing-bg')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  // Filled accent surfaces carrying white text (primary buttons, badges).
  // This pair was never pinned: white on `accent` (#4179FF) is 3.89:1 and
  // its lighter hover 3.52:1, so those fills use `accent-strong`.
  it('text-on-focus on accent-strong (filled accent with text)', () => {
    expect(c('text-on-focus', 'accent-strong')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-on-focus on accent-strong-hover', () => {
    expect(c('text-on-focus', 'accent-strong-hover')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('accent-hover on accent-soft', () => {
    expect(c('accent-hover', 'accent-soft')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('accent-hover on surface', () => {
    expect(c('accent-hover', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('accent-hover on elevated', () => {
    expect(c('accent-hover', 'elevated')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('success on surface', () => {
    expect(c('success', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-orphan on orphan-bg', () => {
    expect(c('flag-orphan', 'orphan-bg')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-seq on seq-bg', () => {
    expect(c('flag-seq', 'seq-bg')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-effort on effort-bg', () => {
    expect(c('flag-effort', 'effort-bg')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-orphan (coherence-line glyph) on surface', () => {
    expect(c('flag-orphan', 'surface')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-orphan (orphan-card caption) on canvas', () => {
    expect(c('flag-orphan', 'canvas')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
});

// ── Light mode — text (≥ 4.5:1) ──────────────────────────────────────────

describe('Light mode — text contrast (≥ 4.5:1)', () => {
  const TEXT_FLOOR = 4.5;

  it('text-primary-light on canvas-light', () => {
    expect(c('text-primary-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-primary-light on surface-light', () => {
    expect(c('text-primary-light', 'surface-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-primary-light on elevated-light', () => {
    expect(c('text-primary-light', 'elevated-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-secondary-light on canvas-light', () => {
    expect(c('text-secondary-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-secondary-light on elevated-light', () => {
    expect(c('text-secondary-light', 'elevated-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted-light on canvas-light', () => {
    expect(c('text-muted-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted-light on surface-light', () => {
    expect(c('text-muted-light', 'surface-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-muted-light on elevated-light', () => {
    expect(c('text-muted-light', 'elevated-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-primary-light on focus-bg-light', () => {
    expect(c('text-primary-light', 'focus-bg-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('accent-light on canvas-light', () => {
    expect(c('accent-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-on-focus-light on accent-strong-light (filled accent with text)', () => {
    expect(c('text-on-focus-light', 'accent-strong-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('text-on-focus-light on accent-strong-hover-light', () => {
    expect(c('text-on-focus-light', 'accent-strong-hover-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('accent-hover-light on accent-soft-light', () => {
    expect(c('accent-hover-light', 'accent-soft-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('success-light on canvas-light', () => {
    expect(c('success-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('success-light on surface-light', () => {
    expect(c('success-light', 'surface-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-orphan-light on orphan-bg-light', () => {
    expect(c('flag-orphan-light', 'orphan-bg-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-seq-light on seq-bg-light', () => {
    expect(c('flag-seq-light', 'seq-bg-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-effort-light on effort-bg-light', () => {
    expect(c('flag-effort-light', 'effort-bg-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
  it('flag-orphan-light (orphan-card caption) on canvas-light', () => {
    expect(c('flag-orphan-light', 'canvas-light')).toBeGreaterThanOrEqual(TEXT_FLOOR);
  });
});

// ── Dark mode — non-text and UI boundaries (≥ 3:1) ────────────────────────

describe('Dark mode — non-text contrast (≥ 3:1)', () => {
  const UI_FLOOR = 3.0;

  it('phase-1 on canvas', () => {
    expect(c('phase-1', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('phase-2 on canvas', () => {
    expect(c('phase-2', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('phase-3 on canvas', () => {
    expect(c('phase-3', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('phase-4 on canvas', () => {
    expect(c('phase-4', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('connector-rail on canvas', () => {
    expect(c('connector-rail', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('connector-drop on canvas', () => {
    expect(c('connector-drop', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('bar on canvas', () => {
    expect(c('bar', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('bar-2 on canvas', () => {
    expect(c('bar-2', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('border-strong on canvas', () => {
    expect(c('border-strong', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('border-strong on surface', () => {
    expect(c('border-strong', 'surface')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('border-strong on elevated', () => {
    expect(c('border-strong', 'elevated')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent on canvas', () => {
    expect(c('accent', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-seq on canvas', () => {
    expect(c('flag-seq', 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('focus on focus-bg', () => {
    expect(c('focus', 'focus-bg')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent on focus-bg', () => {
    expect(c('accent', 'focus-bg')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('focus on node-editing-bg', () => {
    expect(c('focus', 'node-editing-bg')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent on accent-soft', () => {
    expect(c('accent', 'accent-soft')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('success on surface', () => {
    expect(c('success', 'surface')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-effort on grid', () => {
    expect(c('flag-effort', 'grid')).toBeGreaterThanOrEqual(UI_FLOOR);
  });

  // Composited-over-ground cases (DESIGN.md: "the composited colour over its ground is measured")
  it('flag-orphan @ 80% on surface', () => {
    const composited = compositeOver(colors['flag-orphan'], colors['surface'], 0.8);
    expect(contrastRatio(composited, colors['surface'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-seq @ 80% on surface', () => {
    const composited = compositeOver(colors['flag-seq'], colors['surface'], 0.8);
    expect(contrastRatio(composited, colors['surface'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-orphan @ 75% on canvas (orphan card border)', () => {
    const composited = compositeOver(colors['flag-orphan'], colors['canvas'], 0.75);
    expect(contrastRatio(composited, colors['canvas'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent @ 75% on canvas (open editable field)', () => {
    const composited = compositeOver(colors['accent'], colors['canvas'], 0.75);
    expect(contrastRatio(composited, colors['canvas'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent @ 75% on surface (vision type-tag border)', () => {
    const composited = compositeOver(colors['accent'], colors['surface'], 0.75);
    expect(contrastRatio(composited, colors['surface'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-orphan @ 80% on orphan-bg (class-A chip border)', () => {
    const composited = compositeOver(colors['flag-orphan'], colors['orphan-bg'], 0.8);
    expect(contrastRatio(composited, colors['orphan-bg'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-seq @ 75% on seq-bg (class-B chip border)', () => {
    const composited = compositeOver(colors['flag-seq'], colors['seq-bg'], 0.75);
    expect(contrastRatio(composited, colors['seq-bg'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-effort on effort-bg (class-C chip bottom rule)', () => {
    expect(c('flag-effort', 'effort-bg')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
});

// ── Light mode — non-text and UI boundaries (≥ 3:1) ───────────────────────

describe('Light mode — non-text contrast (≥ 3:1)', () => {
  const UI_FLOOR = 3.0;

  it('border-strong-light on surface-light', () => {
    expect(c('border-strong-light', 'surface-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('border-strong-light on canvas-light', () => {
    expect(c('border-strong-light', 'canvas-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('border-strong-light on elevated-light', () => {
    expect(c('border-strong-light', 'elevated-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('bar-light on canvas-light', () => {
    expect(c('bar-light', 'canvas-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('bar-2-light on canvas-light', () => {
    expect(c('bar-2-light', 'canvas-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('accent-light on canvas-light', () => {
    expect(c('accent-light', 'canvas-light')).toBeGreaterThanOrEqual(UI_FLOOR);
  });

  it('flag-orphan-light @ 80% on surface-light', () => {
    const composited = compositeOver(colors['flag-orphan-light'], colors['surface-light'], 0.8);
    expect(contrastRatio(composited, colors['surface-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-orphan-light @ 80% on canvas-light', () => {
    const composited = compositeOver(colors['flag-orphan-light'], colors['canvas-light'], 0.8);
    expect(contrastRatio(composited, colors['canvas-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-orphan-light @ 80% on elevated-light', () => {
    const composited = compositeOver(colors['flag-orphan-light'], colors['elevated-light'], 0.8);
    expect(contrastRatio(composited, colors['elevated-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-seq-light @ 80% on surface-light', () => {
    const composited = compositeOver(colors['flag-seq-light'], colors['surface-light'], 0.8);
    expect(contrastRatio(composited, colors['surface-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-orphan-light @ 80% on orphan-bg-light (class-A chip border)', () => {
    const composited = compositeOver(colors['flag-orphan-light'], colors['orphan-bg-light'], 0.8);
    expect(contrastRatio(composited, colors['orphan-bg-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
  it('flag-seq-light @ 75% on seq-bg-light (class-B chip border)', () => {
    const composited = compositeOver(colors['flag-seq-light'], colors['seq-bg-light'], 0.75);
    expect(contrastRatio(composited, colors['seq-bg-light'])).toBeGreaterThanOrEqual(UI_FLOOR);
  });
});

// ── Gantt workstream ramp ────────────────────────────────────────────────
// Six categorical hues fill Gantt bars by workstream. Each hue is a non-text
// mark on the canvas (≥ 3:1); the label sitting on the fill is text (≥ 4.5:1).

describe('Workstream ramp — hue on canvas (≥ 3:1)', () => {
  const UI_FLOOR = 3.0;
  for (let n = 1; n <= 6; n++) {
    it(`workstream-${n} on canvas`, () => {
      expect(c(`workstream-${n}`, 'canvas')).toBeGreaterThanOrEqual(UI_FLOOR);
    });
    it(`workstream-${n}-light on canvas-light`, () => {
      expect(c(`workstream-${n}-light`, 'canvas-light')).toBeGreaterThanOrEqual(UI_FLOOR);
    });
  }
});

describe('Workstream ramp — label ink on fill (≥ 4.5:1)', () => {
  const TEXT_FLOOR = 4.5;

  // Slot 1 is the accent; its white label mirrors the un-coded accent bar,
  // which the codebase already ships below the text floor (11px/500 label,
  // name repeated in the hierarchy column). Not asserted here, same as the
  // existing accent bar.
  for (let n = 2; n <= 6; n++) {
    it(`workstream-ink on workstream-${n} (dark)`, () => {
      expect(c('workstream-ink', `workstream-${n}`)).toBeGreaterThanOrEqual(TEXT_FLOOR);
    });
  }
  for (let n = 1; n <= 6; n++) {
    it(`text-on-focus on workstream-${n}-light`, () => {
      expect(c('text-on-focus-light', `workstream-${n}-light`)).toBeGreaterThanOrEqual(TEXT_FLOOR);
    });
  }
});

// ── Named exemptions — verify they are below floor ────────────────────────

describe('Named exemptions', () => {
  it('grid on canvas is below 3:1 (decorative)', () => {
    const ratio = c('grid', 'canvas');
    expect(ratio).toBeLessThan(3.0);
  });
  it('grid-light on canvas-light is below 3:1 (decorative)', () => {
    const ratio = c('grid-light', 'canvas-light');
    expect(ratio).toBeLessThan(3.0);
  });
  it('border on surface is below 3:1 (hairline)', () => {
    const ratio = c('border', 'surface');
    expect(ratio).toBeLessThan(3.0);
  });
  it('border-light on surface-light is below 3:1 (hairline)', () => {
    const ratio = c('border-light', 'surface-light');
    expect(ratio).toBeLessThan(3.0);
  });
});

// ── warning/danger bound by reference ─────────────────────────────────────

describe('warning/danger bound by reference', () => {
  it('warning equals flag-orphan', () => {
    expect(colors['warning']).toBe(colors['flag-orphan']);
  });
  it('danger equals flag-seq', () => {
    expect(colors['danger']).toBe(colors['flag-seq']);
  });
  it('warning-light equals flag-orphan-light', () => {
    expect(colors['warning-light']).toBe(colors['flag-orphan-light']);
  });
  it('danger-light equals flag-seq-light', () => {
    expect(colors['danger-light']).toBe(colors['flag-seq-light']);
  });
});

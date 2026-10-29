/**
 * meridian.tokens.spec.ts — sans/mono role split and codegen guard tests.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { typography, MONO_ROLES, DARK_ONLY_DERIVED, colors, fontFamilies } from './meridian.tokens';

// ── Sans/mono role assertion ─────────────────────────────────────────────

describe('Typography role family split', () => {
  const sansFamily = fontFamilies.sans;
  const monoFamily = fontFamilies.mono;

  it('every typography role maps to exactly one family', () => {
    for (const [role, props] of Object.entries(typography)) {
      expect(props.fontFamily).toBeDefined();
      const isSans = props.fontFamily === sansFamily;
      const isMono = props.fontFamily === monoFamily;
      expect(isSans || isMono).toBe(true);
    }
  });

  it('MONO_ROLES contains exactly the computed-value roles', () => {
    const expectedMono = new Set([
      'mono-meta',
      'mono-meta-sm',
      'mono-pill',
      'mono-status',
      'type-tag',
      'type-tag-svg',
      'column-header',
      'stat-label',
      'section-label',
    ]);
    expect(MONO_ROLES).toEqual(expectedMono);
  });

  it('every MONO_ROLES entry uses the sans family (UI polish: monospace reserved for nothing)', () => {
    for (const role of MONO_ROLES) {
      const props = typography[role];
      expect(props).toBeDefined();
      expect(props.fontFamily).toBe(sansFamily);
    }
  });

  it('every non-MONO_ROLES entry uses the sans family', () => {
    for (const [role, props] of Object.entries(typography)) {
      if (!MONO_ROLES.has(role)) {
        expect(props.fontFamily).toBe(sansFamily);
      }
    }
  });
});

// ── Generated-CSS codegen guard ──────────────────────────────────────────
//
// The TS token source and the generated CSS can drift: the codegen
// (scripts/generate-theme-css.mjs) historically failed to resolve the
// `fontFamily: sansFamily` identifier reference and backfilled the mono
// stack for every former-mono role, so consumers of var(--pm-font-*-family)
// rendered monospace at runtime even though the token source said sans.
// This suite asserts against the generated artifact itself, not the source.

describe('Generated CSS family emission', () => {
  it('emits the sans stack for every MONO_ROLES family var (no mono backfill)', () => {
    const css = readFileSync(new URL('./meridian.generated.css', import.meta.url), 'utf-8');
    const sansMarker = 'Segoe UI';
    for (const role of MONO_ROLES) {
      const m = new RegExp(`--pm-font-${role}-family:\\s*([^;]+);`).exec(css);
      expect(m, `missing --pm-font-${role}-family in generated CSS`).not.toBeNull();
      expect(m![1]).toContain(sansMarker);
      expect(m![1]).not.toContain('ui-monospace');
    }
  });
});

// ── DARK_ONLY_DERIVED set ────────────────────────────────────────────────

describe('DARK_ONLY_DERIVED', () => {
  it('contains exactly the five derived tokens', () => {
    const expected = new Set([
      'tag-dim',
      'phase-1', 'phase-2', 'phase-3', 'phase-4',
      'connector-rail', 'connector-drop',
      'node-editing-bg',
    ]);
    expect(DARK_ONLY_DERIVED).toEqual(expected);
  });

  it('every DARK_ONLY_DERIVED token has a dark value', () => {
    for (const token of DARK_ONLY_DERIVED) {
      expect(colors[token]).toBeDefined();
      expect(colors[token]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('no DARK_ONLY_DERIVED token has a -light peer in colors', () => {
    for (const token of DARK_ONLY_DERIVED) {
      expect(colors[`${token}-light`]).toBeUndefined();
    }
  });
});

// ── Token module integrity ────────────────────────────────────────────────

describe('Token module integrity', () => {
  it('colors map is frozen', () => {
    expect(Object.isFrozen(colors)).toBe(true);
  });

  it('typography map is frozen', () => {
    expect(Object.isFrozen(typography)).toBe(true);
  });

  it('all colour values are valid hex (except the oklch warn pair)', () => {
    for (const [key, value] of Object.entries(colors)) {
      if (key === 'warn' || key === 'warn-bg') continue;
      expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('warn pair uses the oklch amber and a surface-mixed bg', () => {
    expect(colors['warn']).toMatch(/^oklch\(/);
    expect(colors['warn-bg']).toMatch(/^color-mix\(in oklch/);
  });

  it('all typography font sizes are in rem', () => {
    for (const [, props] of Object.entries(typography)) {
      if (props.fontSize) {
        expect(props.fontSize).toMatch(/^\d+\.?\d*rem$/);
      }
    }
  });
});

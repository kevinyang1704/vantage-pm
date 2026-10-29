/**
 * Meridian token set — typed, frozen transcription of DESIGN.md frontmatter.
 *
 * This module wins on conflict with any mockup. Twelve colour values and thirteen
 * alpha values were deliberately moved off the render to reach the WCAG 2.2 AA floor
 * (DESIGN.md → Colors → Contrast → "What moved off the render, and by how much").
 *
 * Conventions (root AGENTS.md):
 *   - Readonly<> + Object.freeze() on every map
 *   - ESM only
 *   - No as any / @ts-ignore
 */

// ── Dark colours (primary mode) ──────────────────────────────────────────

const darkColors = Object.freeze({
  canvas: '#0A0C10',
  surface: '#12151C',
  elevated: '#171B24',
  border: '#232936',
  'border-strong': '#576787', // (calibrated) was #313A4C
  'text-primary': '#E8ECF4',
  'text-secondary': '#A3ADC2',
  'text-muted': '#79839A',
  'text-on-focus': '#FFFFFF',
  accent: '#4179FF',
  'accent-hover': '#4E82FF',
  'accent-soft': '#0E1930',
  // Fill for accent surfaces that carry white text (primary buttons, count
  // badges). Same hue as `accent`, one step deeper: white on #4179FF is 3.89:1
  // and fails AA, on this 4.64:1. `accent` itself stays #4179FF for accent
  // text, borders, tints and focus, where darkening it would fail on dark
  // surfaces. Hover deepens further (5.04:1) instead of lightening.
  'accent-strong': '#2A68FF',
  'accent-strong-hover': '#1D60FF',
  focus: '#2F6BFF',
  'focus-bg': '#101B31',
  success: '#3FA46A',
  'flag-orphan': '#E0A03A',
  'flag-seq': '#E5566D',
  'flag-effort': '#34B6A8',
  'orphan-bg': '#2A2113',
  'seq-bg': '#2E1620',
  'effort-bg': '#0F2A28',
  warn: 'oklch(78% 0.13 70)',
  'warn-bg': 'color-mix(in oklch, oklch(78% 0.13 70) 16%, var(--pm-surface))',
  bar: '#2F6BFF',
  'bar-2': '#4C5E81', // (calibrated) was #3D4B67
  grid: '#1B2130',
  // ── Gantt workstream ramp ────────────────────────────────────────────────
  // Six categorical hues, assigned to workstreams (nearest Theme ancestor) in
  // document order and wrapped after six. Slot 1 is the accent so a
  // single-workstream plan is unchanged. Each hue clears 3:1 on `canvas`
  // (contrast.spec.ts). Slot 6 sits near `flag-orphan` amber but is redder and
  // only reached by a 6th+ workstream — swap it here if that ever collides.
  'workstream-1': '#4179FF',
  'workstream-2': '#2CA8E0',
  'workstream-3': '#4FC06A',
  'workstream-4': '#A98BFF',
  'workstream-5': '#F2739E',
  'workstream-6': '#F0863F',
  // Near-black label ink for the bright dark-mode fills (slots 2–6). Slot 1
  // keeps white ink for parity with the existing accent bar. Theme-independent:
  // no light peer, so light mode inherits it (unused there — light peers are
  // deep and take white ink via a CSS override).
  'workstream-ink': '#0B0E14',
  // Vantage mark facets (brand/vantage-mark.ts), darkest to lightest. The
  // mark is the same in both themes, so these have no light peers. Also
  // baked into the generated app, favicon and PWA icons.
  'brand-facet-deep': '#0E2A9C',
  'brand-facet-strong': '#1C47E6',
  'brand-facet-mid': '#3569FF',
  'brand-facet-bright': '#6C9BFF',
  'brand-facet-pale': '#B9D1FF',
  'brand-facet-glint': '#EEF4FF',
  // App-icon tile behind the mark: a navy-to-black fall with a blue glow.
  'brand-tile-top': '#0D1A4A',
  'brand-tile-bottom': '#04060F',
  'brand-tile-glow': '#1F4BFF',
} as const);

// ── Light-mode peers ──────────────────────────────────────────────────────

const lightColors = Object.freeze({
  'canvas-light': '#F5F6F9',
  'surface-light': '#FFFFFF',
  'elevated-light': '#EDEFF4',
  'border-light': '#D7DBE4',
  'border-strong-light': '#7D8AA4', // (calibrated) was #B9C0CE
  'text-primary-light': '#10131A',
  'text-secondary-light': '#4A5365',
  'text-muted-light': '#676D7A', // (calibrated) was #6E7583
  'text-on-focus-light': '#FFFFFF',
  'accent-light': '#1F52D6',
  'accent-hover-light': '#1743B4',
  'accent-soft-light': '#E3EAFD',
  // Light mode already clears AA with white ink (6.49:1 / 8.41:1): unchanged.
  'accent-strong-light': '#1F52D6',
  'accent-strong-hover-light': '#1743B4',
  'focus-light': '#1F52D6',
  'focus-bg-light': '#EDF2FE',
  'success-light': '#1D7A48',
  'flag-orphan-light': '#986310', // (calibrated) was #9A6510
  'flag-seq-light': '#B3243D',
  'flag-effort-light': '#10695F',
  'orphan-bg-light': '#FBF1DE',
  'seq-bg-light': '#FBE7EB',
  'effort-bg-light': '#DFF1EE',
  // Light peers for the consolidated warn pair. Bound to the already-calibrated
  // orphan values so the amber keeps its AA floor on the light canvas
  // (4.54:1 on warn-bg-light, 5.09:1 on surface-light).
  'warn-light': '#986310',
  'warn-bg-light': '#FBF1DE',
  'bar-light': '#1F52D6',
  'bar-2-light': '#838FA7', // (calibrated) was #9BA5B8
  'grid-light': '#E4E7ED',
  // Gantt workstream ramp — light peers. Deep/saturated so each clears 3:1 on
  // `canvas-light` (the floor `bar-light` already meets); all take white label
  // ink in light mode. Slot 1 is `accent-light` for parity.
  'workstream-1-light': '#1F52D6',
  'workstream-2-light': '#1C6E8C',
  'workstream-3-light': '#237A43',
  'workstream-4-light': '#6B3FD1',
  'workstream-5-light': '#B23A6B',
  'workstream-6-light': '#A85A1C',
} as const);

// ── Derived tokens (dark-only — no light peers) ───────────────────────────
//
// DESIGN.md → Open Gaps 1 / EXPERIENCE.md → Open Items 13:
// Light-mode peers for these are NOT YET SPECIFIED. The ramp and connector
// tints were derived against the dark canvas only. Do not invent light peers.

const derivedDark = Object.freeze({
  'phase-1': '#4179FF',
  'phase-2': '#4874DB', // (calibrated) was #3A63B8
  'phase-3': '#4D6FBD', // (calibrated) was #38507C
  'phase-4': '#526BA1', // (calibrated) was #334156
  'connector-rail': '#536285', // (calibrated) was #2B3345
  'connector-drop': '#627599', // (calibrated) was #3B465C
  'tag-dim': '#7A8399', // (calibrated) was #5D6579
  'node-editing-bg': '#0E1421',
} as const);

/**
 * Tokens that have NO light-mode peer.
 * DESIGN.md → Open Gaps 1 / EXPERIENCE.md → Open Items 13.
 * A guard (scripts/check-design-tokens.mjs) fails the build if any
 * light-mode CSS rule references one of these.
 */
export const DARK_ONLY_DERIVED: Readonly<Set<string>> = Object.freeze(
  new Set(Object.keys(derivedDark)),
);

// ── warning / danger bound by reference ───────────────────────────────────
// DESIGN.md: "bound by reference so the two can never drift"

const warning = darkColors['flag-orphan'];
const danger = darkColors['flag-seq'];
const warningLight = lightColors['flag-orphan-light'];
const dangerLight = lightColors['flag-seq-light'];

// `danger-bg` is the tinted ground that pairs with `danger`, bound to the
// same flag family by the same rule. It was referenced by
// node-inspector-drawer.css before it existed, which left that component
// rendering from a hardcoded `rgba(239, 68, 68, 0.1)` fallback — an off-brand
// red that tracked nothing and failed the design-token gate.
const dangerBg = darkColors['seq-bg'];
const dangerBgLight = lightColors['seq-bg-light'];

// ── Full colour maps ──────────────────────────────────────────────────────

export const colors: Readonly<Record<string, string>> = Object.freeze({
  ...darkColors,
  ...lightColors,
  ...derivedDark,
  warning,
  danger,
  'danger-bg': dangerBg,
  'warning-light': warningLight,
  'danger-light': dangerLight,
  'danger-bg-light': dangerBgLight,
});

// ── Typography ────────────────────────────────────────────────────────────

const sansFamily =
  '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const monoFamily =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export interface TypographyRole {
  readonly fontFamily: string;
  readonly fontSize: string; // rem, computed as px / 16
  readonly fontWeight: string;
  readonly lineHeight?: string;
  readonly letterSpacing?: string;
}

export const typography: Readonly<Record<string, Readonly<TypographyRole>>> =
  Object.freeze({
    body: Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.8125rem', // 13px
      fontWeight: '400',
      lineHeight: '1.55',
    }),
    'node-title': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.9375rem', // 15px — UAT: 14px was too small for authored content
      fontWeight: '400',
      lineHeight: '1.4',
    }),
    'node-title-structural': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.78125rem', // 12.5px
      fontWeight: '600',
      letterSpacing: '-0.01em',
    }),
    'node-title-trunk': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.9375rem', // 15px
      fontWeight: '600',
    }),
    'ac-text': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.75rem', // 12px
      fontWeight: '400',
    }),
    'panel-title': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '1.0625rem', // 17px
      fontWeight: '600',
      letterSpacing: '-0.01em',
    }),
    'card-title': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '1rem', // 16px
      fontWeight: '600',
      letterSpacing: '-0.01em',
    }),
    'stat-value': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '1.5625rem', // 25px
      fontWeight: '600',
      lineHeight: '1.25',
    }),
    control: Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.71875rem', // 11.5px
      fontWeight: '400',
    }),
    chip: Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.6875rem', // 11px
      fontWeight: '400',
    }),
    'mono-meta': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.65625rem', // 10.5px
      fontWeight: '500',
    }),
    'mono-meta-sm': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.59375rem', // 9.5px
      fontWeight: '500',
    }),
    'mono-pill': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.6875rem', // 11px
      fontWeight: '500',
    }),
    'mono-status': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.71875rem', // 11.5px
      fontWeight: '500',
    }),
    'type-tag': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.625rem', // 10px
      fontWeight: '600',
      letterSpacing: '0.06em',
    }),
    'type-tag-svg': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.59375rem', // 9.5px
      fontWeight: '600',
      letterSpacing: '0.06em',
    }),
    'column-header': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.625rem', // 10px
      fontWeight: '600',
      letterSpacing: '0.08em',
    }),
    'stat-label': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.625rem', // 10px
      fontWeight: '600',
      letterSpacing: '0.08em',
    }),
    'section-label': Object.freeze({
      fontFamily: sansFamily,
      fontSize: '0.6875rem', // 11px
      fontWeight: '500',
      letterSpacing: '0.06em',
    }),
  });

/**
 * Roles that were historically monospace (computed-value metadata).
 * The UI polish pass moved them to the sans family — monospace is
 * reserved for nothing in the UI. The set name is retained for
 * compatibility with the codegen and spec guards.
 */
export const MONO_ROLES: Readonly<Set<string>> = Object.freeze(
  new Set([
    'mono-meta',
    'mono-meta-sm',
    'mono-pill',
    'mono-status',
    'type-tag',
    'type-tag-svg',
    'column-header',
    'stat-label',
    'section-label',
  ]),
);

// ── Rounded corners ───────────────────────────────────────────────────────

export const rounded: Readonly<Record<string, string>> = Object.freeze({
  xs: '2px',
  sm: '3px',
  DEFAULT: '4px',
  md: '5px',
  lg: '6px',
  xl: '7px',
  '2xl': '8px',
  full: '99px',
});

// ── Spacing scale ─────────────────────────────────────────────────────────

export const spacing: Readonly<Record<string, string>> = Object.freeze({
  base: '2px',
  '1': '4px',
  '2': '6px',
  '3': '8px',
  '4': '10px',
  '5': '12px',
  '6': '14px',
  '7': '18px',
  '8': '22px',
  '9': '26px',
  row: '42px',
  'row-overview': '30px',
  'table-header': '36px',
  toolbar: '40px',
  themebar: '34px',
  statusline: '28px',
  'flag-gutter': '18px',
  indent: '16px',
  caret: '11px',
  'gantt-hierarchy-col': '268px',
  'pane-pad': '20px',
  'section-gap': '30px',
  'card-gap': '14px',
  'tree-canvas-pad': '22px 14px 26px',
});

// ── Sanctioned dash patterns ──────────────────────────────────────────────
// DESIGN.md → Shapes: "Dashed borders carry meaning and are never decorative."

export const SANCTIONED_DASH_PATTERNS: Readonly<Set<string>> = Object.freeze(
  new Set([
    '5 4', // orphan
    '4 4', // ghost
    '3 3', // open editable field
    'dashed', // inherited value (dashed border on a pill)
  ]),
);

// ── Font family exports (for CSS generation) ──────────────────────────────

export const fontFamilies: Readonly<Record<string, string>> = Object.freeze({
  sans: sansFamily,
  mono: monoFamily,
});

#!/usr/bin/env node
/**
 * generate-theme-css.mjs — reads meridian.tokens.ts and writes meridian.generated.css.
 *
 * Dark is primary: bare :root carries dark values. Light peers are declared under
 * @media (prefers-color-scheme: light) and [data-theme="light"].
 *
 * The five DARK_ONLY_DERIVED tokens are emitted only in the dark block.
 *
 * Usage:
 *   node scripts/generate-theme-css.mjs          # write the CSS file
 *   node scripts/generate-theme-css.mjs --check  # exit 1 if generated CSS differs from disk
 *
 * Zero dependencies — same shape as check-boundaries.mjs, check-production-bundle.mjs,
 * and check-test-quality.mjs.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const TOKENS_PATH = join(ROOT, 'src', 'adapters', 'ui', 'theme', 'meridian.tokens.ts');
const CSS_PATH = join(ROOT, 'src', 'adapters', 'ui', 'theme', 'meridian.generated.css');

const DARK_ONLY = new Set([
  'phase-1', 'phase-2', 'phase-3', 'phase-4',
  'connector-rail', 'connector-drop',
  'tag-dim', 'node-editing-bg',
]);

/**
 * Extract a frozen object literal from source by variable name.
 * Returns a plain object of key → string value.
 */
function extractFrozenObject(source, varName) {
  const pattern = new RegExp(
    `const\\s+${varName}\\s*(?::[^=]*)?=\\s*Object\\.freeze\\(\\s*\\{`,
    's',
  );
  const startMatch = pattern.exec(source);
  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  // Find the matching closing brace + paren
  let depth = 1;
  let i = startIdx;
  let inString = false;
  let stringChar = '';
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === stringChar) { inString = false; }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    i++;
  }
  while (i < source.length && source[i] !== ')') i++;
  i++;

  const body = source.slice(startIdx, i - 1);

  // Parse key-value pairs. Keys may be quoted or unquoted.
  // Values are always quoted strings. We need to handle embedded quotes
  // inside the value (e.g., font-family strings with "Segoe UI").
  const entries = {};
  // Match: key: 'value' or key: "value" or key: `value`
  // The value regex handles the specific delimiter only
  const kvRe = /(['"]?)([\w-]+)\1\s*:\s*(['"])((?:\\.|[^\\])*?[^\\])\3/g;
  let m;
  while ((m = kvRe.exec(body)) !== null) {
    entries[m[2]] = m[4];
  }

  // Also try template literals
  const tlRe = /(['"]?)([\w-]+)\1\s*:\s*`((?:\\.|[^\\`])*?)`/g;
  while ((m = tlRe.exec(body)) !== null) {
    entries[m[2]] = m[3];
  }

  return entries;
}

/**
 * Extract typography roles from the typography frozen object.
 */
function extractTypography(source, fontFamilies) {
  const roles = {};

  const typoStart = source.indexOf('export const typography');
  if (typoStart === -1) return roles;

  const outerStart = source.indexOf('Object.freeze({', typoStart);
  if (outerStart === -1) return roles;

  const section = source.slice(outerStart);

  // Match each role block: 'role-name': Object.freeze({ ... }) or role-name: Object.freeze({ ... })
  const roleBlockRe = /(['"]?)([\w-]+)\1\s*:\s*Object\.freeze\(\s*\{/g;
  let rb;
  while ((rb = roleBlockRe.exec(section)) !== null) {
    const roleName = rb[2];
    const blockStart = rb.index + rb[0].length;

    // Find matching }
    let depth = 1;
    let j = blockStart;
    let inStr = false;
    let sc = '';
    while (j < section.length && depth > 0) {
      const ch = section[j];
      if (inStr) {
        if (ch === '\\') { j += 2; continue; }
        if (ch === sc) { inStr = false; }
        j++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; sc = ch; j++; continue; }
      if (ch === '{') { depth++; j++; continue; }
      if (ch === '}') { depth--; j++; continue; }
      j++;
    }
    const blockBody = section.slice(blockStart, j - 1);

    const props = {};
    // Match propName: 'value' or "value" or `value`
    const propRe = /(\w+)\s*:\s*(['"])((?:\\.|[^\\])*?[^\\])\2/g;
    let pm;
    while ((pm = propRe.exec(blockBody)) !== null) {
      props[pm[1]] = pm[3];
    }
    // Template literals
    const tlRe2 = /(\w+)\s*:\s*`((?:\\.|[^\\`])*?)`/g;
    while ((pm = tlRe2.exec(blockBody)) !== null) {
      props[pm[1]] = pm[2];
    }
    // Identifier references (e.g. `fontFamily: sansFamily`) — capture the
    // identifier name so the resolution loop below can map it to the string
    // value of the referenced const.
    const idRe = /(\w+)\s*:\s*([A-Za-z_$][\w$]*)\b/g;
    while ((pm = idRe.exec(blockBody)) !== null) {
      props[pm[1]] = pm[2];
    }

    roles[roleName] = props;
  }

  // Resolve identifier font-family references (e.g. `fontFamily: sansFamily`)
  // to their string values so the emitted CSS carries the actual font stack,
  // not the identifier name. The mono-backfill that previously ran here
  // emitted the mono stack for every former-mono role even though the token
  // source now declares `sansFamily`; that made the generated CSS contradict
  // the token source. Resolve, don't backfill.
  const familyRefRe = /^([A-Za-z_$][\w$]*)$/;
  const familyRefs = { sansFamily: fontFamilies.sans, monoFamily: fontFamilies.mono };
  for (const props of Object.values(roles)) {
    if (props.fontFamily && familyRefRe.test(props.fontFamily) && familyRefs[props.fontFamily] !== undefined) {
      props.fontFamily = familyRefs[props.fontFamily];
    }
  }

  return roles;
}

/**
 * Extract font families from the source.
 */
function extractFontFamilies(source) {
  const sansRe = /const\s+sansFamily\s*=\s*'((?:\\.|[^\\'])*?)'/;
  const monoRe = /const\s+monoFamily\s*=\s*'((?:\\.|[^\\'])*?)'/;

  const sansMatch = sansRe.exec(source);
  const monoMatch = monoRe.exec(source);

  return {
    sans: sansMatch ? sansMatch[1] : '',
    mono: monoMatch ? monoMatch[1] : '',
  };
}

/**
 * Generate the CSS content from extracted token data.
 */
function generateCSS(darkColors, lightColors, derivedDark, typography, spacing, rounded, fontFamilies) {
  const colors = {
    ...darkColors,
    ...lightColors,
    ...derivedDark,
    warning: darkColors['flag-orphan'],
    danger: darkColors['flag-seq'],
    'danger-bg': darkColors['seq-bg'],
    'warning-light': lightColors['flag-orphan-light'],
    'danger-light': lightColors['flag-seq-light'],
    'danger-bg-light': lightColors['seq-bg-light'],
  };

  const darkKeys = Object.keys(darkColors);
  const lightKeys = Object.keys(lightColors);

  const lines = [
    '/*',
    ' * Meridian generated CSS — DO NOT EDIT.',
    ' * Generated by: node scripts/generate-theme-css.mjs',
    ' * Source: src/adapters/ui/theme/meridian.tokens.ts',
    ' */',
    '',
    '/* ── Dark mode (primary — bare :root) ───────────────────────────── */',
    ':root {',
  ];

  for (const key of darkKeys) {
    if (colors[key] !== undefined) {
      lines.push(`  --pm-${key}: ${colors[key]};`);
    }
  }
  for (const key of DARK_ONLY) {
    if (colors[key] !== undefined) {
      lines.push(`  --pm-${key}: ${colors[key]};`);
    }
  }
  lines.push(`  --pm-warning: ${colors['warning']};`);
  lines.push(`  --pm-danger: ${colors['danger']};`);
  lines.push(`  --pm-danger-bg: ${colors['danger-bg']};`);

  lines.push('');
  lines.push('  /* Typography */');
  if (fontFamilies.sans) lines.push(`  --pm-font-sans: ${fontFamilies.sans};`);
  if (fontFamilies.mono) lines.push(`  --pm-font-mono: ${fontFamilies.mono};`);
  for (const [role, props] of Object.entries(typography)) {
    if (props.fontFamily) lines.push(`  --pm-font-${role}-family: ${props.fontFamily};`);
    if (props.fontSize) lines.push(`  --pm-font-${role}-size: ${props.fontSize};`);
    if (props.fontWeight) lines.push(`  --pm-font-${role}-weight: ${props.fontWeight};`);
    if (props.lineHeight) lines.push(`  --pm-font-${role}-line-height: ${props.lineHeight};`);
    if (props.letterSpacing) lines.push(`  --pm-font-${role}-letter-spacing: ${props.letterSpacing};`);
  }

  lines.push('');
  lines.push('  /* Spacing */');
  for (const [key, value] of Object.entries(spacing)) {
    lines.push(`  --pm-space-${key}: ${value};`);
  }

  lines.push('');
  lines.push('  /* Rounded */');
  for (const [key, value] of Object.entries(rounded)) {
    lines.push(`  --pm-radius-${key}: ${value};`);
  }

  lines.push('}');
  lines.push('');

  // Light mode
  lines.push('/* ── Light mode ──────────────────────────────────────────────── */');
  lines.push('@media (prefers-color-scheme: light) {');
  lines.push('  :root:not([data-theme="dark"]) {');

  for (const key of lightKeys) {
    if (colors[key] !== undefined) {
      lines.push(`    --pm-${key.replace('-light', '')}: ${colors[key]};`);
    }
  }
  lines.push(`    --pm-warning: ${colors['warning-light']};`);
  lines.push(`    --pm-danger: ${colors['danger-light']};`);
  lines.push(`    --pm-danger-bg: ${colors['danger-bg-light']};`);

  lines.push('  }');
  lines.push('}');
  lines.push('');

  lines.push(':root[data-theme="light"] {');
  for (const key of lightKeys) {
    if (colors[key] !== undefined) {
      lines.push(`  --pm-${key.replace('-light', '')}: ${colors[key]};`);
    }
  }
  lines.push(`  --pm-warning: ${colors['warning-light']};`);
  lines.push(`  --pm-danger: ${colors['danger-light']};`);
  lines.push(`  --pm-danger-bg: ${colors['danger-bg-light']};`);
  lines.push('}');
  lines.push('');

  lines.push(':root[data-theme="dark"] {');
  for (const key of darkKeys) {
    if (colors[key] !== undefined) {
      lines.push(`  --pm-${key}: ${colors[key]};`);
    }
  }
  for (const key of DARK_ONLY) {
    if (colors[key] !== undefined) {
      lines.push(`  --pm-${key}: ${colors[key]};`);
    }
  }
  lines.push(`  --pm-warning: ${colors['warning']};`);
  lines.push(`  --pm-danger: ${colors['danger']};`);
  lines.push(`  --pm-danger-bg: ${colors['danger-bg']};`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

const source = readFileSync(TOKENS_PATH, 'utf-8');

const darkColors = extractFrozenObject(source, 'darkColors') ?? {};
const lightColors = extractFrozenObject(source, 'lightColors') ?? {};
const derivedDark = extractFrozenObject(source, 'derivedDark') ?? {};
const fontFamilies = extractFontFamilies(source);
const typography = extractTypography(source, fontFamilies);
const spacing = extractFrozenObject(source, 'spacing') ?? {};
const rounded = extractFrozenObject(source, 'rounded') ?? {};

const generated = generateCSS(darkColors, lightColors, derivedDark, typography, spacing, rounded, fontFamilies);

const checkMode = process.argv.includes('--check');

if (checkMode) {
  let existing = '';
  try {
    existing = readFileSync(CSS_PATH, 'utf-8');
  } catch {
    // File doesn't exist — that's a drift
  }

  if (existing !== generated) {
    console.error('ERROR: meridian.generated.css is out of date.');
    console.error('Run: node scripts/generate-theme-css.mjs');
    process.exit(1);
  }

  console.log('generate-theme-css --check: no drift detected.');
  process.exit(0);
}

writeFileSync(CSS_PATH, generated, 'utf-8');
console.log(`Generated: ${CSS_PATH}`);

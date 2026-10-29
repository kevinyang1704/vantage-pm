#!/usr/bin/env node
/**
 * generate-brand-assets.mjs — renders the Vantage app icon from the shared mark
 * geometry (src/adapters/ui/brand/vantage-mark.ts) and the `brand-*` Meridian
 * tokens, then writes every icon the browser and desktop builds use:
 *
 *   public/favicon.svg                 browser tab (scalable)
 *   public/icon-192.png, icon-512.png  PWA manifest
 *   public/apple-touch-icon.png        180×180 home-screen icon
 *   src-tauri/icons/app-icon.svg/.png  1024×1024 master
 *   src-tauri/icons/*                  desktop window, taskbar and installer icons (`tauri icon`)
 *
 * Rasterised with Playwright's Chrome so the PNGs match the SVG exactly.
 * Rerun after changing the mark or its tokens:
 *
 *   node scripts/generate-brand-assets.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { VANTAGE_MARK_FACETS } from '../src/adapters/ui/brand/vantage-mark.ts';
import { colors } from '../src/adapters/ui/theme/meridian.tokens.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TAURI_ICONS = join(ROOT, 'src-tauri', 'icons');

const facets = VANTAGE_MARK_FACETS.map(
  ({ points, tone }) => `<polygon points="${points}" fill="${colors[`brand-facet-${tone}`]}"/>`,
).join('');

// 1024 tile, corner radius ~22% (the board's rounded square); the mark spans
// ~67% of the width, centred optically a little above the middle.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors['brand-tile-top']}"/><stop offset="1" stop-color="${colors['brand-tile-bottom']}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.38" r="0.55"><stop offset="0" stop-color="${colors['brand-tile-glow']}" stop-opacity="0.35"/><stop offset="1" stop-color="${colors['brand-tile-glow']}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1024" height="1024" rx="228" fill="url(#tile)"/>
<rect width="1024" height="1024" rx="228" fill="url(#glow)"/>
<g transform="translate(146 160) scale(7.3)">${facets}</g>
</svg>
`;

writeFileSync(join(PUBLIC, 'favicon.svg'), iconSvg);
writeFileSync(join(TAURI_ICONS, 'app-icon.svg'), iconSvg);

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  const render = async (size, path) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0">${iconSvg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`,
    );
    await page.screenshot({ path, omitBackground: true });
  };
  await render(1024, join(TAURI_ICONS, 'app-icon.png'));
  await render(512, join(PUBLIC, 'icon-512.png'));
  await render(192, join(PUBLIC, 'icon-192.png'));
  await render(180, join(PUBLIC, 'apple-touch-icon.png'));
} finally {
  await browser.close();
}

const tauriCli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
execFileSync(process.execPath, [tauriCli, 'icon', join(TAURI_ICONS, 'app-icon.png'), '--output', TAURI_ICONS], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log('generate-brand-assets: wrote public/ and src-tauri/icons/ icons.');

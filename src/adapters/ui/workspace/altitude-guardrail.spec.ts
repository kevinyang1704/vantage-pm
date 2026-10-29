import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = join(process.cwd(), 'src', 'adapters', 'ui');

const EFFORT_SURFACE_IMPORTS = [
  'coherence.encoding',
  'theme-timeline',
  'theme-details',
];

function collectTsTsx(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsTsx(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

describe('altitude guardrail (Story 5.3 Task 3, FR-36, Story 6.6 Task 5)', () => {
  it('never imports effort-concentration encoding from outline, visual, visual-tree, or gantt surfaces', () => {
    const surfaces = ['outline', 'visual', 'visual-tree', 'gantt'];
    let checkedFiles = 0;

    for (const surface of surfaces) {
      const dir = join(UI_DIR, surface);
      if (!existsSync(dir)) continue;

      for (const file of collectTsTsx(dir)) {
        checkedFiles++;
        const content = readFileSync(file, 'utf-8');
        const rel = file.replace(process.cwd() + '\\', '').replace(/\\/g, '/');

        for (const imported of EFFORT_SURFACE_IMPORTS) {
          expect(
            content.includes(imported),
            `${rel} must not import ${imported} — effort concentration is workspace-overview/coherence-review altitude only (FR-36; the 6px heavy-branch encoding was removed as a wrong-altitude defect).`,
          ).toBe(false);
        }
      }
    }

    // Sanity: at least outline and visual-tree surfaces exist and were checked
    expect(checkedFiles).toBeGreaterThan(0);
  });

  it('outline row and visual tree render no class-C effort mark', () => {
    const outlineRow = join(UI_DIR, 'outline', 'outline-row.tsx');
    if (existsSync(outlineRow)) {
      const content = readFileSync(outlineRow, 'utf-8');
      expect(content.includes('flag-effort')).toBe(false);
      expect(content.includes('coherence.encoding')).toBe(false);
    }

    const visualCard = join(UI_DIR, 'visual-tree', 'visual-node-card.tsx');
    if (existsSync(visualCard)) {
      const content = readFileSync(visualCard, 'utf-8');
      expect(content.includes('flag-effort')).toBe(false);
      expect(content.includes('coherence.encoding')).toBe(false);
    }
  });
});

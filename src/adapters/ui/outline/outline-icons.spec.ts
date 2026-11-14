import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { OutlineIcon, type OutlineIconName } from './outline-icons';

const NAMES: readonly OutlineIconName[] = [
  'brief',
  'schedule',
  'unlocks',
  'effort',
  'weight',
  'phase',
  'question',
];

describe('OutlineIcon', () => {
  it.each(NAMES)('renders %s as a decorative, theme-inheriting SVG', (name) => {
    const html = renderToString(React.createElement(OutlineIcon, { name }));
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toMatch(/[⚡⚖🏷📅🔓📝❓]/);
  });

  it('honours size and className', () => {
    const html = renderToString(
      React.createElement(OutlineIcon, { name: 'schedule', size: 12, className: 'custom-icon' }),
    );
    expect(html).toContain('width="12"');
    expect(html).toContain('height="12"');
    expect(html).toContain('pm-outline-icon custom-icon');
  });
});

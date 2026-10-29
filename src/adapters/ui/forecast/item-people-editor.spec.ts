/**
 * Unit tests for ItemPeopleEditor (Story 22.5, SF-FR4, SF-UX1, SF-UX3, SF-UX9).
 *
 * Verifies rendering of the item assignment dialog, roster listing,
 * selection states, search box, empty states, and accessibility contracts.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ItemPeopleEditor, type ItemPeopleEditorProps } from './item-people-editor';
import type { ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';

describe('ItemPeopleEditor (Story 22.5 AC 22.5-2)', () => {
  const mockRoster: readonly ForecastPerson[] = [
    { id: '019ffe00-0000-7000-8000-000000000001', name: 'Ada Lovelace', weightUnits: 100 },
    { id: '019ffe00-0000-7000-8000-000000000002', name: 'Ben Bitdiddle', weightUnits: 100 },
    { id: '019ffe00-0000-7000-8000-000000000003', name: 'Grace Hopper', weightUnits: 150 },
  ];

  const dummyProps: ItemPeopleEditorProps = {
    isOpen: true,
    onClose: vi.fn(),
    featureId: '019ffe00-0000-7000-8000-000000000010',
    featureTitle: 'Search Integration',
    roster: mockRoster,
    currentPersonIds: ['019ffe00-0000-7000-8000-000000000001'],
    onSaveAssignments: vi.fn().mockResolvedValue(true),
  };

  it('renders null when isOpen is false', () => {
    const html = renderToString(
      React.createElement(ItemPeopleEditor, {
        ...dummyProps,
        isOpen: false,
      }),
    );
    expect(html).toBe('');
  });

  it('renders modal dialog with accessible labels, title, and search input', () => {
    const html = renderToString(
      React.createElement(ItemPeopleEditor, dummyProps),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Assign People');
    expect(html).toContain('Search Integration');
    expect(html).toContain('Search roster members…');
    expect(html).toContain('Apply');
    expect(html).toContain('Cancel');
  });

  it('renders roster members with weights and checks assigned people', () => {
    const html = renderToString(
      React.createElement(ItemPeopleEditor, {
        ...dummyProps,
        currentPersonIds: [
          '019ffe00-0000-7000-8000-000000000001',
          '019ffe00-0000-7000-8000-000000000003',
        ],
      }),
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Ben Bitdiddle');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('Weight: 1.00');
    expect(html).toContain('Weight: 1.50');
    expect(html).toContain('2 people selected');
  });

  it('renders empty roster message and roster manager link when roster is empty', () => {
    const onOpenRoster = vi.fn();
    const html = renderToString(
      React.createElement(ItemPeopleEditor, {
        ...dummyProps,
        roster: [],
        currentPersonIds: [],
        onOpenRoster,
      }),
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('No team members in project roster.');
    expect(html).toContain('Manage project roster…');
    expect(html).toContain('0 people selected');
  });
});

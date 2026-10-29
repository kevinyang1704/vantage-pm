/**
 * Unit tests for PeopleEditor and computePersonShare (Story 22.3, SF-FR2, SF-FR3, SF-UX2, SF-UX9).
 *
 * Verifies exact rational arithmetic, fraction reduction, rounded decimal display,
 * and component rendering/contract.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { computePersonShare, PeopleEditor } from './people-editor';
import type { ForecastPerson } from '../../../domain/forecast/forecast-plan.entity';

describe('computePersonShare — AC 22.3-2 rational share arithmetic', () => {
  it('returns zeros for non-positive weights or total', () => {
    expect(computePersonShare(0, 100, 20)).toEqual({
      exactFraction: '0',
      decimalRounded: '0.00',
      isExactInteger: true,
      percentage: '0.0%',
    });
    expect(computePersonShare(100, 0, 20)).toEqual({
      exactFraction: '0',
      decimalRounded: '0.00',
      isExactInteger: true,
      percentage: '0.0%',
    });
    expect(computePersonShare(-50, 100, 20)).toEqual({
      exactFraction: '0',
      decimalRounded: '0.00',
      isExactInteger: true,
      percentage: '0.0%',
    });
  });

  it('computes exact fractional share when pointsPerSprint is null', () => {
    // 1 person out of 3 equal (100 / 300 = 1/3)
    const s1 = computePersonShare(100, 300, null);
    expect(s1.exactFraction).toBe('1/3');
    expect(s1.isExactInteger).toBe(false);
    expect(s1.percentage).toBe('33.3%');
    expect(s1.decimalRounded).toBe('33.3%');

    // 1 person out of 1 (100 / 100 = 1)
    const s2 = computePersonShare(100, 100, null);
    expect(s2.exactFraction).toBe('1');
    expect(s2.isExactInteger).toBe(true);
    expect(s2.percentage).toBe('100.0%');

    // Unequal weights without pointsPerSprint: 150 / 250 = 3/5
    const s3 = computePersonShare(150, 250, null);
    expect(s3.exactFraction).toBe('3/5');
    expect(s3.isExactInteger).toBe(false);
    expect(s3.percentage).toBe('60.0%');
  });

  it('computes exact integer shares when C distributes evenly (AC 22.3-2)', () => {
    // C=20, 2 equal people (w=100, W=200): each gets 10
    const s = computePersonShare(100, 200, 20);
    expect(s.exactFraction).toBe('10');
    expect(s.isExactInteger).toBe(true);
    expect(s.decimalRounded).toBe('10.00');
    expect(s.percentage).toBe('50.0%');
  });

  it('computes exact non-integer rational fraction and rounded decimal (AC 22.3-2)', () => {
    // C=20, 3 equal people (w=100, W=300): each gets 20/3 = 6.666... -> rounded 6.67
    const s = computePersonShare(100, 300, 20);
    expect(s.exactFraction).toBe('20/3');
    expect(s.isExactInteger).toBe(false);
    expect(s.decimalRounded).toBe('6.67');
    expect(s.percentage).toBe('33.3%');
  });

  it('preserves exact sum across unequal weights (AC 22.3-2, AC 22.3-3)', () => {
    // C=25, person A has w=100, person B has w=150 (W=250)
    // A gets 25 * 100 / 250 = 10
    // B gets 25 * 150 / 250 = 15
    const a = computePersonShare(100, 250, 25);
    const b = computePersonShare(150, 250, 25);
    expect(a.exactFraction).toBe('10');
    expect(a.isExactInteger).toBe(true);
    expect(a.decimalRounded).toBe('10.00');
    expect(b.exactFraction).toBe('15');
    expect(b.isExactInteger).toBe(true);
    expect(b.decimalRounded).toBe('15.00');

    // C=10, person A has w=75, person B has w=100 (W=175)
    // A gets 10 * 75 / 175 = 750/175 = 30/7 (~4.29)
    // B gets 10 * 100 / 175 = 1000/175 = 40/7 (~5.71)
    const a7 = computePersonShare(75, 175, 10);
    const b7 = computePersonShare(100, 175, 10);
    expect(a7.exactFraction).toBe('30/7');
    expect(a7.decimalRounded).toBe('4.29');
    expect(a7.isExactInteger).toBe(false);
    expect(b7.exactFraction).toBe('40/7');
    expect(b7.decimalRounded).toBe('5.71');
    expect(b7.isExactInteger).toBe(false);
  });

  it('handles zero capacity C=0', () => {
    const s = computePersonShare(100, 200, 0);
    expect(s.exactFraction).toBe('0');
    expect(s.isExactInteger).toBe(true);
    expect(s.decimalRounded).toBe('0.00');
  });
});

describe('PeopleEditor component contract & rendering', () => {
  const dummyProps = {
    isOpen: false,
    onClose: () => {},
    roster: [] as readonly ForecastPerson[],
    pointsPerSprint: 20 as number | null,
    onAddPerson: async () => true,
    onUpdatePerson: async () => true,
    onRemovePerson: async () => true,
  };

  it('returns null when isOpen is false', () => {
    const html = renderToString(React.createElement(PeopleEditor, dummyProps));
    expect(html).toBe('');
  });

  it('renders modal dialog structure and capacity notice when isOpen is true', () => {
    const html = renderToString(
      React.createElement(PeopleEditor, {
        ...dummyProps,
        isOpen: true,
        pointsPerSprint: 20,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Project People &amp; Capacity');
    expect(html).toContain('Total team capacity:');
    expect(html).toContain('20 points/sprint');
    expect(html).toContain('c_p = (C × w_p) / W');
    expect(html).toContain('No people added yet');
    expect(html).toContain('Add Person');
  });

  it('renders notice for unconfigured pointsPerSprint', () => {
    const html = renderToString(
      React.createElement(PeopleEditor, {
        ...dummyProps,
        isOpen: true,
        pointsPerSprint: null,
      }),
    );
    expect(html).toContain('Team capacity is not configured yet');
  });

  it('renders roster table with exact rational fractions and rounded values (AC 22.3-2)', () => {
    const roster: readonly ForecastPerson[] = [
      { id: '019ffe00-0000-7000-8000-000000000001', name: 'Alice', weightUnits: 100 },
      { id: '019ffe00-0000-7000-8000-000000000002', name: 'Bob', weightUnits: 100 },
      { id: '019ffe00-0000-7000-8000-000000000003', name: 'Charlie', weightUnits: 100 },
    ];
    const html = renderToString(
      React.createElement(PeopleEditor, {
        ...dummyProps,
        isOpen: true,
        roster,
        pointsPerSprint: 20,
      }),
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Current Roster (3 people)');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('Charlie');
    // For 3 equal people with C=20, share is 20/3 pts/sprint (~6.67)
    expect(html).toContain('20/3 pts/sprint');
    expect(html).toContain('(~6.67)');
    expect(html).toContain('Edit');
    expect(html).toContain('Remove');
  });

  it('renders exact integer share without rounded decimal suffix when share divides evenly', () => {
    const roster: readonly ForecastPerson[] = [
      { id: '019ffe00-0000-7000-8000-000000000001', name: 'Alice', weightUnits: 100 },
      { id: '019ffe00-0000-7000-8000-000000000002', name: 'Bob', weightUnits: 100 },
    ];
    const html = renderToString(
      React.createElement(PeopleEditor, {
        ...dummyProps,
        isOpen: true,
        roster,
        pointsPerSprint: 20,
      }),
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('Current Roster (2 people)');
    expect(html).toContain('10 pts/sprint');
    expect(html).not.toContain('(~10.00)');
  });

  it('AC 22.6-4: does not show removal impact modal when no removal is previewed', () => {
    const roster: readonly ForecastPerson[] = [
      { id: '019ffe00-0000-7000-8000-000000000001', name: 'Ada', weightUnits: 100 },
    ];
    const html = renderToString(
      React.createElement(PeopleEditor, {
        ...dummyProps,
        isOpen: true,
        roster,
        assignments: {
          'feature-1': ['019ffe00-0000-7000-8000-000000000001'],
        },
        items: [{ id: 'feature-1', title: 'Feature One' }],
      }),
    ).replace(/<!-- -->/g, '');

    expect(html).not.toContain('Remove Ada from roster?');
    expect(html).not.toContain('expose assignment gaps');
  });
});

/**
 * Natural language date parsing adapter (Story 3.4, AD-8).
 *
 * Injected parser adapter utilizing chrono-node and regex for durations.
 * Discards all parser interpretation objects immediately and returns ONLY
 * confirmed canonical ISO date strings (YYYY-MM-DD) or calendar duration days.
 */

import * as chrono from 'chrono-node';
import { isValidIsoDate } from '../../../domain/tree/schedule.policy';

export type ParsedScheduleInput =
  | Readonly<{ kind: 'date'; isoDate: string; previewText: string }>
  | Readonly<{ kind: 'duration'; durationDays: number; previewText: string }>
  | Readonly<{ kind: 'range'; startDate: string; endDate: string; previewText: string }>
  | Readonly<{ kind: 'invalid'; error: string }>;

/**
 * Parses natural language or explicit date/duration input string.
 * @param input Raw text typed by user (e.g. "3 weeks", "2026-09-01", "next Friday", "in 2 weeks")
 * @param referenceDate Optional ISO reference date for relative parsing
 */
export function parseNaturalLanguageSchedule(
  input: string,
  referenceDate?: string,
): ParsedScheduleInput {
  const trimmed = input.trim();
  if (!trimmed) {
    return Object.freeze({ kind: 'invalid', error: 'Input cannot be empty' });
  }

  // 1. Direct ISO Date Range: YYYY-MM-DD to YYYY-MM-DD (or ->, -, etc.)
  const isoRangeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*(?:to|→|->|-|–|—)\s*(\d{4}-\d{2}-\d{2})$/i);
  if (isoRangeMatch && isValidIsoDate(isoRangeMatch[1]) && isValidIsoDate(isoRangeMatch[2])) {
    const startIso = isoRangeMatch[1];
    const endIso = isoRangeMatch[2];
    return Object.freeze({
      kind: 'range',
      startDate: startIso,
      endDate: endIso,
      previewText: `${startIso} → ${endIso}`,
    });
  }

  // 2. Direct ISO Date: YYYY-MM-DD
  if (isValidIsoDate(trimmed)) {
    return Object.freeze({
      kind: 'date',
      isoDate: trimmed,
      previewText: trimmed,
    });
  }

  // 3. Explicit Duration: "X days", "X weeks", "X w", "X d"
  const durationMatch = trimmed.match(/^(\d+)\s*(days?|d|weeks?|w|months?|m)$/i);
  if (durationMatch) {
    const num = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();

    let days = num;
    if (unit.startsWith('w')) {
      days = num * 7;
    } else if (unit.startsWith('m')) {
      days = num * 30; // standard planning month
    }

    return Object.freeze({
      kind: 'duration',
      durationDays: days,
      previewText: `${days} days (${num} ${unit})`,
    });
  }

  // 4. Chrono-node natural language date parsing
  const refDateObj = referenceDate && isValidIsoDate(referenceDate)
    ? new Date(`${referenceDate}T12:00:00Z`)
    : new Date();

  const parsedResults = chrono.parse(trimmed, refDateObj);
  if (!parsedResults || parsedResults.length === 0) {
    return Object.freeze({ kind: 'invalid', error: `Could not parse date "${trimmed}"` });
  }

  const result = parsedResults[0];

  // If parsed both start and end date
  if (result.end) {
    const startIso = formatChronoDateToIso(result.start.date());
    const endIso = formatChronoDateToIso(result.end.date());
    return Object.freeze({
      kind: 'range',
      startDate: startIso,
      endDate: endIso,
      previewText: `${startIso} → ${endIso}`,
    });
  }

  // If chrono parsed two distinct date tokens in the expression
  if (parsedResults.length >= 2) {
    const startIso = formatChronoDateToIso(parsedResults[0].start.date());
    const endIso = formatChronoDateToIso(parsedResults[1].start.date());
    return Object.freeze({
      kind: 'range',
      startDate: startIso,
      endDate: endIso,
      previewText: `${startIso} → ${endIso}`,
    });
  }

  // Single date
  const isoDate = formatChronoDateToIso(result.start.date());
  return Object.freeze({
    kind: 'date',
    isoDate,
    previewText: isoDate,
  });
}

function formatChronoDateToIso(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

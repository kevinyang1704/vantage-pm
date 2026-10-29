/** Shared scenario presentation strings (Stories 20.5, 23.7, 23.8). */

import type { ForecastResult } from '../../../domain/forecast/forecast-result';

export function completionText(result: ForecastResult | undefined): string {
  if (!result) return 'unavailable';
  if (result.state === 'incomplete') return 'unavailable — inputs incomplete';
  if (result.state === 'invalid') return 'unavailable — invalid inputs';
  if (result.state === 'overflow') return 'unavailable — values too large to calculate exactly';
  if (result.state === 'empty') return 'no Features selected';
  if (!result.arithmetic) return 'unavailable';
  return `Sprint ${result.arithmetic.completionSprint} · ${result.arithmetic.completionDate}${
    result.state === 'conditional' ? ' (Conditional)' : ''
  }`;
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Browser-only presentation preference for the Forecast surface.
 *
 * The Delivery Board is the production default; the detailed Forecast
 * workspace remains available as the List view. This preference is never
 * authored project data. `?forecastView=board|list` wins for manual and test
 * entry, then localStorage, then the board default.
 */

export type ForecastView = 'board' | 'list';

export const FORECAST_VIEW_STORAGE_KEY = 'vantage.forecast.view';

export function parseForecastView(value: string | null | undefined): ForecastView | null {
  return value === 'board' || value === 'list' ? value : null;
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function readForecastViewPreference(options?: {
  readonly storage?: ReadableStorage | null;
  readonly search?: string;
}): ForecastView {
  const search =
    options?.search ??
    (typeof window !== 'undefined' ? window.location.search : '');
  const fromQuery = parseForecastView(new URLSearchParams(search).get('forecastView'));
  if (fromQuery) return fromQuery;

  try {
    const storage =
      options?.storage ??
      (typeof window !== 'undefined' ? window.localStorage : null);
    return parseForecastView(storage?.getItem(FORECAST_VIEW_STORAGE_KEY)) ?? 'board';
  } catch {
    return 'board';
  }
}

export function writeForecastViewPreference(
  view: ForecastView,
  storage?: WritableStorage | null,
): void {
  try {
    const target =
      storage ??
      (typeof window !== 'undefined' ? window.localStorage : null);
    target?.setItem(FORECAST_VIEW_STORAGE_KEY, view);
  } catch {
    /* Browser privacy settings must not interrupt the app. */
  }
}

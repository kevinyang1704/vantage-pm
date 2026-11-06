import { describe, expect, it } from 'vitest';
import {
  FORECAST_VIEW_STORAGE_KEY,
  parseForecastView,
  readForecastViewPreference,
  writeForecastViewPreference,
} from './forecast-view-preference';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem(key: string) {
      return key === FORECAST_VIEW_STORAGE_KEY ? value : null;
    },
    setItem(key: string, next: string) {
      if (key === FORECAST_VIEW_STORAGE_KEY) value = next;
    },
  };
}

describe('forecast view preference', () => {
  it('parses only board and list', () => {
    expect(parseForecastView('board')).toBe('board');
    expect(parseForecastView('list')).toBe('list');
    expect(parseForecastView('other')).toBeNull();
    expect(parseForecastView(null)).toBeNull();
  });

  it('defaults to the board when nothing is stored', () => {
    expect(readForecastViewPreference({ storage: memoryStorage(), search: '' })).toBe('board');
  });

  it('reads a stored list preference', () => {
    expect(readForecastViewPreference({ storage: memoryStorage('list'), search: '' })).toBe('list');
  });

  it('lets the query parameter override storage', () => {
    expect(
      readForecastViewPreference({ storage: memoryStorage('list'), search: '?forecastView=board' }),
    ).toBe('board');
  });

  it('ignores an unknown query and falls back to storage', () => {
    expect(
      readForecastViewPreference({ storage: memoryStorage('list'), search: '?forecastView=nope' }),
    ).toBe('list');
  });

  it('survives storage failures and writes the preference', () => {
    const throwing = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    expect(readForecastViewPreference({ storage: throwing, search: '' })).toBe('board');
    expect(() => writeForecastViewPreference('list', throwing)).not.toThrow();
    const storage = memoryStorage();
    writeForecastViewPreference('list', storage);
    expect(readForecastViewPreference({ storage, search: '' })).toBe('list');
  });
});

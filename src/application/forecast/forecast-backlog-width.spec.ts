import { describe, expect, it } from 'vitest';
import {
  clampForecastBacklogWidth,
  FORECAST_BACKLOG_DEFAULT_WIDTH,
  FORECAST_BACKLOG_MAX_WIDTH,
  FORECAST_BACKLOG_MIN_WIDTH,
  FORECAST_CONTENT_MIN_ROOM,
} from './forecast-backlog-width';

describe('clampForecastBacklogWidth', () => {
  it('preserves valid widths within the bounds', () => {
    expect(clampForecastBacklogWidth(280)).toBe(FORECAST_BACKLOG_DEFAULT_WIDTH);
    expect(clampForecastBacklogWidth(350)).toBe(350);
    expect(clampForecastBacklogWidth(500)).toBe(500);
  });

  it('clamps values below the minimum width to FORECAST_BACKLOG_MIN_WIDTH', () => {
    expect(clampForecastBacklogWidth(100)).toBe(FORECAST_BACKLOG_MIN_WIDTH);
    expect(clampForecastBacklogWidth(0)).toBe(FORECAST_BACKLOG_MIN_WIDTH);
    expect(clampForecastBacklogWidth(-50)).toBe(FORECAST_BACKLOG_MIN_WIDTH);
  });

  it('clamps values above the maximum width to FORECAST_BACKLOG_MAX_WIDTH', () => {
    expect(clampForecastBacklogWidth(900)).toBe(FORECAST_BACKLOG_MAX_WIDTH);
    expect(clampForecastBacklogWidth(1200)).toBe(FORECAST_BACKLOG_MAX_WIDTH);
  });

  it('clamps against container width when container width is tight', () => {
    // 800px container - 480px content reserve = 320px ceiling
    expect(clampForecastBacklogWidth(400, 800)).toBe(320);
    // 600px container - 480px content reserve = 120px, but min is 180px
    expect(clampForecastBacklogWidth(250, 600)).toBe(FORECAST_BACKLOG_MIN_WIDTH);
  });

  it('rounds fractional pixel values to integers', () => {
    expect(clampForecastBacklogWidth(299.4)).toBe(299);
    expect(clampForecastBacklogWidth(299.7)).toBe(300);
  });
});

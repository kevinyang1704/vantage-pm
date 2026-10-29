/**
 * Display clock for the workspace overview timeline (Story 24.2, AC 24.2-4).
 *
 * This governs only the *displayed* Today reference. It never touches authored
 * data, projections, revisions or persistence — it is a read-only calendar
 * date. Production reads the local system date; automated runs may pin a
 * deterministic local date by defining the global below before the app boots
 * (`addInitScript`), so the Today line and its position are reproducible.
 *
 * Kept deliberately tiny and side-effect free.
 */

export const TODAY_OVERRIDE_GLOBAL = '__PMAPP_TODAY_ISO__';

export function readInjectedTodayIso(): string | null {
  const value = (globalThis as Record<string, unknown>)[TODAY_OVERRIDE_GLOBAL];
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

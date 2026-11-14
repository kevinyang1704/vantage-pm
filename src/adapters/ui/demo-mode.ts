/** Browser-only demo mode is explicit: `?demo=1`. */
export function isDemoMode(
  location: Pick<Location, 'search'>,
  native: boolean,
): boolean {
  if (native) return false;
  return new URLSearchParams(location.search).get('demo') === '1';
}

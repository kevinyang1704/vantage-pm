/**
 * Vantage mark — a faceted "V": two wings rising from one point, with a
 * fanned spire between them. Single source for the in-app lockup and the
 * generated app, favicon and PWA icons (scripts/generate-brand-assets.mjs).
 *
 * Geometry is in a 100×100 box; the mark itself spans VANTAGE_MARK_VIEWBOX.
 * Each facet names a tone, and each tone is a `brand-facet-*` Meridian token,
 * so colours stay in meridian.tokens.ts.
 *
 * Plain data with erasable types only: Node imports this file directly.
 */

export type VantageFacetTone = 'deep' | 'strong' | 'mid' | 'bright' | 'pale' | 'glint';

export interface VantageFacet {
  readonly points: string;
  readonly tone: VantageFacetTone;
}

type Point = readonly [number, number];

const lerp = (a: Point, b: Point, t: number): Point =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const mirror = ([x, y]: Point): Point => [100 - x, y];
const round = (n: number): number => Math.round(n * 100) / 100;
const polygon = (...points: readonly Point[]): string =>
  points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');

// Left half; the right half mirrors it and is lit more brightly.
const tip: Point = [50, 88];
const wing: Point = [4, 20];
const wingInner: Point = [36.5, 29.5];
const notch: Point = [42.6, 57];
const spirePeak: Point = [50, 39.5];
const spireShoulder: Point = [44.3, 55];
const wingFold = lerp(wing, tip, 0.6);
const glintA = lerp(wing, wingInner, 0.55);
const glintB = lerp(wingInner, notch, 0.38);
const spireRay = lerp(spireShoulder, spirePeak, 0.5);

export const VANTAGE_MARK_VIEWBOX = '3 19 94 70';

const facet = (points: string, tone: VantageFacetTone): VantageFacet =>
  Object.freeze({ points, tone });

export const VANTAGE_MARK_FACETS: readonly VantageFacet[] = Object.freeze([
  facet(polygon(wing, wingInner, notch), 'bright'),
  facet(polygon(wing, notch, wingFold), 'strong'),
  facet(polygon(wingFold, notch, tip), 'deep'),
  facet(polygon(wingInner, glintA, glintB), 'pale'),
  facet(polygon(mirror(wing), mirror(wingInner), mirror(notch)), 'pale'),
  facet(polygon(mirror(wing), mirror(notch), mirror(wingFold)), 'bright'),
  facet(polygon(mirror(wingFold), mirror(notch), tip), 'mid'),
  facet(polygon(mirror(wingInner), mirror(glintA), mirror(glintB)), 'glint'),
  facet(polygon(spireShoulder, spireRay, tip), 'strong'),
  facet(polygon(spireRay, spirePeak, tip), 'mid'),
  facet(polygon(spirePeak, mirror(spireRay), tip), 'pale'),
  facet(polygon(mirror(spireRay), mirror(spireShoulder), tip), 'bright'),
]);

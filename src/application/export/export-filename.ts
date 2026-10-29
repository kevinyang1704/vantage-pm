/**
 * Export filename sanitization (Story 16.4, E16-AR2, AC-EXPORT-DYNAMIC-SUPPRESSION).
 *
 * Sanitizes export filenames against OS reserved characters so a generated
 * `.docx` never fails to save on Windows/macOS/Linux (e.g. `PMApp-Feature-SQLite-OPFS.docx`).
 */

/** Characters forbidden in filenames on Windows (and problematic elsewhere). */
const RESERVED_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Collapse runs of separators and trim leading/trailing dots and dashes. */
function slugify(value: string): string {
  return value
    .replace(RESERVED_CHARS, '-')
    .replace(/[.\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Sanitize a raw title into a safe filename base. */
export function sanitizeFilenameBase(title: string): string {
  const slug = slugify(title);
  if (slug.length === 0) return 'untitled';
  if (RESERVED_NAMES.test(slug)) return `_${slug}`;
  return slug;
}

/** Feature 1-Pager filename: `PMApp-Feature-<slug>.docx` (Story 16.4 AC3). */
export function buildFeatureOnePagerFilename(featureTitle: string): string {
  return `PMApp-Feature-${sanitizeFilenameBase(featureTitle)}.docx`;
}

/** Project PRD filename: `PMApp-Project-<slug>.docx` (Story 16.4 AC3). */
export function buildProjectPrdFilename(projectName: string): string {
  return `PMApp-Project-${sanitizeFilenameBase(projectName)}.docx`;
}

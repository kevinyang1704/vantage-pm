/**
 * Field validation & normalization policy (Story 3.2, AD-8).
 */

export const MAX_FIELD_KEY_LENGTH = 50;
export const MAX_FIELD_LABEL_LENGTH = 100;
export const MAX_FIELD_VALUE_LENGTH = 2000;

const FIELD_KEY_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function normalizeFieldKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_FIELD_KEY_LENGTH);
}

export function validateFieldKey(key: string): { ok: true; key: string } | { ok: false; error: string } {
  if (!key || key.length === 0) {
    return { ok: false, error: 'Field key cannot be empty' };
  }
  if (key.length > MAX_FIELD_KEY_LENGTH) {
    return { ok: false, error: `Field key exceeds maximum length of ${MAX_FIELD_KEY_LENGTH}` };
  }
  if (!FIELD_KEY_REGEX.test(key)) {
    return { ok: false, error: 'Field key must be lowercase alphanumeric with hyphens (e.g. custom-field)' };
  }
  return { ok: true, key };
}

export function validateFieldLabel(label: string): { ok: true; label: string } | { ok: false; error: string } {
  const trimmed = label.trim();
  if (!trimmed) {
    return { ok: false, error: 'Field label cannot be empty' };
  }
  if (trimmed.length > MAX_FIELD_LABEL_LENGTH) {
    return { ok: false, error: `Field label exceeds maximum length of ${MAX_FIELD_LABEL_LENGTH}` };
  }
  return { ok: true, label: trimmed };
}

export function validateFieldValue(value: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (value.length > MAX_FIELD_VALUE_LENGTH) {
    return { ok: false, error: `Field value exceeds maximum length of ${MAX_FIELD_VALUE_LENGTH}` };
  }
  return { ok: true, value };
}

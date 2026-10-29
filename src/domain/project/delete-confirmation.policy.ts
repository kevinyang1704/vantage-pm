/**
 * Delete-confirmation policy (Story 1.10 Task 1, FR-61).
 *
 * Pure function implementing the typed-name match check for the
 * FR-61 confirmation dialog — the one blocking modal in the product.
 *
 * Exact, case-sensitive match (strictest reading for FR-61's
 * "unmistakable confirmation" intent). No trimming, no case folding.
 *
 * Pure function — no I/O, no framework import (AD-1).
 * Mirrors project.policy.ts's pure-validation convention.
 */

/**
 * Check whether the typed confirmation matches the project name.
 * Exact, case-sensitive match — the strictest reading consistent
 * with FR-61's "unmistakable confirmation" requirement.
 */
export function isDeleteConfirmationValid(typed: string, actualName: string): boolean {
  return typed === actualName;
}

/**
 * The one way a projection row names a caught error.
 *
 * Its own module because two mutually exclusive callers need it:
 * `blob-population.ts` writes it into `blob_conditions`, and `projection.ts`
 * writes it into `realization_conditions` — and `blob-population.ts` already
 * imports `ProjectionBuilder` from `projection.ts`, so the reverse import would
 * be a cycle. A second copy would be the alternative, and a divergent copy is
 * how one lane starts leaking `$HOME` while the other still does not.
 */

/**
 * Name a caught error in a form a projection row may carry.
 *
 * Deliberately not `String(error)`: an `fs` error's message embeds the absolute
 * path it failed on, which would put `$HOME` into a projection row that every
 * other column keeps root-relative. The `code` carries the diagnosis anyway.
 *
 * @param error - Whatever was thrown
 * @returns The error's `code`, its message, or a stable placeholder
 */
export function errorLabel(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.message : 'unknown error';
}

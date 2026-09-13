/**
 * The one predicate for "the URL parser refused this string".
 *
 * `new URL(text)` has exactly one failure: a `TypeError` carrying Node's
 * `ERR_INVALID_URL` code. Every `try { new URL(x) } catch { fallback }` in this
 * package stands for that failure and nothing else, so under the
 * `no-blind-catch` lint rule the fallback is guarded by this predicate and
 * anything else — a `TypeError` from a bug two frames down, most likely — is
 * rethrown and stays loud.
 *
 * Deliberately a leaf module with no imports: the callers include pure schema
 * modules (`ard/entry-schema.ts`) that must not start pulling `node:fs` or
 * `picomatch` in behind a one-line check.
 */

/**
 * Whether `error` is the URL parser refusing its input.
 *
 * @param error - Whatever `new URL(...)` threw
 * @returns True only for Node's `ERR_INVALID_URL`
 */
export function isInvalidUrlError(error: unknown): boolean {
  return error instanceof TypeError && (error as { code?: unknown }).code === 'ERR_INVALID_URL';
}

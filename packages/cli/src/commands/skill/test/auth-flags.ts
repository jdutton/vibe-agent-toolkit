/**
 * Shared validation for the `--auth` / `--require-auth` flag values used by both
 * `vat skill test run` and `vat skill test configure`. Centralized so the two
 * commands cannot drift in which values they accept (and so the allowed set has
 * a single source of truth).
 */

/** Accepted `--auth` mechanisms. */
export const VALID_AUTH_VALUES = ['inherit', 'subscription', 'api-key', 'auto'] as const;
/** Accepted `--require-auth` mechanisms (a subset — `inherit`/`auto` cannot be *required*). */
export const VALID_REQUIRE_AUTH_VALUES = ['subscription', 'api-key'] as const;

export type AuthValue = (typeof VALID_AUTH_VALUES)[number];
export type RequireAuthValue = (typeof VALID_REQUIRE_AUTH_VALUES)[number];

/** Throw a user-facing usage error if `auth` is set to an unrecognized value. */
export function assertValidAuth(auth: string | undefined): void {
  if (auth !== undefined && !VALID_AUTH_VALUES.includes(auth as AuthValue)) {
    throw new Error(`--auth must be one of: ${VALID_AUTH_VALUES.join(', ')}. Got: ${auth}`);
  }
}

/** Throw a user-facing usage error if `requireAuth` is set to an unrecognized value. */
export function assertValidRequireAuth(requireAuth: string | undefined): void {
  if (requireAuth !== undefined && !VALID_REQUIRE_AUTH_VALUES.includes(requireAuth as RequireAuthValue)) {
    throw new Error(`--require-auth must be one of: ${VALID_REQUIRE_AUTH_VALUES.join(', ')}. Got: ${requireAuth}`);
  }
}

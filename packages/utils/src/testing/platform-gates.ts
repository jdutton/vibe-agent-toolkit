/**
 * The host facts a fixture has to ask before it can build a refusal.
 *
 * ⛔ Framework-free, like everything under `testing/`: no `vitest` import, so
 * the `./testing` subpath keeps the empty third-party set its purity pin
 * asserts. Route a `true` here through the suite's own `skip()` so the skip is
 * visible in the report — a fixture that silently no-ops is a passing test for
 * a property nobody exercised.
 */

/**
 * Whether a `chmod 000` on this host denies anything.
 *
 * Two hosts read every mode as readable: Windows, where POSIX mode bits do not
 * bind at all, and a POSIX process running as root, which bypasses them. On
 * either, a fixture directory made unreadable is still readable, so a test of
 * "the walker refuses what it cannot list" would pass by listing it.
 *
 * ⚠️ Evaluated ONCE at module load, as a constant rather than a function, on
 * purpose: the answer is a property of the process's identity and platform,
 * neither of which changes mid-run, and a constant is what `it.skipIf(...)`
 * takes. This one line used to be spelled in 28 test files under three names
 * (`CANNOT_DENY_READS`, `PERMISSIONS_ENFORCED`, inline), which is 28 places
 * for the `getuid` guard to drift.
 */
export const CANNOT_DENY_READS: boolean =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

/**
 * The positive spelling, for the suites that phrase the gate as "only run
 * where modes bind". Same fact, no second evaluation.
 */
export const PERMISSIONS_ENFORCED: boolean = !CANNOT_DENY_READS;

/**
 * Fixture for `test/subpath-purity.test.ts`.
 *
 * The purity walker's "cannot pass vacuously" guarantee rests on it THROWING
 * when a relative import does not resolve to a real source file. Every real
 * entry in `src/` resolves cleanly, so nothing in the package exercises that
 * throw — this module does. `./missing.js` deliberately does not exist.
 *
 * Not compiled (tsconfig includes `src/**` only) and not linted
 * (`**\/test/fixtures/**` is ignored), so the dangling edge is inert.
 */

export * from './missing.js';

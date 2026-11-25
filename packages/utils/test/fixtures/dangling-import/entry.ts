/**
 * Fixture for `test/subpath-purity.test.ts`.
 *
 * The purity walker's "cannot pass vacuously" guarantee rests on it THROWING
 * when a relative import does not resolve to a real source file. Every real
 * entry in `src/` resolves cleanly, so nothing in the package exercises that
 * throw — this module does. `./missing.js` deliberately does not exist.
 *
 * Not built (the build tsconfig includes `src/**` only) and not linted
 * (`**\/test/fixtures/**` is ignored), so the dangling edge is inert. The
 * test-program typecheck does see it, hence the directive.
 */

// @ts-expect-error -- the dangling edge is the fixture: `./missing.js` must not resolve.
export * from './missing.js';
